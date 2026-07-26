import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { env, xamanMode } from '../env.js'
import { asStub, xaman, SIGNIN_TTL_MINUTES } from '../xaman.js'
import { issuesOf, usernameSchema, xrplAddressSchema } from '../schemas.js'
import { bearerFrom, createSession, requireAuth, revokeSession } from '../session.js'

export const authRouter = Router()

// Same lifetime we ask Xaman to enforce, so the two clocks cannot disagree.
const SIGNIN_TTL_MS = SIGNIN_TTL_MINUTES * 60 * 1000

const UuidParams = z.object({ uuid: z.string().uuid() })

/**
 * POST /api/auth/signin
 * Creates a Xaman SignIn payload. The client renders `qrPng` and then polls
 * GET /api/auth/signin/:uuid until it resolves.
 */
authRouter.post('/auth/signin', async (_req, res) => {
  const payload = await xaman.createSignInPayload()
  const expiresAt = new Date(Date.now() + SIGNIN_TTL_MS)

  await prisma.signInRequest.create({
    data: { payloadUuid: payload.uuid, expiresAt },
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
  const status = await xaman.getPayload(parsed.data.uuid)
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

  const { token, expiresAt } = await createSession(user.id)
  await prisma.signInRequest.update({
    where: { id: request.id },
    data: { consumedAt: new Date() },
  })

  res.json({
    state: 'authenticated',
    token,
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

  const { token, expiresAt } = await createSession(user.id)
  res.status(201).json({
    state: 'authenticated',
    token,
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

/** POST /api/auth/signout */
authRouter.post('/auth/signout', async (req, res) => {
  const token = bearerFrom(req)
  if (token) await revokeSession(token)
  res.status(204).end()
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
