/**
 * The server finishing a sale on its own, and letting go of one that cannot finish. Written before the code.
 *
 * Until now the sweep only drove BOX-OFFICE sales. A normal resale whose buyer signed and closed the tab stayed in
 * SETTLING until somebody polled it (found live on devnet: the sweep advanced 0 sales). Both offers stand, so nobody's
 * money was at risk, but the sale simply did not happen.
 *
 * What is pinned: which sales the sweep drives (v1 and v2, never auctions), that a poll and the sweep arriving together
 * broker exactly once (at the DATABASE, not only the in-process lease), what happens to a bid that can never settle
 * (gone, or the buyer cannot pay), that waiting is bounded, and that a stuck sale is reported.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.FEE_MODEL = 'v2'
  process.env.XRP_USD_CENTS = '134'
})

import { Wallet } from 'xrpl'

const BROKER = Wallet.generate().classicAddress

type Sale = { hash: string; succeeded: boolean; result: string }
const brokerSale = vi.fn<(p: { sellOfferIndex: string; buyOfferIndex: string; brokerFeeDrops: bigint }) => Promise<Sale>>()
const tryGetPayload = vi.fn<(u: string) => Promise<unknown>>()
const txSucceeded = vi.fn<(h: string) => Promise<boolean | null>>()
const offerIndexFromTx = vi.fn<(h: string) => Promise<string | null>>()
const spendableDrops = vi.fn<(a: string) => Promise<bigint>>()
const offerOnLedgerState = vi.fn<(i: string) => Promise<'present' | 'gone' | 'unknown'>>()
const cancelOffers = vi.fn<(i: string[]) => Promise<void>>()

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
const { advanceListing, advanceListingUnleased, advanceStuckSales, reportStuckSettling } = await import('../src/listing-advance.js')
const { MAX_SETTLE_STRIKES, STUCK_AFTER_MS } = await import('../src/settle-policy.js')

const UTAG = 'sw_'
const XRP = 1_000_000n
let uniq = ''
let n = 0
const ago = (ms: number) => new Date(Date.now() - ms)
const ok: Sale = { hash: 'H'.repeat(64), succeeded: true, result: 'tesSUCCESS' }

async function mkUser(name: string) {
  return prisma.user.create({ data: { username: `${UTAG}${name}_${uniq}`.slice(0, 20), xrplAddress: Wallet.generate().classicAddress } })
}

async function mkSale(opts: {
  status: 'BUYER_PENDING' | 'SETTLING' | 'ACTIVE'
  reserved?: boolean
  auction?: boolean
  v2?: boolean
  settlingAgoMs?: number | null
  signedBid?: boolean
  signedAgoMs?: number
  over?: Record<string, unknown>
}) {
  n += 1
  const org = await mkUser(`o${n}`)
  const buyer = await mkUser(`b${n}`)
  const event = await prisma.event.create({
    data: { network: NETWORK, slug: `sw-${uniq}-${n}`, title: 'Sweep Test', startsAt: new Date(Date.now() + 864e5), organizerId: org.id, nftTaxon: 80_000 + n, royaltyBps: 500, platformBps: 250, ticketCount: 5, status: 'PUBLISHED' },
  })
  const ticket = await prisma.ticket.create({
    data: { nfTokenId: `${uniq}${n}`.padEnd(64, 'A').toUpperCase().replace(/[^0-9A-F]/g, 'A'), network: NETWORK, eventId: event.id, ownerId: org.id, ownerAddress: org.xrplAddress, status: 'LISTED' },
  })
  const hex = `${uniq}${n}`.replace(/[^0-9a-f]/g, '0').padEnd(12, '0').slice(0, 12)
  const buyUuid = `00000000-0000-4000-8000-${hex}`
  let auctionId: string | undefined
  if (opts.auction) {
    const a = await prisma.auction.create({ data: { network: NETWORK, ticketId: ticket.id, startsAt: ago(3_600_000), endsAt: new Date(Date.now() + 3_600_000), reserveDrops: 20n * XRP, status: 'LIVE' } })
    auctionId = a.id
  }
  const listing = await prisma.listing.create({
    data: {
      network: NETWORK, ticketId: ticket.id, sellerId: org.id, sellerAddress: org.xrplAddress, brokerAddress: BROKER,
      priceDrops: 25n * XRP,
      platformFeeDrops: opts.v2 ? 1_250_000n : 625_000n,
      feeModel: opts.v2 ? 'SELLER_PAYS_V2' : 'BUYER_PAYS_V1',
      feeBps: opts.v2 ? 500 : null,
      listPayloadUuid: `delegate:${hex}${n}`,
      buyPayloadUuid: buyUuid,
      offerIndex: 'AA'.repeat(32),
      buyOfferIndex: opts.status === 'SETTLING' ? 'BB'.repeat(32) : null,
      buyerId: buyer.id, buyerAddress: buyer.xrplAddress,
      reservedForId: opts.reserved ? buyer.id : null,
      auctionId,
      status: opts.status,
      settlingSince: opts.status === 'SETTLING' && opts.settlingAgoMs !== null ? ago(opts.settlingAgoMs ?? 120_000) : null,
      listedAt: ago(opts.reserved ? 120_000 : 86_400_000), // a resale has usually been listed for a long time
      expiresAt: new Date(Date.now() + 300_000),
      ...opts.over,
    },
  })
  if (opts.signedBid) {
    await prisma.xamanPayload.create({
      data: { uuid: buyUuid, network: NETWORK, signer: 'xaman', signed: true, terminal: true, txid: 'T'.repeat(64), account: buyer.xrplAddress, source: 'test', fetchedAt: ago(opts.signedAgoMs ?? 120_000) },
    })
  }
  return { org, buyer, event, ticket, listing }
}

const row = (id: string) => prisma.listing.findUniqueOrThrow({ where: { id } })

async function cleanup() {
  const ev = { event: { slug: { startsWith: 'sw-' } } }
  await prisma.listingBuyerNotice.deleteMany({ where: { listing: { ticket: ev } } })
  await prisma.xamanPayload.deleteMany({ where: { source: 'test' } })
  await prisma.listing.deleteMany({ where: { ticket: ev } })
  await prisma.auction.deleteMany({ where: { ticket: ev } })
  await prisma.transfer.deleteMany({ where: { ticket: ev } })
  await prisma.ticket.deleteMany({ where: ev })
  await prisma.event.deleteMany({ where: { slug: { startsWith: 'sw-' } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: UTAG } } })
}

beforeEach(async () => {
  uniq = Math.random().toString(16).slice(2, 7)
  n = 0
  await cleanup()
  brokerSale.mockReset().mockResolvedValue(ok)
  tryGetPayload.mockReset().mockResolvedValue({ signed: true, cancelled: false, expired: false, account: 'rX', txid: 'T'.repeat(64) })
  txSucceeded.mockReset().mockResolvedValue(true)
  offerIndexFromTx.mockReset().mockResolvedValue('BB'.repeat(32))
  spendableDrops.mockReset().mockResolvedValue(1_000n * XRP)
  offerOnLedgerState.mockReset().mockResolvedValue('present')
  cancelOffers.mockReset().mockResolvedValue(undefined)
})
afterEach(cleanup)
afterAll(async () => {
  await prisma.$disconnect()
})

describe('what the sweep drives', () => {
  it.each([
    ['v1 (buyer pays on top)', false, 625_000n],
    ['v2 (seller pays)', true, 1_250_000n],
  ])('finishes an ordinary RESALE stuck in SETTLING, %s, with no client polling', async (_n, v2, fee) => {
    const { listing, buyer, ticket } = await mkSale({ status: 'SETTLING', v2 })

    expect(await advanceStuckSales()).toBe(1)

    expect((await row(listing.id)).status).toBe('SOLD')
    expect(brokerSale).toHaveBeenCalledTimes(1)
    expect(brokerSale).toHaveBeenCalledWith(expect.objectContaining({ brokerFeeDrops: fee }))
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({ ownerId: buyer.id, ownerAddress: buyer.xrplAddress })
  })

  it.each([
    ['v1', false],
    ['v2', true],
  ])('takes a resale buyer who signed and left from "signed" to the match, %s', async (_n, v2) => {
    const { listing } = await mkSale({ status: 'BUYER_PENDING', v2, signedBid: true })

    // One pass does both steps: having moved the sale to SETTLING itself, the sweep does not leave it for the next 45 seconds.
    expect(await advanceStuckSales()).toBe(1)
    expect((await row(listing.id)).status).toBe('SOLD')
    expect(brokerSale).toHaveBeenCalledTimes(1)
  })

  it('leaves a resale whose bid is NOT signed alone (that is the buyer\'s to finish, and costs a Xaman call to check)', async () => {
    const { listing } = await mkSale({ status: 'BUYER_PENDING' }) // no signed payload on record
    expect(await advanceStuckSales()).toBe(0)
    expect((await row(listing.id)).status).toBe('BUYER_PENDING')
    expect(tryGetPayload).not.toHaveBeenCalled()
  })

  it('leaves a signed bid alone for 45 seconds: the buyer\'s own poll goes first', async () => {
    const { listing } = await mkSale({ status: 'BUYER_PENDING', signedBid: true, signedAgoMs: 10_000 })
    expect(await advanceStuckSales()).toBe(0)
    expect((await row(listing.id)).status).toBe('BUYER_PENDING')
  })

  it('leaves a sale alone for its first 45 seconds in SETTLING, resale or not', async () => {
    const { listing } = await mkSale({ status: 'SETTLING', settlingAgoMs: 10_000 })
    expect(await advanceStuckSales()).toBe(0)
    expect((await row(listing.id)).status).toBe('SETTLING')
  })

  it('NEVER drives an auction\'s listing: settleAuction owns it, and brokering it here would sell at the floor', async () => {
    const { listing } = await mkSale({ status: 'SETTLING', auction: true })
    expect(await advanceStuckSales()).toBe(0)
    expect(brokerSale).not.toHaveBeenCalled()
    expect((await row(listing.id)).status).toBe('SETTLING')
  })

  it('does not touch a listing still waiting for a bid', async () => {
    await mkSale({ status: 'ACTIVE' })
    expect(await advanceStuckSales()).toBe(0)
  })

  it('still drives a box-office sale by the old rule (listed more than 45 seconds ago)', async () => {
    const { listing } = await mkSale({ status: 'SETTLING', reserved: true, settlingAgoMs: null })
    expect(await advanceStuckSales()).toBe(1)
    expect((await row(listing.id)).status).toBe('SOLD')
  })

  it('skips a sale that is in backoff, rather than asking the ledger every 15 seconds', async () => {
    const { listing } = await mkSale({ status: 'SETTLING', over: { settleStrikes: 2, settleNextAt: new Date(Date.now() + 300_000) } })
    expect(await advanceStuckSales()).toBe(0)
    expect(spendableDrops).not.toHaveBeenCalled()
    expect((await row(listing.id)).status).toBe('SETTLING')
  })

  it('one failing sale does not stop the others', async () => {
    const first = await mkSale({ status: 'SETTLING', settlingAgoMs: 300_000 })
    const second = await mkSale({ status: 'SETTLING', settlingAgoMs: 200_000 })
    brokerSale.mockRejectedValueOnce(new Error('node down'))
    await advanceStuckSales()
    expect((await row(first.listing.id)).status).toBe('SETTLING')
    expect((await row(second.listing.id)).status).toBe('SOLD')
  })
})

describe('no double settlement: the sweep and a client poll racing', () => {
  const slow = () =>
    brokerSale.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 120)) // long enough for the others to arrive mid-match
      return ok
    })

  it('a poll and the sweep together broker ONCE (the in-process lease)', async () => {
    const { listing } = await mkSale({ status: 'SETTLING' })
    slow()
    await Promise.all([advanceListing(listing.id), advanceListing(listing.id), advanceStuckSales()])
    expect(brokerSale).toHaveBeenCalledTimes(1)
    expect((await row(listing.id)).status).toBe('SOLD')
  })

  it('two drivers with NO lease still broker once: the database row itself decides who goes', async () => {
    // The lease can lapse under a slow driver, or a second instance can fail to see it. The claim on the row is what
    // must hold when it does.
    const { listing } = await mkSale({ status: 'SETTLING' })
    slow()
    const results = await Promise.all([advanceListingUnleased(listing.id), advanceListingUnleased(listing.id), advanceListingUnleased(listing.id)])
    expect(brokerSale).toHaveBeenCalledTimes(1)
    expect(results.map((r) => r?.state).sort()).toEqual(['settling', 'settling', 'sold'])
    const final = await row(listing.id)
    expect(final.status).toBe('SOLD') // and not FAILED by a second match finding the offers consumed
  })

  it('a driver that finds the row claimed does not step, and says where the sale stands', async () => {
    const { listing } = await mkSale({ status: 'SETTLING', over: { settleClaimedUntil: new Date(Date.now() + 60_000) } })
    const view = await advanceListingUnleased(listing.id)
    expect(view?.state).toBe('settling')
    expect(brokerSale).not.toHaveBeenCalled()
  })

  it('a claim whose driver died (lapsed) can be taken again', async () => {
    const { listing } = await mkSale({ status: 'SETTLING', over: { settleClaimedUntil: ago(1_000) } })
    expect((await advanceListingUnleased(listing.id))?.state).toBe('sold')
    expect(brokerSale).toHaveBeenCalledTimes(1)
  })

  it('an attempt that THROWS (node down) gives the claim back too, rather than locking the sale for the whole lease', async () => {
    const { listing } = await mkSale({ status: 'SETTLING' })
    brokerSale.mockRejectedValueOnce(new Error('node down'))
    await expect(advanceListing(listing.id)).rejects.toThrow('node down')
    expect((await row(listing.id)).settleClaimedUntil).toBeNull()
    expect((await advanceListing(listing.id))?.state).toBe('sold') // the very next pass, not 90 seconds later
  })

  it('a failed attempt gives the claim back, so the next pass is not locked out', async () => {
    const { listing } = await mkSale({ status: 'SETTLING' })
    brokerSale.mockResolvedValueOnce({ hash: 'F'.repeat(64), succeeded: false, result: 'tecINSUFFICIENT_FUNDS' })
    await advanceListing(listing.id)
    expect((await row(listing.id)).settleClaimedUntil).toBeNull()
    expect((await advanceListing(listing.id))?.state).toBe('sold')
  })
})

describe('a bid that can never settle is let go', () => {
  it('the buyer\'s offer is GONE from the ledger: the listing returns to sale, the buyer is told, nothing is brokered', async () => {
    const { listing, buyer } = await mkSale({ status: 'SETTLING' })
    offerOnLedgerState.mockImplementation(async (i) => (i === 'BB'.repeat(32) ? 'gone' : 'present'))

    const view = await advanceListing(listing.id)

    expect(brokerSale).not.toHaveBeenCalled()
    expect(view).toMatchObject({ state: 'failed' })
    expect(String(view?.reason)).toMatch(/offer/i)
    expect(await row(listing.id)).toMatchObject({
      status: 'ACTIVE', buyerId: null, buyerAddress: null, buyPayloadUuid: null, buyTxHash: null, buyOfferIndex: null,
      settlingSince: null, settleStrikes: 0, settleNextAt: null, settleClaimedUntil: null, failureReason: null,
    })
    const notice = await prisma.listingBuyerNotice.findFirstOrThrow({ where: { listingId: listing.id } })
    expect(notice).toMatchObject({ userId: buyer.id, amountDrops: 25n * XRP + 625_000n })
    expect(notice.reason).toMatch(/offer/i)
    expect(cancelOffers).not.toHaveBeenCalled() // there is nothing left to cancel
  })

  it('an UNREADABLE ledger is not "gone": it carries on and lets the match decide', async () => {
    const { listing } = await mkSale({ status: 'SETTLING' })
    offerOnLedgerState.mockResolvedValue('unknown')
    expect((await advanceListing(listing.id))?.state).toBe('sold')
    expect(await prisma.listingBuyerNotice.count({ where: { listingId: listing.id } })).toBe(0)
  })

  it('the match says the offers are gone (tecNO_ENTRY) and the buyer\'s is the one missing: let it go', async () => {
    const { listing } = await mkSale({ status: 'SETTLING' })
    brokerSale.mockResolvedValue({ hash: 'F'.repeat(64), succeeded: false, result: 'tecNO_ENTRY' })
    offerOnLedgerState.mockResolvedValueOnce('present').mockResolvedValueOnce('present') // checked before the attempt
    offerOnLedgerState.mockImplementation(async (i) => (i === 'BB'.repeat(32) ? 'gone' : 'present')) // and after
    await advanceListing(listing.id)
    expect((await row(listing.id)).status).toBe('ACTIVE')
    expect(await prisma.listingBuyerNotice.count({ where: { listingId: listing.id } })).toBe(1)
  })

  it('the SELLER\'s offer is the one gone: the sale fails (the ticket moved), the buyer is told, and their offer is cancelled', async () => {
    const { listing } = await mkSale({ status: 'SETTLING' })
    brokerSale.mockResolvedValue({ hash: 'F'.repeat(64), succeeded: false, result: 'tecNO_ENTRY' })
    offerOnLedgerState.mockResolvedValueOnce('present').mockResolvedValueOnce('present')
    offerOnLedgerState.mockImplementation(async (i) => (i === 'AA'.repeat(32) ? 'gone' : 'present'))
    await advanceListing(listing.id)
    expect((await row(listing.id)).status).toBe('FAILED')
    expect(cancelOffers).toHaveBeenCalledWith(['BB'.repeat(32)])
    expect(await prisma.listingBuyerNotice.count({ where: { listingId: listing.id } })).toBe(1)
  })

  it('the SELLER\'s offer is already gone before the attempt: nothing is brokered, the buyer is told, their offer is cancelled', async () => {
    const { listing } = await mkSale({ status: 'SETTLING' })
    offerOnLedgerState.mockImplementation(async (i) => (i === 'AA'.repeat(32) ? 'gone' : 'present'))
    const view = await advanceListing(listing.id)
    expect(brokerSale).not.toHaveBeenCalled()
    expect(view).toMatchObject({ state: 'failed' })
    expect((await row(listing.id)).status).toBe('FAILED')
    expect(cancelOffers).toHaveBeenCalledWith(['BB'.repeat(32)])
    expect(await prisma.listingBuyerNotice.count({ where: { listingId: listing.id } })).toBe(1)
  })

  it('a buyer who cannot pay is waited for, with backoff: strike by strike, never more often than the gate allows', async () => {
    const { listing } = await mkSale({ status: 'SETTLING' })
    spendableDrops.mockResolvedValue(1n * XRP) // short

    await advanceListing(listing.id)
    let r = await row(listing.id)
    expect(r.status).toBe('SETTLING')
    expect(r.settleStrikes).toBe(1)
    expect(r.settleNextAt!.getTime()).toBeGreaterThan(Date.now())
    expect(r.failureReason).toMatch(/Waiting for the buyer's balance/)

    // Polled again at once, as a client does every couple of seconds: no new strike.
    await advanceListing(listing.id)
    await advanceListing(listing.id)
    expect((await row(listing.id)).settleStrikes).toBe(1)
    expect(brokerSale).not.toHaveBeenCalled() // no fee burned to learn what a read tells us
  })

  it('a buyer who funds the bid in time settles, whatever the strikes so far', async () => {
    const { listing } = await mkSale({ status: 'SETTLING', over: { settleStrikes: MAX_SETTLE_STRIKES - 1, settleNextAt: ago(1_000) } })
    spendableDrops.mockResolvedValue(1_000n * XRP)
    expect((await advanceListing(listing.id))?.state).toBe('sold')
  })

  it('after the maximum number of strikes the sale is let go: back on sale, the buyer\'s leftover offer cancelled, the buyer told', async () => {
    const { listing, buyer } = await mkSale({ status: 'SETTLING' })
    spendableDrops.mockResolvedValue(1n * XRP)

    for (let i = 1; i < MAX_SETTLE_STRIKES; i++) {
      await advanceListing(listing.id)
      expect((await row(listing.id)).status).toBe('SETTLING')
      expect((await row(listing.id)).settleStrikes).toBe(i)
      await prisma.listing.update({ where: { id: listing.id }, data: { settleNextAt: ago(1_000) } }) // let the backoff pass
    }
    expect(cancelOffers).not.toHaveBeenCalled()

    const view = await advanceListing(listing.id) // the last strike
    expect(view).toMatchObject({ state: 'failed' })
    expect(await row(listing.id)).toMatchObject({ status: 'ACTIVE', buyerId: null, buyOfferIndex: null, settleStrikes: 0 })
    expect(cancelOffers).toHaveBeenCalledWith(['BB'.repeat(32)])
    const notice = await prisma.listingBuyerNotice.findFirstOrThrow({ where: { listingId: listing.id } })
    expect(notice.userId).toBe(buyer.id)
    expect(notice.reason).toMatch(/could not|funds|pay/i)
    expect(brokerSale).not.toHaveBeenCalled()
  })

  it('the same cap applies when the LEDGER reports the shortfall (tecINSUFFICIENT_FUNDS), not just the pre-check', async () => {
    const { listing } = await mkSale({ status: 'SETTLING', over: { settleStrikes: MAX_SETTLE_STRIKES - 1 } })
    brokerSale.mockResolvedValue({ hash: 'F'.repeat(64), succeeded: false, result: 'tecINSUFFICIENT_FUNDS' })
    await advanceListing(listing.id)
    expect((await row(listing.id)).status).toBe('ACTIVE')
    expect(cancelOffers).toHaveBeenCalledWith(['BB'.repeat(32)])
    expect(await prisma.listingBuyerNotice.count({ where: { listingId: listing.id } })).toBe(1)
  })

  it('a failure that is OURS (no permission) is never blamed on the buyer: no strike, no notice, the sale is not released', async () => {
    const { listing } = await mkSale({ status: 'SETTLING' })
    brokerSale.mockResolvedValue({ hash: 'F'.repeat(64), succeeded: false, result: 'tecNO_PERMISSION' })
    await advanceListing(listing.id)
    const r = await row(listing.id)
    expect(r.status).toBe('FAILED')
    expect(r.settleStrikes).toBe(0)
    expect(await prisma.listingBuyerNotice.count({ where: { listingId: listing.id } })).toBe(0)
  })

  it('a box-office sale that is let go frees the ticket as well, and cancels both offers', async () => {
    const { listing, ticket } = await mkSale({ status: 'SETTLING', reserved: true, settlingAgoMs: 120_000 })
    offerOnLedgerState.mockImplementation(async (i) => (i === 'BB'.repeat(32) ? 'gone' : 'present'))
    await advanceListing(listing.id)
    expect((await row(listing.id)).status).toBe('CANCELLED')
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('MINTED')
    expect(cancelOffers).toHaveBeenCalledWith(['AA'.repeat(32)]) // the seller's checkout offer
    expect(await prisma.listingBuyerNotice.count({ where: { listingId: listing.id } })).toBe(1)
  })

  it('a let-go sale is not driven again by the sweep', async () => {
    const { listing } = await mkSale({ status: 'SETTLING' })
    offerOnLedgerState.mockImplementation(async (i) => (i === 'BB'.repeat(32) ? 'gone' : 'present'))
    await advanceStuckSales()
    expect((await row(listing.id)).status).toBe('ACTIVE')
    brokerSale.mockClear()
    expect(await advanceStuckSales()).toBe(0)
    expect(brokerSale).not.toHaveBeenCalled()
  })

  it('records only ONE notice when two drivers let the same sale go at once', async () => {
    const { listing } = await mkSale({ status: 'SETTLING' })
    offerOnLedgerState.mockImplementation(async (i) => {
      await new Promise((r) => setTimeout(r, 40))
      return i === 'BB'.repeat(32) ? 'gone' : 'present'
    })
    await Promise.all([advanceListingUnleased(listing.id), advanceListingUnleased(listing.id)])
    expect(await prisma.listingBuyerNotice.count({ where: { listingId: listing.id } })).toBe(1)
  })
})

describe('a stuck sale is reported', () => {
  it('logs a sale that has been SETTLING longer than the threshold, once', async () => {
    const stuck = await mkSale({ status: 'SETTLING', settlingAgoMs: STUCK_AFTER_MS + 60_000 })
    const fine = await mkSale({ status: 'SETTLING', settlingAgoMs: STUCK_AFTER_MS - 60_000 })
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const first = await reportStuckSettling()
    expect(first).toEqual([stuck.listing.id])
    expect(err).toHaveBeenCalledTimes(1)
    expect(String(err.mock.calls[0]![0])).toContain(stuck.listing.id.slice(0, 8))
    expect(String(err.mock.calls[0]![0])).toMatch(/SETTLING/)

    expect(await reportStuckSettling()).toEqual([]) // not again every sweep
    expect(err).toHaveBeenCalledTimes(1)
    expect((await row(fine.listing.id)).settleAlertedAt).toBeNull()
    err.mockRestore()
  })

  it('counts a row from before settlingSince existed by when it was listed', async () => {
    const { listing } = await mkSale({ status: 'SETTLING', settlingAgoMs: null, over: { listedAt: ago(STUCK_AFTER_MS + 60_000) } })
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await reportStuckSettling()).toEqual([listing.id])
    err.mockRestore()
  })

  it('ignores sales that are not SETTLING', async () => {
    await mkSale({ status: 'ACTIVE', over: { settlingSince: ago(STUCK_AFTER_MS * 3) } })
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await reportStuckSettling()).toEqual([])
    err.mockRestore()
  })
})
