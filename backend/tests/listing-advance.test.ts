/**
 * Moving a sale forward when nobody is polling.
 *
 * A box-office buyer signs on their phone; the page that was polling is a tab on
 * a laptop they have since closed. These pin that the sweep finishes the sale for
 * them, and — the part that bites — that two drivers advancing one sale
 * (the buyer's poll AND the sweep) broker it once, because a second broker
 * attempt finds the offers already consumed and marks a completed sale FAILED.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Wallet } from 'xrpl'

const BROKER = Wallet.generate().classicAddress

const brokerSale = vi.fn<(p: { sellOfferIndex: string; buyOfferIndex: string; brokerFeeDrops: bigint }) => Promise<{ hash: string; succeeded: boolean; result: string }>>()
const tryGetPayload = vi.fn<(u: string) => Promise<unknown>>()
const txSucceeded = vi.fn<(h: string) => Promise<boolean | null>>()
const offerIndexFromTx = vi.fn<(h: string) => Promise<string | null>>()
const spendableDrops = vi.fn<(a: string) => Promise<bigint>>()
const cancelOffers = vi.fn<(i: string[]) => Promise<void>>()
const offerOnLedgerState = vi.fn<(i: string) => Promise<'present' | 'gone' | 'unknown'>>()

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return {
    ...actual,
    brokerSale: (p: Parameters<typeof brokerSale>[0]) => brokerSale(p),
    txSucceeded: (h: string) => txSucceeded(h),
    offerIndexFromTx: (h: string) => offerIndexFromTx(h),
    spendableDrops: (a: string) => spendableDrops(a),
    offerOnLedgerState: (i: string) => offerOnLedgerState(i),
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

const UTAG = 'la_'
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
}) {
  n += 1
  const org = await mkUser(`o${n}`, 'ORGANIZER')
  const buyer = await mkUser(`b${n}`)
  const event = await prisma.event.create({
    data: {
      network: NETWORK,
      slug: `la-${uniq}-${n}`,
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
      priceDrops: 25_000_000n,
      platformFeeDrops: 625_000n,
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
  const ev = { event: { slug: { startsWith: 'la-' } } }
  await prisma.listing.deleteMany({ where: { ticket: ev } })
  await prisma.transfer.deleteMany({ where: { ticket: ev } })
  await prisma.ticket.deleteMany({ where: ev })
  await prisma.event.deleteMany({ where: { slug: { startsWith: 'la-' } } })
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
  offerOnLedgerState.mockReset().mockResolvedValue('present')
})
afterEach(cleanup)
afterAll(async () => {
  await prisma.$disconnect()
})

describe('advanceStuckSales', () => {
  it('finishes a settling sale whose buyer has gone, with no poll at all', async () => {
    const { listing, buyer, ticket } = await mkSale({ status: 'SETTLING' })

    expect(await advanceStuckSales()).toBe(1)

    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe('SOLD')
    const moved = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })
    expect(moved).toMatchObject({ ownerId: buyer.id, ownerAddress: buyer.xrplAddress, status: 'MINTED' })
    expect(brokerSale).toHaveBeenCalledTimes(1)
    expect(brokerSale).toHaveBeenCalledWith({
      sellOfferIndex: 'AA'.repeat(32),
      buyOfferIndex: 'BB'.repeat(32),
      brokerFeeDrops: 625_000n,
    })
  })

  it('takes a buyer who signed and left from "signed" all the way to the match', async () => {
    const { listing } = await mkSale({ status: 'BUYER_PENDING' })
    tryGetPayload.mockResolvedValue({ signed: true, cancelled: false, expired: false, account: 'rX', txid: 'T'.repeat(64) })

    await advanceStuckSales() // BUYER_PENDING -> SETTLING -> SOLD, in the one pass
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe('SOLD')
  })

  it('leaves a sale alone for the first 45 seconds - the buyer\'s own poll goes first', async () => {
    const { listing } = await mkSale({ status: 'SETTLING', listedAgoMs: 10_000 })

    expect(await advanceStuckSales()).toBe(0)

    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe('SETTLING')
    expect(brokerSale).not.toHaveBeenCalled()
  })

  // Ordinary resales are now driven too: see settlement-sweep.test.ts.

  it('does not touch a listing still waiting for its offer to be matched to a bid', async () => {
    await mkSale({ status: 'ACTIVE' })
    expect(await advanceStuckSales()).toBe(0)
  })

  it('releases a box-office sale whose buyer never signed and whose request expired', async () => {
    const { listing, ticket } = await mkSale({ status: 'BUYER_PENDING' })
    await prisma.listing.update({ where: { id: listing.id }, data: { expiresAt: old(5_000) } })

    await advanceStuckSales()

    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe('CANCELLED')
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('MINTED')
    expect(cancelOffers).toHaveBeenCalledTimes(1)
  })

  it('one failing sale does not stop the others', async () => {
    const first = await mkSale({ status: 'SETTLING', listedAgoMs: 300_000 })
    const second = await mkSale({ status: 'SETTLING', listedAgoMs: 200_000 })
    brokerSale.mockRejectedValueOnce(new Error('node down'))

    await advanceStuckSales()

    expect((await prisma.listing.findUniqueOrThrow({ where: { id: first.listing.id } })).status).toBe('SETTLING')
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: second.listing.id } })).status).toBe('SOLD')
  })

  it('stays SETTLING (retryable) rather than failing when the buyer is briefly short', async () => {
    const { listing } = await mkSale({ status: 'SETTLING' })
    spendableDrops.mockResolvedValue(1_000_000n)

    await advanceStuckSales()

    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })
    expect(after.status).toBe('SETTLING')
    expect(after.failureReason).toMatch(/Waiting for the buyer's balance/)
    expect(brokerSale).not.toHaveBeenCalled() // no fee burned to learn what a read tells us
  })
})

describe('two drivers on one sale', () => {
  it('broker it ONCE - the buyer\'s poll and the sweep arriving together', async () => {
    const { listing } = await mkSale({ status: 'SETTLING' })
    brokerSale.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 80)) // long enough for the second to arrive
      return { hash: 'H'.repeat(64), succeeded: true, result: 'tesSUCCESS' }
    })

    const [a, b] = await Promise.all([advanceListing(listing.id), advanceListing(listing.id)])

    // The second saw a lease held and reported where the sale stood, instead of
    // stepping alongside - which is the second brokerSale, finding the offers
    // consumed (tecNO_ENTRY) and marking a COMPLETED sale as failed.
    expect(brokerSale).toHaveBeenCalledTimes(1)
    expect([a?.state, b?.state].sort()).toEqual(['settling', 'sold'])
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe('SOLD')
  })

  it('reports where the sale stands, and does not step, while another driver holds it', async () => {
    const { listing } = await mkSale({ status: 'SETTLING' })
    expect(await acquireLock(`listing:${listing.id}`, 60_000)).toBe(true)

    const view = await advanceListing(listing.id)

    expect(view?.state).toBe('settling')
    expect(brokerSale).not.toHaveBeenCalled()
    await releaseLock(`listing:${listing.id}`)
  })

  it('takes no lease for a finished sale', async () => {
    const { listing } = await mkSale({ status: 'SETTLING' })
    await prisma.listing.update({ where: { id: listing.id }, data: { status: 'SOLD' } })
    expect(await acquireLock(`listing:${listing.id}`, 60_000)).toBe(true) // someone "holds" it

    expect((await advanceListing(listing.id))?.state).toBe('sold')
    await releaseLock(`listing:${listing.id}`)
  })

  it('answers null for a listing that does not exist', async () => {
    expect(await advanceListing('00000000-0000-4000-8000-000000000000')).toBeNull()
  })
})
