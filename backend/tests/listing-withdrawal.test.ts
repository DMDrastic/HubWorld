/**
 * Withdrawing a listing, across the gap where the ledger has not caught up.
 *
 * `txSucceeded` returns null while a transaction is not yet in a validated
 * ledger, which is the normal case for the first poll after signing. The route
 * records that as CANCELLING and waits to be polled again.
 *
 * The bug this suite exists for: the branch that finishes the withdrawal was
 * guarded on `status === 'ACTIVE'`, so the LATER poll — the only thing that
 * could ever resolve CANCELLING — no longer matched, and nothing else in the
 * codebase moves a listing out of that status. The withdrawal never completed.
 * That is not a cosmetic stall: `ON_LEDGER_STATES` counts CANCELLING, so
 * `open-auction.ts` and `POST /tickets/:id/list` both refuse, and the ticket is
 * permanently unlistable and unauctionable while its offer sits live on-ledger.
 *
 * So what is asserted here is specifically the SECOND poll. A test that only
 * checked the first would have passed against the broken code.
 *
 * Conventions follow the other DB-backed suites: real Postgres, only the network
 * stubbed, fixtures prefixed and cleaned up by prefix.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

const txSucceeded = vi.fn<(txHash: string) => Promise<boolean | null>>()
const tryGetPayload = vi.fn()

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return {
    ...actual,
    // Real fee maths and real builders; only the network call is faked.
    txSucceeded: (...a: Parameters<typeof txSucceeded>) => txSucceeded(...a),
    holdsNft: async () => true,
  }
})

vi.mock('../src/xaman.js', async () => {
  const actual = await vi.importActual<typeof import('../src/xaman.js')>('../src/xaman.js')
  return {
    ...actual,
    tryGetPayload: (...a: unknown[]) => tryGetPayload(...a),
    xaman: {
      mode: 'stub' as const,
      createPayload: async () => ({ uuid: 'stub', next: 'n', qrPng: 'q' }),
      createSignInPayload: async () => ({ uuid: 'stub', next: 'n', qrPng: 'q' }),
      getPayload: async () => null,
      cancelPayload: async () => true,
    },
  }
})

// Same reason as in routes.authorization: brokerMode comes from PLATFORM_SEED,
// and the sell route answers 503 without one — before any of this is reached.
// Left ambient, the suite would pass locally and fail in CI.
vi.mock('../src/env.js', async () => {
  const actual = await vi.importActual<typeof import('../src/env.js')>('../src/env.js')
  return { ...actual, brokerMode: 'live' as const }
})

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')

const app = createApp()

const UTAG = 'lw_'
const STAG = 'lw-'
const CANCEL_UUID = '00000000-0000-4000-8000-00000000cancel'.slice(0, 36)
const CANCEL_TX = 'A'.repeat(64)

let uniq = ''

const eventWhere = {
  OR: [{ slug: { startsWith: STAG } }, { organizer: { username: { startsWith: UTAG } } }],
}

async function cleanup() {
  const byEvent = { ticket: { event: eventWhere } }
  await prisma.transfer.deleteMany({ where: byEvent })
  await prisma.listing.deleteMany({ where: { seller: { username: { startsWith: UTAG } } } })
  await prisma.auction.deleteMany({ where: byEvent })
  await prisma.ticket.deleteMany({ where: { event: eventWhere } })
  await prisma.event.deleteMany({ where: eventWhere })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: UTAG } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: UTAG } } })
}

beforeEach(async () => {
  uniq = Math.random().toString(36).slice(2, 8)
  await cleanup()
  txSucceeded.mockReset()
  tryGetPayload.mockReset()
})

afterEach(cleanup)
afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

/** A listing already withdrawn by the seller and awaiting ledger confirmation. */
async function mkWithdrawnListing() {
  const seller = await prisma.user.create({
    data: {
      username: `${UTAG}sell_${uniq}`.slice(0, 20),
      xrplAddress: `r${UTAG}${uniq}`.padEnd(28, 'x').slice(0, 33),
    },
  })
  const event = await prisma.event.create({
    data: {
      network: NETWORK,
      slug: `${STAG}${uniq}`,
      title: 'Withdrawal Test Event',
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: seller.id,
      nftTaxon: 60_000 + Math.floor(Math.random() * 9_000),
      royaltyBps: 500,
      platformBps: 250,
      ticketCount: 5,
      status: 'PUBLISHED',
    },
  })
  const ticket = await prisma.ticket.create({
    data: {
      network: NETWORK,
      nfTokenId: `${'B'.repeat(58)}${uniq}`.slice(0, 64).toUpperCase(),
      eventId: event.id,
      ownerId: seller.id,
      ownerAddress: seller.xrplAddress,
      status: 'LISTED',
    },
  })
  const listing = await prisma.listing.create({
    data: {
      network: NETWORK,
      ticketId: ticket.id,
      sellerId: seller.id,
      sellerAddress: seller.xrplAddress,
      priceDrops: 10_000_000n,
      platformFeeDrops: 250_000n,
      status: 'ACTIVE',
      offerIndex: 'C'.repeat(64),
      listPayloadUuid: '00000000-0000-4000-8000-000000000list',
      cancelPayloadUuid: CANCEL_UUID,
      expiresAt: new Date(Date.now() + 600_000),
    },
  })
  // A real session, not a forged header — the poll route is behind requireAuth.
  const { token } = await createSession(seller.id)
  return { seller, event, ticket, listing, auth: `Bearer ${token}` }
}

