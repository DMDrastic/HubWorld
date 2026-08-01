/**
 * Auction settlement, against a real database with the ledger mocked.
 *
 * Settlement has run successfully several times on testnet, but only ever down
 * the happy path: top bidder wins, everyone pays. The branches that matter most
 * have never executed — a winner who cannot pay, a broker submission that fails,
 * every bidder falling through. Those are exactly the paths where money goes to
 * the wrong place or an auction silently dies holding someone's ticket.
 *
 * The database is real because the interesting behaviour IS the database work:
 * which bid ends up WON, whether losers are marked, whether the ticket moves and
 * provenance is written in the same transaction. Mocking Prisma would test a
 * mock. Only the network calls are stubbed, and `platformFeeDrops` stays real so
 * the fee arithmetic is the shipped arithmetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const brokerSale = vi.fn()
const spendableDrops = vi.fn()
const brokerCancelOffers = vi.fn()

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return {
    ...actual,
    // Real fee maths; only the network is faked.
    brokerSale: (...a: unknown[]) => brokerSale(...a),
    spendableDrops: (...a: unknown[]) => spendableDrops(...a),
    brokerCancelOffers: (...a: unknown[]) => brokerCancelOffers(...a),
  }
})

const { prisma } = await import('../src/prisma.js')
const { settleAuction, settleDueAuctions, auctionLockName, BROKER_LOCK } = await import(
  '../src/settlement.js'
)
const { acquireLock, releaseLock } = await import('../src/job-lock.js')

const XRP = 1_000_000n
const TAG = 'it-settle'

type Ctx = {
  auctionId: string
  ticketId: string
  organizerId: string
  sellerId: string
  bidders: { id: string; username: string; address: string }[]
}

/** Builds a complete auction: event, ticket, holder's sell offer, and bids. */
async function seed(opts: {
  reserveDrops: bigint
  endsAt: Date
  bids: Array<{ amount: bigint; status?: 'COMMITTED' | 'OUTBID'; offerIndex?: string | null }>
  withSellOffer?: boolean
  platformBps?: number
}): Promise<Ctx> {
  const uniq = Math.random().toString(36).slice(2, 8)

  const mk = (name: string) =>
    prisma.user.create({
      data: {
        username: `${TAG}-${name}-${uniq}`,
        xrplAddress: `r${TAG}${name}${uniq}`.slice(0, 34),
      },
    })

  const organizer = await mk('org')
  const seller = await mk('sell')
  const bidderRows = await Promise.all(opts.bids.map((_, i) => mk(`bid${i}`)))

  const event = await prisma.event.create({
    data: {
      slug: `${TAG}-${uniq}`,
      title: 'Settlement Test',
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: organizer.id,
      nftTaxon: 90000 + Math.floor(Math.random() * 9000),
      royaltyBps: 500,
      platformBps: opts.platformBps ?? 250,
      ticketCount: 1,
    },
  })

  const ticket = await prisma.ticket.create({
    data: {
      nfTokenId: `${uniq}${'0'.repeat(64)}`.slice(0, 64).toUpperCase(),
      eventId: event.id,
      ownerId: seller.id,
      ownerAddress: seller.xrplAddress,
      status: 'IN_AUCTION',
    },
  })

  const auction = await prisma.auction.create({
    data: {
      ticketId: ticket.id,
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: opts.endsAt,
      reserveDrops: opts.reserveDrops,
      status: 'LIVE',
    },
  })

  if (opts.withSellOffer !== false) {
    await prisma.listing.create({
      data: {
        ticketId: ticket.id,
        sellerId: seller.id,
        sellerAddress: seller.xrplAddress,
        priceDrops: opts.reserveDrops,
        platformFeeDrops: 0n,
        listPayloadUuid: `${TAG}-${uniq}-list`,
        expiresAt: new Date(Date.now() + 3_600_000),
        offerIndex: `SELL-${uniq}`,
        status: 'ACTIVE',
        auctionId: auction.id,
      },
    })
  }

  await Promise.all(
    opts.bids.map((b, i) =>
      prisma.bid.create({
        data: {
          auctionId: auction.id,
          bidderId: bidderRows[i]!.id,
          bidderAddress: bidderRows[i]!.xrplAddress,
          amountDrops: b.amount,
          status: b.status ?? 'COMMITTED',
          buyOfferIndex: b.offerIndex === null ? null : (b.offerIndex ?? `BUY-${uniq}-${i}`),
          bidPayloadUuid: `${TAG}-${uniq}-bid${i}`,
        },
      }),
    ),
  )

  return {
    auctionId: auction.id,
    ticketId: ticket.id,
    organizerId: organizer.id,
    sellerId: seller.id,
    bidders: bidderRows.map((b) => ({
      id: b.id,
      username: b.username,
      address: b.xrplAddress,
    })),
  }
}

