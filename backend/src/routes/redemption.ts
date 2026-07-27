/**
 * Check-in at the door.
 *
 * The flow that turns an NFT into admission:
 *
 *   1. staff   POST /events/:slug/checkin  → a Xaman SignIn payload, shown at the door
 *   2. holder  signs it in Xaman
 *   3. staff   GET  /checkin/:uuid         → verdict, ON THE DOOR DEVICE
 *
 * Three decisions worth keeping:
 *
 * **A signature, not a display.** A QR on an attendee's phone can be
 * screenshotted and sent to a friend; a Xaman signature cannot, because it needs
 * their key at that moment. This is the same primitive that proves wallet
 * ownership at sign-in.
 *
 * **The verdict appears on the staff device.** If the attendee's screen showed
 * "admitted", a screenshot of a green tick would be a ticket.
 *
 * **Signing is not enough on its own.** It proves who they are, not what they
 * hold, so the ledger is re-read to confirm that address still holds a ticket for
 * this event. They may have sold or gifted it since.
 */
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { xamanMode } from '../env.js'
import { tryGetPayload, xaman, SIGNIN_TTL_MINUTES } from '../xaman.js'
import { issuesOf, slugSchema } from '../schemas.js'
import { requireAuth, requireOrganizer } from '../session.js'
import { holdsNft } from '../ledger.js'

export const redemptionRouter = Router()

/** Short: a door queue moves, and a stale payload is a confused attendee. */
const CHECKIN_TTL_MINUTES = Math.min(SIGNIN_TTL_MINUTES, 10)
const CHECKIN_TTL_MS = CHECKIN_TTL_MINUTES * 60 * 1000

const SlugParams = z.object({ slug: slugSchema })
const UuidParams = z.object({ uuid: z.string().uuid() })

/**
 * POST /api/events/:slug/checkin
 * Organizer-only. Creates the payload the attendee signs.
 */
redemptionRouter.post('/events/:slug/checkin', requireAuth, requireOrganizer, async (req, res) => {
  const parsed = SlugParams.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid event slug', details: issuesOf(parsed.error) })
    return
  }

  const event = await prisma.event.findUnique({ where: { slug: parsed.data.slug } })
  if (!event) {
    res.status(404).json({ error: 'Event not found' })
    return
  }
  // Only the organizer runs their own door. Anyone else could otherwise burn
  // through attendees' tickets.
  if (event.organizerId !== req.userId) {
    res.status(403).json({ error: 'Only the event organizer can check people in' })
    return
  }
  if (event.status === 'CANCELLED') {
    res.status(409).json({ error: 'This event is cancelled' })
    return
  }

  // No force_network: SignIn is a pseudo-transaction, never submitted, so it
  // costs nothing and works for a holder whose wallet is unfunded.
  const payload = await xaman.createSignInPayload()
  const expiresAt = new Date(Date.now() + CHECKIN_TTL_MS)

  const redemption = await prisma.redemption.create({
    data: {
      payloadUuid: payload.uuid,
      eventId: event.id,
      staffId: req.userId!,
      expiresAt,
    },
  })

  res.status(201).json({
    checkInId: redemption.id,
    uuid: payload.uuid,
    next: payload.next,
    qrPng: payload.qrPng,
    expiresAt: expiresAt.toISOString(),
    mode: xamanMode,
    event: { slug: event.slug, title: event.title },
  })
})

/**
 * GET /api/checkin/:uuid
 * Organizer-only. The verdict, deliberately on the staff device.
 */
