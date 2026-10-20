/**
 * Door entry by a displayed code: the attendee shows a short-lived QR, staff scan it.
 *
 *   POST /api/tickets/:nfTokenId/door-token   → the holder asks for a code to show
 *   POST /api/events/:slug/checkin/scan       → door staff submit what they scanned
 *   POST /api/events/:slug/door-mode          → the organizer picks how the door works
 *
 * The other door mode, where staff show a code and the attendee signs it in
 * Xaman, lives in `redemption.ts`. An event is in exactly one of the two; asking
 * the wrong one is a 409 that says which.
 *
 * Everything after "who is this" is shared with that mode (`door-admit.ts`), so
 * the ledger re-check, the already-used verdict and the one-winner admission are
 * the same whichever way someone arrived. What differs is only how the person
 * was established, and this mode is weaker there on purpose: it proves a
 * logged-in session, not a key at the door. See `door-token.ts`.
 */
import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { NETWORK } from '../network.js'
import { env, doorTokenMode } from '../env.js'
import { issuesOf, slugSchema } from '../schemas.js'
import { requireAuth } from '../session.js'
import { checkDoorAccess } from '../door-access.js'
import { holdsNft } from '../ledger.js'
import { admit, type AdmitBody } from '../door-admit.js'
import { DOOR_TOKEN_TTL_MS, signDoorToken, verifyDoorToken } from '../door-token.js'

export const doorQrRouter = Router()

/** The page asks for a fresh code this long after it got one, inside the 45s a code lives. */
const REFRESH_SECONDS = 30

const NfParams = z.object({
  nfTokenId: z
    .string()
    .regex(/^[0-9A-Fa-f]{64}$/)
    .transform((s) => s.toUpperCase()),
})
const SlugParams = z.object({ slug: slugSchema })
const ScanBody = z.object({ token: z.string().min(1).max(600) })
const ModeBody = z.object({ mode: z.enum(['QR', 'SIGNATURE']) })

const off = (res: import('express').Response) =>
  res.status(503).json({ error: 'Door codes are not available on this server', code: 'DOOR_CODES_OFF' })

const WRONG_MODE_SIGNATURE = {
  error: 'This event checks people in with a Xaman signature, not a code',
  code: 'DOOR_MODE_SIGNATURE',
}

/**
 * POST /api/tickets/:nfTokenId/door-token — holder-only.
 */
doorQrRouter.post('/tickets/:nfTokenId/door-token', requireAuth, async (req, res) => {
  if (doorTokenMode !== 'live') return void off(res)
  const params = NfParams.safeParse(req.params)
  if (!params.success) {
    res.status(400).json({ error: 'Invalid ticket id', details: issuesOf(params.error) })
    return
  }
  const { nfTokenId } = params.data

  const ticket = await prisma.ticket.findUnique({
    where: { network_nfTokenId: { network: NETWORK, nfTokenId } },
    include: { event: true },
  })
  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found' })
    return
  }
  const me = await prisma.user.findUnique({ where: { id: req.userId! } })
  if (!me) {
    res.status(404).json({ error: 'User no longer exists' })
    return
  }
  // Our ownership column is a cache; the ledger is the authority. A holder who
  // gifted or sold the ticket in Xaman must not be handed a working code.
  if (ticket.ownerAddress !== me.xrplAddress) {
    res.status(403).json({ error: 'This is not your ticket' })
    return
  }
  try {
    if (!(await holdsNft(me.xrplAddress, nfTokenId))) {
      await prisma.ticket.update({ where: { id: ticket.id }, data: { ownerId: null, ownerAddress: null, syncedAt: new Date() } })
      res.status(403).json({ error: 'The ledger says you do not hold this ticket' })
      return
    }
  } catch {
    // An unreachable ledger is not a refusal; the door re-checks anyway.
  }

  if (ticket.status === 'REDEEMED') {
    res.status(409).json({ error: 'This ticket has already been used' })
    return
  }
  if (ticket.status === 'BURNED') {
    res.status(409).json({ error: 'This ticket is no longer valid' })
    return
  }
  if (ticket.event.status === 'CANCELLED') {
    res.status(409).json({ error: 'This event is cancelled' })
    return
  }
  if (ticket.event.doorMode !== 'QR') {
    res.status(409).json(WRONG_MODE_SIGNATURE)
    return
  }

  const { token, expiresAt } = signDoorToken(
    { t: nfTokenId, e: ticket.eventId, u: me.id },
    { secret: env.DOOR_TOKEN_SECRET! },
  )
  // `expiresInSeconds` as well as the absolute time: a phone's clock can be minutes
  // out, and the page must stop showing a dead code by ITS OWN clock, not ours.
  res.json({
    token,
    expiresAt: expiresAt.toISOString(),
    expiresInSeconds: DOOR_TOKEN_TTL_MS / 1000,
    refreshInSeconds: REFRESH_SECONDS,
  })
})

