/**
 * The resale floor follows the fetched XRP price, over HTTP. Written before the code.
 *
 * With the price feed ON and no manual number, the US$5 floor comes from the newest stored reading. No reading, or one
 * more than a day old, means NO floor can be computed, and then new resale listings and auctions wait ("try again
 * shortly") instead of being priced against a guess. A first sale by the organizer has no floor, so it is unaffected.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.FEE_MODEL = 'v2'
  process.env.PRICE_FEED = 'on'
  // Set but empty: treated as absent, and dotenv will not fill it from a developer's .env.
  process.env.XRP_USD_CENTS = ''
})

import request from 'supertest'
import { maxAskForCap } from '../src/resale-policy.js'

const payloadTxs: Array<Record<string, unknown>> = []
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
      createPayload: async (tx: unknown) => {
        payloadTxs.push(tx as Record<string, unknown>)
        return created()
      },
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

const UTAG = 'pf_'
const STAG = 'pf-'
const XRP = 1_000_000n

type Actor = { id: string; username: string; address: string; token: string }

let uniq = ''
let hexUniq = ''

async function mkUser(name: string, role: 'USER' | 'ORGANIZER' | 'ADMIN' = 'USER', founding = false): Promise<Actor> {
  const username = `${UTAG}${name}_${uniq}`.slice(0, 20)
  const user = await prisma.user.create({
    data: {
      username,
      xrplAddress: `r${UTAG}${name}${uniq}`.padEnd(28, 'x').slice(0, 33),
      role,
      foundingOrganizer: founding,
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
  await prisma.priceReading.deleteMany({})
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
  payloadTxs.length = 0
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

const list = (holder: Actor, nfTokenId: string, price: bigint) =>
  request(app).post(`/api/tickets/${nfTokenId}/list`).set('Authorization', as(holder)).send({ priceDrops: price.toString() })


const reading = (micro: bigint, agoMs = 60_000) =>
  prisma.priceReading.create({ data: { microUsd: micro, detail: {}, createdAt: new Date(Date.now() - agoMs) } })

const open = (holder: Actor, nfTokenId: string, reserve: bigint) =>
  request(app).post(`/api/tickets/${nfTokenId}/auction`).set('Authorization', as(holder)).send({ reserveDrops: reserve.toString() })

async function fixture() {
  const organizer = await mkUser('org', 'ORGANIZER')
  const holder = await mkUser('holder')
  const event = await mkEvent(organizer, { ticketCount: 1 })
  const ticket = await mkTicket(event.id, holder, 6n * XRP, paid(12))
  return { organizer, holder, event, ticket }
}

describe('a resale listing: the floor is the newest reading', () => {
  it('at $1.25 the floor is exactly 4 XRP: one drop under is refused in words, the floor itself is allowed', async () => {
    await reading(1_250_000n)
    const a = await fixture()
    const under = await list(a.holder, a.ticket.nfTokenId, 3_999_999n)
    expect(under.status).toBe(400)
    expect(under.body.error).toMatch(/at least 4\.000000 XRP/)
    expect(await prisma.listing.count({ where: { ticketId: a.ticket.id } })).toBe(0)
    expect((await list(a.holder, a.ticket.nfTokenId, 4_000_000n)).status).toBe(201)
  })

  it('uses the NEWEST reading: when the price rises the floor falls, and the next listing sees it', async () => {
    await reading(1_000_000n, 3_600_000) // an hour ago: floor 5 XRP
    await reading(2_000_000n, 60_000) // now: floor 2.5 XRP
    const a = await fixture()
    expect((await list(a.holder, a.ticket.nfTokenId, 2_500_000n)).status).toBe(201)
  })

  it('with NO reading at all, waits: 503, a code, nothing created, nothing for the seller to sign', async () => {
    const a = await fixture()
    const res = await list(a.holder, a.ticket.nfTokenId, 10n * XRP)
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('PRICE_UNAVAILABLE')
    expect(res.body.error).toMatch(/try again/i)
    expect(await prisma.listing.count({ where: { ticketId: a.ticket.id } })).toBe(0)
    expect(payloadTxs).toHaveLength(0)
  })

  it('with a reading just over a day old, waits too (a stale price is not guessed at, here with no manual fallback)', async () => {
    await reading(1_250_000n, 24 * 3_600_000 + 60_000)
    const a = await fixture()
    expect((await list(a.holder, a.ticket.nfTokenId, 10n * XRP)).status).toBe(503)
  })

  it('a reading just under a day old is still good', async () => {
    await reading(1_250_000n, 24 * 3_600_000 - 60_000)
    const a = await fixture()
    expect((await list(a.holder, a.ticket.nfTokenId, 10n * XRP)).status).toBe(201)
  })

  it('the organizer\'s FIRST sale has no floor, so it goes ahead with no price at all', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const event = await mkEvent(organizer, { ticketCount: 5 })
    const ticket = await mkTicket(event.id, organizer, null)
    const res = await list(organizer, ticket.nfTokenId, 1n * XRP)
    expect(res.status).toBe(201)
  })
})

describe('opening an auction: the same floor, the same wait', () => {
  it('refuses a reserve under the floor at the fetched price, and allows exactly the floor', async () => {
    await reading(1_250_000n)
    const a = await fixture()
    expect((await open(a.holder, a.ticket.nfTokenId, 3_999_999n)).status).toBe(400)
    expect(await prisma.auction.count({ where: { ticketId: a.ticket.id } })).toBe(0)
    expect((await open(a.holder, a.ticket.nfTokenId, 4_000_000n)).status).toBe(201)
  })

  it('waits when there is no usable price: 503, and no auction is created', async () => {
    const a = await fixture()
    const res = await open(a.holder, a.ticket.nfTokenId, 10n * XRP)
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('PRICE_UNAVAILABLE')
    expect(await prisma.auction.count({ where: { ticketId: a.ticket.id } })).toBe(0)
  })
})

describe('GET /api/policy tells the seller\'s form the floor', () => {
  it('gives the floor in drops at the fetched price', async () => {
    await reading(1_250_000n)
    const res = await request(app).get('/api/policy')
    expect(res.body.minResaleDrops).toBe('4000000')
    expect(res.body.resaleFloorAvailable).toBe(true)
  })

  it('says plainly that there is none right now, and does not invent one', async () => {
    const res = await request(app).get('/api/policy')
    expect(res.body.minResaleDrops).toBeUndefined()
    expect(res.body.resaleFloorAvailable).toBe(false)
  })
})