async function cleanup() {
  // Children first — foreign keys.
  await prisma.transfer.deleteMany({ where: { ticket: { event: { slug: { startsWith: TAG } } } } })
  await prisma.bid.deleteMany({ where: { bidPayloadUuid: { startsWith: TAG } } })
  await prisma.listing.deleteMany({ where: { listPayloadUuid: { startsWith: TAG } } })
  await prisma.auction.deleteMany({ where: { ticket: { event: { slug: { startsWith: TAG } } } } })
  await prisma.ticket.deleteMany({ where: { event: { slug: { startsWith: TAG } } } })
  await prisma.event.deleteMany({ where: { slug: { startsWith: TAG } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: TAG } } })
}

const PAST = () => new Date(Date.now() - 60_000)
const FUTURE = () => new Date(Date.now() + 3_600_000)

beforeEach(async () => {
  await cleanup()
  brokerSale.mockReset()
  spendableDrops.mockReset()
  brokerCancelOffers.mockReset()
  // Default: everyone can pay and settlement succeeds.
  spendableDrops.mockResolvedValue(1_000_000_000n)
  brokerCancelOffers.mockResolvedValue({ hash: 'CANCEL', succeeded: true, result: 'tesSUCCESS' })
})

afterEach(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('when settlement should not happen', () => {
  it('leaves an auction that has not closed alone', async () => {
    const ctx = await seed({ reserveDrops: 10n * XRP, endsAt: FUTURE(), bids: [{ amount: 20n * XRP }] })
    const out = await settleAuction(ctx.auctionId)

    expect(out.kind).toBe('not-due')
    // Critically, nothing was submitted — settling early would sell a ticket
    // while people are still bidding.
    expect(brokerSale).not.toHaveBeenCalled()
  })

  it('cancels an auction that received no bids', async () => {
    const ctx = await seed({ reserveDrops: 10n * XRP, endsAt: PAST(), bids: [] })
    const out = await settleAuction(ctx.auctionId)

    expect(out.kind).toBe('no-bids')
    // The ticket must be released, not left IN_AUCTION forever.
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ctx.ticketId } })
    expect(ticket.status).toBe('MINTED')
    expect(ticket.ownerId).toBe(ctx.sellerId)
  })

  it('cancels when the top bid is below the reserve', async () => {
    // The reserve exists so a holder is not forced to sell cheap.
    const ctx = await seed({ reserveDrops: 20n * XRP, endsAt: PAST(), bids: [{ amount: 5n * XRP }] })
    const out = await settleAuction(ctx.auctionId)

    expect(out.kind).toBe('reserve-not-met')
    expect(brokerSale).not.toHaveBeenCalled()
    const bids = await prisma.bid.findMany({ where: { auctionId: ctx.auctionId } })
    expect(bids.every((b) => b.status === 'LOST')).toBe(true)
  })

  it('parks rather than fails when the holder has no sell offer', async () => {
    // A setup gap, not an auction outcome: there is nothing to broker against,
    // and failing would throw away real bids.
    const ctx = await seed({
      reserveDrops: 10n * XRP,
      endsAt: PAST(),
      bids: [{ amount: 20n * XRP }],
      withSellOffer: false,
    })
    const out = await settleAuction(ctx.auctionId)

    expect(out.kind).toBe('no-sell-offer')
    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: ctx.auctionId } })
    expect(auction.status).toBe('SETTLING')
    const bids = await prisma.bid.findMany({ where: { auctionId: ctx.auctionId } })
    // Bids survive, so a later sweep can still settle them.
    expect(bids.some((b) => b.status === 'COMMITTED')).toBe(true)
  })
})

