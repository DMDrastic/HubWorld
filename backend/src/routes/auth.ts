import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { env, xamanMode } from '../env.js'
import { asStub, tryGetPayload, xaman, SIGNIN_TTL_MINUTES } from '../xaman.js'
import { trackPayload } from '../payload-store.js'
import { issuesOf, usernameSchema, xrplAddressSchema } from '../schemas.js'
import {
  clearSessionCookie,
  createSession,
  requireAuth,
  revokeSession,
  setSessionCookie,
  tokenFrom,
} from '../session.js'

export const authRouter = Router()

// Same lifetime we ask Xaman to enforce, so the two clocks cannot disagree.
const SIGNIN_TTL_MS = SIGNIN_TTL_MINUTES * 60 * 1000

/**
 * Issue a session, retiring whatever session this browser is about to forget.
 *
 * Setting the cookie replaces the previous token in the browser, so if that
 * token still names a live session, nobody holds it any more — and a token
 * nobody holds can never be revoked, because revocation needs the token. It
 * stays valid for the full 7 days on any other copy of it.
 *
 * That is also half of the account-switching confusion: signing in as a second
 * account left the first account's session live and unreachable, so "sign out"
 * could only ever end the newest one.
 */
async function issueSession(req: Request, res: Response, userId: string) {
  const previous = tokenFrom(req)
  if (previous) await revokeSession(previous)

  const { token, expiresAt } = await createSession(userId)
  setSessionCookie(res, token, expiresAt)
  return expiresAt
}

const UuidParams = z.object({ uuid: z.string().uuid() })

/**
 * POST /api/auth/signin
 * Creates a Xaman SignIn payload. The client renders `qrPng` and then polls
 * GET /api/auth/signin/:uuid until it resolves.
 */
/** Names the sign-in a client already has open, so clicking twice costs one slot. */
const SIGNIN_COOKIE = 'hubworld_signin'

authRouter.post('/auth/signin', async (req, res) => {
  // Clicking "Sign in" repeatedly used to mint a payload each time, and every
  // unresolved one holds a slot against Xaman's per-application cap until it
  // expires. Six clicks was six slots. If this client already has one open and
  // unsigned, hand back the same one.
  const priorUuid = (req as typeof req & { cookies?: Record<string, string> }).cookies?.[
    SIGNIN_COOKIE
  ]
  if (typeof priorUuid === 'string' && priorUuid.length > 0) {
    const prior = await prisma.signInRequest.findUnique({ where: { payloadUuid: priorUuid } })
    if (prior && prior.status === 'PENDING' && !prior.consumedAt && prior.expiresAt > new Date()) {
      // `status` is OUR record, and it only becomes SIGNED when a poll happens
      // to observe it. Sign in, close the tab before the next poll, and the row
      // still says PENDING — so this used to hand the same payload back, Xaman
      // refused an already-signed payload, and sign-in stayed broken until the
      // TTL expired. Switching between accounts hits it every time.
      //
      // So the reuse is confirmed against Xaman rather than against ourselves.
      // Anything short of positive evidence that it is still unsigned falls
      // through and mints a fresh payload: spending one more slot is a bounded
      // cost, while handing back a dead payload is a sign-in the user cannot
      // complete and cannot diagnose. That includes 'unavailable' (a 429), where
      // by definition we know nothing about it.
      const live = await tryGetPayload(prior.payloadUuid)
      const reusable =
        live !== 'unavailable' && live !== null && !live.signed && !live.cancelled && !live.expired

      if (reusable) {
        res.status(200).json({
          uuid: prior.payloadUuid,
          next: `https://xumm.app/sign/${prior.payloadUuid}`,
          qrPng: `https://xumm.app/sign/${prior.payloadUuid}_q.png`,
          expiresAt: prior.expiresAt.toISOString(),
          mode: xamanMode,
          reused: true,
        })
        return
      }
    }
  }

  const payload = await xaman.createSignInPayload()
  // Registered before it can resolve, so a webhook callback finds it and
  // reconciliation can spot one whose callback never arrived.
  await trackPayload(payload.uuid)
  const expiresAt = new Date(Date.now() + SIGNIN_TTL_MS)

  await prisma.signInRequest.create({
    data: { payloadUuid: payload.uuid, expiresAt },
  })

  // Remembered only so a repeat click can reuse it. Short-lived and harmless:
  // it names a payload, and knowing a payload id grants nothing.
  res.cookie(SIGNIN_COOKIE, payload.uuid, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  })

  res.status(201).json({
    uuid: payload.uuid,
    next: payload.next,
    qrPng: payload.qrPng,
    expiresAt: expiresAt.toISOString(),
    mode: xamanMode,
  })
})

