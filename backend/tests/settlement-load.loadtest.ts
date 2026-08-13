/**
 * The sweep under a thundering herd.
 *
 * RUN ALONE: `npm run test:load`. Not part of `npm test`, and the filename ends
 * `.loadtest.ts` so the default glob cannot pick it up. The fixture here is
 * thirty auctions closing at once, and `settleDueAuctions` takes 25 at a time
 * from a database every suite shares — so run beside its neighbours this file
 * starves THEIR auctions and fails THEIR tests. Measured: six clean full-suite
 * runs without it, roughly one failure in three with it, always somewhere else.
 * See vitest.load.config.ts.
 *
 * Roadmap §4: per-auction `JobLock` leases make settlement CORRECT under
 * concurrency, but correct and fast are different claims, and auctions cluster
 * at round times — so many closing at once is exactly the moment this must not
 * fall over. Nothing exercised that.
 *
 * The fixtures close with NO bids, so every auction takes the terminal `no-bids`
 * path: it exercises the queue, the batch cap and the lease without submitting
 * anything to a ledger, without the broker, and without leaving rows that a
 * later sweep would pick up again. That last property is what makes the
 * concurrency assertion meaningful rather than a coin toss.
 *
 * Assertions are about OUR auctions only, never about the global result count.
 * `settleDueAuctions` sweeps every due auction in the database and suites share
 * one, so a test that asserts a total passes alone and fails beside a neighbour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The ledger is mocked DEFENSIVELY, not because these fixtures need it.
 *
 * A no-bids auction never reaches the broker, so nothing here would call it.
 * But `settleDueAuctions` sweeps every due auction in the database, not just
 * this file's — and suites share one. Without this mock a sweep started here
 * could pick up a neighbouring suite's fully-formed auction and submit a REAL
 * broker transaction with the seed from `.env`.
 *
 * `telLOCAL_ERROR` resolves rather than throws for the same reason
 * `network-scoping.test.ts` chose it: `classifyResult` treats `tel*` as
 * transient — safe to retry as-is — so a foreign auction this sweep happens to
 * touch is left intact for its own suite instead of having a bidder demoted.
 */
const brokerSale = vi.fn()

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return {
    ...actual,
    brokerSale: (...a: unknown[]) => brokerSale(...a),
    spendableDrops: async () => 10_000_000_000n,
    brokerCancelOffers: async () => undefined,
  }
})

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { settleDueAuctions } = await import('../src/settlement.js')

const TAG = 'load-sweep'

/** Matches the `take` in settleDueAuctions. Asserted below, not assumed. */
const SWEEP_BATCH = 25

let created: string[] = []

async function seedDueAuctions(count: number): Promise<string[]> {
  const uniq = Math.random().toString(36).slice(2, 8)

  const organizer = await prisma.user.create({
    data: { username: `${TAG}-org-${uniq}`, xrplAddress: `r${TAG}org${uniq}`.slice(0, 34) },
  })

  const event = await prisma.event.create({
    data: {
      slug: `${TAG}-event-${uniq}`,
      title: 'Sweep load fixture',
      organizerId: organizer.id,
      startsAt: new Date('2030-01-01T00:00:00Z'),
      nftTaxon: 990_000,
      ticketCount: count,
      royaltyBps: 0,
      platformBps: 250,
      network: NETWORK,
    },
  })

  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const ticket = await prisma.ticket.create({
      data: {
        // Unique per ticket AND per run: the column is unique on
        // (network, nfTokenId), and two suites seeding at once must not collide.
        nfTokenId: `LOAD${uniq}${Math.random().toString(36).slice(2, 10)}${String(i).padStart(4, '0')}`
          .toUpperCase()
          .padEnd(64, '0'),
        eventId: event.id,
        ownerId: organizer.id,
        ownerAddress: organizer.xrplAddress,
        network: NETWORK,
      },
    })

    const auction = await prisma.auction.create({
      data: {
        ticketId: ticket.id,
        network: NETWORK,
        startsAt: new Date(Date.now() - 60_000),
        // All closing at the same instant: the herd this test is named for.
        //
        // Only JUST due, and that is load-bearing. The sweep takes 25 at a time
        // ordered by `endsAt` ASC, so a herd dated well into the past sorts
        // ahead of every other suite's fixture and fills the batch — starving
        // their auctions and failing their tests, which is exactly what an
        // earlier version of this file did. Being the newest due work puts this
        // fixture at the BACK of the shared queue, where a load test belongs.
        endsAt: new Date(Date.now() - 100),
        reserveDrops: 10_000_000n,
        status: 'LIVE',
      },
    })
    ids.push(auction.id)
  }

  return ids
}

