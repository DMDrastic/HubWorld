/**
 * Turning FEE_MODEL back OFF is a safe undo, at the buy route: a listing made under the new terms asks its buyer for what
 * IT recorded (the price alone), not what a v1 process would charge on a new listing (price + fee).
 *
 * The buying cases of `listing-v2.routes.test.ts`, run in a process where FEE_MODEL is NOT set. The listings are created
 * directly with their recorded model, as they would exist after a restart with the switch off.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'


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
const { feeModelV2 } = await import('../src/env.js')
const { NETWORK } = await import('../src/network.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')

const app = createApp()

const UTAG = 'lu2_'
const STAG = 'lu2-'
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

describe('this file really runs with the model OFF', () => {
  it('FEE_MODEL is not v2 in this process (or the whole file proves nothing)', () => {
    expect(feeModelV2).toBe(false)
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
