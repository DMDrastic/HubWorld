/**
 * Buying and bidding must check the LEDGER, not our own status column.
 *
 * A seller can cancel their offer or move a ticket in Xaman without ever
 * touching HubWorld — that is the premise the whole data model is built on,
 * which is why `Ticket.ownerAddress` carries `syncedAt` and why CLAUDE.md says
 * never to treat it as authoritative for anything that matters.
 *
 * Both of these paths did exactly that. `POST /listings/:id/buy` gated on
 * `Listing.status === 'ACTIVE'`, and `POST /auctions/:id/bid` built the offer's
 * `Owner` from the cached address. Every other write path that acts on a ticket
 * already re-reads: gift, list and auction-open all call `holdsNft` first.
 *
 * The cost of getting it wrong falls on the person with the least information:
 * the buyer spends a Xaman payload, signs, and locks 0.2 XRP of owner reserve
 * on an offer that can never match — discovering it only when settlement fails.
 *
 * Three cases per path, and the third is the one that is easy to get backwards:
 * an UNREACHABLE ledger must not behave like a negative answer, or a public node
 * blinking would block legitimate purchases. Same rule the door follows when it
 * admits an attendee on a cached claim rather than turning away a real one.
 */
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const holdsNft = vi.fn()

/**
 * The signer is stubbed, and that is not optional.
 *
 * These routes reach `xaman.createPayload` once the guard lets them through. In
 * any checkout holding credentials that creates a REAL payload against the quota
 * this project treats as its binding constraint — CLAUDE.md: "The test suite must
 * never create real payloads." An earlier version of this file did exactly that,
 * and only passed locally because the live call happened to fail.
 */
vi.mock('../src/xaman.js', async () => {
  const actual = await vi.importActual<typeof import('../src/xaman.js')>('../src/xaman.js')
  let n = 0
  const created = () => ({
    uuid: `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`,
    next: 'https://xumm.app/sign/stub',
    qrPng: 'https://xumm.app/sign/stub.png',
  })
  return {
    ...actual,
    xaman: {
      mode: 'stub' as const,
      createPayload: async () => created(),
      createSignInPayload: async () => created(),
      getPayload: async () => null,
      cancelPayload: async () => true,
    },
  }
})

/**
 * The broker is forced live. `brokerMode` reads PLATFORM_SEED, and the bid route
 * answers 503 without it — BEFORE reaching the guard this file exists to assert.
 * Left ambient, these tests would pass on a laptop with a seed and fail in CI
 * without one, which is exactly what happened.
 */
vi.mock('../src/env.js', async () => {
  const actual = await vi.importActual<typeof import('../src/env.js')>('../src/env.js')
  return { ...actual, brokerMode: 'live' as const }
})

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return {
    ...actual,
    holdsNft: (...a: unknown[]) => holdsNft(...a),
    spendableDrops: async () => 10_000_000_000n,
    accountFunding: async () => ({ spendableDrops: 10_000_000_000n, reserveIncDrops: 200_000n }),
  }
})

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')

const app = createApp()

/** A real session, not a forged header — the token path is part of the boundary. */
async function tokenFor(userId: string) {
  const { token } = await createSession(userId)
  return `Bearer ${token}`
}

const buyAs = (listingId: string, auth: string) =>
  request(app).post(`/api/listings/${listingId}/buy`).set('authorization', auth).send({})

const bidAs = (auctionId: string, auth: string, amountDrops: string) =>
  request(app)
    .post(`/api/auctions/${auctionId}/bid`)
    .set('authorization', auth)
    .send({ amountDrops })

const TAG = 'stale-guard'
const XRP = 1_000_000n

let created: string[] = []

async function seedListing(opts: { redeemed?: boolean } = {}) {
  const uniq = Math.random().toString(36).slice(2, 8)
  const mk = (name: string) =>
    prisma.user.create({
      data: {
        username: `${TAG}-${name}-${uniq}`,
        xrplAddress: `r${TAG}${name}${uniq}`.slice(0, 34),
      },
    })

  const seller = await mk('sell')
  const buyer = await mk('buy')

  const event = await prisma.event.create({
    data: {
      network: NETWORK,
      slug: `${TAG}-${uniq}`,
      title: 'Stale guard fixture',
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: seller.id,
      nftTaxon: 970_000,
      royaltyBps: 0,
      platformBps: 250,
      ticketCount: 1,
    },
  })

  const ticket = await prisma.ticket.create({
    data: {
      network: NETWORK,
      nfTokenId: `STALE${uniq}`.padEnd(64, '0').toUpperCase(),
      eventId: event.id,
      ownerId: seller.id,
      ownerAddress: seller.xrplAddress,
      status: opts.redeemed ? 'REDEEMED' : 'MINTED',
    },
  })

  const listing = await prisma.listing.create({
    data: {
      network: NETWORK,
      ticketId: ticket.id,
      sellerId: seller.id,
      sellerAddress: seller.xrplAddress,
      priceDrops: XRP,
      platformFeeDrops: 25_000n,
      status: 'ACTIVE',
      listPayloadUuid: `list-${uniq}`,
      expiresAt: new Date(Date.now() + 3_600_000),
      offerIndex: `SELL-${uniq}`,
      brokerAddress: 'rBrokerFixture000000000000000000',
    },
  })

  created.push(event.slug)
  return { seller, buyer, ticket, listing }
}