describe('a withdrawal completes even when the ledger lags the signature', () => {
  /**
   * The whole point. The first poll cannot see a validated transaction and parks
   * the listing in CANCELLING; the second sees it and must finish the job.
   * Against the ACTIVE-only guard the second poll fell through untouched, which
   * is exactly the production row this suite was written for.
   */
  it('resolves CANCELLING to CANCELLED on a later poll', async () => {
    const { listing, ticket, auth } = await mkWithdrawnListing()
    tryGetPayload.mockResolvedValue({ signed: true, txid: CANCEL_TX })

    // Poll 1: signed, but not yet in a validated ledger.
    txSucceeded.mockResolvedValueOnce(null)
    const first = await request(app).get(`/api/listings/${listing.id}`).set('authorization', auth)
    expect(first.status).toBe(200)
    expect(first.body.state).toBe('cancelling')

    const mid = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })
    expect(mid.status).toBe('CANCELLING')
    expect(mid.cancelTxHash).toBe(CANCEL_TX)

    // Poll 2: the ledger has caught up.
    txSucceeded.mockResolvedValueOnce(true)
    const second = await request(app).get(`/api/listings/${listing.id}`).set('authorization', auth)
    expect(second.status).toBe(200)
    expect(second.body.state).toBe('cancelled')

    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })
    expect(after.status).toBe('CANCELLED')
    expect(after.closedAt).not.toBeNull()

    // The ticket has to be released too, or it stays unlistable — which is the
    // user-visible half of this bug.
    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })
    expect(t.status).toBe('MINTED')
  })

  /**
   * A cancellation the ledger REJECTED leaves the sell offer live, so the
   * listing is still genuinely for sale. Parking it in CANCELLING would strand
   * the ticket for a withdrawal that demonstrably did not happen.
   */
  it('returns a rejected cancellation to ACTIVE rather than stranding it', async () => {
    const { listing, auth } = await mkWithdrawnListing()
    tryGetPayload.mockResolvedValue({ signed: true, txid: CANCEL_TX })

    txSucceeded.mockResolvedValueOnce(null)
    await request(app).get(`/api/listings/${listing.id}`).set('authorization', auth)
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe(
      'CANCELLING',
    )

    txSucceeded.mockResolvedValueOnce(false)
    const res = await request(app).get(`/api/listings/${listing.id}`).set('authorization', auth)
    expect(res.body.state).toBe('active')

    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })
    expect(after.status).toBe('ACTIVE')
    // The dead payload is cleared, or every later poll re-checks a transaction
    // already known to have failed and the listing cannot be withdrawn again.
    expect(after.cancelPayloadUuid).toBeNull()
    expect(after.cancelTxHash).toBeNull()
  })

  /**
   * CANCELLING must not resolve on optimism. While the ledger still cannot
   * confirm, the listing stays put rather than being closed on the assumption
   * that a signature is a settlement.
   */
  it('stays in CANCELLING while the ledger still cannot confirm', async () => {
    const { listing, auth } = await mkWithdrawnListing()
    tryGetPayload.mockResolvedValue({ signed: true, txid: CANCEL_TX })

    txSucceeded.mockResolvedValue(null)
    await request(app).get(`/api/listings/${listing.id}`).set('authorization', auth)
    const res = await request(app).get(`/api/listings/${listing.id}`).set('authorization', auth)
    expect(res.body.state).toBe('cancelling')

    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })
    expect(after.status).toBe('CANCELLING')
    expect(after.closedAt).toBeNull()
  })

  /**
   * Rate limiting says nothing about a payload, so a 429 must not be read as a
   * verdict on the withdrawal — the listing simply stays where it is.
   */
  it('leaves CANCELLING untouched when Xaman is unavailable', async () => {
    const { listing, auth } = await mkWithdrawnListing()
    tryGetPayload.mockResolvedValueOnce({ signed: true, txid: CANCEL_TX })
    txSucceeded.mockResolvedValueOnce(null)
    await request(app).get(`/api/listings/${listing.id}`).set('authorization', auth)

    tryGetPayload.mockResolvedValueOnce('unavailable')
    const res = await request(app).get(`/api/listings/${listing.id}`).set('authorization', auth)
    expect(res.status).toBe(200)

    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })
    expect(after.status).toBe('CANCELLING')
  })
})