redemptionRouter.get('/checkin/:uuid', requireAuth, async (req, res) => {
  const parsed = UuidParams.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid check-in id', details: issuesOf(parsed.error) })
    return
  }

  const redemption = await prisma.redemption.findUnique({
    where: { payloadUuid: parsed.data.uuid },
    include: {
      event: true,
      holder: { select: { username: true } },
      ticket: { select: { seat: true, tier: true, nfTokenId: true } },
    },
  })
  if (!redemption) {
    res.status(404).json({ error: 'Unknown check-in' })
    return
  }
  if (redemption.staffId !== req.userId) {
    res.status(403).json({ error: 'Not your check-in' })
    return
  }

  const view = (extra: Record<string, unknown> = {}) => ({
    checkInId: redemption.id,
    state: redemption.status.toLowerCase(),
    holder: redemption.holder ? `@${redemption.holder.username}` : null,
    ticket: redemption.ticket
      ? {
          seat: redemption.ticket.seat,
          tier: redemption.ticket.tier,
          nfTokenId: redemption.ticket.nfTokenId,
        }
      : null,
    ...(redemption.failureReason ? { reason: redemption.failureReason } : {}),
    ...extra,
  })

  // Terminal — a verdict is final, and re-polling must never re-admit anyone.
  if (redemption.status !== 'PENDING') {
    res.json(view())
    return
  }

  const status = await tryGetPayload(redemption.payloadUuid)
  if (status === 'unavailable') {
    res.json(view())
    return
  }
  if (status?.cancelled) {
    await prisma.redemption.update({
      where: { id: redemption.id },
      data: { status: 'REJECTED' },
    })
    res.json({ ...view(), state: 'rejected' })
    return
  }
  if (!status?.signed || !status.account) {
    if (redemption.expiresAt < new Date() || status?.expired) {
      await prisma.redemption.update({ where: { id: redemption.id }, data: { status: 'EXPIRED' } })
      res.json({ ...view(), state: 'expired' })
      return
    }
    res.json(view())
    return
  }

  // Signed. The address is proven; what they hold is not.
  const address = status.account

  const candidates = await prisma.ticket.findMany({
    where: { eventId: redemption.eventId, ownerAddress: address },
    orderBy: { createdAt: 'asc' },
    include: { owner: { select: { id: true, username: true } } },
  })

  const holder = await prisma.user.findUnique({ where: { xrplAddress: address } })

  // Already-used tickets are reported distinctly from having none: "this ticket
  // was already scanned" and "you have no ticket" are different conversations at
  // a door.
  const unredeemed = candidates.filter((t) => t.status !== 'REDEEMED')
  if (candidates.length > 0 && unredeemed.length === 0) {
    await prisma.redemption.update({
      where: { id: redemption.id },
      data: {
        status: 'ALREADY_USED',
        resolvedAddress: address,
        holderId: holder?.id ?? null,
        ticketId: candidates[0]!.id,
        failureReason: 'That ticket has already been checked in',
      },
    })
    res.json({
      ...view(),
      state: 'already_used',
      holder: holder ? `@${holder.username}` : null,
      reason: 'That ticket has already been checked in',
    })
    return
  }

  // Our ownership column is a cache, so confirm against the ledger before
  // admitting anyone. A stale row would let someone in on a ticket they sold.
  let ticket = null
  for (const candidate of unredeemed) {
    try {
      if (await holdsNft(address, candidate.nfTokenId)) {
        ticket = candidate
        break
      }
      // Cache disagreed with the ledger — record that we noticed.
      await prisma.ticket.update({
        where: { id: candidate.id },
        data: { ownerId: null, ownerAddress: null, syncedAt: new Date() },
      })
    } catch {
      // Ledger unreachable. Refusing entry on a network blip is worse than the
      // alternative here, so fall back to the cached claim and let the audit
      // trail carry it.
      ticket = candidate
      break
    }
  }

  if (!ticket) {
    await prisma.redemption.update({
      where: { id: redemption.id },
      data: {
        status: 'NO_TICKET',
        resolvedAddress: address,
        holderId: holder?.id ?? null,
        failureReason: 'No valid ticket for this event',
      },
    })
    res.json({
      ...view(),
      state: 'no_ticket',
      holder: holder ? `@${holder.username}` : null,
      reason: 'No valid ticket for this event',
    })
    return
  }

  // Admit. The ticket and the record change together, so a ticket can never be
  // marked used without an audit row naming who admitted them.
  const [, updated] = await prisma.$transaction([
    prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'REDEEMED' } }),
    prisma.redemption.update({
      where: { id: redemption.id },
      data: {
        status: 'REDEEMED',
        resolvedAddress: address,
        holderId: holder?.id ?? null,
        ticketId: ticket.id,
        redeemedAt: new Date(),
      },
      include: {
        holder: { select: { username: true } },
        ticket: { select: { seat: true, tier: true, nfTokenId: true } },
      },
    }),
  ])

  res.json({
    checkInId: updated.id,
    state: 'redeemed',
    holder: updated.holder ? `@${updated.holder.username}` : null,
    ticket: {
      seat: updated.ticket?.seat ?? null,
      tier: updated.ticket?.tier ?? null,
      nfTokenId: updated.ticket?.nfTokenId ?? '',
    },
    redeemedAt: updated.redeemedAt?.toISOString(),
  })
})

/**
 * GET /api/events/:slug/door — how the door is going.
 */
redemptionRouter.get('/events/:slug/door', requireAuth, requireOrganizer, async (req, res) => {
  const parsed = SlugParams.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid event slug', details: issuesOf(parsed.error) })
    return
  }

  const event = await prisma.event.findUnique({
    where: { slug: parsed.data.slug },
    include: { _count: { select: { tickets: true } } },
  })
  if (!event) {
    res.status(404).json({ error: 'Event not found' })
    return
  }
  if (event.organizerId !== req.userId) {
    res.status(403).json({ error: 'Only the event organizer can see the door' })
    return
  }

  const [admitted, recent] = await Promise.all([
    prisma.ticket.count({ where: { eventId: event.id, status: 'REDEEMED' } }),
    prisma.redemption.findMany({
      where: { eventId: event.id, status: 'REDEEMED' },
      orderBy: { redeemedAt: 'desc' },
      take: 20,
      include: {
        holder: { select: { username: true } },
        ticket: { select: { seat: true, tier: true } },
      },
    }),
  ])

  res.json({
    event: { slug: event.slug, title: event.title },
    admitted,
    issued: event._count.tickets,
    recent: recent.map((r) => ({
      holder: r.holder ? `@${r.holder.username}` : null,
      seat: r.ticket?.seat ?? null,
      tier: r.ticket?.tier ?? null,
      redeemedAt: r.redeemedAt?.toISOString() ?? null,
    })),
  })
})