/**
 * POST /api/events/:slug/checkin/scan — door staff.
 *
 * Always answers 200 with a verdict once the request itself is valid, in the
 * same shape as `GET /checkin/:uuid`, so the door screen shows a bad code the
 * way it shows any other refusal. Every scan leaves an audit row, junk included:
 * a door dispute is exactly when "what did staff scan at 9:42" matters.
 */
doorQrRouter.post('/events/:slug/checkin/scan', requireAuth, async (req, res) => {
  if (doorTokenMode !== 'live') return void off(res)
  const params = SlugParams.safeParse(req.params)
  const body = ScanBody.safeParse(req.body ?? {})
  if (!params.success || !body.success) {
    res.status(400).json({ error: 'Invalid request' })
    return
  }

  const event = await prisma.event.findUnique({ where: { slug: params.data.slug } })
  if (!event) {
    res.status(404).json({ error: 'Event not found' })
    return
  }
  const access = await checkDoorAccess({
    eventId: event.id,
    organizerId: event.organizerId,
    userId: req.userId!,
    role: req.userRole,
  })
  if (!access.allowed) {
    res.status(403).json({ error: access.reason })
    return
  }
  if (event.status === 'CANCELLED') {
    res.status(409).json({ error: 'This event is cancelled' })
    return
  }
  if (event.doorMode !== 'QR') {
    res.status(409).json(WRONG_MODE_SIGNATURE)
    return
  }

  const redemption = await prisma.redemption.create({
    data: {
      payloadUuid: randomUUID(),
      method: 'QR',
      network: NETWORK,
      eventId: event.id,
      staffId: req.userId!,
      expiresAt: new Date(),
    },
  })
  const verdict = async (
    status: 'REJECTED' | 'EXPIRED' | 'NO_TICKET',
    state: 'rejected' | 'expired' | 'no_ticket',
    reason: string,
  ): Promise<AdmitBody | { checkInId: string; state: string; holder: null; ticket: null; reason: string }> => {
    await prisma.redemption.update({ where: { id: redemption.id }, data: { status, failureReason: reason } })
    return { checkInId: redemption.id, state, holder: null, ticket: null, reason }
  }

  const check = verifyDoorToken(body.data.token, { secret: env.DOOR_TOKEN_SECRET! })
  if (!check.ok) {
    res.json(
      check.reason === 'expired'
        ? await verdict('EXPIRED', 'expired', 'That code has expired. Ask them to hold their phone up again.')
        : await verdict('REJECTED', 'rejected', 'That is not a HubWorld ticket code'),
    )
    return
  }
  const { claims } = check

  // A code made for another event is a ticket this door does not honour.
  if (claims.e !== event.id) {
    res.json(await verdict('NO_TICKET', 'no_ticket', 'That ticket is for a different event'))
    return
  }
  const holder = await prisma.user.findUnique({ where: { id: claims.u } })
  if (!holder) {
    res.json(await verdict('REJECTED', 'rejected', 'That is not a HubWorld ticket code'))
    return
  }

  // From here it is the same decision as a signature: the ledger is re-read, a
  // used ticket is "already checked in", and exactly one caller wins the ticket.
  // Pinned to the ONE ticket the code names, so someone holding two is not
  // charged a second by a code for the first.
  res.json(
    await admit({
      redemptionId: redemption.id,
      eventId: event.id,
      address: holder.xrplAddress,
      onlyNfTokenId: claims.t,
    }),
  )
})

/**
 * POST /api/events/:slug/door-mode — the event's organizer.
 *
 * Switchable after creation because nothing about a ticket depends on it. Not
 * switchable into a mode this server cannot run.
 */
doorQrRouter.post('/events/:slug/door-mode', requireAuth, async (req, res) => {
  const params = SlugParams.safeParse(req.params)
  const body = ModeBody.safeParse(req.body ?? {})
  if (!params.success || !body.success) {
    res.status(400).json({ error: 'Invalid request' })
    return
  }
  const event = await prisma.event.findUnique({ where: { slug: params.data.slug } })
  if (!event) {
    res.status(404).json({ error: 'Event not found' })
    return
  }
  if (event.organizerId !== req.userId && req.userRole !== 'ADMIN') {
    res.status(403).json({ error: 'Only the event organizer can change how the door works' })
    return
  }
  if (body.data.mode === 'QR' && doorTokenMode !== 'live') return void off(res)

  const updated = await prisma.event.update({ where: { id: event.id }, data: { doorMode: body.data.mode } })
  res.json({ slug: updated.slug, doorMode: updated.doorMode })
})