beforeEach(() => {
  created = []
  brokerSale.mockReset()
  brokerSale.mockResolvedValue({
    hash: 'load-not-submitted',
    succeeded: false,
    result: 'telLOCAL_ERROR',
  })
})

afterEach(async () => {
  if (created.length === 0) return
  await prisma.auction.deleteMany({ where: { id: { in: created } } })
  await prisma.ticket.deleteMany({ where: { nfTokenId: { startsWith: 'LOAD' } } })
  await prisma.event.deleteMany({ where: { slug: { startsWith: `${TAG}-event-` } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: `${TAG}-org-` } } })
})

type Result = { auctionId: string; outcome: { kind: string } }

/** Only the results belonging to this test's fixtures. */
const mine = (results: Result[], ids: string[]) => results.filter((r) => ids.includes(r.auctionId))

describe('settleDueAuctions under a herd', () => {
  it('closes every auction it picks up', async () => {
    created = await seedDueAuctions(5)

    const ours = mine(await settleDueAuctions(), created)

    expect(ours).toHaveLength(5)
    expect(ours.every((r) => r.outcome.kind === 'no-bids')).toBe(true)

    const closed = await prisma.auction.count({
      where: { id: { in: created }, status: 'CANCELLED' },
    })
    expect(closed).toBe(5)
  })

  it('caps a single sweep, so a herd drains over several passes', async () => {
    // The cap is real and silent: 30 auctions closing together, and one sweep
    // handles at most 25. At a 15s interval that is a queue rather than a stall
    // — but it is a queue nobody had measured, and it lengthens with however
    // long each settlement's ledger round trip takes. A herd big enough will
    // therefore close late, and no error is raised when it does.
    created = await seedDueAuctions(SWEEP_BATCH + 5)

    const first = mine(await settleDueAuctions(), created)
    expect(first.length).toBeLessThanOrEqual(SWEEP_BATCH)
    expect(first.length).toBeLessThan(created.length)

    // Drain is asserted against the DATABASE, not against this call's results.
    // Suites share a database and sweep concurrently, so another suite's sweep
    // may legitimately close one of these auctions — in which case it never
    // appears in a result list here at all. Counting our own returned ids
    // therefore under-counts whenever a neighbour is busy, which is precisely
    // the flake this replaces. What matters operationally is that the herd ends
    // up closed and the loop terminates.
    const outstanding = () =>
      prisma.auction.count({
        where: { id: { in: created }, status: { in: ['LIVE', 'SETTLING'] } },
      })

    for (let pass = 0; pass < 6 && (await outstanding()) > 0; pass++) {
      await settleDueAuctions()
    }

    expect(await outstanding()).toBe(0)
    expect(
      await prisma.auction.count({ where: { id: { in: created }, status: 'CANCELLED' } }),
    ).toBe(created.length)
  })

  it('does the work once per auction when two sweeps overlap', async () => {
    // What the per-auction lease is for. Two processes sweeping at once is the
    // normal case the moment there is more than one instance, and settling the
    // same auction twice would burn a fee discovering the offers were already
    // consumed.
    //
    // The invariant is not "appears once" — a second sweep may legitimately
    // observe an auction the first has already finished, and reports it as
    // `already-resolved` having changed nothing. It is that the WORK happens
    // once.
    created = await seedDueAuctions(10)

    const [a, b] = await Promise.all([settleDueAuctions(), settleDueAuctions()])

    const worked = [...mine(a, created), ...mine(b, created)].filter(
      (r) => r.outcome.kind !== 'already-resolved',
    )
    const workedIds = worked.map((r) => r.auctionId)

    // The lease property: no auction was acted on twice. Deliberately NOT
    // "exactly ten were acted on here" — a neighbouring suite sweeps the same
    // database, so it may close one of these first, and it would then be absent
    // from both result sets. That is correct behaviour, and asserting a count
    // makes a passing property fail whenever someone else is running.
    expect(new Set(workedIds).size).toBe(workedIds.length)

    // What must hold regardless of who did the work.
    const closed = await prisma.auction.count({
      where: { id: { in: created }, status: 'CANCELLED' },
    })
    expect(closed).toBe(10)
  })
})