/**
 * GET /api/auth/signin/:uuid
 *
 * Poll target. Returns one of:
 *   pending        — not yet signed
 *   needs_username — signed by an address with no Hubworld account yet
 *   authenticated  — signed, session token issued
 *   rejected / expired
 */
authRouter.get('/auth/signin/:uuid', async (req, res) => {
  const parsed = UuidParams.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid payload id', details: issuesOf(parsed.error) })
    return
  }

  const request = await prisma.signInRequest.findUnique({
    where: { payloadUuid: parsed.data.uuid },
  })
  if (!request) {
    res.status(404).json({ error: 'Unknown sign-in request' })
    return
  }

  // A signature is single-use. Re-polling a consumed request must not mint
  // another session.
  if (request.consumedAt) {
    res.status(410).json({ state: 'consumed', error: 'This sign-in has already been used' })
    return
  }
  if (request.status === 'REJECTED') {
    res.json({ state: 'rejected' })
    return
  }

  // Ask Xaman BEFORE applying our own expiry. Xaman is the authority on whether
  // the payload was signed in time; deciding "expired" from our clock first
  // throws away signatures that actually landed inside the window.
  const status = await tryGetPayload(parsed.data.uuid)
  if (status === 'unavailable') {
    // Rate-limited: we learned nothing, so do not let local expiry fire.
    res.json({ state: 'pending' })
    return
  }
  const locallyExpired = request.status === 'EXPIRED' || request.expiresAt < new Date()

  const markExpired = async () => {
    if (request.status !== 'EXPIRED') {
      await prisma.signInRequest.update({
        where: { id: request.id },
        data: { status: 'EXPIRED' },
      })
    }
  }

  if (!status) {
    if (locallyExpired) {
      await markExpired()
      res.json({ state: 'expired' })
      return
    }
    res.json({ state: 'pending' })
    return
  }

  if (status.cancelled) {
    await prisma.signInRequest.update({
      where: { id: request.id },
      data: { status: 'REJECTED' },
    })
    res.json({ state: 'rejected' })
    return
  }

  if (!status.signed || !status.account) {
    if (status.expired || locallyExpired) {
      await markExpired()
      res.json({ state: 'expired' })
      return
    }
    res.json({ state: 'pending' })
    return
  }

  // Signed. The signing address is the only thing we trust from this flow.
  const address = status.account
  const user = await prisma.user.findUnique({ where: { xrplAddress: address } })

  await prisma.signInRequest.update({
    where: { id: request.id },
    data: {
      status: 'SIGNED',
      resolvedAddress: address,
      resolvedAt: new Date(),
      userId: user?.id ?? null,
    },
  })

  if (!user) {
    // First time this wallet has signed in — it needs an @handle before it
    // becomes an account. The address is proven, so this is safe to hand back.
    res.json({ state: 'needs_username', address })
    return
  }

  await prisma.signInRequest.update({
    where: { id: request.id },
    data: { consumedAt: new Date() },
  })

  // The token goes into an httpOnly cookie and is NOT returned in the body.
  // Handing it to JavaScript is exactly the exposure we are closing.
  const expiresAt = await issueSession(req, res, user.id)

  res.json({
    state: 'authenticated',
    expiresAt: expiresAt.toISOString(),
    user: {
      username: user.username,
      displayName: user.displayName,
      xrplAddress: user.xrplAddress,
    },
  })
})

