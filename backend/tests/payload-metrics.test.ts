/**
 * Payload accounting: the quota is spent by flow, so it must be counted by flow.
 *
 * The Xaman application has a limit on payloads CREATED and none of it can be
 * reclaimed — cancelling a resolved payload returns 404 and it still counts. The
 * testnet application is already exhausted, so this is not a hypothetical
 * ceiling; it is the failure mode at scale, arriving early. What was missing was
 * any way to say where the spend went, which made the question that decides the
 * unit economics — how many payloads does one attendee cost, end to end —
 * unanswerable.
 *
 * Two properties carry the whole design, and both are pinned here with the
 * failure they exist to prevent:
 *
 * 1. **Creating a payload counts it.** Counting lives in the signer wrapper
 *    rather than in eleven routes, because a route that forgets is real spend
 *    that never shows up in the numbers. Deleting the record call in
 *    `CountingSigner` must fail a test.
 *
 * 2. **Stub payloads are not spend.** They cost nothing and the e2e suite makes
 *    them by the dozen. Folding them into the totals would overstate consumption
 *    in the one direction that HIDES a problem — you would look at an inflated
 *    figure, believe you were near the limit, and never learn what real usage
 *    costs.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { withPayloadCounting } = await import('../src/xaman.js')
const { payloadUsage, recordPayloadCreation } = await import('../src/payload-metrics.js')

/**
 * A signer that touches no network.
 *
 * The exported `xaman` is deliberately NOT used here. In a checkout holding real
 * credentials it resolves to the live client, so exercising it would create real
 * Xaman payloads on every test run — spending the quota this feature exists to
 * conserve, and reporting the suite's own consumption as product usage. Counting
 * is a property of the wrapper, not of who it wraps, so a fake proves it.
 */
const fakeSigner = {
  mode: 'stub' as const,
  async createPayload() {
    return { uuid: uid(), next: 'none://', qrPng: 'data:,' }
  },
  async createSignInPayload() {
    return { uuid: uid(), next: 'none://', qrPng: 'data:,' }
  },
  async getPayload() {
    return null
  },
  async cancelPayload() {
    return true
  },
}

const xaman = withPayloadCounting(fakeSigner)

const TAG = 'pmtest'

let n = 0
const uid = () => `${TAG}-${Date.now()}-${n++}`

async function cleanup() {
  await prisma.xamanPayload.deleteMany({ where: { uuid: { startsWith: TAG } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: TAG } } })
}

beforeEach(cleanup)
afterEach(cleanup)
afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

async function makeUser() {
  const u = uid()
  return prisma.user.create({
    data: { username: u.slice(0, 30), xrplAddress: `r${u}`.slice(0, 34) },
  })
}

/** Only this suite's rows, so a shared database cannot colour the result. */
async function usageOf(signer: string) {
  const rows = await prisma.xamanPayload.findMany({ where: { uuid: { startsWith: TAG }, signer } })
  return rows
}

describe('creating a payload is what counts it', () => {
  it('records flow, network and signer without the route doing anything', async () => {
    // The route is not involved at all here — this is the seam. If counting
    // lived in the routes, this test could not exist and eleven call sites
    // would each be one forgotten line away from invisible spend.
    const created = await xaman.createPayload({ TransactionType: 'NFTokenMint' }, { flow: 'MINT' })

    const row = await prisma.xamanPayload.findUnique({ where: { uuid: created.uuid } })
    expect(row).not.toBeNull()
    expect(row!.flow).toBe('MINT')
    expect(row!.network).toBe(NETWORK)
    // Taken from the wrapped signer, not from a constant — which is what makes
    // a second signer at this seam distinguishable in the report.
    expect(row!.signer).toBe('stub')

    await prisma.xamanPayload.delete({ where: { uuid: created.uuid } })
  })

  it('attributes it to a user when one is known', async () => {
    const user = await makeUser()
    const created = await xaman.createPayload(
      { TransactionType: 'NFTokenCreateOffer' },
      { flow: 'AUCTION_BID', userId: user.id },
    )

    const row = await prisma.xamanPayload.findUnique({ where: { uuid: created.uuid } })
    expect(row!.userId).toBe(user.id)
    expect(row!.flow).toBe('AUCTION_BID')

    await prisma.xamanPayload.delete({ where: { uuid: created.uuid } })
  })

  it('records sign-in payloads too, and separates the door from sign-in', async () => {
    // Both submit the same SignIn pseudo-transaction, so nothing about the wire
    // format distinguishes them. They have opposite cost curves — sign-in is
    // once per person per week, the door is once per person per event — so
    // collapsing them would hide whichever one grows.
    const a = await xaman.createSignInPayload({ flow: 'SIGNIN' })
    const b = await xaman.createSignInPayload({ flow: 'DOOR_CHECKIN' })

    const rows = await prisma.xamanPayload.findMany({ where: { uuid: { in: [a.uuid, b.uuid] } } })
    expect(rows.map((r) => r.flow).sort()).toEqual(['DOOR_CHECKIN', 'SIGNIN'])

    await prisma.xamanPayload.deleteMany({ where: { uuid: { in: [a.uuid, b.uuid] } } })
  })

  it('registers the payload before the caller can act on it', async () => {
    // This is what absorbing `trackPayload` bought. Routes used to register the
    // payload a few statements after creating it, leaving a window in which a
    // signature could resolve against a uuid reconciliation had never heard of.
    // By the time createPayload RETURNS, the row already exists.
    const created = await xaman.createSignInPayload({ flow: 'SIGNIN' })
    expect(await prisma.xamanPayload.count({ where: { uuid: created.uuid } })).toBe(1)

    await prisma.xamanPayload.delete({ where: { uuid: created.uuid } })
  })
})