describe('the happy path', () => {
  it('sells to the highest bidder and records everything together', async () => {
    brokerSale.mockResolvedValue({ hash: 'TX-WIN', succeeded: true, result: 'tesSUCCESS' })
    const ctx = await seed({
      reserveDrops: 10n * XRP,
      endsAt: PAST(),
      bids: [{ amount: 15n * XRP }, { amount: 25n * XRP }, { amount: 20n * XRP }],
    })

    const out = await settleAuction(ctx.auctionId)

    expect(out.kind).toBe('settled')
    if (out.kind !== 'settled') return
    expect(out.amountDrops).toBe(25n * XRP)
    // 2.5% of the WINNING bid, not of the reserve.
    expect(out.feeDrops).toBe(625_000n)

    const bids = await prisma.bid.findMany({ where: { auctionId: ctx.auctionId } })
    expect(bids.filter((b) => b.status === 'WON')).toHaveLength(1)
    expect(bids.find((b) => b.status === 'WON')!.amountDrops).toBe(25n * XRP)
    expect(bids.filter((b) => b.status === 'LOST')).toHaveLength(2)

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ctx.ticketId } })
    expect(ticket.ownerId).toBe(out.winnerId)
    expect(ticket.status).toBe('MINTED')

    // Provenance and the sale close in the same transaction as ownership.
    const transfer = await prisma.transfer.findUnique({ where: { txHash: 'TX-WIN' } })
    expect(transfer?.kind).toBe('AUCTION_SETTLE')

    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: ctx.auctionId } })
    expect(auction.status).toBe('SETTLED')
    const listing = await prisma.listing.findFirstOrThrow({ where: { auctionId: ctx.auctionId } })
    expect(listing.status).toBe('SOLD')
  })

  it('cleans up the losing bids’ offers', async () => {
    // Each holds 0.2 XRP of its bidder's reserve; nobody should have to sign to
    // get that back.
    brokerSale.mockResolvedValue({ hash: 'TX-WIN-2', succeeded: true, result: 'tesSUCCESS' })
    const ctx = await seed({
      reserveDrops: 10n * XRP,
      endsAt: PAST(),
      bids: [{ amount: 12n * XRP }, { amount: 30n * XRP }],
    })

    await settleAuction(ctx.auctionId)

    expect(brokerCancelOffers).toHaveBeenCalledTimes(1)
    const cancelled = brokerCancelOffers.mock.calls[0]![0] as string[]
    expect(cancelled).toHaveLength(1)
  })

  it('survives a cleanup failure without undoing the sale', async () => {
    // Tidying is best-effort. A completed sale must not be reversed because a
    // cancellation call failed.
    brokerSale.mockResolvedValue({ hash: 'TX-WIN-3', succeeded: true, result: 'tesSUCCESS' })
    brokerCancelOffers.mockRejectedValue(new Error('network'))
    const ctx = await seed({
      reserveDrops: 10n * XRP,
      endsAt: PAST(),
      bids: [{ amount: 12n * XRP }, { amount: 30n * XRP }],
    })

    const out = await settleAuction(ctx.auctionId)

    expect(out.kind).toBe('settled')
    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: ctx.auctionId } })
    expect(auction.status).toBe('SETTLED')
  })
})

