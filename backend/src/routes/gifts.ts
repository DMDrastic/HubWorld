/**
 * Gifting — free peer-to-peer ticket transfer.
 *
 * XRPL has no "transfer" transaction, so a gift takes TWO signatures on two
 * different devices:
 *
 *   1. sender    NFTokenCreateOffer  amount 0, Destination = recipient
 *   2. recipient NFTokenAcceptOffer  on that offer index
 *
 * Ownership does not move until the second one validates. Between the two the
 * offer sits on-ledger, claimable by nobody except the named destination.
 *
 * Ownership is re-read from the ledger before a gift starts. Ticket.ownerAddress
 * is a cache and the holder may have moved the ticket in Xaman without ever
 * touching Hubworld.
 */
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { xamanMode } from '../env.js'
import { xaman, SIGNIN_TTL_MINUTES } from '../xaman.js'
import { issuesOf, usernameSchema } from '../schemas.js'
import { requireAuth } from '../session.js'
import {
  buildAcceptOfferTx,
  buildCancelOfferTx,
  buildGiftOfferTx,
  holdsNft,
  offerIndexFromTx,
  txSucceeded,
  XAMAN_NETWORK,
} from '../ledger.js'

export const giftsRouter = Router()

// Longer than sign-in: the recipient may not be at their phone, and the offer
// sits safely on-ledger meanwhile.
const GIFT_TTL_MINUTES = 60
const GIFT_TTL_MS = GIFT_TTL_MINUTES * 60 * 1000

const IdParams = z.object({ id: z.string().uuid() })
const NfTokenIdParams = z.object({
  nfTokenId: z.string().regex(/^[0-9A-Fa-f]{64}$/, 'not a valid NFTokenID'),
})
const GiftBody = z.object({ to: usernameSchema })

/** Live states — a ticket may only have one gift in flight at a time. */
const IN_FLIGHT = ['PENDING_OFFER', 'OFFERED', 'ACCEPTING', 'CANCELLING'] as const

/**
 * POST /api/tickets/:nfTokenId/gift
 * Owner-only. Returns a Xaman payload for the SENDER to sign.
 */
giftsRouter.post('/tickets/:nfTokenId/gift', requireAuth, async (req, res) => {
  const params = NfTokenIdParams.safeParse(req.params)
  if (!params.success) {
    res.status(400).json({ error: 'Invalid ticket id', details: issuesOf(params.error) })
    return
  }
  const body = GiftBody.safeParse(req.body ?? {})
  if (!body.success) {
    res.status(400).json({ error: 'Invalid request', details: issuesOf(body.error) })
    return
  }

  const nfTokenId = params.data.nfTokenId.toUpperCase()

  const [ticket, me, recipient] = await Promise.all([
    prisma.ticket.findUnique({ where: { nfTokenId } }),
    prisma.user.findUnique({ where: { id: req.userId! } }),
    prisma.user.findUnique({ where: { username: body.data.to } }),
  ])

  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found' })
    return
  }
  if (!me) {
    res.status(404).json({ error: 'User no longer exists' })
    return
  }
  if (!recipient) {
    res.status(404).json({ error: `No Hubworld account for @${body.data.to}` })
    return
  }
  if (recipient.id === me.id) {
    res.status(400).json({ error: 'You already own this ticket' })
    return
  }

  // The ledger decides who owns this, not our cache.
  const owns = await holdsNft(me.xrplAddress, nfTokenId)
  if (!owns) {
    // Our cache disagreed with the ledger — record that we noticed.
    if (ticket.ownerId === me.id) {
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { ownerId: null, ownerAddress: null, syncedAt: new Date() },
      })
    }
    res.status(403).json({ error: 'The ledger says you do not hold this ticket' })
    return
  }

  if (ticket.status === 'LISTED' || ticket.status === 'IN_AUCTION') {
    res.status(409).json({ error: `Cannot gift a ticket that is ${ticket.status.toLowerCase()}` })
    return
  }

  const existing = await prisma.gift.findFirst({
    where: { ticketId: ticket.id, status: { in: [...IN_FLIGHT] }, expiresAt: { gt: new Date() } },
  })
  if (existing) {
    res.status(409).json({ error: 'This ticket already has a gift in flight' })
    return
  }

  let txjson
  try {
    txjson = buildGiftOfferTx({
      ownerAddress: me.xrplAddress,
      nfTokenId,
      destinationAddress: recipient.xrplAddress,
    })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not build gift' })
    return
  }

  const payload = await xaman.createPayload(txjson as unknown as Record<string, unknown>, {
    expireMinutes: GIFT_TTL_MINUTES,
    forceNetwork: XAMAN_NETWORK,
  })

  const expiresAt = new Date(Date.now() + GIFT_TTL_MS)
  const gift = await prisma.gift.create({
    data: {
      ticketId: ticket.id,
      fromId: me.id,
      toId: recipient.id,
      // Snapshot the addresses — re-resolving the handle later could retarget
      // a gift that is already in flight.
      fromAddress: me.xrplAddress,
      toAddress: recipient.xrplAddress,
      offerPayloadUuid: payload.uuid,
      expiresAt,
    },
  })

  res.status(201).json({
    giftId: gift.id,
    uuid: payload.uuid,
    next: payload.next,
    qrPng: payload.qrPng,
    expiresAt: expiresAt.toISOString(),
    mode: xamanMode,
    to: { username: recipient.username, xrplAddress: recipient.xrplAddress },
  })
})

