/**
 * Minting.
 *
 * The organizer is the NFT issuer (brokered mode — see CLAUDE.md), so the
 * organizer must sign the NFTokenMint on their own device. Hubworld only builds
 * the transaction and watches the ledger for the result.
 *
 * Two steps, because signing is asynchronous:
 *   POST /api/events/:slug/mint  → build tx, create Xaman payload, return QR
 *   GET  /api/mint/:uuid         → poll until the ledger validates it
 *
 * The NFTokenID does not exist until the transaction is validated — it is
 * derived by the ledger, not chosen by us. That is why the Ticket row can only
 * be written on the polling side.
 */
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { NETWORK } from '../network.js'
import { xamanMode } from '../env.js'
import { tryGetPayload, xaman, SIGNIN_TTL_MINUTES } from '../xaman.js'
import { trackPayload } from '../payload-store.js'
import { issuesOf, slugSchema } from '../schemas.js'
import { requireAuth, requireOrganizer } from '../session.js'
import { buildMintTx, nftokenIdFromTx, XAMAN_NETWORK } from '../ledger.js'
import { signedByOtherAccount } from '../signer.js'

export const mintRouter = Router()

const MINT_TTL_MINUTES = SIGNIN_TTL_MINUTES
const MINT_TTL_MS = MINT_TTL_MINUTES * 60 * 1000

const SlugParams = z.object({ slug: slugSchema })
const UuidParams = z.object({ uuid: z.string().uuid() })

const MintBody = z.object({
  seat: z.string().trim().min(1).max(20).optional(),
  tier: z.string().trim().min(1).max(40).optional(),
})

/**
 * POST /api/events/:slug/mint
 * Organizer-only. Returns a Xaman payload for the organizer to sign.
 */