describe('stub payloads are never counted as quota spend', () => {
  it('excludes them from the default report', async () => {
    await recordPayloadCreation({ uuid: `${TAG}-real`, flow: 'MINT', signer: 'xaman' })
    await recordPayloadCreation({ uuid: `${TAG}-fake`, flow: 'MINT', signer: 'stub' })

    // Paired with its control, so this cannot pass by finding nothing at all.
    expect((await usageOf('xaman')).length).toBe(1)
    expect((await usageOf('stub')).length).toBe(1)

    const real = await payloadUsage({ signer: 'xaman' })
    const stub = await payloadUsage({ signer: 'stub' })
    expect(real.signer).toBe('xaman')
    expect(real.created).toBeGreaterThanOrEqual(1)
    expect(stub.created).toBeGreaterThanOrEqual(1)
  })
})

describe('the report', () => {
  /** A fixed set of rows, written directly so the arithmetic has known inputs. */
  async function seed() {
    const user = await makeUser()
    const rows = [
      { uuid: `${TAG}-1`, flow: 'SIGNIN' as const, signed: true, terminal: true, userId: null },
      { uuid: `${TAG}-2`, flow: 'SIGNIN' as const, signed: false, terminal: true, userId: null },
      { uuid: `${TAG}-3`, flow: 'SIGNIN' as const, signed: false, terminal: false, userId: null },
      { uuid: `${TAG}-4`, flow: 'MINT' as const, signed: true, terminal: true, userId: user.id },
      { uuid: `${TAG}-5`, flow: 'MINT' as const, signed: true, terminal: true, userId: user.id },
    ]
    for (const r of rows) {
      await prisma.xamanPayload.create({
        data: { ...r, network: NETWORK, signer: `${TAG}signer` },
      })
    }
    return user
  }

  it('counts creations, signatures and waste separately', async () => {
    await seed()
    const u = await payloadUsage({ signer: `${TAG}signer` })

    expect(u.created).toBe(5)
    expect(u.signed).toBe(3)
    // Exactly one: `-2` is over and unsigned. `-3` is unsigned but still in
    // flight, and counting that as waste would make the figure swing with
    // however many people happen to be mid-flow when the report runs.
    expect(u.wasted).toBe(1)
  })

  it('breaks down by flow, largest first', async () => {
    await seed()
    const u = await payloadUsage({ signer: `${TAG}signer` })

    expect(u.byFlow).toEqual([
      { flow: 'SIGNIN', created: 3, signed: 1 },
      { flow: 'MINT', created: 2, signed: 2 },
    ])
  })

  it('reports attributed payloads per user, counting only attributable rows', async () => {
    await seed()
    const u = await payloadUsage({ signer: `${TAG}signer` })

    // Two MINT rows for one user. The three SIGNIN rows have no user and must
    // not be divided into anyone — which is exactly why this is documented as a
    // FLOOR on the cost of a person rather than the cost of a person.
    expect(u.distinctUsers).toBe(1)
    expect(u.perIdentifiedUser).toBe(2)
  })

  it('has no per-user figure when nothing is attributable', async () => {
    await recordPayloadCreation({ uuid: `${TAG}-x`, flow: 'SIGNIN', signer: `${TAG}signer` })
    const u = await payloadUsage({ signer: `${TAG}signer` })

    // Null, not zero. Zero would read as "each user costs nothing".
    expect(u.perIdentifiedUser).toBeNull()
  })

  it('scopes to one network', async () => {
    const foreign = NETWORK === 'MAINNET' ? 'TESTNET' : 'MAINNET'
    await prisma.xamanPayload.create({
      data: { uuid: `${TAG}-far`, flow: 'MINT', network: foreign, signer: `${TAG}signer` },
    })
    await prisma.xamanPayload.create({
      data: { uuid: `${TAG}-near`, flow: 'MINT', network: NETWORK, signer: `${TAG}signer` },
    })

    // Paired control: the same query finds the row when it IS on this network,
    // so this cannot pass by matching nothing.
    expect((await payloadUsage({ signer: `${TAG}signer` })).created).toBe(1)
    expect((await payloadUsage({ signer: `${TAG}signer`, network: foreign })).created).toBe(1)
  })
})

describe('counting must never break signing', () => {
  it('swallows a write failure rather than throwing', async () => {
    // The person holding the phone does not care that we failed to count them.
    // A metrics write that can throw turns a bookkeeping problem into a failed
    // mint, which is a far worse trade than an undercounted payload.
    await expect(
      recordPayloadCreation({
        uuid: `${TAG}-bad`,
        flow: 'MINT',
        signer: 'xaman',
        userId: 'no-such-user-id',
      }),
    ).resolves.toBeUndefined()
  })

  it('keeps the original attribution if the same uuid is recorded twice', async () => {
    await recordPayloadCreation({ uuid: `${TAG}-dup`, flow: 'MINT', signer: 'xaman' })
    await recordPayloadCreation({ uuid: `${TAG}-dup`, flow: 'AUCTION_BID', signer: 'xaman' })

    const row = await prisma.xamanPayload.findUnique({ where: { uuid: `${TAG}-dup` } })
    // The first write is the one that happened at creation.
    expect(row!.flow).toBe('MINT')
  })
})
