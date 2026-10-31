/**
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

vi.hoisted(() => {
  process.env.FEE_MODEL = 'v2'
})

import request from 'supertest'
import { maxAskForCap } from '../src/resale-policy.js'

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

const UTAG = 'rv2_'
const STAG = 'rv2-'
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

// --------------------------------------------------------------- auction --

const paid = (xrp: number) => ({ minor: BigInt(Math.round(xrp * 1_000_000)), currency: 'XRP' as const })

describe('opening an auction: the reserve may not exceed what the buyer paid', () => {
  async function open(opts: ResaleConfig & { paidXrp?: number | null; face?: bigint | null }, reserve: bigint) {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const event = await mkEvent(organizer, { ticketCount: 1, ...opts })
    const ticket = await mkTicket(event.id, holder, opts.face ?? null, opts.paidXrp === null || opts.paidXrp === undefined ? null : paid(opts.paidXrp))
    const res = await request(app).post(`/api/tickets/${ticket.nfTokenId}/auction`).set('Authorization', as(holder)).send({ reserveDrops: reserve.toString() })
    return { res, ticket }
  }

  it('amount paid wins when the policy is looser: unrestricted, 8 paid, a reserve of 9 is refused and 8 is allowed', async () => {
    const refused = await open({ resalePolicy: 'UNRESTRICTED', paidXrp: 8 }, 9n * XRP)
    expect(refused.res.status).toBe(400)
    expect(refused.res.body.error).toMatch(/at most what its buyer paid, 8\.000000 XRP/)
    expect(await prisma.auction.count({ where: { ticketId: refused.ticket.id } })).toBe(0)
  })

  it('and the amount itself is allowed', async () => {
    const { res } = await open({ resalePolicy: 'UNRESTRICTED', paidXrp: 8 }, 8n * XRP)
    expect(res.status).toBe(201)
  })

  it('policy wins when it is stricter: a fixed cap of 5, 8 paid, a reserve of 6 is refused naming the organizer\'s limit', async () => {
    const { res } = await open({ resalePolicy: 'FIXED_CAP', resaleCapDrops: 5n * XRP, paidXrp: 8 }, 6n * XRP)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/organizer has limited resale prices to 5\.000000 XRP/)
  })

  it('a percentage cap that allows 9 against 8 paid is held to 8', async () => {
    const { res } = await open({ resalePolicy: 'PERCENTAGE_CAP', resaleCapBps: 15_000, face: 6n * XRP, paidXrp: 8 }, 9n * XRP)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/what its buyer paid/)
  })

  it('DISABLED stays disabled however much was paid', async () => {
    const { res } = await open({ resalePolicy: 'DISABLED', paidXrp: 8 }, 1n * XRP)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/does not allow resale/)
  })

  it('a ticket that was free cannot be put up for money, and the seller is told why', async () => {
    const { res } = await open({ resalePolicy: 'UNRESTRICTED', paidXrp: 0 }, 1n * XRP)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/free/i)
  })

  it('a ticket with NO recorded amount keeps its policy exactly: unrestricted still allows anything', async () => {
    const { res } = await open({ resalePolicy: 'UNRESTRICTED', paidXrp: null }, 1_000_000n * XRP)
    expect(res.status).toBe(201)
  })

  it('a ticket with no recorded amount under a fixed cap is held to the cap alone', async () => {
    const ok = await open({ resalePolicy: 'FIXED_CAP', resaleCapDrops: 50n * XRP, paidXrp: null }, 50n * XRP)
    expect(ok.res.status).toBe(201)
  })
})

// ------------------------------------------------------------------ listing --

describe('a fixed-price listing: what the BUYER pays may not exceed what the ticket\'s buyer paid', () => {
  // The listing's terms are still the buyer-pays ones here (the fee is added on top of the ask); when the
  // listing terms change with the new model, this is the test that changes with them.
  const list = async (opts: ResaleConfig & { paidXrp: number | null }, ask: bigint) => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const event = await mkEvent(organizer, { ticketCount: 5, ...opts })
    const ticket = await mkTicket(event.id, holder, 6n * XRP, opts.paidXrp === null ? null : paid(opts.paidXrp))
    return request(app).post(`/api/tickets/${ticket.nfTokenId}/list`).set('Authorization', as(holder)).send({ priceDrops: ask.toString() })
  }

  it('unrestricted, 8 paid: the largest ask whose total clears 8 is allowed', async () => {
    const res = await list({ resalePolicy: 'UNRESTRICTED', paidXrp: 8 }, maxAskForCap(8n * XRP, 250))
    expect(res.status).toBe(201)
  })

  it('and an ask of exactly 8, whose buyer would pay 8.2, is refused, saying it is what the buyer paid', async () => {
    // (maxAskForCap is a safe lower bound rather than an exact edge, so the refusal is tested well clear of it.)
    const res = await list({ resalePolicy: 'UNRESTRICTED', paidXrp: 8 }, 8n * XRP)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/what its buyer paid/)
  })

  it('a ticket with no recorded amount lists at whatever its policy allows', async () => {
    expect((await list({ resalePolicy: 'UNRESTRICTED', paidXrp: null }, 1_000n * XRP)).status).toBe(201)
  })
})

// -------------------------------------------------------------------- bid --

describe('bidding: a bid may not exceed what the ticket\'s buyer paid', () => {
  async function liveAuction(opts: ResaleConfig & { paidXrp?: number | null }) {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const bidder = await mkUser('bidder')
    const event = await mkEvent(organizer, { ticketCount: 1, ...opts })
    const ticket = await mkTicket(event.id, holder, null, opts.paidXrp === null || opts.paidXrp === undefined ? null : paid(opts.paidXrp))
    const auction = await prisma.auction.create({
      data: { network: NETWORK, ticketId: ticket.id, startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 3_600_000), reserveDrops: 1n * XRP, status: 'LIVE' },
    })
    return { bidder, auction }
  }
  const bid = (bidder: Actor, auctionId: string, amount: bigint) =>
    request(app).post(`/api/auctions/${auctionId}/bid`).set('Authorization', as(bidder)).send({ amountDrops: amount.toString() })

  it('refuses a bid above the amount paid even under an unrestricted policy, and allows the amount itself', async () => {
    const { bidder, auction } = await liveAuction({ resalePolicy: 'UNRESTRICTED', paidXrp: 8 })
    const over = await bid(bidder, auction.id, 8n * XRP + 1n)
    expect(over.status).toBe(400)
    expect(over.body.error).toMatch(/what its buyer paid/)
    expect(await prisma.bid.count({ where: { auctionId: auction.id } })).toBe(0)
    expect((await bid(bidder, auction.id, 8n * XRP)).status).toBe(201)
  })

  it('a ticket with no recorded amount accepts a bid its policy allows', async () => {
    const { bidder, auction } = await liveAuction({ resalePolicy: 'UNRESTRICTED', paidXrp: null })
    expect((await bid(bidder, auction.id, 1_000n * XRP)).status).toBe(201)
  })
})

// ------------------------------------------------- what the seller is shown --

describe('GET /tickets/mine tells the seller the cap and where it comes from', () => {
  async function mine(opts: ResaleConfig & { paidXrp: number | null; face?: bigint | null }) {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const event = await mkEvent(organizer, { ticketCount: 5, ...opts })
    await mkTicket(event.id, holder, opts.face ?? 6n * XRP, opts.paidXrp === null ? null : paid(opts.paidXrp))
    const res = await request(app).get('/api/tickets/mine').set('Authorization', as(holder))
    return res.body.tickets?.[0] ?? res.body[0]
  }

  it('unrestricted with 8 paid: capped at 8, and the source is what was paid', async () => {
    const t = await mine({ resalePolicy: 'UNRESTRICTED', paidXrp: 8 })
    expect(t.maxAuctionReserveDrops).toBe((8n * XRP).toString())
    expect(t.resaleCapSource).toBe('PAID')
  })

  it('a fixed cap of 5 with 8 paid: capped at 5, and the source is the organizer\'s policy', async () => {
    const t = await mine({ resalePolicy: 'FIXED_CAP', resaleCapDrops: 5n * XRP, paidXrp: 8 })
    expect(t.maxAuctionReserveDrops).toBe((5n * XRP).toString())
    expect(t.resaleCapSource).toBe('POLICY')
  })

  it('a ticket with no recorded amount: no limit from this rule, exactly as before', async () => {
    const t = await mine({ resalePolicy: 'UNRESTRICTED', paidXrp: null })
    expect(t.maxAuctionReserveDrops).toBeNull()
    expect(t.resaleCapSource).toBe('NONE')
  })
})