const ClaimBody = z.object({
  uuid: z.string().uuid(),
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(60).optional(),
})

/**
 * POST /api/auth/claim
 * Binds an @handle to the address that just proved ownership via SignIn.
 */
authRouter.post('/auth/claim', async (req, res) => {
  const parsed = ClaimBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: issuesOf(parsed.error) })
    return
  }

  const { uuid, username, displayName } = parsed.data

  const request = await prisma.signInRequest.findUnique({ where: { payloadUuid: uuid } })

  // Only a freshly signed, unconsumed, unexpired request may mint an account.
  if (
    !request ||
    request.status !== 'SIGNED' ||
    !request.resolvedAddress ||
    request.userId ||
    request.consumedAt ||
    request.expiresAt < new Date()
  ) {
    res.status(400).json({ error: 'Sign-in request is not claimable' })
    return
  }

  const addressOk = xrplAddressSchema.safeParse(request.resolvedAddress)
  if (!addressOk.success) {
    res.status(500).json({ error: 'Stored address failed validation' })
    return
  }

  const existing = await prisma.user.findFirst({
    where: { OR: [{ username }, { xrplAddress: addressOk.data }] },
  })
  if (existing) {
    res.status(409).json({
      error:
        existing.username === username
          ? `@${username} is taken`
          : 'That address already has an account',
    })
    return
  }

  const user = await prisma.user.create({
    data: { username, displayName: displayName ?? null, xrplAddress: addressOk.data },
  })

  await prisma.signInRequest.update({
    where: { id: request.id },
    data: { userId: user.id, consumedAt: new Date() },
  })

  const expiresAt = await issueSession(req, res, user.id)

  res.status(201).json({
    state: 'authenticated',
    expiresAt: expiresAt.toISOString(),
    user: {
      username: user.username,
      displayName: user.displayName,
      xrplAddress: user.xrplAddress,
    },
  })
})

/** GET /api/auth/me — who the bearer token belongs to. */
authRouter.get('/auth/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: {
      username: true,
      displayName: true,
      xrplAddress: true,
      createdAt: true,
      role: true,
      _count: { select: { ticketsOwned: true } },
    },
  })

  if (!user) {
    res.status(404).json({ error: 'User no longer exists' })
    return
  }

  const { _count, ...rest } = user
  res.json({ ...rest, ticketsOwned: _count.ticketsOwned })
})

/**
 * POST /api/auth/signout
 *
 * Reports whether a live session was actually ended. Idempotent either way, but
 * the client must be able to tell the difference: signing out and revoking
 * nothing means the browser was carrying a session this account never held, and
 * a UI that renders that as success is exactly how "sign out did nothing" goes
 * unnoticed.
 */
authRouter.post('/auth/signout', async (req, res) => {
  const token = tokenFrom(req)
  const revoked = token ? await revokeSession(token) : false
  clearSessionCookie(res)
  res.status(200).json({ revoked })
})

// ------------------------------------------------------------- dev only ----

const SimulateBody = z.object({
  uuid: z.string().uuid(),
  account: xrplAddressSchema.optional(),
  outcome: z.enum(['sign', 'reject']).default('sign'),
})

/**
 * POST /api/auth/signin/simulate
 *
 * Stands in for a human signing in the Xaman app. Exists ONLY when running in
 * stub mode outside production — double-guarded because an endpoint that mints
 * arbitrary sessions is a total authentication bypass if it ever ships.
 */
authRouter.post('/auth/signin/simulate', async (req, res) => {
  const stub = asStub(xaman)
  if (!stub || env.NODE_ENV === 'production') {
    res.status(404).json({ error: 'Not found' })
    return
  }

  const parsed = SimulateBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: issuesOf(parsed.error) })
    return
  }

  const account = parsed.data.account ?? 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w'
  const ok = stub.simulate(parsed.data.uuid, account, parsed.data.outcome)
  if (!ok) {
    res.status(404).json({ error: 'Unknown payload' })
    return
  }

  res.json({ simulated: parsed.data.outcome, account })
})