/**
 * POST /api/gifts/:id/accept
 * Recipient-only. Returns a Xaman payload for the RECIPIENT to sign.
 */
giftsRouter.post('/gifts/:id/accept', requireAuth, async (req, res) => {
  const parsed = IdParams.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid gift id', details: issuesOf(parsed.error) })
    return
  }

  const gift = await prisma.gift.findUnique({ where: { id: parsed.data.id } })
  if (!gift) {
    res.status(404).json({ error: 'Gift not found' })
    return
  }
  if (gift.toId !== req.userId) {
    res.status(403).json({ error: 'This gift is not addressed to you' })
    return
  }
  if (gift.status !== 'OFFERED' || !gift.offerIndex) {
    res.status(409).json({ error: `Gift is ${gift.status.toLowerCase()}, not awaiting acceptance` })
    return
  }
  if (gift.expiresAt < new Date()) {
    res.status(409).json({ error: 'This gift has expired' })
    return
  }

  const payload = await xaman.createPayload(
    buildAcceptOfferTx({
      accepterAddress: gift.toAddress,
      offerIndex: gift.offerIndex,
    }) as unknown as Record<string, unknown>,
    { expireMinutes: GIFT_TTL_MINUTES, forceNetwork: XAMAN_NETWORK },
  )

  await prisma.gift.update({
    where: { id: gift.id },
    data: { acceptPayloadUuid: payload.uuid },
  })

  res.status(201).json({
    giftId: gift.id,
    uuid: payload.uuid,
    next: payload.next,
    qrPng: payload.qrPng,
    mode: xamanMode,
  })
})

/**
 * POST /api/gifts/:id/cancel
 * Sender-only withdrawal.
 *
 * Two cases, and they are genuinely different:
 *   - not yet signed  → no ledger object exists, so this is a local flip
 *   - already offered → an NFTokenOffer is live on-ledger and can only be
 *                       removed by a signed NFTokenCancelOffer
 *
 * Once the recipient has signed their acceptance it is too late; the ledger
 * decides that race, not us.
 */
giftsRouter.post('/gifts/:id/cancel', requireAuth, async (req, res) => {
  const parsed = IdParams.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid gift id', details: issuesOf(parsed.error) })
    return
  }

  const gift = await prisma.gift.findUnique({ where: { id: parsed.data.id } })
  if (!gift) {
    res.status(404).json({ error: 'Gift not found' })
    return
  }
  if (gift.fromId !== req.userId) {
    res.status(403).json({ error: 'Only the sender can withdraw a gift' })
    return
  }

  // Nothing on-ledger yet — withdrawing is just abandoning the payload.
  if (gift.status === 'PENDING_OFFER') {
    await prisma.gift.update({
      where: { id: gift.id },
      data: { status: 'CANCELLED', resolvedAt: new Date() },
    })
    res.json({ state: 'cancelled', giftId: gift.id })
    return
  }

  if (gift.status !== 'OFFERED' || !gift.offerIndex) {
    res.status(409).json({ error: `Gift is ${gift.status.toLowerCase()} and cannot be withdrawn` })
    return
  }

  const payload = await xaman.createPayload(
    buildCancelOfferTx({
      ownerAddress: gift.fromAddress,
      offerIndex: gift.offerIndex,
    }) as unknown as Record<string, unknown>,
    { expireMinutes: GIFT_TTL_MINUTES, forceNetwork: XAMAN_NETWORK },
  )

  await prisma.gift.update({
    where: { id: gift.id },
    data: { cancelPayloadUuid: payload.uuid },
  })

  res.status(201).json({
    giftId: gift.id,
    uuid: payload.uuid,
    next: payload.next,
    qrPng: payload.qrPng,
    mode: xamanMode,
  })
})

