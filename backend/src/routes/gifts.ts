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
import { NETWORK } from '../network.js'
import { xamanMode } from '../env.js'
import { tryGetPayload, xaman, SIGNIN_TTL_MINUTES } from '../xaman.js'
import { issuesOf, usernameSchema } from '../schemas.js'
import { requireAuth } from '../session.js'
import { ON_LEDGER_STATES, mayExpire } from '../gift-policy.js'
import { signedByOtherAccount } from '../signer.js'
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

/**
 * How long an UNSIGNED Xaman payload stays valid. Longer than sign-in because
 * the recipient may not be at their phone.
 *
 * This is a payload TTL, NOT a gift TTL. An XRPL NFTokenOffer has no expiry —
 * once it exists on-ledger it lives until accepted or cancelled. Treating this
 * timeout as the gift's lifetime would mark a gift `expired` while its offer is
 * still live and acceptable in Xaman, and if the recipient then accepted it we
 * would never write the GIFT provenance row. So expiry applies only while
 * nothing has reached the ledger.
 */
const GIFT_TTL_MINUTES = 60
const GIFT_TTL_MS = GIFT_TTL_MINUTES * 60 * 1000

const IdParams = z.object({ id: z.string().uuid() })
const NfTokenIdParams = z.object({
  nfTokenId: z.string().regex(/^[0-9A-Fa-f]{64}$/, 'not a valid NFTokenID'),
})
const GiftBody = z.object({ to: usernameSchema })

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
    prisma.ticket.findUnique({ where: { network_nfTokenId: { network: NETWORK, nfTokenId } } }),
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

  if (ticket.status === 'REDEEMED') {
    // Admission has already been used. The NFT still exists and can be moved in
    // Xaman as a collectible, but Hubworld will not present it as a ticket.
    res.status(409).json({ error: 'That ticket has already been checked in' })
    return
  }
  if (ticket.status === 'LISTED' || ticket.status === 'IN_AUCTION') {
    res.status(409).json({ error: `Cannot gift a ticket that is ${ticket.status.toLowerCase()}` })
    return
  }

  // A live on-ledger offer counts as in-flight regardless of the payload TTL —
  // only an unsigned PENDING_OFFER goes stale.
  const existing = await prisma.gift.findFirst({
    where: {
      ticketId: ticket.id,
      OR: [
        { status: { in: [...ON_LEDGER_STATES] } },
        { status: 'PENDING_OFFER', expiresAt: { gt: new Date() } },
      ],
    },
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
    flow: 'GIFT_OFFER',
    userId: me.id,
    expireMinutes: GIFT_TTL_MINUTES,
    forceNetwork: XAMAN_NETWORK,
  })

  const expiresAt = new Date(Date.now() + GIFT_TTL_MS)
  const gift = await prisma.gift.create({
    data: {
      ticketId: ticket.id,
      network: NETWORK,
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
  // Deliberately no expiry check: the offer is on-ledger and has none. Refusing
  // here would only push the recipient to accept in Xaman instead, where we
  // would never observe it.

  const payload = await xaman.createPayload(
    buildAcceptOfferTx({
      accepterAddress: gift.toAddress,
      offerIndex: gift.offerIndex,
    }) as unknown as Record<string, unknown>,
    { flow: 'GIFT_ACCEPT', userId: req.userId, expireMinutes: GIFT_TTL_MINUTES, forceNetwork: XAMAN_NETWORK },
  )

  await prisma.gift.update({
    where: { id: gift.id },
    data: {
      acceptPayloadUuid: payload.uuid,
      // Refresh the payload TTL. Without this a retry after one stale payload
      // would be born already expired and revert on its first poll.
      expiresAt: new Date(Date.now() + GIFT_TTL_MS),
    },
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
    { flow: 'GIFT_CANCEL', userId: req.userId, expireMinutes: GIFT_TTL_MINUTES, forceNetwork: XAMAN_NETWORK },
  )

  await prisma.gift.update({
    where: { id: gift.id },
    data: {
      cancelPayloadUuid: payload.uuid,
      expiresAt: new Date(Date.now() + GIFT_TTL_MS),
    },
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

  // Only meaningful while nothing is on-ledger yet — see GIFT_TTL_MINUTES.
  const payloadExpired = gift.expiresAt < new Date()

  // ---- phase 1: waiting on the sender's offer -----------------------------
  if (gift.status === 'PENDING_OFFER') {
    const status = await tryGetPayload(gift.offerPayloadUuid)
    if (status === 'unavailable') {
      res.json(view())
      return
    }

    if (status?.cancelled) {
      await prisma.gift.update({ where: { id: gift.id }, data: { status: 'CANCELLED' } })
      res.json({ ...view(), state: 'cancelled' })
      return
    }
    if (!status?.signed) {
      // Nothing on-ledger yet, so expiring is honest here — mayExpire is what
      // guarantees that, and keeps this branch tied to the documented rule.
      if (mayExpire(gift.status) && (payloadExpired || status?.expired)) {
        await prisma.gift.update({ where: { id: gift.id }, data: { status: 'EXPIRED' } })
        res.json({ ...view(), state: 'expired' })
        return
      }
      res.json(view())
      return
    }
    // The sender's payload can be signed by any account in their Xaman. If a
    // different one signed, the offer on-ledger is from a wallet that is not the
    // one we recorded as the sender — and since the offer moves a ticket, the
    // GIFT provenance row would name someone who never held it.
    if (signedByOtherAccount(gift.fromAddress, status.account)) {
      await prisma.gift.update({
        where: { id: gift.id },
        data: { status: 'FAILED', failureReason: 'Signed by a different account than the sender' },
      })
      res.json({
        ...view(),
        state: 'failed',
        reason: 'Signed by a different account than the sender',
      })
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
    const cancel = await tryGetPayload(gift.cancelPayloadUuid)
    if (cancel === 'unavailable') {
      res.json(view())
      return
    }

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
  //
  // An OFFERED gift never expires: the offer is on-ledger and the ledger gives
  // it no lifetime. It ends only by acceptance or withdrawal.
  if (gift.status === 'OFFERED' && !gift.acceptPayloadUuid) {
    res.json(view({ awaitingRecipient: true }))
    return
  }

  if (!gift.acceptPayloadUuid) {
    res.json(view())
    return
  }

  const status = await tryGetPayload(gift.acceptPayloadUuid)
  if (status === 'unavailable') {
    res.json(view({ awaitingRecipient: true }))
    return
  }

  if (status?.cancelled) {
    await prisma.gift.update({ where: { id: gift.id }, data: { status: 'DECLINED' } })
    res.json({ ...view(), state: 'declined' })
    return
  }
  if (!status?.signed) {
    // The ACCEPT payload went stale unsigned. The offer itself is untouched, so
    // drop the dead payload and fall back to OFFERED — the recipient can simply
    // start their half again rather than losing the gift.
    if (payloadExpired || status?.expired) {
      await prisma.gift.update({
        where: { id: gift.id },
        data: { status: 'OFFERED', acceptPayloadUuid: null },
      })
      res.json({ ...view(), state: 'offered', awaitingRecipient: true })
      return
    }
    res.json(view({ awaitingRecipient: true }))
    return
  }
  // Same check on the receiving side, and it matters more here: this half moves
  // ownership. Accepting with a different wallet would put the ticket in an
  // account we never recorded, while the GIFT provenance row and
  // `Ticket.ownerAddress` both claim the intended recipient holds it.
  //
  // The offer's `Destination` means only the recipient CAN accept, so the ledger
  // would reject a stranger — but a user with several accounts in one Xaman is
  // not a stranger, and that is exactly the case this catches.
  if (signedByOtherAccount(gift.toAddress, status.account)) {
    await prisma.gift.update({
      where: { id: gift.id },
      data: {
        status: 'FAILED',
        failureReason: 'Signed by a different account than the recipient',
      },
    })
    res.json({
      ...view(),
      state: 'failed',
      reason: 'Signed by a different account than the recipient',
    })
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

    const already = await tx.transfer.findUnique({
      where: { network_txHash: { network: NETWORK, txHash: status.txid! } },
    })
    if (!already) {
      await tx.transfer.create({
        data: {
          ticketId: gift.ticketId,
          network: NETWORK,
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
    // OFFERED entries are listed regardless of the payload TTL — the on-ledger
    // offer is still live and the recipient must keep seeing it.
    where:
      parsed.data.role === 'incoming'
        ? { toId: req.userId!, status: { in: ['OFFERED', 'ACCEPTING'] } }
        : {
            fromId: req.userId!,
            OR: [
              { status: { in: [...ON_LEDGER_STATES] } },
              { status: 'PENDING_OFFER', expiresAt: { gt: new Date() } },
            ],
          },
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
