/**
 * What a sale costs the buyer and what the broker takes, per listing, once settlement runs. Written before the code.
 * (Harness shared with listing-advance.test.ts, whose header follows.)
 *
 * Moving a sale forward when nobody is polling.
 *
 * A box-office buyer signs on their phone; the page that was polling is a tab on
 * a laptop they have since closed. These pin that the sweep finishes the sale for
 * them, and — the part that bites — that two drivers advancing one sale
 * (the buyer's poll AND the sweep) broker it once, because a second broker
 * attempt finds the offers already consumed and marks a completed sale FAILED.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  // The new model is ON for this whole file: the point is that each listing keeps the terms it was created under.
  process.env.FEE_MODEL = 'v2'
  process.env.XRP_USD_CENTS = '134'
})

import { Wallet } from 'xrpl'

const BROKER = Wallet.generate().classicAddress

const brokerSale = vi.fn<(p: { sellOfferIndex: string; buyOfferIndex: string; brokerFeeDrops: bigint }) => Promise<{ hash: string; succeeded: boolean; result: string }>>()
const tryGetPayload = vi.fn<(u: string) => Promise<unknown>>()
const txSucceeded = vi.fn<(h: string) => Promise<boolean | null>>()
const offerIndexFromTx = vi.fn<(h: string) => Promise<string | null>>()
const spendableDrops = vi.fn<(a: string) => Promise<bigint>>()
const cancelOffers = vi.fn<(i: string[]) => Promise<void>>()

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return {
    ...actual,
    brokerSale: (p: Parameters<typeof brokerSale>[0]) => brokerSale(p),
    txSucceeded: (h: string) => txSucceeded(h),
    offerIndexFromTx: (h: string) => offerIndexFromTx(h),
    spendableDrops: (a: string) => spendableDrops(a),
    platformAddress: () => BROKER,
  }
})
vi.mock('../src/xaman.js', async () => {
  const actual = await vi.importActual<typeof import('../src/xaman.js')>('../src/xaman.js')
  return { ...actual, tryGetPayload: (u: string) => tryGetPayload(u) }
})
vi.mock('../src/primary-sale-ledger.js', () => ({
  defaultPrimarySaleLedger: () => ({ cancelOffers: (i: string[]) => cancelOffers(i) }),
}))

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { advanceListing, advanceStuckSales } = await import('../src/listing-advance.js')
const { acquireLock, releaseLock } = await import('../src/job-lock.js')

const UTAG = 'lt_'
let uniq = ''
let n = 0
const old = (ms: number) => new Date(Date.now() - ms)

async function mkUser(name: string, role: 'USER' | 'ORGANIZER' = 'USER') {
  return prisma.user.create({
    data: { username: `${UTAG}${name}_${uniq}`.slice(0, 20), xrplAddress: Wallet.generate().classicAddress, role },
  })
}

async function mkSale(opts: {
  status: 'BUYER_PENDING' | 'SETTLING' | 'ACTIVE'
  reserved?: boolean
  listedAgoMs?: number
  buyTx?: string
  feeModel?: 'BUYER_PAYS_V1' | 'SELLER_PAYS_V2'
  priceDrops?: bigint
  platformFeeDrops?: bigint
  feeBps?: number | null
  isPrimarySale?: boolean
  ticketOriginalCost?: bigint | null
}) {
  n += 1
  const org = await mkUser(`o${n}`, 'ORGANIZER')
  const buyer = await mkUser(`b${n}`)
  const event = await prisma.event.create({
    data: {
      network: NETWORK,
      slug: `lt-${uniq}-${n}`,
      title: 'Advance Test',
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: org.id,
      nftTaxon: 90_000 + n,
      royaltyBps: 500,
      platformBps: 250,
      ticketCount: 5,
      status: 'PUBLISHED',
    },
  })
  const ticket = await prisma.ticket.create({
    data: {
      nfTokenId: `${uniq}${n}`.padEnd(64, 'A').toUpperCase().replace(/[^0-9A-F]/g, 'A'),
      network: NETWORK,
      eventId: event.id,
      ownerId: org.id,
      ownerAddress: org.xrplAddress,
      status: 'LISTED',
      ...(opts.ticketOriginalCost !== undefined && opts.ticketOriginalCost !== null
        ? { originalCostMinor: opts.ticketOriginalCost, originalCostCurrency: 'XRP' as const }
        : {}),
    },
  })
  const hex = `${uniq}${n}`.replace(/[^0-9a-f]/g, '0').padEnd(12, '0').slice(0, 12)
  const listing = await prisma.listing.create({
    data: {
      network: NETWORK,
      ticketId: ticket.id,
      sellerId: org.id,
      sellerAddress: org.xrplAddress,
      brokerAddress: BROKER,
      priceDrops: opts.priceDrops ?? 25_000_000n,
      platformFeeDrops: opts.platformFeeDrops ?? 625_000n,
      ...(opts.feeModel ? { feeModel: opts.feeModel } : {}),
      feeBps: opts.feeBps ?? null,
      isPrimarySale: opts.isPrimarySale ?? false,
      listPayloadUuid: `delegate:${hex}${n}`,
      buyPayloadUuid: `00000000-0000-4000-8000-${hex}`,
      offerIndex: 'AA'.repeat(32),
      buyOfferIndex: opts.status === 'SETTLING' ? 'BB'.repeat(32) : null,
      buyerId: buyer.id,
      buyerAddress: buyer.xrplAddress,
      reservedForId: opts.reserved === false ? null : buyer.id,
      status: opts.status,
      listedAt: old(opts.listedAgoMs ?? 120_000),
      expiresAt: new Date(Date.now() + 300_000),
    },
  })
  return { org, buyer, event, ticket, listing }
}

async function cleanup() {
  const ev = { event: { slug: { startsWith: 'lt-' } } }
  await prisma.listing.deleteMany({ where: { ticket: ev } })
  await prisma.transfer.deleteMany({ where: { ticket: ev } })
  await prisma.ticket.deleteMany({ where: ev })
  await prisma.event.deleteMany({ where: { slug: { startsWith: 'lt-' } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: UTAG } } })
  await prisma.$executeRaw`DELETE FROM "JobLock" WHERE "name" LIKE 'listing:%' AND "owner" = 'x'`
}

beforeEach(async () => {
  uniq = Math.random().toString(16).slice(2, 7)
  n = 0
  await cleanup()
  brokerSale.mockReset().mockResolvedValue({ hash: 'H'.repeat(64), succeeded: true, result: 'tesSUCCESS' })
  tryGetPayload.mockReset().mockResolvedValue({ signed: false, cancelled: false, expired: false, account: null, txid: null })
  txSucceeded.mockReset().mockResolvedValue(true)
  offerIndexFromTx.mockReset().mockResolvedValue('BB'.repeat(32))
  spendableDrops.mockReset().mockResolvedValue(1_000_000_000n)
  cancelOffers.mockReset().mockResolvedValue(undefined)
})
afterEach(cleanup)
afterAll(async () => {
  await prisma.$disconnect()
})


const XRP = 1_000_000n

describe('settling a listing keeps the terms it was created under', () => {
  it('V1 (buyer pays on top): the buyer owes price + fee, and the broker is paid the fee, exactly as today', async () => {
    // 25 XRP ask, 0.625 fee: the buyer's bid is 25.625.
    const { listing } = await mkSale({ status: 'SETTLING', priceDrops: 25n * XRP, platformFeeDrops: 625_000n })
    spendableDrops.mockResolvedValue(25n * XRP + 624_999n) // one drop short of price + fee
    await advanceListing(listing.id)
    expect(brokerSale).not.toHaveBeenCalled()

    spendableDrops.mockResolvedValue(25n * XRP + 625_000n)
    await advanceListing(listing.id)
    expect(brokerSale).toHaveBeenCalledWith(expect.objectContaining({ brokerFeeDrops: 625_000n }))
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe('SOLD')
  })

  it('V2 (seller pays): the buyer owes exactly the price, and the broker is paid the fee', async () => {
    // 25 XRP price, 1.25 fee (5%): the buyer's bid is 25, the sell offer was 23.75.
    const { listing } = await mkSale({ status: 'SETTLING', feeModel: 'SELLER_PAYS_V2', priceDrops: 25n * XRP, platformFeeDrops: 1_250_000n, feeBps: 500 })
    spendableDrops.mockResolvedValue(25n * XRP - 1n) // one drop short of the PRICE
    await advanceListing(listing.id)
    expect(brokerSale).not.toHaveBeenCalled()

    spendableDrops.mockResolvedValue(25n * XRP)
    await advanceListing(listing.id)
    expect(brokerSale).toHaveBeenCalledTimes(1)
    expect(brokerSale).toHaveBeenCalledWith(expect.objectContaining({ brokerFeeDrops: 1_250_000n }))
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe('SOLD')
  })

  it('a V2 buyer who has only the price is NOT told to find price + fee', async () => {
    const { listing } = await mkSale({ status: 'SETTLING', feeModel: 'SELLER_PAYS_V2', priceDrops: 25n * XRP, platformFeeDrops: 1_250_000n, feeBps: 500 })
    spendableDrops.mockResolvedValue(25n * XRP) // exactly the price, which is less than price + fee
    const res = await advanceListing(listing.id)
    expect(res?.state).toBe('sold')
  })
})

describe('what a listing looks like to a buyer', () => {
  it('V1 shows price, fee, and price + fee; V2 shows the price as the whole of what is paid', async () => {
    const v1 = await mkSale({ status: 'ACTIVE', priceDrops: 25n * XRP, platformFeeDrops: 625_000n })
    const v2 = await mkSale({ status: 'ACTIVE', feeModel: 'SELLER_PAYS_V2', priceDrops: 25n * XRP, platformFeeDrops: 1_250_000n, feeBps: 500 })
    const view1 = await advanceListing(v1.listing.id)
    const view2 = await advanceListing(v2.listing.id)
    expect(view1).toMatchObject({ priceDrops: '25000000', platformFeeDrops: '625000', buyerPaysDrops: '25625000', feeModel: 'BUYER_PAYS_V1' })
    expect(view2).toMatchObject({ priceDrops: '25000000', platformFeeDrops: '1250000', buyerPaysDrops: '25000000', feeModel: 'SELLER_PAYS_V2' })
  })
})

describe('recording what the first buyer paid', () => {
  it('a first sale made under the new model records the ALL-IN amount on the ticket, in XRP', async () => {
    // A primary listing: 20 XRP price, 0.7 fee (350 bps) paid on top by the buyer = 20.7 all-in.
    const { listing, ticket } = await mkSale({ status: 'SETTLING', isPrimarySale: true, feeBps: 350, priceDrops: 20n * XRP, platformFeeDrops: 700_000n })
    await advanceListing(listing.id)
    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })
    expect(t.originalCostMinor).toBe(20_700_000n)
    expect(t.originalCostCurrency).toBe('XRP')
  })

  it('a first sale listed before the new model existed records nothing, so its ticket keeps the old rules', async () => {
    const { listing, ticket } = await mkSale({ status: 'SETTLING', isPrimarySale: true, feeBps: null })
    await advanceListing(listing.id)
    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })
    expect(t.originalCostMinor).toBeNull()
    expect(t.originalCostCurrency).toBeNull()
  })

  it('a RESALE never changes what the first buyer paid', async () => {
    const { listing, ticket } = await mkSale({
      status: 'SETTLING',
      feeModel: 'SELLER_PAYS_V2',
      feeBps: 500,
      isPrimarySale: false,
      priceDrops: 25n * XRP,
      platformFeeDrops: 1_250_000n,
      ticketOriginalCost: 20_700_000n,
    })
    await advanceListing(listing.id)
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).originalCostMinor).toBe(20_700_000n)
  })

  it('a resale of a ticket with NO recorded amount (an older ticket) does not invent one from the resale price', async () => {
    // Otherwise the first resale of every older ticket would quietly set its cap to whatever it sold for.
    const { listing, ticket } = await mkSale({ status: 'SETTLING', feeModel: 'SELLER_PAYS_V2', feeBps: 500, isPrimarySale: false, priceDrops: 25n * XRP, platformFeeDrops: 1_250_000n, ticketOriginalCost: null })
    await advanceListing(listing.id)
    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })
    expect(t.originalCostMinor).toBeNull()
    expect(t.originalCostCurrency).toBeNull()
  })

  it('a first sale never overwrites an amount that is already recorded', async () => {
    // The organizer bought a ticket back and sold it again as "primary": the original amount stands.
    const { listing, ticket } = await mkSale({ status: 'SETTLING', isPrimarySale: true, feeBps: 350, priceDrops: 30n * XRP, platformFeeDrops: 1_050_000n, ticketOriginalCost: 20_700_000n })
    await advanceListing(listing.id)
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).originalCostMinor).toBe(20_700_000n)
  })

  it('records nothing for a sale that FAILED', async () => {
    brokerSale.mockResolvedValue({ hash: 'F'.repeat(64), succeeded: false, result: 'tecNO_PERMISSION' })
    const { listing, ticket } = await mkSale({ status: 'SETTLING', isPrimarySale: true, feeBps: 350, priceDrops: 20n * XRP, platformFeeDrops: 700_000n })
    await advanceListing(listing.id)
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).originalCostMinor).toBeNull()
  })
})
