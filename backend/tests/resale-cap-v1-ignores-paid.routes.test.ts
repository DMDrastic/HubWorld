/**
 * With the fee model at its default (OFF), a recorded all-in amount changes NOTHING: this is the guarantee that
 * merging the new cap leaves today's behaviour alone. (Header of the sibling file follows.)
 * The resale cap under the NEW fee model, over HTTP: the lower of the organizer's policy and what the buyer
 * paid, enforced wherever a resale price can be set (auction reserve, bid) and shown to the seller.
 *
 * Same harness as resale-cap.routes.test.ts (real app, real session, real database; only the network faked),
 * with FEE_MODEL=v2. The fixed-price LISTING path is deliberately not here: its terms change with the new model
 * (the seller pays the fee) and it is tested with that change. The legacy cases are: a ticket with no recorded
 * amount keeps its policy exactly. Originally: the same boundary-from-outside approach as
 * `routes.authorization.test.ts`: a real Express app, a real session, a real
 * database. `checkResalePrice` is unit-tested in isolation
 * (`resale-policy.test.ts`); this pins that the three routes actually CALL it,
 * with the real ownership/eligibility checks still in front of it.
 *
 * Only the network is faked — `holdsNft`/`accountNfts` (ledger reads),
 * `accountFunding` (bid affordability), and `platformAddress` (broker
 * resolution — see below), plus Xaman. Nothing here submits a real
 * transaction.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import request from 'supertest'

const holdsNft = vi.fn<(address: string, nfTokenId: string) => Promise<boolean>>()
const accountNfts = vi.fn<(address: string) => Promise<{ NFTokenID: string }[]>>()
const accountFunding =
  vi.fn<(address: string) => Promise<{ spendableDrops: bigint; reserveIncDrops: bigint }>>()

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return {
    ...actual,
    holdsNft: (...a: Parameters<typeof holdsNft>) => holdsNft(...a),
    accountNfts: (...a: Parameters<typeof accountNfts>) => accountNfts(...a),
    accountFunding: (...a: Parameters<typeof accountFunding>) => accountFunding(...a),
    // listings.ts/open-auction.ts resolve this for real (unconditionally) when
    // creating a listing/auction, and it throws without PLATFORM_SEED set —
    // which CI genuinely has unset. Forcing brokerMode live (below) gets past
    // the "broker not configured" guard but does not make the real seed exist,
    // so this must be stubbed too, same as broker-health.test.ts does. Found
    // the hard way: this suite passed locally only because a real PLATFORM_SEED
    // happened to sit in .env, and failed in CI with none.
    platformAddress: () => 'rBrokerFixtureAddress0000000000000',
  }
})

vi.mock('../src/xaman.js', async () => {
  const actual = await vi.importActual<typeof import('../src/xaman.js')>('../src/xaman.js')
  let n = 0
  const created = () => {
    n += 1
    return {
      uuid: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
      next: 'https://xumm.app/sign/stub',
      qrPng: 'https://xumm.app/sign/stub.png',
    }
  }
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

// Same reasoning as routes.authorization.test.ts: brokerMode is read from
// PLATFORM_SEED, and the routes under test answer 503 without it — before
// ever reaching the cap check this suite exists to pin.
vi.mock('../src/env.js', async () => {
  const actual = await vi.importActual<typeof import('../src/env.js')>('../src/env.js')
  return { ...actual, brokerMode: 'live' as const }
})

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')

const app = createApp()

const UTAG = 'rv1_'
const STAG = 'rv1-'
const XRP = 1_000_000n

type Actor = { id: string; username: string; address: string; token: string }

let uniq = ''
let hexUniq = ''

async function mkUser(name: string, role: 'USER' | 'ORGANIZER' | 'ADMIN' = 'USER'): Promise<Actor> {
  const username = `${UTAG}${name}_${uniq}`.slice(0, 20)
  const user = await prisma.user.create({
    data: {
      username,
      xrplAddress: `r${UTAG}${name}${uniq}`.padEnd(28, 'x').slice(0, 33),
      role,
    },
  })
  const { token } = await createSession(user.id)
  return { id: user.id, username: user.username, address: user.xrplAddress, token }
}

function as(actor: Actor) {
  return `Bearer ${actor.token}`
}

type ResaleConfig = {
  resalePolicy?: 'UNRESTRICTED' | 'PERCENTAGE_CAP' | 'FIXED_CAP' | 'FACE_VALUE_ONLY' | 'DISABLED'
  resaleCapBps?: number
  resaleCapDrops?: bigint
}

async function mkEvent(organizer: Actor, opts: { ticketCount?: number } & ResaleConfig = {}) {
  return prisma.event.create({
    data: {
      network: NETWORK,
      slug: `${STAG}${uniq}`,
      title: 'Resale Cap Test Event',
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: organizer.id,
      nftTaxon: 70_000 + Math.floor(Math.random() * 9_000),
      royaltyBps: 500,
      platformBps: 250,
      ticketCount: opts.ticketCount ?? 10,
      status: 'PUBLISHED',
      resalePolicy: opts.resalePolicy ?? 'UNRESTRICTED',
      resaleCapBps: opts.resaleCapBps ?? null,
      resaleCapDrops: opts.resaleCapDrops ?? null,
    },
  })
}

async function mkTicket(
  eventId: string,
  owner: Actor,
  faceValueDrops: bigint | null = null,
  paid: { minor: bigint; currency: 'XRP' | 'USD' | 'RLUSD' } | null = null,
) {
  return prisma.ticket.create({
    data: {
      network: NETWORK,
      nfTokenId: `${hexUniq}${'0'.repeat(64)}`.slice(0, 64).toUpperCase(),
      eventId,
      ownerId: owner.id,
      ownerAddress: owner.address,
      status: 'MINTED',
      faceValueDrops,
      originalCostMinor: paid?.minor ?? null,
      originalCostCurrency: paid?.currency ?? null,
    },
  })
}

const eventWhere = {
  OR: [{ slug: { startsWith: STAG } }, { organizer: { username: { startsWith: UTAG } } }],
}

async function cleanup() {
  const byEvent = { ticket: { event: eventWhere } }
  await prisma.bid.deleteMany({ where: { auction: byEvent } })
  await prisma.listing.deleteMany({ where: { seller: { username: { startsWith: UTAG } } } })
  await prisma.auction.deleteMany({ where: byEvent })
  await prisma.ticket.deleteMany({ where: { event: eventWhere } })
  await prisma.event.deleteMany({ where: eventWhere })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: UTAG } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: UTAG } } })
}

beforeEach(async () => {
  uniq = Math.random().toString(36).slice(2, 8)
  hexUniq = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0')
  await cleanup()
  holdsNft.mockReset()
  accountNfts.mockReset()
  accountFunding.mockReset()
  holdsNft.mockResolvedValue(true)
  accountNfts.mockResolvedValue([])
  accountFunding.mockResolvedValue({ spendableDrops: 100_000n * XRP, reserveIncDrops: 200_000n })
})

afterEach(cleanup)
afterAll(async () => {
  await prisma.$disconnect()
})

const paid = (xrp: number) => ({ minor: BigInt(Math.round(xrp * 1_000_000)), currency: 'XRP' as const })

describe('fee model OFF: a recorded all-in amount is ignored', () => {
  it('an unrestricted policy still allows any reserve on a ticket whose buyer paid 8', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const event = await mkEvent(organizer, { ticketCount: 1, resalePolicy: 'UNRESTRICTED' })
    const ticket = await mkTicket(event.id, holder, null, paid(8))
    const res = await request(app).post(`/api/tickets/${ticket.nfTokenId}/auction`).set('Authorization', as(holder)).send({ reserveDrops: (1_000n * XRP).toString() })
    expect(res.status).toBe(201)
  })

  it('a free ticket (0 recorded) is not blocked either', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const event = await mkEvent(organizer, { ticketCount: 1, resalePolicy: 'UNRESTRICTED' })
    const ticket = await mkTicket(event.id, holder, null, paid(0))
    const res = await request(app).post(`/api/tickets/${ticket.nfTokenId}/auction`).set('Authorization', as(holder)).send({ reserveDrops: (5n * XRP).toString() })
    expect(res.status).toBe(201)
  })

  it('a bid is capped by the policy alone', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const bidder = await mkUser('bidder')
    const event = await mkEvent(organizer, { ticketCount: 1, resalePolicy: 'UNRESTRICTED' })
    const ticket = await mkTicket(event.id, holder, null, paid(8))
    const auction = await prisma.auction.create({
      data: { network: NETWORK, ticketId: ticket.id, startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 3_600_000), reserveDrops: 1n * XRP, status: 'LIVE' },
    })
    const res = await request(app).post(`/api/auctions/${auction.id}/bid`).set('Authorization', as(bidder)).send({ amountDrops: (500n * XRP).toString() })
    expect(res.status).toBe(201)
  })

  it('the seller\'s view shows no cap from this rule', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const event = await mkEvent(organizer, { ticketCount: 5, resalePolicy: 'UNRESTRICTED' })
    await mkTicket(event.id, holder, 6n * XRP, paid(8))
    const res = await request(app).get('/api/tickets/mine').set('Authorization', as(holder))
    const t = res.body.tickets?.[0] ?? res.body[0]
    expect(t.maxAuctionReserveDrops).toBeNull()
    expect(t.resaleCapSource).toBe('NONE')
  })

  it('opening an auction records no fee rate, so it settles at the event\'s rate as it always did', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const event = await mkEvent(organizer, { ticketCount: 1, resalePolicy: 'UNRESTRICTED' })
    const ticket = await mkTicket(event.id, holder, null, paid(8))
    const res = await request(app).post(`/api/tickets/${ticket.nfTokenId}/auction`).set('Authorization', as(holder)).send({ reserveDrops: (10n * XRP).toString() })
    expect(res.status).toBe(201)
    const auction = await prisma.auction.findFirstOrThrow({ where: { ticketId: ticket.id } })
    expect(auction.feeBps).toBeNull()
    const listing = await prisma.listing.findFirstOrThrow({ where: { auctionId: auction.id } })
    expect(listing.feeBps).toBeNull()
    // 2.5% of 10 XRP = 0.25 XRP, the event's rate.
    expect(listing.platformFeeDrops).toBe(250_000n)
  })
})