/**
 * Prefix-based and ordered, not per-slug: a failed run leaves rows behind, and
 * the next run must be able to clean up after it rather than tripping over a
 * foreign key it did not create. Children before parents throughout.
 */
async function cleanup() {
  const inFixture = { ticket: { event: { slug: { startsWith: `${TAG}-` } } } }
  await prisma.bid.deleteMany({ where: { auction: inFixture } })
  await prisma.auction.deleteMany({ where: inFixture })
  await prisma.transfer.deleteMany({ where: inFixture })
  await prisma.listing.deleteMany({ where: inFixture })
  await prisma.ticket.deleteMany({ where: { event: { slug: { startsWith: `${TAG}-` } } } })
  await prisma.event.deleteMany({ where: { slug: { startsWith: `${TAG}-` } } })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: `${TAG}-` } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } })
}

beforeEach(async () => {
  created = []
  holdsNft.mockReset()
  await cleanup()
})

afterEach(cleanup)

describe('a listing whose seller no longer holds the ticket', () => {
  it('is withdrawn rather than sold', async () => {
    const { listing, buyer } = await seedListing()
    // The seller moved it in Xaman. Our status still says ACTIVE.
    holdsNft.mockResolvedValue(false)

    const result = await buyAs(listing.id, await tokenFor(buyer.id))

    expect(result.status).toBe(409)
    expect(result.body.error).toMatch(/no longer holds/i)

    // Withdrawn, not left ACTIVE for the next buyer to hit the same wall.
    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })
    expect(after.status).toBe('CANCELLED')
  })

  it('still sells when the seller does hold it', async () => {
    // The control. A guard that refuses everything passes the test above too.
    const { listing, buyer } = await seedListing()
    holdsNft.mockResolvedValue(true)

    const result = await buyAs(listing.id, await tokenFor(buyer.id))

    // Asserted as "the guard did not fire", not as a particular end state: how
    // far the request travels afterwards depends on the signer, and that is a
    // different question from the one this file is about.
    expect(result.body.error ?? '').not.toMatch(/no longer holds/i)
    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })
    expect(after.status).not.toBe('CANCELLED')
  })

  it('does not block the sale when the ledger cannot be read', async () => {
    // An unknown answer is not a negative one. Treating a node blip as "the
    // seller does not hold it" would cancel live listings during an outage.
    const { listing, buyer } = await seedListing()
    holdsNft.mockRejectedValue(new Error('websocket closed'))

    const result = await buyAs(listing.id, await tokenFor(buyer.id))

    expect(result.body.error ?? '').not.toMatch(/no longer holds/i)
    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })
    expect(after.status).not.toBe('CANCELLED')
  })
})

/** The same fixture with a LIVE auction on the ticket, for the bid path. */
async function seedAuction() {
  const { seller, buyer, ticket } = await seedListing()
  const auction = await prisma.auction.create({
    data: {
      network: NETWORK,
      ticketId: ticket.id,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 3_600_000),
      reserveDrops: XRP / 2n,
      status: 'LIVE',
    },
  })
  return { seller, buyer, ticket, auction }
}

describe('a bid against a ticket that has moved', () => {
  it('is refused rather than left unsettleable', async () => {
    // Ticket.ownerAddress is a CACHE. The bid names it as the offer's Owner, so
    // a stale value produces an offer nobody can settle — while still costing
    // the bidder a payload and 0.2 XRP of reserve.
    const { auction, buyer } = await seedAuction()
    holdsNft.mockResolvedValue(false)

    const result = await bidAs(auction.id, await tokenFor(buyer.id), XRP.toString())

    expect(result.status).toBe(409)
    expect(result.body.error).toMatch(/moved/i)
  })

  it('accepts the bid when the holder still holds it', async () => {
    const { auction, buyer } = await seedAuction()
    holdsNft.mockResolvedValue(true)

    const result = await bidAs(auction.id, await tokenFor(buyer.id), XRP.toString())

    expect(result.body.error ?? '').not.toMatch(/moved/i)
  })

  it('does not block bidding when the ledger cannot be read', async () => {
    const { auction, buyer } = await seedAuction()
    holdsNft.mockRejectedValue(new Error('websocket closed'))

    const result = await bidAs(auction.id, await tokenFor(buyer.id), XRP.toString())

    expect(result.body.error ?? '').not.toMatch(/moved/i)
  })
})