mintRouter.post('/events/:slug/mint', requireAuth, requireOrganizer, async (req, res) => {
  const params = SlugParams.safeParse(req.params)
  if (!params.success) {
    res.status(400).json({ error: 'Invalid event slug', details: issuesOf(params.error) })
    return
  }

  const body = MintBody.safeParse(req.body ?? {})
  if (!body.success) {
    res.status(400).json({ error: 'Invalid request', details: issuesOf(body.error) })
    return
  }

  const event = await prisma.event.findUnique({
    where: { slug: params.data.slug },
    include: { organizer: true, _count: { select: { tickets: true } } },
  })
  if (!event) {
    res.status(404).json({ error: 'Event not found' })
    return
  }

  // Only the organizer can issue tickets for their own event. Anyone else
  // signing would produce an NFT issued by the wrong account, which would send
  // royalties to the wrong place and break provenance.
  if (event.organizerId !== req.userId) {
    res.status(403).json({ error: 'Only the event organizer can mint tickets' })
    return
  }

  if (event.status === 'CANCELLED' || event.status === 'COMPLETED') {
    res.status(409).json({ error: `Cannot mint for a ${event.status.toLowerCase()} event` })
    return
  }

  // ticketCount is the cap the organizer advertised. Count minted tickets plus
  // mints already in flight, so rapid double-submits cannot overshoot it.
  const inFlight = await prisma.mintRequest.count({
    where: { eventId: event.id, status: { in: ['PENDING', 'SIGNED'] }, expiresAt: { gt: new Date() } },
  })
  if (event.ticketCount > 0 && event._count.tickets + inFlight >= event.ticketCount) {
    res.status(409).json({
      error: `All ${event.ticketCount} tickets for this event are minted or pending`,
    })
    return
  }

  let txjson: ReturnType<typeof buildMintTx>
  try {
    txjson = buildMintTx({
      issuerAddress: event.organizer.xrplAddress,
      taxon: event.nftTaxon,
      royaltyBps: event.royaltyBps,
    })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not build mint' })
    return
  }

  const payload = await xaman.createPayload(txjson as unknown as Record<string, unknown>, {
    expireMinutes: MINT_TTL_MINUTES,
    // Pin the network. Without this a wallet set to mainnet would sign a
    // testnet-intended mint against real funds.
    forceNetwork: XAMAN_NETWORK,
  })
  // Registered before it can resolve, so a webhook callback finds it and
  // reconciliation can spot one whose callback never arrived.
  await trackPayload(payload.uuid)

  const expiresAt = new Date(Date.now() + MINT_TTL_MS)
  await prisma.mintRequest.create({
    data: {
      payloadUuid: payload.uuid,
      network: NETWORK,
      eventId: event.id,
      requestedById: req.userId!,
      seat: body.data.seat ?? null,
      tier: body.data.tier ?? null,
      expiresAt,
    },
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
 * GET /api/mint/:uuid
 *
 * Poll target. States:
 *   pending  — not yet signed, or signed but not yet validated on-ledger
 *   minted   — validated; Ticket + MINT provenance written
 *   rejected / expired / failed
 */
mintRouter.get('/mint/:uuid', requireAuth, async (req, res) => {
  const parsed = UuidParams.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid payload id', details: issuesOf(parsed.error) })
    return
  }

  const request = await prisma.mintRequest.findUnique({
    where: { payloadUuid: parsed.data.uuid },
    include: { event: { include: { organizer: true } } },
  })
  if (!request) {
    res.status(404).json({ error: 'Unknown mint request' })
    return
  }
  if (request.requestedById !== req.userId) {
    res.status(403).json({ error: 'Not your mint request' })
    return
  }

  // Terminal states short-circuit — no need to ask Xaman again.
  if (request.status === 'MINTED' && request.ticketId) {
    res.json({ state: 'minted', ...(await mintedPayload(request.ticketId)) })
    return
  }
  if (request.status === 'REJECTED') {
    res.json({ state: 'rejected' })
    return
  }
  if (request.status === 'FAILED') {
    res.json({ state: 'failed', reason: request.failureReason ?? 'The ledger rejected the mint' })
    return
  }

  // Xaman first, our clock second — same reasoning as sign-in: deciding
  // "expired" locally throws away signatures that landed inside the window.
  const status = await tryGetPayload(parsed.data.uuid)
  if (status === 'unavailable') {
    res.json({ state: 'pending' })
    return
  }
  const locallyExpired = request.status === 'EXPIRED' || request.expiresAt < new Date()

  const markExpired = async () => {
    if (request.status !== 'EXPIRED') {
      await prisma.mintRequest.update({ where: { id: request.id }, data: { status: 'EXPIRED' } })
    }
  }

  if (!status || (!status.signed && !status.cancelled)) {
    if ((status?.expired ?? false) || locallyExpired) {
      await markExpired()
      res.json({ state: 'expired' })
      return
    }
    res.json({ state: 'pending' })
    return
  }

  if (status.cancelled) {
    await prisma.mintRequest.update({ where: { id: request.id }, data: { status: 'REJECTED' } })
    res.json({ state: 'rejected' })
    return
  }

  // Signed by WHOM, though. A payload is built for one account but Xaman signs
  // with whichever account the user has selected, so the signer must match the
  // organizer we built this mint for.
  //
  // This one is more than bookkeeping: the signer becomes the NFT's ISSUER, and
  // the issuer is who `TransferFee` pays. A mint signed by the wrong account
  // produces a ticket whose royalties go to that account forever, with a
  // `Ticket` row claiming it belongs to the event's organizer. It cannot be
  // corrected afterwards — the issuer is baked into the NFTokenID.
  if (signedByOtherAccount(request.event.organizer.xrplAddress, status.account)) {
    await prisma.mintRequest.update({
      where: { id: request.id },
      data: {
        status: 'FAILED',
        txHash: status.txid ?? null,
        failureReason: 'Signed by a different account than the event organizer',
      },
    })
    res.json({
      state: 'failed',
      reason: 'Signed by a different account than the event organizer',
    })
    return
  }

  // A signature is not a mint: the transaction still has to be submitted and
  // validated before an NFTokenID exists.
  if (!status.txid) {
    await prisma.mintRequest.update({
      where: { id: request.id },
      data: { status: 'SIGNED', failureReason: null },
    })
    res.json({ state: 'pending', signed: true })
    return
  }

  let nfTokenId: string | null
  try {
    nfTokenId = await nftokenIdFromTx(status.txid)
  } catch (err) {
    // Most often the transaction is not yet in a validated ledger. Stay
    // pending rather than failing a mint that is merely slow.
    void err
    await prisma.mintRequest.update({
      where: { id: request.id },
      data: { status: 'SIGNED', txHash: status.txid },
    })
    res.json({ state: 'pending', signed: true })
    return
  }

  if (!nfTokenId) {
    await prisma.mintRequest.update({
      where: { id: request.id },
      data: { status: 'SIGNED', txHash: status.txid },
    })
    res.json({ state: 'pending', signed: true })
    return
  }

  const issuer = request.event.organizer

  // One transaction, so a Ticket never exists without its provenance row.
  // The unique nfTokenId also makes a duplicate poll a no-op rather than a
  // second ticket.
  const ticket = await prisma.$transaction(async (tx) => {
    const existing = await tx.ticket.findUnique({
      where: { network_nfTokenId: { network: NETWORK, nfTokenId: nfTokenId! } },
    })
    if (existing) return existing

    const created = await tx.ticket.create({
      data: {
        nfTokenId: nfTokenId!,
        network: NETWORK,
        eventId: request.eventId,
        // Freshly minted: the issuer holds it until it is gifted or sold.
        ownerId: issuer.id,
        ownerAddress: issuer.xrplAddress,
        syncedAt: new Date(),
        seat: request.seat,
        tier: request.tier,
        status: 'MINTED',
      },
    })

    await tx.transfer.create({
      data: {
        ticketId: created.id,
        network: NETWORK,
        fromAddress: null, // a mint has no sender
        toAddress: issuer.xrplAddress,
        txHash: status.txid!,
        kind: 'MINT',
        occurredAt: new Date(),
      },
    })

    return created
  })

  await prisma.mintRequest.update({
    where: { id: request.id },
    data: {
      status: 'MINTED',
      txHash: status.txid,
      nfTokenId,
      ticketId: ticket.id,
      resolvedAt: new Date(),
    },
  })

  res.json({ state: 'minted', ...(await mintedPayload(ticket.id)) })
})

async function mintedPayload(ticketId: string) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: { event: { select: { slug: true, title: true } } },
  })
  if (!ticket) return { ticket: null }

  return {
    ticket: {
      id: ticket.id,
      nfTokenId: ticket.nfTokenId,
      seat: ticket.seat,
      tier: ticket.tier,
      status: ticket.status,
      ownerAddress: ticket.ownerAddress,
      event: ticket.event,
    },
  }
}
