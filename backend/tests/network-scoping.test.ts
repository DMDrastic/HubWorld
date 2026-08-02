/**
 * Rows are scoped to the ledger they belong to.
 *
 * An `NFTokenID`, an offer index and a tx hash are only meaningful against one
 * network, and nothing in the data model recorded which. A database holding
 * both testnet and mainnet rows was therefore indistinguishable to anything
 * that reads the ledger: `ledger:sync` pointed at mainnet found none of the
 * testnet tickets held by any account it could see and reported the entire
 * inventory as drift — which `--apply` would then have acted on.
 *
 * Two properties are pinned here, both with controls. A scoping test that only
 * asserts an absence passes just as well when the fixture was never created, so
 * every exclusion below is paired with the same query finding the row when it
 * IS on this network.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return {
    ...actual,
    // Nothing here should reach the network. If scoping fails, settlement would
    // try to broker a foreign auction — and this throwing is how we would know.
    brokerSale: () => {
      throw new Error('brokerSale must not be reached for a foreign-network auction')
    },
    spendableDrops: async () => 10_000_000_000n,
    brokerCancelOffers: async () => undefined,
  }
})

const { prisma } = await import('../src/prisma.js')
const { NETWORK, onThisNetwork } = await import('../src/network.js')
const { settleDueAuctions } = await import('../src/settlement.js')

const XRP = 1_000_000n
const TAG = 'netscope'

/** The tests run with XRPL_NETWORK unset, so this process is testnet. */
const OTHER = 'MAINNET' as const

async function cleanup() {
  await prisma.bid.deleteMany({ where: { auction: { ticket: { event: { slug: { startsWith: TAG } } } } } })
  await prisma.listing.deleteMany({ where: { ticket: { event: { slug: { startsWith: TAG } } } } })
  await prisma.auction.deleteMany({ where: { ticket: { event: { slug: { startsWith: TAG } } } } })
  await prisma.transfer.deleteMany({ where: { ticket: { event: { slug: { startsWith: TAG } } } } })
  await prisma.ticket.deleteMany({ where: { event: { slug: { startsWith: TAG } } } })
  await prisma.event.deleteMany({ where: { slug: { startsWith: TAG } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: TAG } } })
}

beforeEach(cleanup)
afterEach(cleanup)
afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

async function makeEvent(network: typeof NETWORK | typeof OTHER, uniq: string) {
  const organizer = await prisma.user.create({
    data: { username: `${TAG}-org-${uniq}`, xrplAddress: `r${TAG}org${uniq}`.slice(0, 34) },
  })
  const event = await prisma.event.create({
    data: {
      slug: `${TAG}-${uniq}`,
      network,
      title: 'Network Scoping',
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: organizer.id,
      nftTaxon: 70_000 + Math.floor(Math.random() * 9_000),
      ticketCount: 1,
    },
  })
  return { organizer, event }
}

describe('an on-ledger id is unique per network, not globally', () => {
  it('lets the same NFTokenID exist on two networks', async () => {
    // Reachable rather than theoretical: an NFTokenID derives from the issuer's
    // AccountID, the taxon and the sequence, none of which are network-specific.
    // Reusing a seed across networks is ordinary in development, so the same
    // account minting the same taxon at the same sequence collides exactly.
    const nfTokenId = 'A'.repeat(64)
    const a = await makeEvent(NETWORK, 'aa')
    const b = await makeEvent(OTHER, 'bb')

    await prisma.ticket.create({
      data: { nfTokenId, network: NETWORK, eventId: a.event.id },
    })
    await prisma.ticket.create({
      data: { nfTokenId, network: OTHER, eventId: b.event.id },
    })

    const both = await prisma.ticket.findMany({ where: { nfTokenId } })
    expect(both).toHaveLength(2)
    expect(new Set(both.map((t) => t.network))).toEqual(new Set([NETWORK, OTHER]))
  })

  it('still refuses a duplicate within one network', async () => {
    // The constraint must not have been loosened into uselessness.
    const nfTokenId = 'B'.repeat(64)
    const { event } = await makeEvent(NETWORK, 'cc')

    await prisma.ticket.create({ data: { nfTokenId, network: NETWORK, eventId: event.id } })
    await expect(
      prisma.ticket.create({ data: { nfTokenId, network: NETWORK, eventId: event.id } }),
    ).rejects.toThrow()
  })

  it('finds a ticket by the network-scoped key', async () => {
    const nfTokenId = 'C'.repeat(64)
    const { event } = await makeEvent(NETWORK, 'dd')
    await prisma.ticket.create({ data: { nfTokenId, network: NETWORK, eventId: event.id } })

    const found = await prisma.ticket.findUnique({
      where: { network_nfTokenId: { network: NETWORK, nfTokenId } },
    })
    expect(found).not.toBeNull()

    // The same id on the other network is a different ticket, and absent.
    const foreign = await prisma.ticket.findUnique({
      where: { network_nfTokenId: { network: OTHER, nfTokenId } },
    })
    expect(foreign).toBeNull()
  })
})

