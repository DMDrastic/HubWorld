/**
 * Resale price caps, over HTTP — the same boundary-from-outside approach as
 * `routes.authorization.test.ts`: a real Express app, a real session, a real
 * database. `checkResalePrice` is unit-tested in isolation
 * (`resale-policy.test.ts`); this pins that the three routes actually CALL it,
 * with the real ownership/eligibility checks still in front of it.
 *
 * Only the network is faked — `holdsNft`/`accountNfts` (ledger reads) and
 * `accountFunding` (bid affordability), plus Xaman. Nothing here submits a
 * real transaction.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { maxAskForCap } from '../src/resale-policy.js'

/** Every event in this suite uses this platformBps — see mkEvent. */
const PLATFORM_BPS = 250

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

const UTAG = 'rc_'
const STAG = 'rc-'
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

async function mkTicket(eventId: string, owner: Actor, faceValueDrops: bigint | null = null) {
  return prisma.ticket.create({
    data: {
      network: NETWORK,
      nfTokenId: `${hexUniq}${'0'.repeat(64)}`.slice(0, 64).toUpperCase(),
      eventId,
      ownerId: owner.id,
      ownerAddress: owner.address,
      status: 'MINTED',
      faceValueDrops,
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

// ------------------------------------------------------------------ list --

describe('POST /tickets/:nfTokenId/list', () => {
  it('refuses a price above a FIXED_CAP', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const event = await mkEvent(organizer, { resalePolicy: 'FIXED_CAP', resaleCapDrops: 100n * XRP })
    const ticket = await mkTicket(event.id, holder)

    const res = await request(app)
      .post(`/api/tickets/${ticket.nfTokenId}/list`)
      .set('Authorization', as(holder))
      .send({ priceDrops: (100n * XRP + 1n).toString() })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/limited resale prices to 100.000000 XRP/)
  })

  it('refuses an ask AT the raw cap, because the buyer pays ask + platform fee', async () => {
    // This is the fix under test: priceDrops alone is the seller's ask, not
    // what the buyer pays. An ask of exactly 100 XRP plus a 2.5% platform fee
    // means the buyer pays 102.5 XRP — over a 100 XRP cap on their total.
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const event = await mkEvent(organizer, { resalePolicy: 'FIXED_CAP', resaleCapDrops: 100n * XRP })
    const ticket = await mkTicket(event.id, holder)

    const res = await request(app)
      .post(`/api/tickets/${ticket.nfTokenId}/list`)
      .set('Authorization', as(holder))
      .send({ priceDrops: (100n * XRP).toString() })

    expect(res.status).toBe(400)
  })

  it('allows the largest ask whose buyer-paid total still clears the cap', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const event = await mkEvent(organizer, { resalePolicy: 'FIXED_CAP', resaleCapDrops: 100n * XRP })
    const ticket = await mkTicket(event.id, holder)
    const ask = maxAskForCap(100n * XRP, PLATFORM_BPS)

    const res = await request(app)
      .post(`/api/tickets/${ticket.nfTokenId}/list`)
      .set('Authorization', as(holder))
      .send({ priceDrops: ask.toString() })

    expect(res.status).toBe(201)
  })

  it('refuses a PERCENTAGE_CAP resale with no recorded face value', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const event = await mkEvent(organizer, { resalePolicy: 'PERCENTAGE_CAP', resaleCapBps: 12_000 })
    const ticket = await mkTicket(event.id, holder, null) // never minted with a price

    const res = await request(app)
      .post(`/api/tickets/${ticket.nfTokenId}/list`)
      .set('Authorization', as(holder))
      .send({ priceDrops: (1n * XRP).toString() })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no recorded face value/)
  })

  it('allows the largest ask whose total clears a PERCENTAGE_CAP of 120%', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const event = await mkEvent(organizer, { resalePolicy: 'PERCENTAGE_CAP', resaleCapBps: 12_000 })
    const ticket = await mkTicket(event.id, holder, 100n * XRP)
    const ask = maxAskForCap(120n * XRP, PLATFORM_BPS) // 120% of the 100 XRP face value

    const res = await request(app)
      .post(`/api/tickets/${ticket.nfTokenId}/list`)
      .set('Authorization', as(holder))
      .send({ priceDrops: ask.toString() })

    expect(res.status).toBe(201)
  })

  it('refuses any listing at all under DISABLED', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const event = await mkEvent(organizer, { resalePolicy: 'DISABLED' })
    const ticket = await mkTicket(event.id, holder)

    const res = await request(app)
      .post(`/api/tickets/${ticket.nfTokenId}/list`)
      .set('Authorization', as(holder))
      .send({ priceDrops: XRP.toString() })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/does not allow resale/)
  })

  it('exempts the organizer selling their own ticket, and backfills face value', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const event = await mkEvent(organizer, { resalePolicy: 'FIXED_CAP', resaleCapDrops: 10n * XRP })
    const ticket = await mkTicket(event.id, organizer, null) // minted to hold, no price yet

    // Priced well above the "cap" — allowed, because this is a primary sale.
    const res = await request(app)
      .post(`/api/tickets/${ticket.nfTokenId}/list`)
      .set('Authorization', as(organizer))
      .send({ priceDrops: (500n * XRP).toString() })

    expect(res.status).toBe(201)
    const updated = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })
    expect(updated.faceValueDrops).toBe(500n * XRP)
  })

  it('does NOT exempt the organizer re-listing a ticket that already has a face value', async () => {
    // The circumvention this guards against: a holder lists at the cap, the
    // organizer buys it back (nothing stops that — buy.ts only refuses buying
    // your OWN listing), then relists. If "seller is the organizer" alone were
    // exempt, the cap would be meaningless the moment the organizer bought one
    // ticket back.
    const organizer = await mkUser('org', 'ORGANIZER')
    const event = await mkEvent(organizer, { resalePolicy: 'FIXED_CAP', resaleCapDrops: 50n * XRP })
    // Face value already established — e.g. from the original mint-and-list —
    // and the ticket happens to be back with the organizer right now.
    const ticket = await mkTicket(event.id, organizer, 50n * XRP)

    const res = await request(app)
      .post(`/api/tickets/${ticket.nfTokenId}/list`)
      .set('Authorization', as(organizer))
      .send({ priceDrops: (10_000n * XRP).toString() })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/limited resale prices to 50.000000 XRP/)
  })

  it('UNRESTRICTED allows any price', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const event = await mkEvent(organizer, { resalePolicy: 'UNRESTRICTED' })
    const ticket = await mkTicket(event.id, holder)

    const res = await request(app)
      .post(`/api/tickets/${ticket.nfTokenId}/list`)
      .set('Authorization', as(holder))
      .send({ priceDrops: (1_000_000n * XRP).toString() })

    expect(res.status).toBe(201)
  })
})

