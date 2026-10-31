/**
 * Signing in with Privy (an email login that comes with a wallet the person owns).
 *
 *   POST /api/auth/privy         tokens + public key  -> authenticated | needs_username
 *   POST /api/auth/privy/claim   tokens + public key + @handle -> authenticated
 *
 * Stateless on purpose: unlike the Xaman flow there is no SignInRequest to remember, because
 * the tokens ARE the proof and are re-verified on every call. The wallet's address is read from
 * the verified identity token and the client's public key is bound to it (see `privy-auth.ts`),
 * so nothing the browser says is taken on trust.
 *
 * Off unless the deployment turns it on (`SIGNERS` includes `privy` and `PRIVY_APP_ID` is set):
 * with the flag off these routes answer 404 as if they did not exist, and create no accounts.
 */
import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { env, privyMode } from '../env.js'
import { issuesOf, usernameSchema } from '../schemas.js'
import { PrivyAuthError, bindPublicKey, makePrivyVerifier } from '../privy-auth.js'
import { issueSession } from './auth.js'

export const privyAuthRouter = Router()

type Verifier = ReturnType<typeof makePrivyVerifier>
let verifier: Verifier | null = null

/** The verifier for this deployment's app. Tests replace it with one over a local key set. */
export function privyVerifier(): Verifier {
  verifier ??= makePrivyVerifier({ appId: env.PRIVY_APP_ID! })
  return verifier
}
export function setPrivyVerifierForTests(v: Verifier | null): void {
  verifier = v
}

const Tokens = z.object({
  accessToken: z.string().min(20).max(8_000),
  identityToken: z.string().min(20).max(16_000),
  publicKey: z.string().min(60).max(70),
})
const ClaimBody = Tokens.extend({
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(60).optional(),
})

const STATUS: Record<PrivyAuthError['code'], number> = {
  invalid_token: 401,
  mismatched_tokens: 401,
  no_wallet: 409,
  ambiguous_wallet: 409,
  bad_key: 400,
}

/** Verify the tokens and the key; answer the failure to the client, or return who this is. */
async function identify(body: z.infer<typeof Tokens>, res: import('express').Response) {
  try {
    const who = await privyVerifier().verify(body.accessToken, body.identityToken)
    const publicKey = bindPublicKey(body.publicKey, who.address)
    return { ...who, publicKey }
  } catch (err) {
    if (err instanceof PrivyAuthError) {
      res.status(STATUS[err.code]).json({ error: err.message, code: err.code })
      return null
    }
    throw err
  }
}

const userBody = (u: { username: string; displayName: string | null; xrplAddress: string }) => ({
  username: u.username,
  displayName: u.displayName,
  xrplAddress: u.xrplAddress,
})

privyAuthRouter.post('/auth/privy', async (req, res) => {
  if (privyMode !== 'live') return void res.status(404).json({ error: 'Not found' })
  const parsed = Tokens.safeParse(req.body)
  if (!parsed.success) return void res.status(400).json({ error: 'Invalid request', details: issuesOf(parsed.error) })

  const who = await identify(parsed.data, res)
  if (!who) return

  const wallet = await prisma.wallet.findUnique({
    where: { signerKind_providerUserId: { signerKind: 'PRIVY', providerUserId: who.did } },
    include: { user: true },
  })
  if (wallet) {
    // Privy gave this person one wallet and it must stay that one: a different address under the
    // same login would hand a session for the old account to a wallet it does not hold.
    if (wallet.xrplAddress !== who.address) {
      return void res.status(409).json({ error: 'This login is linked to a different wallet.', code: 'wallet_changed' })
    }
    if (!wallet.publicKey) {
      await prisma.wallet.update({ where: { id: wallet.id }, data: { publicKey: who.publicKey } })
    }
    const expiresAt = await issueSession(req, res, wallet.userId)
    return void res.json({ state: 'authenticated', expiresAt: expiresAt.toISOString(), user: userBody(wallet.user) })
  }

  // A new person. Their address must not already belong to an account (an exported key signing
  // in with Xaman, say): two accounts must never share one wallet.
  const taken = await prisma.wallet.findUnique({ where: { xrplAddress: who.address }, select: { id: true } })
  const takenUser = taken ?? (await prisma.user.findUnique({ where: { xrplAddress: who.address }, select: { id: true } }))
  if (takenUser) {
    return void res.status(409).json({ error: 'That wallet already has an account.', code: 'address_taken' })
  }
  res.json({ state: 'needs_username' })
})

privyAuthRouter.post('/auth/privy/claim', async (req, res) => {
  if (privyMode !== 'live') return void res.status(404).json({ error: 'Not found' })
  const parsed = ClaimBody.safeParse(req.body)
  if (!parsed.success) return void res.status(400).json({ error: 'Invalid request', details: issuesOf(parsed.error) })

  const who = await identify(parsed.data, res)
  if (!who) return
  const { username, displayName } = parsed.data

  // Already claimed (a retry, or a double click): sign them in rather than fail or duplicate.
  const existing = await prisma.wallet.findUnique({
    where: { signerKind_providerUserId: { signerKind: 'PRIVY', providerUserId: who.did } },
    include: { user: true },
  })
  if (existing) {
    const expiresAt = await issueSession(req, res, existing.userId)
    return void res.json({ state: 'authenticated', expiresAt: expiresAt.toISOString(), user: userBody(existing.user) })
  }

  const clash = await prisma.user.findFirst({
    where: { OR: [{ username }, { xrplAddress: who.address }] },
    select: { username: true },
  })
  if (clash) {
    return void res.status(409).json({
      error: clash.username === username ? `@${username} is taken` : 'That wallet already has an account.',
    })
  }

  try {
    // The account and its wallet are one write: a failure never leaves a user with no wallet.
    const user = await prisma.user.create({
      data: {
        username,
        displayName: displayName ?? null,
        xrplAddress: who.address,
        wallet: {
          create: {
            xrplAddress: who.address,
            signerKind: 'PRIVY',
            providerUserId: who.did,
            publicKey: who.publicKey,
          },
        },
      },
    })
    const expiresAt = await issueSession(req, res, user.id)
    res.status(201).json({ state: 'authenticated', expiresAt: expiresAt.toISOString(), user: userBody(user) })
  } catch (err) {
    // Two claims racing for one handle or one wallet: the loser is told, not a 500.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return void res.status(409).json({ error: 'That handle or wallet was just taken. Try again.' })
    }
    throw err
  }
})