describe('when the top bidder cannot pay', () => {
  it('falls through to the runner-up', async () => {
    // The whole reason buy offers were chosen over escrow: funds are not locked,
    // so the leading bidder may simply have spent the money. An auction with a
    // flaky top bidder should still sell.
    const ctx = await seed({
      reserveDrops: 10n * XRP,
      endsAt: PAST(),
      bids: [{ amount: 30n * XRP }, { amount: 20n * XRP }],
    })
    const broke = (await prisma.bid.findFirstOrThrow({
      where: { auctionId: ctx.auctionId, amountDrops: 30n * XRP },
    }))!

    spendableDrops.mockImplementation(async (addr: string) =>
      addr === broke.bidderAddress ? 1n * XRP : 1_000_000_000n,
    )
    brokerSale.mockResolvedValue({ hash: 'TX-RUNNER', succeeded: true, result: 'tesSUCCESS' })

    const out = await settleAuction(ctx.auctionId)

    expect(out.kind).toBe('settled')
    if (out.kind !== 'settled') return
    expect(out.amountDrops).toBe(20n * XRP)

    // The top bidder is not merely skipped; they are recorded as unable to pay.
    const top = await prisma.bid.findUniqueOrThrow({ where: { id: broke.id } })
    expect(top.status).toBe('LOST')
    expect(top.failureReason).toMatch(/could not pay/i)
    // And no transaction was wasted on them.
    expect(brokerSale).toHaveBeenCalledTimes(1)
  })

  it('falls through when the ledger rejects the submission', async () => {
    // Balance looked fine but settlement still failed — spent between the check
    // and the submit.
    const ctx = await seed({
      reserveDrops: 10n * XRP,
      endsAt: PAST(),
      bids: [{ amount: 30n * XRP }, { amount: 20n * XRP }],
    })
    brokerSale
      .mockResolvedValueOnce({ hash: 'TX-FAIL', succeeded: false, result: 'tecINSUFFICIENT_FUNDS' })
      .mockResolvedValueOnce({ hash: 'TX-OK', succeeded: true, result: 'tesSUCCESS' })

    const out = await settleAuction(ctx.auctionId)

    expect(out.kind).toBe('settled')
    if (out.kind !== 'settled') return
    expect(out.amountDrops).toBe(20n * XRP)
    expect(brokerSale).toHaveBeenCalledTimes(2)

    const transfer = await prisma.transfer.findUnique({ where: { txHash: 'TX-OK' } })
    expect(transfer?.kind).toBe('AUCTION_SETTLE')
  })

  it('stays retryable when nobody can pay', async () => {
    // Both offers are still live on-ledger, so this is not terminal — the same
    // lesson as the fixed-price sale that was written off as FAILED and later
    // became settleable.
    spendableDrops.mockResolvedValue(1n)
    const ctx = await seed({
      reserveDrops: 10n * XRP,
      endsAt: PAST(),
      bids: [{ amount: 30n * XRP }, { amount: 20n * XRP }],
    })

    const out = await settleAuction(ctx.auctionId)

    expect(out.kind).toBe('failed')
    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: ctx.auctionId } })
    expect(auction.status).toBe('SETTLING')
    expect(brokerSale).not.toHaveBeenCalled()

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ctx.ticketId } })
    // The ticket has NOT moved and is not released — the auction is unresolved,
    // not over.
    expect(ticket.ownerId).toBe(ctx.sellerId)
  })
})

describe('edge cases that would otherwise mis-sell', () => {
  it('ignores a bid with no on-ledger offer', async () => {
    // A bid whose buy offer never materialised cannot be brokered against.
    brokerSale.mockResolvedValue({ hash: 'TX-EDGE', succeeded: true, result: 'tesSUCCESS' })
    const ctx = await seed({
      reserveDrops: 10n * XRP,
      endsAt: PAST(),
      bids: [{ amount: 40n * XRP, offerIndex: null }, { amount: 20n * XRP }],
    })

    const out = await settleAuction(ctx.auctionId)

    expect(out.kind).toBe('settled')
    if (out.kind !== 'settled') return
    expect(out.amountDrops).toBe(20n * XRP)
  })

  it('does not settle a second time', async () => {
    // A repeat sweep must not re-broker a sold auction.
    brokerSale.mockResolvedValue({ hash: 'TX-ONCE', succeeded: true, result: 'tesSUCCESS' })
    const ctx = await seed({ reserveDrops: 10n * XRP, endsAt: PAST(), bids: [{ amount: 20n * XRP }] })

    await settleAuction(ctx.auctionId)
    const calls = brokerSale.mock.calls.length
    const second = await settleAuction(ctx.auctionId)

    expect(brokerSale.mock.calls.length).toBe(calls)
    expect(second.kind).not.toBe('settled')
    const transfers = await prisma.transfer.findMany({ where: { txHash: 'TX-ONCE' } })
    expect(transfers).toHaveLength(1)
  })

  it('charges the fee on the winning bid, not the reserve', async () => {
    // Getting this backwards would underpay Hubworld on every competitive
    // auction — the fee is a share of what actually sold.
    brokerSale.mockResolvedValue({ hash: 'TX-FEE', succeeded: true, result: 'tesSUCCESS' })
    const ctx = await seed({
      reserveDrops: 10n * XRP,
      endsAt: PAST(),
      bids: [{ amount: 100n * XRP }],
      platformBps: 250,
    })

    const out = await settleAuction(ctx.auctionId)
    if (out.kind !== 'settled') throw new Error('expected settled')

    expect(out.feeDrops).toBe(2_500_000n)
    expect(brokerSale).toHaveBeenCalledWith(
      expect.objectContaining({ brokerFeeDrops: 2_500_000n }),
    )
  })
})

