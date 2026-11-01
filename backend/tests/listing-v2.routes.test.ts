/**
 * Creating and buying a listing under the NEW fee model, over HTTP. Written before the code.
 * (Harness shared with resale-cap-v2.routes.test.ts, whose header follows.)
 *
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
  process.env.XRP_USD_CENTS = '134'
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

const UTAG = 'lv2_'
const STAG = 'lv2-'
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

describe('a RESALE listing under the new model: the seller pays the fee', () => {
  async function fixture(opts: ResaleConfig & { paidXrp?: number | null } = {}) {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const event = await mkEvent(organizer, { ticketCount: 5, ...opts })
    const ticket = await mkTicket(event.id, holder, 6n * XRP, opts.paidXrp === undefined || opts.paidXrp === null ? null : paid(opts.paidXrp))
    return { organizer, holder, event, ticket }
  }

  it('10 XRP: the buyer pays 10, the fee is 0.5, the sell offer on the ledger is 9.5', async () => {
    const { holder, ticket } = await fixture({ paidXrp: 12 })
    const res = await list(holder, ticket.nfTokenId, 10n * XRP)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ priceDrops: '10000000', platformFeeDrops: '500000', feeModel: 'SELLER_PAYS_V2' })
    expect(payloadTxs).toHaveLength(1)
    expect(payloadTxs[0]).toMatchObject({ TransactionType: 'NFTokenCreateOffer', Amount: '9500000' })
    const row = await prisma.listing.findUniqueOrThrow({ where: { id: res.body.listingId } })
    expect(row).toMatchObject({ feeModel: 'SELLER_PAYS_V2', feeBps: 500, isPrimarySale: false, priceDrops: 10n * XRP, platformFeeDrops: 500_000n })
  })

  it('refuses a price below the US$5 floor (3.731344 XRP at 134 cents), allows exactly the floor, and creates nothing when refused', async () => {
    const a = await fixture({ paidXrp: 12 })
    const under = await list(a.holder, a.ticket.nfTokenId, 3_731_343n)
    expect(under.status).toBe(400)
    expect(under.body.error).toMatch(/at least 3\.731344 XRP/)
    expect(await prisma.listing.count({ where: { ticketId: a.ticket.id } })).toBe(0)
    expect(payloadTxs).toHaveLength(0)
    expect((await list(a.holder, a.ticket.nfTokenId, 3_731_344n)).status).toBe(201)
  })

  it('the cap is what the buyer pays, with no fee added on top: 8 paid allows an ask of 8 and not one drop more', async () => {
    const a = await fixture({ resalePolicy: 'UNRESTRICTED', paidXrp: 8 })
    expect((await list(a.holder, a.ticket.nfTokenId, 8n * XRP)).status).toBe(201)
  })

  it('and one drop above what was paid is refused, saying so', async () => {
    const a = await fixture({ resalePolicy: 'UNRESTRICTED', paidXrp: 8 })
    const over = await list(a.holder, a.ticket.nfTokenId, 8n * XRP + 1n)
    expect(over.status).toBe(400)
    expect(over.body.error).toMatch(/what its buyer paid/)
    expect(over.body.maxResaleDrops).toBe((8n * XRP).toString())
  })

  it('a ticket that was free cannot be listed for money', async () => {
    const a = await fixture({ resalePolicy: 'UNRESTRICTED', paidXrp: 0 })
    const res = await list(a.holder, a.ticket.nfTokenId, 10n * XRP)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/free/i)
  })

  it('an older ticket (no recorded amount) is held to its policy alone, but still to the floor, and the seller still pays the fee', async () => {
    const a = await fixture({ resalePolicy: 'UNRESTRICTED', paidXrp: null })
    const res = await list(a.holder, a.ticket.nfTokenId, 1_000n * XRP)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ platformFeeDrops: (50n * XRP).toString(), feeModel: 'SELLER_PAYS_V2' })
  })
})

describe('a FIRST sale listed by the organizer keeps the buyer-pays shape, with the new fan fee', () => {
  async function primary(opts: { founding?: boolean; startsAt?: Date } = {}) {
    const organizer = await mkUser('org', 'ORGANIZER', opts.founding ?? false)
    const event = await mkEvent(organizer, { ticketCount: 5 })
    if (opts.startsAt) await prisma.event.update({ where: { id: event.id }, data: { startsAt: opts.startsAt } })
    const ticket = await mkTicket(event.id, organizer, null)
    return { organizer, ticket }
  }

  it('20 XRP: the organizer is offered 20, the buyer will pay 20.7, recorded at 350 bps as a first sale', async () => {
    const { organizer, ticket } = await primary()
    const res = await list(organizer, ticket.nfTokenId, 20n * XRP)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ priceDrops: '20000000', platformFeeDrops: '700000' })
    expect(payloadTxs[0]).toMatchObject({ Amount: '20000000' })
    const row = await prisma.listing.findUniqueOrThrow({ where: { id: res.body.listingId } })
    expect(row).toMatchObject({ feeModel: 'BUYER_PAYS_V1', feeBps: 350, isPrimarySale: true })
  })

  it('a founding organizer\'s event inside the window pays the lower fan fee: 0.6, at 300 bps', async () => {
    const { organizer, ticket } = await primary({ founding: true })
    const res = await list(organizer, ticket.nfTokenId, 20n * XRP)
    expect(res.body).toMatchObject({ platformFeeDrops: '600000' })
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: res.body.listingId } })).feeBps).toBe(300)
  })

  it('a founding organizer\'s event after the window pays the standard fee', async () => {
    const { organizer, ticket } = await primary({ founding: true, startsAt: new Date('2028-06-01T12:00:00Z') })
    const res = await list(organizer, ticket.nfTokenId, 20n * XRP)
    expect(res.body).toMatchObject({ platformFeeDrops: '700000' })
  })

  it('has no resale floor: a first sale can be priced at 1 XRP', async () => {
    const { organizer, ticket } = await primary()
    expect((await list(organizer, ticket.nfTokenId, 1n * XRP)).status).toBe(201)
  })
})

describe('buying: the bid is what THAT listing says the buyer owes', () => {
  async function activeListing(feeModel: 'BUYER_PAYS_V1' | 'SELLER_PAYS_V2', fee: bigint) {
    const organizer = await mkUser('org', 'ORGANIZER')
    const seller = await mkUser('seller')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(organizer, { ticketCount: 5 })
    const ticket = await mkTicket(event.id, seller, 6n * XRP)
    const l = await prisma.listing.create({
      data: {
        network: NETWORK,
        ticketId: ticket.id,
        sellerId: seller.id,
        sellerAddress: seller.address,
        brokerAddress: 'rBrokerFixtureAddress0000000000000',
        priceDrops: 10n * XRP,
        platformFeeDrops: fee,
        feeModel,
        feeBps: feeModel === 'SELLER_PAYS_V2' ? 500 : null,
        listPayloadUuid: `00000000-0000-4000-9000-${Math.floor(Math.random() * 1e12).toString().padStart(12, '0')}`,
        offerIndex: 'AA'.repeat(32),
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 600_000),
      },
    })
    return { buyer, l }
  }
  const buy = (buyer: Actor, id: string) => request(app).post(`/api/listings/${id}/buy`).set('Authorization', as(buyer))

  it('a V2 listing: the bid is exactly the price', async () => {
    const { buyer, l } = await activeListing('SELLER_PAYS_V2', 500_000n)
    const res = await buy(buyer, l.id)
    expect(res.status).toBe(201)
    expect(res.body.paysDrops).toBe('10000000')
    expect(payloadTxs[0]).toMatchObject({ Amount: '10000000' })
  })

  it('a V1 listing, even with the new model on: the bid is still the price plus the fee', async () => {
    const { buyer, l } = await activeListing('BUYER_PAYS_V1', 250_000n)
    const res = await buy(buyer, l.id)
    expect(res.status).toBe(201)
    expect(res.body.paysDrops).toBe('10250000')
    expect(payloadTxs[0]).toMatchObject({ Amount: '10250000' })
  })
})
