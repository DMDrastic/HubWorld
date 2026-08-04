/**
 * `evaluateSoldOut` — the real one, against a real database.
 *
 * WHY THIS EXISTS. `auction-policy.test.ts` reimplements the rule inside the
 * test file — "Mirrors evaluateSoldOut's decision" — and then tests the copy.
 * That test passes whatever the shipped function does, and Stryker found it on
 * its first run: 78 mutants in `src/auction-policy.ts`, none covered.
 *
 * It is not a hypothetical. Deleting `organizerHolds === 0` from the shipped
 * source — the entire second half of the rule — left every test passing. With
 * that half gone, an organizer holding their whole allocation qualifies as sold
 * out and can open auctions on their own stock: an organizer bidding up their
 * own event, which is the exact thing the rule exists to prevent.
 *
 * So these import the module. A mirror in a test file is documentation that
 * cannot fail; the point of a test is that it can.
 *
 * DB-backed because the function counts rows — that counting IS the behaviour,
 * and the codebase's rule is that sold out is DERIVED, never read from
 * `Event.status`, precisely because that field is settable and was once wrong.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { evaluateSoldOut } = await import('../src/auction-policy.js')

const TAG = 'apreal'

async function cleanup() {
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

/**
 * An event with `ticketCount` promised, `minted` issued, of which `heldByOrg`
 * remain with the organizer and the rest sit with an attendee.
 */
async function seed(opts: {
  ticketCount: number
  minted: number
  heldByOrg: number
  status?: 'PUBLISHED' | 'SOLD_OUT'
}) {
  const uniq = Math.random().toString(36).slice(2, 8)
  const organizer = await prisma.user.create({
    data: { username: `${TAG}-org-${uniq}`, xrplAddress: `r${TAG}org${uniq}`.slice(0, 34) },
  })
  const holder = await prisma.user.create({
    data: { username: `${TAG}-fan-${uniq}`, xrplAddress: `r${TAG}fan${uniq}`.slice(0, 34) },
  })
  const event = await prisma.event.create({
    data: {
      slug: `${TAG}-${uniq}`,
      network: NETWORK,
      title: 'Policy',
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: organizer.id,
      nftTaxon: 80_000 + Math.floor(Math.random() * 9_000),
      ticketCount: opts.ticketCount,
      status: opts.status ?? 'PUBLISHED',
    },
  })
  for (let i = 0; i < opts.minted; i++) {
    const owner = i < opts.heldByOrg ? organizer : holder
    await prisma.ticket.create({
      data: {
        nfTokenId: `${TAG}${uniq}${i}`.padEnd(64, '0').slice(0, 64),
        network: NETWORK,
        eventId: event.id,
        ownerId: owner.id,
        ownerAddress: owner.xrplAddress,
      },
    })
  }
  return event
}

describe('sold out requires BOTH halves, against the shipped function', () => {
  it('is sold out only when everything is issued AND the organizer holds none', async () => {
    const event = await seed({ ticketCount: 3, minted: 3, heldByOrg: 0 })
    const state = await evaluateSoldOut(event.id)

    expect(state).toMatchObject({ ticketCount: 3, minted: 3, organizerHolds: 0, soldOut: true })
  })

  it('is NOT sold out while the organizer still holds stock', async () => {
    // The half that deleting left undetected. Buyers can still pay face value,
    // so there is nothing scarce to bid over — and an organizer auctioning
    // their own allocation is bidding up their own event.
    const event = await seed({ ticketCount: 3, minted: 3, heldByOrg: 1 })
    const state = await evaluateSoldOut(event.id)

    expect(state.organizerHolds).toBe(1)
    expect(state.soldOut).toBe(false)
  })

  it('is NOT sold out while tickets remain unissued', async () => {
    const event = await seed({ ticketCount: 5, minted: 2, heldByOrg: 0 })
    expect((await evaluateSoldOut(event.id)).soldOut).toBe(false)
  })

  it('treats a ticketCount of 0 as never sold out', async () => {
    // No declared cap. Otherwise an event would qualify the moment it existed,
    // with nothing minted at all.
    const event = await seed({ ticketCount: 0, minted: 0, heldByOrg: 0 })
    expect((await evaluateSoldOut(event.id)).soldOut).toBe(false)
  })

  it('counts over-issue as sold out, since minted >= ticketCount', async () => {
    const event = await seed({ ticketCount: 2, minted: 3, heldByOrg: 0 })
    expect((await evaluateSoldOut(event.id)).soldOut).toBe(true)
  })
})

describe('it corrects Event.status rather than trusting it', () => {
  it('promotes PUBLISHED to SOLD_OUT when the counts say so', async () => {
    // The enum is a cache of a derived fact. Seeded data once claimed SOLD_OUT
    // with zero tickets minted, which is why nothing reads that field.
    const event = await seed({ ticketCount: 2, minted: 2, heldByOrg: 0, status: 'PUBLISHED' })
    await evaluateSoldOut(event.id)

    const after = await prisma.event.findUniqueOrThrow({ where: { id: event.id } })
    expect(after.status).toBe('SOLD_OUT')
  })

  it('demotes SOLD_OUT back to PUBLISHED when a ticket returns to the organizer', async () => {
    const event = await seed({ ticketCount: 2, minted: 2, heldByOrg: 1, status: 'SOLD_OUT' })
    await evaluateSoldOut(event.id)

    const after = await prisma.event.findUniqueOrThrow({ where: { id: event.id } })
    expect(after.status).toBe('PUBLISHED')
  })
})