/**
 * GET /api/gifts/:id
 *
 * Poll target for both halves. Either party may poll; the state machine
 * advances whichever phase is outstanding.
 */
giftsRouter.get('/gifts/:id', requireAuth, async (req, res) => {
  const parsed = IdParams.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid gift id', details: issuesOf(parsed.error) })
    return
  }

  const gift = await prisma.gift.findUnique({
    where: { id: parsed.data.id },
    include: {
      ticket: { include: { event: { select: { slug: true, title: true } } } },
      from: { select: { username: true } },
      to: { select: { username: true } },
    },
  })
  if (!gift) {
    res.status(404).json({ error: 'Gift not found' })
    return
  }
  if (gift.fromId !== req.userId && gift.toId !== req.userId) {
    res.status(403).json({ error: 'Not your gift' })
    return
  }

  const view = (extra: Record<string, unknown> = {}) => ({
    state: gift.status.toLowerCase(),
    giftId: gift.id,
    role: gift.fromId === req.userId ? 'sender' : 'recipient',
    from: `@${gift.from.username}`,
    to: `@${gift.to.username}`,
    ticket: {
      nfTokenId: gift.ticket.nfTokenId,
      seat: gift.ticket.seat,
      tier: gift.ticket.tier,
      event: gift.ticket.event,
    },
    ...extra,
  })

  // Terminal states need no further ledger or Xaman work.
  if (['ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED'].includes(gift.status)) {
    res.json(view())
    return
  }
  if (gift.status === 'FAILED') {
    res.json(view({ reason: gift.failureReason ?? 'The ledger rejected the transaction' }))
    return
  }

  const expired = gift.expiresAt < new Date()

  // ---- phase 1: waiting on the sender's offer -----------------------------
  if (gift.status === 'PENDING_OFFER') {
    const status = await xaman.getPayload(gift.offerPayloadUuid)

    if (status?.cancelled) {
      await prisma.gift.update({ where: { id: gift.id }, data: { status: 'CANCELLED' } })
      res.json({ ...view(), state: 'cancelled' })
      return
    }
    if (!status?.signed) {
      if (expired || status?.expired) {
        await prisma.gift.update({ where: { id: gift.id }, data: { status: 'EXPIRED' } })
        res.json({ ...view(), state: 'expired' })
        return
      }
      res.json(view())
      return
    }
    if (!status.txid) {
      res.json(view({ signed: true }))
      return
    }

    // Signed and submitted — read the offer index the ledger assigned.
    const ok = await txSucceeded(status.txid)
    if (ok === null) {
      res.json(view({ signed: true }))
      return
    }
    if (!ok) {
      await prisma.gift.update({
        where: { id: gift.id },
        data: {
          status: 'FAILED',
          offerTxHash: status.txid,
          failureReason: 'The ledger rejected the gift offer',
        },
      })
      res.json({ ...view(), state: 'failed', reason: 'The ledger rejected the gift offer' })
      return
    }

    const offerIndex = await offerIndexFromTx(status.txid)
    if (!offerIndex) {
      res.json(view({ signed: true }))
      return
    }

    await prisma.gift.update({
      where: { id: gift.id },
      data: {
        status: 'OFFERED',
        offerTxHash: status.txid,
        offerIndex,
        offeredAt: new Date(),
      },
    })
    res.json({ ...view(), state: 'offered' })
    return
  }

  // ---- withdrawal --------------------------------------------------------
  // Only when the recipient has not started their half. If both have signed,
  // fall through to the acceptance path and let the ledger settle the race —
  // whichever transaction validates first wins, and we report what happened.
  if (gift.cancelPayloadUuid && !gift.acceptPayloadUuid) {
    const cancel = await xaman.getPayload(gift.cancelPayloadUuid)

    if (cancel?.signed && cancel.txid) {
      const ok = await txSucceeded(cancel.txid)
      if (ok === null) {
        await prisma.gift.update({
          where: { id: gift.id },
          data: { status: 'CANCELLING', cancelTxHash: cancel.txid },
        })
        res.json({ ...view(), state: 'cancelling' })
        return
      }
      if (ok) {
        await prisma.gift.update({
          where: { id: gift.id },
          data: { status: 'CANCELLED', cancelTxHash: cancel.txid, resolvedAt: new Date() },
        })
        res.json({ ...view(), state: 'cancelled' })
        return
      }
      // The cancel itself failed — most likely the offer was already taken.
      await prisma.gift.update({
        where: { id: gift.id },
        data: { cancelTxHash: cancel.txid, failureReason: 'The withdrawal was rejected' },
      })
    }
    // Not signed yet: the offer is still live, so fall through and keep
    // reporting `offered`.
  }

  // ---- phase 2: waiting on the recipient ---------------------------------
  if (gift.status === 'OFFERED') {
    if (expired) {
      await prisma.gift.update({ where: { id: gift.id }, data: { status: 'EXPIRED' } })
      res.json({ ...view(), state: 'expired' })
      return
    }
    // No accept payload yet — the recipient has not started their half.
    if (!gift.acceptPayloadUuid) {
      res.json(view({ awaitingRecipient: true }))
      return
    }
  }

  if (!gift.acceptPayloadUuid) {
    res.json(view())
    return
  }

  const status = await xaman.getPayload(gift.acceptPayloadUuid)

  if (status?.cancelled) {
    await prisma.gift.update({ where: { id: gift.id }, data: { status: 'DECLINED' } })
    res.json({ ...view(), state: 'declined' })
    return
  }
  if (!status?.signed) {
    if (expired || status?.expired) {
      await prisma.gift.update({ where: { id: gift.id }, data: { status: 'EXPIRED' } })
      res.json({ ...view(), state: 'expired' })
      return
    }
    res.json(view({ awaitingRecipient: true }))
    return
  }
  if (!status.txid) {
    await prisma.gift.update({ where: { id: gift.id }, data: { status: 'ACCEPTING' } })
    res.json({ ...view(), state: 'accepting' })
    return
  }

  const ok = await txSucceeded(status.txid)
  if (ok === null) {
    await prisma.gift.update({
      where: { id: gift.id },
      data: { status: 'ACCEPTING', acceptTxHash: status.txid },
    })
    res.json({ ...view(), state: 'accepting' })
    return
  }
  if (!ok) {
    await prisma.gift.update({
      where: { id: gift.id },
      data: {
        status: 'FAILED',
        acceptTxHash: status.txid,
        failureReason: 'The ledger rejected the acceptance',
      },
    })
    res.json({ ...view(), state: 'failed', reason: 'The ledger rejected the acceptance' })
    return
  }

  // Ownership has moved. Update the cache and append provenance in one
  // transaction, keyed on the unique txHash so a duplicate poll is a no-op.
  await prisma.$transaction(async (tx) => {
    await tx.ticket.update({
      where: { id: gift.ticketId },
      data: {
        ownerId: gift.toId,
        ownerAddress: gift.toAddress,
        syncedAt: new Date(),
        status: 'MINTED',
      },
    })

    const already = await tx.transfer.findUnique({ where: { txHash: status.txid! } })
    if (!already) {
      await tx.transfer.create({
        data: {
          ticketId: gift.ticketId,
          fromAddress: gift.fromAddress,
          toAddress: gift.toAddress,
          txHash: status.txid!,
          kind: 'GIFT',
          occurredAt: new Date(),
        },
      })
    }

    await tx.gift.update({
      where: { id: gift.id },
      data: { status: 'ACCEPTED', acceptTxHash: status.txid, resolvedAt: new Date() },
    })
  })

  res.json({ ...view(), state: 'accepted' })
})

/**
 * GET /api/gifts?role=incoming|outgoing
 * What is waiting for me, and what I have sent.
 */
const ListQuery = z.object({
  role: z.enum(['incoming', 'outgoing']).default('incoming'),
})

giftsRouter.get('/gifts', requireAuth, async (req, res) => {
  const parsed = ListQuery.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', details: issuesOf(parsed.error) })
    return
  }

  const gifts = await prisma.gift.findMany({
    where:
      parsed.data.role === 'incoming'
        ? { toId: req.userId!, status: { in: ['OFFERED', 'ACCEPTING'] } }
        : { fromId: req.userId!, status: { in: [...IN_FLIGHT] } },
    include: {
      ticket: { include: { event: { select: { slug: true, title: true } } } },
      from: { select: { username: true } },
      to: { select: { username: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  res.json({
    gifts: gifts.map((g) => ({
      giftId: g.id,
      state: g.status.toLowerCase(),
      from: `@${g.from.username}`,
      to: `@${g.to.username}`,
      expiresAt: g.expiresAt.toISOString(),
      ticket: {
        nfTokenId: g.ticket.nfTokenId,
        seat: g.ticket.seat,
        tier: g.ticket.tier,
        event: g.ticket.event,
      },
    })),
  })
})