// --------------------------------------------------------------- auction --

describe('POST /tickets/:nfTokenId/auction', () => {
  it('refuses a reserve above the cap, before the auction is created', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    // ticketCount 1, minted 1, held by a non-organizer -> sold out, eligible.
    const event = await mkEvent(organizer, {
      ticketCount: 1,
      resalePolicy: 'FIXED_CAP',
      resaleCapDrops: 50n * XRP,
    })
    const ticket = await mkTicket(event.id, holder)

    const res = await request(app)
      .post(`/api/tickets/${ticket.nfTokenId}/auction`)
      .set('Authorization', as(holder))
      .send({ reserveDrops: (51n * XRP).toString() })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/limited resale prices/)
    expect(await prisma.auction.count({ where: { ticketId: ticket.id } })).toBe(0)
  })

  it('allows a reserve at or below the cap', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const event = await mkEvent(organizer, {
      ticketCount: 1,
      resalePolicy: 'FIXED_CAP',
      resaleCapDrops: 50n * XRP,
    })
    const ticket = await mkTicket(event.id, holder)

    const res = await request(app)
      .post(`/api/tickets/${ticket.nfTokenId}/auction`)
      .set('Authorization', as(holder))
      .send({ reserveDrops: (50n * XRP).toString() })

    expect(res.status).toBe(201)
  })
})

// -------------------------------------------------------------------- bid --

describe('POST /auctions/:id/bid', () => {
  async function liveAuction(opts: ResaleConfig & { faceValueDrops?: bigint | null } = {}) {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const bidder = await mkUser('bidder')
    const event = await mkEvent(organizer, { ticketCount: 1, ...opts })
    const ticket = await mkTicket(event.id, holder, opts.faceValueDrops ?? null)
    const auction = await prisma.auction.create({
      data: {
        network: NETWORK,
        ticketId: ticket.id,
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 3_600_000),
        reserveDrops: 10n * XRP,
        status: 'LIVE',
      },
    })
    return { organizer, holder, bidder, event, ticket, auction }
  }

  it('refuses a bid above the cap, even though it clears the reserve', async () => {
    const { bidder, auction } = await liveAuction({
      resalePolicy: 'FIXED_CAP',
      resaleCapDrops: 50n * XRP,
    })

    const res = await request(app)
      .post(`/api/auctions/${auction.id}/bid`)
      .set('Authorization', as(bidder))
      .send({ amountDrops: (51n * XRP).toString() })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/limited resale prices to 50.000000 XRP/)
    expect(await prisma.bid.count({ where: { auctionId: auction.id } })).toBe(0)
  })

  it('allows a bid at exactly the cap', async () => {
    const { bidder, auction } = await liveAuction({
      resalePolicy: 'FIXED_CAP',
      resaleCapDrops: 50n * XRP,
    })

    const res = await request(app)
      .post(`/api/auctions/${auction.id}/bid`)
      .set('Authorization', as(bidder))
      .send({ amountDrops: (50n * XRP).toString() })

    expect(res.status).toBe(201)
  })

  it('refuses a bid once face value is missing under PERCENTAGE_CAP', async () => {
    const { bidder, auction } = await liveAuction({
      resalePolicy: 'PERCENTAGE_CAP',
      resaleCapBps: 12_000,
      faceValueDrops: null,
    })

    const res = await request(app)
      .post(`/api/auctions/${auction.id}/bid`)
      .set('Authorization', as(bidder))
      .send({ amountDrops: (10n * XRP).toString() })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no recorded face value/)
  })
})