/**
 * Concurrency, now that the lease is per auction rather than per sweep.
 *
 * The old design took one `auction-sweep` lease around everything, which made
 * these races impossible by making concurrency impossible. Splitting the lease
 * buys fault isolation — a stalled auction no longer blocks every other one —
 * but it opens two doors that were previously nailed shut, and both are tested
 * here because both would lose somebody money.
 */
describe('per-auction leasing', () => {
  async function releaseAll(auctionId: string) {
    await releaseLock(auctionLockName(auctionId)).catch(() => undefined)
    await releaseLock(BROKER_LOCK).catch(() => undefined)
  }

  it('settles exactly once when two sweeps run at the same time', async () => {
    const ctx = await seed({
      reserveDrops: 5n * XRP,
      endsAt: PAST(),
      bids: [{ amount: 10n * XRP, status: 'COMMITTED' }],
      withSellOffer: true,
    })
    brokerSale.mockResolvedValue({ hash: 'TX-ONCE', succeeded: true, result: 'tesSUCCESS' })

    // Both build their due list before either finishes — the exact race the
    // single global lease used to prevent by construction.
    const [a, b] = await Promise.all([settleDueAuctions(), settleDueAuctions()])

    // The ledger must be touched once. Twice would mean paying a second bidder
    // for a ticket that had already moved.
    expect(brokerSale).toHaveBeenCalledTimes(1)

    const kinds = [...a, ...b].map((r) => r.outcome.kind)
    expect(kinds.filter((k) => k === 'settled')).toHaveLength(1)

    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: ctx.auctionId } })
    expect(auction.status).toBe('SETTLED')
    await releaseAll(ctx.auctionId)
  })

  it('does not undo a finished auction when handed a stale id', async () => {
    // The failure this guards: sweep one settles and releases; sweep two arrives
    // with an id from its earlier query, finds no COMMITTED bids left, and takes
    // the no-bids path — CANCELLING an auction that had just sold.
    const ctx = await seed({
      reserveDrops: 5n * XRP,
      endsAt: PAST(),
      bids: [{ amount: 10n * XRP, status: 'COMMITTED' }],
      withSellOffer: true,
    })
    brokerSale.mockResolvedValue({ hash: 'TX-STALE', succeeded: true, result: 'tesSUCCESS' })

    const first = await settleAuction(ctx.auctionId)
    expect(first.kind).toBe('settled')

    const again = await settleAuction(ctx.auctionId)
    expect(again.kind).toBe('already-resolved')

    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: ctx.auctionId } })
    expect(auction.status).toBe('SETTLED')

    const winner = await prisma.bid.findFirstOrThrow({ where: { auctionId: ctx.auctionId } })
    expect(winner.status).toBe('WON')
    await releaseAll(ctx.auctionId)
  })

  it('skips an auction another process is holding, without touching it', async () => {
    const ctx = await seed({
      reserveDrops: 5n * XRP,
      endsAt: PAST(),
      bids: [{ amount: 10n * XRP, status: 'COMMITTED' }],
      withSellOffer: true,
    })
    // Stand in for another instance mid-settlement.
    expect(await acquireLock(auctionLockName(ctx.auctionId), 60_000)).toBe(true)

    const results = await settleDueAuctions()

    expect(results.find((r) => r.auctionId === ctx.auctionId)).toBeUndefined()
    expect(brokerSale).not.toHaveBeenCalled()
    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: ctx.auctionId } })
    expect(auction.status).toBe('LIVE')
    await releaseAll(ctx.auctionId)
  })

  it('leaves every bid untouched when the broker is busy', async () => {
    // Broker contention must never look like a bidder who could not pay. Marking
    // one LOST here would discard a good bid for a reason that had nothing to do
    // with the bidder.
    const ctx = await seed({
      reserveDrops: 5n * XRP,
      endsAt: PAST(),
      bids: [
        { amount: 10n * XRP, status: 'COMMITTED' },
        { amount: 8n * XRP, status: 'OUTBID' },
      ],
      withSellOffer: true,
    })
    expect(await acquireLock(BROKER_LOCK, 60_000)).toBe(true)

    const outcome = await settleAuction(ctx.auctionId)

    expect(outcome.kind).toBe('broker-busy')
    expect(brokerSale).not.toHaveBeenCalled()
    const bids = await prisma.bid.findMany({ where: { auctionId: ctx.auctionId } })
    expect(bids.map((b) => b.status).sort()).toEqual(['COMMITTED', 'OUTBID'])
    await releaseAll(ctx.auctionId)
  })
})