describe('the settlement sweep only settles this network', () => {
  /** A due, LIVE auction with a committed bid — settleable but for its network. */
  async function dueAuction(network: typeof NETWORK | typeof OTHER, uniq: string) {
    const { event } = await makeEvent(network, uniq)
    const bidder = await prisma.user.create({
      data: { username: `${TAG}-bid-${uniq}`, xrplAddress: `r${TAG}bid${uniq}`.slice(0, 34) },
    })
    const ticket = await prisma.ticket.create({
      data: {
        nfTokenId: uniq.padEnd(64, 'F'),
        network,
        eventId: event.id,
        status: 'IN_AUCTION',
      },
    })
    const auction = await prisma.auction.create({
      data: {
        ticketId: ticket.id,
        network,
        startsAt: new Date(Date.now() - 120_000),
        endsAt: new Date(Date.now() - 60_000), // due
        reserveDrops: 1n * XRP,
        status: 'LIVE',
      },
    })
    await prisma.bid.create({
      data: {
        auctionId: auction.id,
        network,
        bidderId: bidder.id,
        bidderAddress: bidder.xrplAddress,
        amountDrops: 5n * XRP,
        status: 'COMMITTED',
        buyOfferIndex: `offer-${uniq}`,
      },
    })
    return auction
  }

  it('ignores a due auction belonging to another network', async () => {
    // Settlement SUBMITS a transaction. Brokering an auction from another
    // ledger means matching offers that do not exist here — the fee is spent
    // to discover it. The mocked brokerSale throws if this is reached.
    const foreign = await dueAuction(OTHER, 'ee')

    const results = await settleDueAuctions()

    expect(results.map((r) => r.auctionId)).not.toContain(foreign.id)
    // Untouched, not merely unsettled.
    const after = await prisma.auction.findUniqueOrThrow({ where: { id: foreign.id } })
    expect(after.status).toBe('LIVE')
  })

  it('does pick up the identical auction on this network', async () => {
    // The control. Without it the test above passes just as well when the
    // sweep is broken, or when the fixture was never due in the first place.
    const mine = await dueAuction(NETWORK, 'ff')

    const results = await settleDueAuctions()

    expect(results.map((r) => r.auctionId)).toContain(mine.id)
    const after = await prisma.auction.findUniqueOrThrow({ where: { id: mine.id } })
    expect(after.status).not.toBe('LIVE')
  })
})

describe('scoping a query by network', () => {
  it('excludes rows from other ledgers, and only those', async () => {
    await makeEvent(NETWORK, 'gg')
    await makeEvent(OTHER, 'hh')

    const scoped = await prisma.event.findMany({
      where: { ...onThisNetwork, slug: { startsWith: TAG } },
    })
    const unscoped = await prisma.event.findMany({ where: { slug: { startsWith: TAG } } })

    expect(scoped).toHaveLength(1)
    expect(scoped[0]!.network).toBe(NETWORK)
    // The control: both rows really do exist, so the exclusion above is the
    // filter working rather than the fixture missing.
    expect(unscoped).toHaveLength(2)
  })
})
