/**
 * The lazy primary sale, over HTTP. Real Express app, session and database; the
 * ledger and Xaman are faked.
 *
 * What is pinned is everything that can go wrong without looking wrong: two
 * buyers handed one ticket, an offer left on the ledger for a buyer who left, a
 * ticket stuck behind a hold that nothing will ever clear, and — above all — the
 * delegate being talked into listing something it was not asked to.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { Wallet } from 'xrpl'
import { makeNftId } from './nft-id.js'

const BROKER = Wallet.generate().classicAddress
const DELEGATE = Wallet.generate().classicAddress

type Created = Record<string, unknown>

const fake = vi.hoisted(() => ({
  permission: 'granted' as 'granted' | 'absent' | 'unknown',
  notHeld: new Set<string>(),
  holdsUnknown: false,
  funding: { spendableDrops: 100_000_000_000n, reserveIncDrops: 200_000n } as { spendableDrops: bigint; reserveIncDrops: bigint },
  fundingThrows: false,
  /** How long the leased SUBMIT takes. */
  offerDelayMs: 0,
  /** How long the unleased wait for validation takes. */
  waitDelayMs: 0,
  /** Outcome of the submit (preliminary codes such as terNO_DELEGATE_PERMISSION). */
  result: (): { ok: true } | { ok: false; code: string } => ({ ok: true }),
  /** Outcome after validation (tec codes, which still consume the sequence). */
  awaitResult: (): { ok: true } | { ok: false; code: string } => ({ ok: true }),
  created: [] as Created[],
  cancelled: [] as string[][],
  /** How many times the leased submit was attempted. */
  starts: 0,
  n: 0,
}))

vi.mock('../src/primary-sale-ledger.js', () => {
  const ledger = {
    async readPermission() {
      return fake.permission
    },
    async holds(_org: string, id: string) {
      if (fake.holdsUnknown) return null
      return !fake.notHeld.has(id)
    },
    async funding() {
      if (fake.fundingThrows) throw new Error('node down')
      return fake.funding
    },
    async startSellOffer(tx: Created) {
      fake.starts += 1
      if (fake.offerDelayMs) await new Promise((r) => setTimeout(r, fake.offerDelayMs))
      const r = fake.result()
      if (!r.ok) return r
      fake.created.push(tx)
      fake.n += 1
      return { ok: true as const, hash: `TX${fake.n}`.padEnd(64, '0'), lastLedgerSequence: 0, n: fake.n }
    },
    async awaitSellOffer(started: { hash: string; n: number }) {
      if (fake.waitDelayMs) await new Promise((r) => setTimeout(r, fake.waitDelayMs))
      const r = fake.awaitResult()
      if (!r.ok) return r
      return { ok: true as const, txHash: started.hash, offerIndex: `OFFER${started.n}`.padEnd(64, '0') }
    },
    async cancelOffers(indexes: string[]) {
      fake.cancelled.push(indexes)
    },
  }
  return { defaultPrimarySaleLedger: () => ledger, realPrimarySaleLedger: () => ledger, stubPrimarySaleLedger: () => ledger }
})

const createPayload = vi.fn<(tx: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown>>()
const tryGetPayload = vi.fn<(uuid: string) => Promise<unknown>>()

vi.mock('../src/xaman.js', async () => {
  const actual = await vi.importActual<typeof import('../src/xaman.js')>('../src/xaman.js')
  return {
    ...actual,
    tryGetPayload: (u: string) => tryGetPayload(u),
    xaman: {
      mode: 'stub' as const,
      createPayload: (...a: Parameters<typeof createPayload>) => createPayload(...a),
      createSignInPayload: async () => ({ uuid: '', next: '', qrPng: '' }),
      getPayload: async () => null,
      cancelPayload: async () => true,
    },
  }
})

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return { ...actual, platformAddress: () => BROKER, delegateAddress: () => DELEGATE }
})

vi.mock('../src/env.js', async () => {
  const actual = await vi.importActual<typeof import('../src/env.js')>('../src/env.js')
  return { ...actual, brokerMode: 'live' as const, delegateMode: 'live' as const }
})

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')
const { releaseHold, releaseExpiredHolds, claimTicket } = await import('../src/primary-sale.js')
const { HOLD_GRACE_MS } = await import('../src/primary-sale-policy.js')
const { defaultPrimarySaleLedger } = await import('../src/primary-sale-ledger.js')

const app = createApp()
const UTAG = 'ps_'
const XRP = 1_000_000n
const PRICE = 25n * XRP
const FEE = (PRICE * 250n) / 10_000n // 2.5% platform fee

type Actor = { id: string; username: string; address: string; token: string }
let uniq = ''
let n = 0

async function mkUser(name: string, role: 'USER' | 'ORGANIZER' = 'USER'): Promise<Actor> {
  const address = Wallet.generate().classicAddress
  const user = await prisma.user.create({
    data: { username: `${UTAG}${name}_${uniq}`.slice(0, 20), xrplAddress: address, role },
  })
  const { token } = await createSession(user.id)
  return { id: user.id, username: user.username, address, token }
}
const as = (a: Actor) => `Bearer ${a.token}`

async function mkEvent(organizer: Actor, over: Record<string, unknown> = {}) {
  return prisma.event.create({
    data: {
      network: NETWORK,
      slug: `ps-${uniq}`,
      title: 'Box Office Test',
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: organizer.id,
      nftTaxon: 80_000 + Math.floor(Math.random() * 900),
      royaltyBps: 500,
      platformBps: 250,
      ticketCount: 100,
      status: 'PUBLISHED',
      primaryPriceDrops: PRICE,
      ...over,
    },
  })
}

/** Tickets the organizer holds, with REAL NFTokenIDs so the guard runs on every sale. */
async function mkTickets(event: { id: string; nftTaxon: number }, organizer: Actor, count: number) {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    n += 1
    const nfTokenId = makeNftId(organizer.address, event.nftTaxon, n)
    ids.push(nfTokenId)
    await prisma.ticket.create({
      data: {
        nfTokenId,
        network: NETWORK,
        eventId: event.id,
        ownerId: organizer.id,
        ownerAddress: organizer.address,
        status: 'MINTED',
      },
    })
    await new Promise((r) => setTimeout(r, 2)) // distinct createdAt, so claim order is stable
  }
  return ids
}

async function cleanup() {
  const ev = { event: { slug: { startsWith: 'ps-' } } }
  await prisma.listing.deleteMany({ where: { ticket: ev } })
  await prisma.transfer.deleteMany({ where: { ticket: ev } })
  await prisma.ticket.deleteMany({ where: ev })
  await prisma.event.deleteMany({ where: { slug: { startsWith: 'ps-' } } })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: UTAG } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: UTAG } } })
}

beforeEach(async () => {
  uniq = Math.random().toString(36).slice(2, 7)
  await cleanup()
  Object.assign(fake, {
    permission: 'granted',
    notHeld: new Set<string>(),
    holdsUnknown: false,
    funding: { spendableDrops: 100_000_000_000n, reserveIncDrops: 200_000n },
    fundingThrows: false,
    offerDelayMs: 0,
    waitDelayMs: 0,
    result: () => ({ ok: true }),
    awaitResult: () => ({ ok: true }),
    created: [],
    cancelled: [],
    starts: 0,
    n: 0,
  })
  let c = 0
  createPayload.mockReset()
  createPayload.mockImplementation(async () => {
    c += 1
    return {
      uuid: `00000000-0000-4000-9000-${uniq.padStart(5, '0').replace(/[^0-9a-f]/g, '0')}${String(c).padStart(7, '0')}`,
      next: 'https://xumm.app/sign/stub',
      qrPng: 'data:image/png;base64,AA==',
    }
  })
  tryGetPayload.mockReset()
  tryGetPayload.mockResolvedValue({ signed: false, cancelled: false, expired: false, account: null, txid: null })
})
afterEach(cleanup)
afterAll(async () => {
  await prisma.$disconnect()
})

const checkout = (actor: Actor, slug: string) =>
  request(app).post(`/api/events/${slug}/checkout`).set('Authorization', as(actor))

const ticketStatuses = async (eventId: string) =>
  (await prisma.ticket.findMany({ where: { eventId }, orderBy: { createdAt: 'asc' } })).map((t) => t.status)

// ---------------------------------------------------------------------------

describe('a successful checkout', () => {
  it('holds one ticket for the buyer, lists it, and hands back their signing request', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    const [first] = await mkTickets(event, org, 3)

    const res = await checkout(buyer, event.slug)

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ mode: 'stub', paysDrops: (PRICE + FEE).toString() })
    expect(res.body.uuid).toMatch(/^[0-9a-f-]{36}$/)

    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: res.body.listingId }, include: { ticket: true } })
    expect(listing).toMatchObject({
      status: 'BUYER_PENDING',
      reservedForId: buyer.id,
      buyerId: buyer.id,
      sellerId: org.id,
      priceDrops: PRICE,
      platformFeeDrops: FEE, // frozen on the listing, like any sale
      brokerAddress: BROKER,
    })
    expect(listing.offerIndex).toBeTruthy()
    expect(listing.ticket.nfTokenId).toBe(first) // the oldest unsold one
    expect(listing.ticket.status).toBe('LISTED')
    expect(listing.ticket.faceValueDrops).toBe(PRICE) // resale caps depend on it
    // Only the ONE ticket was touched.
    expect(await ticketStatuses(event.id)).toEqual(['LISTED', 'MINTED', 'MINTED'])
  })

  it('creates the sell offer AS the organizer, signed by the delegate, for the broker only', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)

    await checkout(buyer, event.slug)

    expect(fake.created).toHaveLength(1)
    expect(fake.created[0]).toMatchObject({
      TransactionType: 'NFTokenCreateOffer',
      Account: org.address, // the organizer's offer...
      Delegate: DELEGATE, // ...signed by the delegate
      Destination: BROKER, // matchable by nobody else
      Amount: PRICE.toString(),
      Flags: 1, // a sell offer
    })
  })

  it('asks the buyer for price + platform fee, pinned to the network, for the hold\'s length', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)

    await checkout(buyer, event.slug)

    const [tx, opts] = createPayload.mock.calls[0]!
    expect(tx).toMatchObject({
      TransactionType: 'NFTokenCreateOffer',
      Account: buyer.address,
      Owner: org.address,
      Destination: BROKER,
      Amount: (PRICE + FEE).toString(), // the ledger requires buy >= sell + brokerFee
    })
    expect(opts).toMatchObject({ flow: 'LISTING_BUY', userId: buyer.id, expireMinutes: 5 })
    expect(opts.forceNetwork).toBeDefined()
  })

  it('never advertises the held ticket in the marketplace, nor lets anyone else buy it', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const rival = await mkUser('rival')
    const seller = await mkUser('seller')
    const event = await mkEvent(org)
    const [, resaleId] = await mkTickets(event, org, 2)
    const res = await checkout(buyer, event.slug)
    // As if it had reached ACTIVE: a reserved listing must still be invisible.
    await prisma.listing.update({ where: { id: res.body.listingId }, data: { status: 'ACTIVE' } })

    // A POSITIVE CONTROL: an ordinary resale listing, which the marketplace must
    // show. Without it, "the reserved one is absent" would also pass against an
    // endpoint that returned nothing at all.
    const resaleTicket = await prisma.ticket.update({
      where: { network_nfTokenId: { network: NETWORK, nfTokenId: resaleId! } },
      data: { ownerId: seller.id, ownerAddress: seller.address, status: 'LISTED' },
    })
    const resale = await prisma.listing.create({
      data: {
        network: NETWORK,
        ticketId: resaleTicket.id,
        sellerId: seller.id,
        sellerAddress: seller.address,
        brokerAddress: BROKER,
        priceDrops: PRICE,
        platformFeeDrops: FEE,
        listPayloadUuid: `00000000-0000-4000-8000-${uniq.padStart(5, '0').replace(/[^0-9a-f]/g, '0')}0000cc`,
        offerIndex: 'RESALE'.padEnd(64, '0'),
        status: 'ACTIVE',
        listedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    })

    const market = await request(app).get('/api/listings')
    const ids = market.body.listings.map((l: { listingId: string }) => l.listingId)
    expect(ids).toContain(resale.id)
    expect(ids).not.toContain(res.body.listingId)

    const grab = await request(app).post(`/api/listings/${res.body.listingId}/buy`).set('Authorization', as(rival))
    expect(grab.status).toBe(409)
    expect(grab.body.error).toMatch(/reserved/i)
  })
})

describe('two buyers at once', () => {
  it('are given two DIFFERENT tickets, never the same one', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const a = await mkUser('a')
    const b = await mkUser('b')
    const c = await mkUser('c')
    const event = await mkEvent(org)
    await mkTickets(event, org, 3)
    fake.offerDelayMs = 30

    const results = await Promise.all([checkout(a, event.slug), checkout(b, event.slug), checkout(c, event.slug)])

    expect(results.map((r) => r.status)).toEqual([201, 201, 201])
    const listings = await prisma.listing.findMany({ where: { id: { in: results.map((r) => r.body.listingId) } } })
    expect(new Set(listings.map((l) => l.ticketId)).size).toBe(3)
    expect(await ticketStatuses(event.id)).toEqual(['LISTED', 'LISTED', 'LISTED'])
  })

  it('serialise only the SUBMIT on the organizer\'s account, and wait for validation together', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const a = await mkUser('a')
    const b = await mkUser('b')
    const c = await mkUser('c')
    const event = await mkEvent(org)
    await mkTickets(event, org, 3)
    fake.offerDelayMs = 40
    fake.waitDelayMs = 200

    // Instrument the two phases through the fake's own delays.
    let submitting = 0
    let peakSubmit = 0
    let waiting = 0
    let peakWait = 0
    const ledger = defaultPrimarySaleLedger() as unknown as {
      startSellOffer: (tx: Created) => Promise<unknown>
      awaitSellOffer: (s: unknown) => Promise<unknown>
    }
    const start = ledger.startSellOffer.bind(ledger)
    const wait = ledger.awaitSellOffer.bind(ledger)
    ledger.startSellOffer = async (tx) => {
      submitting += 1
      peakSubmit = Math.max(peakSubmit, submitting)
      try {
        return await start(tx)
      } finally {
        submitting -= 1
      }
    }
    ledger.awaitSellOffer = async (s) => {
      waiting += 1
      peakWait = Math.max(peakWait, waiting)
      try {
        return await wait(s)
      } finally {
        waiting -= 1
      }
    }

    const t0 = Date.now()
    await Promise.all([checkout(a, event.slug), checkout(b, event.slug), checkout(c, event.slug)])
    const took = Date.now() - t0
    ledger.startSellOffer = start
    ledger.awaitSellOffer = wait

    // Two offers signed as one account at once would read the same sequence...
    expect(peakSubmit).toBe(1)
    // ...but nothing needs the account while an offer waits to validate, so those
    // overlap. Measured on real devnet: holding the lease through the wait made a
    // single organizer's checkouts strictly one per ledger close (~6s each).
    expect(peakWait).toBeGreaterThan(1)
    // Three sequential 200ms waits would be 600ms+; overlapped they are ~200ms.
    expect(took).toBeLessThan(560)
  })

  it('a crowd of 25 gets 25 different tickets, with nobody told "sold out" while stock remains', async () => {
    // The claim is one UPDATE ... FOR UPDATE SKIP LOCKED. Without SKIP LOCKED the
    // buyers queue on the same row and a LIMIT 1 comes back empty after the first
    // commits — "sold out" with 24 tickets on the shelf. Overlap is only
    // probabilistic, so this uses a crowd rather than a pair.
    const org = await mkUser('org', 'ORGANIZER')
    const event = await mkEvent(org, { ticketCount: 100 })
    await mkTickets(event, org, 25)
    const buyers = await Promise.all(Array.from({ length: 25 }, (_, i) => mkUser(`b${i}`)))

    const results = await Promise.all(buyers.map((b) => checkout(b, event.slug)))

    expect(results.map((r) => r.status)).toEqual(Array(25).fill(201))
    const listings = await prisma.listing.findMany({ where: { id: { in: results.map((r) => r.body.listingId) } } })
    expect(new Set(listings.map((l) => l.ticketId)).size).toBe(25)
  })

  it('the last ticket goes to one buyer; the other hears "sold out"', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const a = await mkUser('a')
    const b = await mkUser('b')
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)

    const results = await Promise.all([checkout(a, event.slug), checkout(b, event.slug)])

    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    const loser = results.find((r) => r.status === 409)!
    expect(loser.body).toMatchObject({ error: 'Sold out', code: 'SOLD_OUT' })
  })
})

describe('claiming a ticket', () => {
  it('does not queue a second buyer behind the first: it takes the NEXT ticket', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const a = await mkUser('a')
    const b = await mkUser('b')
    const event = await mkEvent(org)
    const [first, second] = await mkTickets(event, org, 2)
    const base = {
      eventId: event.id,
      organizerId: org.id,
      organizerAddress: org.address,
      brokerAddress: BROKER,
      priceDrops: PRICE,
      platformBps: 250,
    }

    // A claims and is held open, uncommitted — as a real claim is for the moment
    // between its UPDATE and its COMMIT.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let aHasClaimed!: () => void
    const aClaimed = new Promise<void>((r) => (aHasClaimed = r))
    const claimA = claimTicket({
      ...base,
      buyerId: a.id,
      whileHeld: async () => {
        aHasClaimed()
        await gate
      },
    })
    await aClaimed

    // B must finish WHILE A is still open. With a plain FOR UPDATE it blocks on
    // A's row lock until A commits and then comes back with nothing ("sold out"
    // with a ticket on the shelf); SKIP LOCKED steps over it.
    const claimB = claimTicket({ ...base, buyerId: b.id })
    const raced = await Promise.race([claimB, new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 1500))])
    release()
    await claimA

    expect(raced).not.toBe('blocked')
    expect((raced as { nfTokenId: string }).nfTokenId).toBe(second)
    expect((await claimA)!.nfTokenId).toBe(first)
  })

  it('claims nothing, and says so, when there is nothing left', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const a = await mkUser('a')
    const event = await mkEvent(org)

    expect(
      await claimTicket({
        eventId: event.id,
        organizerId: org.id,
        organizerAddress: org.address,
        brokerAddress: BROKER,
        priceDrops: PRICE,
        platformBps: 250,
        buyerId: a.id,
      }),
    ).toBeNull()
  })
})

describe('when it must not sell', () => {
  it('refuses an event with no price', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org, { primaryPriceDrops: null })
    await mkTickets(event, org, 1)

    const res = await checkout(buyer, event.slug)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('NO_PRICE')
  })

  it('refuses an event that is not on sale', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    for (const status of ['DRAFT', 'CANCELLED', 'COMPLETED']) {
      const event = await mkEvent(org, { slug: `ps-${uniq}-${status.toLowerCase()}`, status })
      await mkTickets(event, org, 1)
      expect((await checkout(buyer, event.slug)).body.code).toBe('NOT_ON_SALE')
    }
  })

  it('refuses the organizer buying their own ticket', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)
    expect((await checkout(org, event.slug)).status).toBe(400)
  })

  it('needs a session', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const event = await mkEvent(org)
    expect((await request(app).post(`/api/events/${event.slug}/checkout`)).status).toBe(401)
  })

  it('stays closed when the organizer has not granted selling — and touches nothing', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 2)
    fake.permission = 'absent'

    const res = await checkout(buyer, event.slug)

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('SALES_CLOSED')
    expect(await ticketStatuses(event.id)).toEqual(['MINTED', 'MINTED'])
    expect(await prisma.listing.count({ where: { ticket: { eventId: event.id } } })).toBe(0)
    expect(fake.created).toHaveLength(0)
  })

  it('does not call an unreadable ledger "closed"', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)
    fake.permission = 'unknown'

    const res = await checkout(buyer, event.slug)

    expect(res.status).toBe(503)
    expect(res.body.code).toBeUndefined()
  })

  it('declines, without exposing the balance, when the organizer cannot carry another offer', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)
    fake.funding = { spendableDrops: 100_000n, reserveIncDrops: 200_000n }

    const res = await checkout(buyer, event.slug)

    expect(res.status).toBe(503)
    expect(res.body.code).toBe('UNAVAILABLE')
    expect(JSON.stringify(res.body)).not.toMatch(/100000|XRP|drops/i)
    expect(await ticketStatuses(event.id)).toEqual(['MINTED'])
  })

  it('does not let an unreadable balance block a sale', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)
    fake.fundingThrows = true

    expect((await checkout(buyer, event.slug)).status).toBe(201)
  })

  it('allows one purchase in progress per buyer per event, and points at it', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 3)
    const first = await checkout(buyer, event.slug)

    const second = await checkout(buyer, event.slug)

    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({ code: 'IN_PROGRESS', listingId: first.body.listingId })
    expect(await ticketStatuses(event.id)).toEqual(['LISTED', 'MINTED', 'MINTED']) // not two held
  })

  it('only sells tickets the organizer holds, never one that was gifted away or redeemed', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    const [gifted, redeemed, stock] = await mkTickets(event, org, 3)
    await prisma.ticket.update({ where: { network_nfTokenId: { network: NETWORK, nfTokenId: gifted! } }, data: { ownerId: holder.id, ownerAddress: holder.address } })
    await prisma.ticket.update({ where: { network_nfTokenId: { network: NETWORK, nfTokenId: redeemed! } }, data: { status: 'REDEEMED' } })

    const res = await checkout(buyer, event.slug)

    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: res.body.listingId }, include: { ticket: true } })
    expect(listing.ticket.nfTokenId).toBe(stock)
  })
})

describe('when the ledger disagrees with us', () => {
  it('skips a ticket the organizer no longer holds and takes it out of circulation', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    const [moved, stock] = await mkTickets(event, org, 2)
    fake.notHeld.add(moved!) // moved in Xaman without telling us

    const res = await checkout(buyer, event.slug)

    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: res.body.listingId }, include: { ticket: true } })
    expect(listing.ticket.nfTokenId).toBe(stock)
    // The cache was wrong; it is cleared rather than trusted, so it is never offered again.
    const stale = await prisma.ticket.findUniqueOrThrow({ where: { network_nfTokenId: { network: NETWORK, nfTokenId: moved! } } })
    expect(stale).toMatchObject({ ownerId: null, ownerAddress: null, status: 'MINTED' })
  })

  it('treats an unreadable ownership check as "carry on", not as "gone"', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)
    fake.holdsUnknown = true

    expect((await checkout(buyer, event.slug)).status).toBe(201)
  })
})

describe('when the offer cannot be made', () => {
  const failWith = (code: string) => {
    fake.result = () => ({ ok: false, code })
  }

  it.each([
    ['terNO_DELEGATE_PERMISSION', 409, 'SALES_CLOSED'],
    ['tecNO_PERMISSION', 409, 'SALES_CLOSED'],
    ['tecINSUFFICIENT_RESERVE', 503, 'UNAVAILABLE'],
    ['tecUNFUNDED', 503, 'UNAVAILABLE'],
  ])('%s releases the ticket and says so', async (code, status, tag) => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 2)
    failWith(code)

    const res = await checkout(buyer, event.slug)

    expect(res.status).toBe(status)
    expect(res.body.code).toBe(tag)
    // Nothing is left held, so the buyer can try again and the ticket can be sold.
    expect(await ticketStatuses(event.id)).toEqual(['MINTED', 'MINTED'])
    const listing = await prisma.listing.findFirstOrThrow({ where: { ticket: { eventId: event.id } } })
    expect(listing.status).toBe('CANCELLED')
    expect(createPayload).not.toHaveBeenCalled() // the buyer was never asked to sign
  })

  it('a tec after validation (the sequence is spent) releases the ticket too', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)
    fake.awaitResult = () => ({ ok: false, code: 'tecINSUFFICIENT_RESERVE' })

    const res = await checkout(buyer, event.slug)

    expect(res.status).toBe(503)
    expect(res.body.code).toBe('UNAVAILABLE')
    expect(await ticketStatuses(event.id)).toEqual(['MINTED'])
    expect(createPayload).not.toHaveBeenCalled()
  })

  it('an offer that never validates releases the ticket instead of holding it', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)
    fake.awaitResult = () => ({ ok: false, code: 'expired' })

    const res = await checkout(buyer, event.slug)

    expect(res.status).toBe(502)
    expect(await ticketStatuses(event.id)).toEqual(['MINTED'])
  })

  it('any other failure is a retryable 502 that charges nothing', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)
    failWith('timeout')

    const res = await checkout(buyer, event.slug)

    expect(res.status).toBe(502)
    expect(res.body.error).toMatch(/Nothing was charged/)
    expect(await ticketStatuses(event.id)).toEqual(['MINTED'])
  })

  it('gives the ticket back and cancels the offer if the buyer cannot be asked to sign', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)
    createPayload.mockRejectedValue(new Error('quota'))

    const res = await checkout(buyer, event.slug)

    expect(res.status).toBe(503)
    expect(await ticketStatuses(event.id)).toEqual(['MINTED'])
    // The offer exists on the ledger by now, so it is taken off.
    expect(fake.cancelled).toEqual([['OFFER1'.padEnd(64, '0')]])
  })
})

describe('a stale sequence read', () => {
  it('is retried, not reported as a failed sale', async () => {
    // The first real mainnet run lost one of two simultaneous buyers to this: the
    // second offer read the organizer's sequence from a view that had not yet seen
    // the first, and came back tefPAST_SEQ with nothing submitted.
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)
    let calls = 0
    fake.result = () => (++calls < 3 ? { ok: false, code: 'tefPAST_SEQ' } : { ok: true })

    const res = await checkout(buyer, event.slug)

    expect(res.status).toBe(201)
    expect(fake.starts).toBe(3)
    expect(await ticketStatuses(event.id)).toEqual(['LISTED'])
  })

  it('treats terPRE_SEQ the same way', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)
    let calls = 0
    fake.result = () => (++calls < 2 ? { ok: false, code: 'terPRE_SEQ' } : { ok: true })

    expect((await checkout(buyer, event.slug)).status).toBe(201)
  })

  it('gives up after a few attempts, releasing the ticket and charging nothing', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)
    fake.result = () => ({ ok: false, code: 'tefPAST_SEQ' })

    const res = await checkout(buyer, event.slug)

    expect(res.status).toBe(502)
    expect(fake.starts).toBe(4)
    expect(await ticketStatuses(event.id)).toEqual(['MINTED'])
    expect(createPayload).not.toHaveBeenCalled()
  })

  it('does NOT retry a real verdict', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)
    fake.result = () => ({ ok: false, code: 'terNO_DELEGATE_PERMISSION' })

    const res = await checkout(buyer, event.slug)

    // A revoked grant will not un-revoke itself; retrying would only burn time.
    expect(res.status).toBe(409)
    expect(fake.starts).toBe(1)
  })
})

describe('the guard on the delegate', () => {
  it('refuses to list a ticket from another event, even if it is in the organizer\'s hands', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    // A ticket on THIS event's row, but minted under a different taxon — the shape
    // of an NFT that wandered into the account from somewhere else.
    n += 1
    await prisma.ticket.create({
      data: {
        nfTokenId: makeNftId(org.address, event.nftTaxon + 7, n),
        network: NETWORK,
        eventId: event.id,
        ownerId: org.id,
        ownerAddress: org.address,
        status: 'MINTED',
      },
    })

    const res = await checkout(buyer, event.slug)

    expect(res.status).toBe(500)
    expect(fake.created).toHaveLength(0) // nothing was ever signed
    expect(await ticketStatuses(event.id)).toEqual(['MINTED'])
  })

  it('refuses to list a ticket the organizer did not issue', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    n += 1
    await prisma.ticket.create({
      data: {
        nfTokenId: makeNftId(Wallet.generate().classicAddress, event.nftTaxon, n),
        network: NETWORK,
        eventId: event.id,
        ownerId: org.id,
        ownerAddress: org.address,
        status: 'MINTED',
      },
    })

    expect((await checkout(buyer, event.slug)).status).toBe(500)
    expect(fake.created).toHaveLength(0)
  })
})

describe('abandoned checkouts', () => {
  async function held(buyerName = 'buyer') {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser(buyerName)
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)
    const res = await checkout(buyer, event.slug)
    return { org, buyer, event, listingId: res.body.listingId as string }
  }

  const expireBy = (listingId: string, ms: number) =>
    prisma.listing.update({ where: { id: listingId }, data: { expiresAt: new Date(Date.now() - ms) } })

  it('releaseHold gives the ticket back and cancels the offer, once', async () => {
    const { event, listingId } = await held()

    expect(await releaseHold(listingId, defaultPrimarySaleLedger(), 'test')).toBe(true)

    expect(await ticketStatuses(event.id)).toEqual(['MINTED'])
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } })
    expect(listing).toMatchObject({ status: 'CANCELLED', buyerId: null, buyPayloadUuid: null })
    expect(fake.cancelled).toEqual([[listing.offerIndex]])

    // Idempotent: the poll, the sweep and a retry can all call it.
    expect(await releaseHold(listingId, defaultPrimarySaleLedger(), 'again')).toBe(false)
    expect(fake.cancelled).toHaveLength(1)
  })

  it('releaseHold does not reset a ticket that has since moved on', async () => {
    const { event, listingId } = await held()
    await prisma.ticket.updateMany({ where: { eventId: event.id }, data: { status: 'REDEEMED' } })

    await releaseHold(listingId, defaultPrimarySaleLedger(), 'test')

    expect(await ticketStatuses(event.id)).toEqual(['REDEEMED'])
  })

  it('the sweep reclaims an expired, unsigned hold', async () => {
    const { event, listingId } = await held()
    await expireBy(listingId, HOLD_GRACE_MS + 5_000)

    expect(await releaseExpiredHolds(defaultPrimarySaleLedger())).toBe(1)

    expect(await ticketStatuses(event.id)).toEqual(['MINTED'])
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listingId } })).status).toBe('CANCELLED')
  })

  it('the sweep leaves a hold alone inside the grace period', async () => {
    const { event, listingId } = await held()
    await expireBy(listingId, 1_000) // expired a second ago, well inside the grace

    expect(await releaseExpiredHolds(defaultPrimarySaleLedger())).toBe(0)
    expect(await ticketStatuses(event.id)).toEqual(['LISTED'])
  })

  it('the sweep never reclaims under a live signature', async () => {
    const { event, listingId } = await held()
    await expireBy(listingId, HOLD_GRACE_MS * 10)
    tryGetPayload.mockResolvedValue({ signed: true, cancelled: false, expired: false, account: 'rX', txid: null })

    expect(await releaseExpiredHolds(defaultPrimarySaleLedger())).toBe(0)
    expect(await ticketStatuses(event.id)).toEqual(['LISTED'])
  })

  it('the sweep does not treat an unreachable Xaman as "unsigned"', async () => {
    const { event, listingId } = await held()
    await expireBy(listingId, HOLD_GRACE_MS * 10)
    tryGetPayload.mockResolvedValue('unavailable')

    expect(await releaseExpiredHolds(defaultPrimarySaleLedger())).toBe(0)
    expect(await ticketStatuses(event.id)).toEqual(['LISTED'])
  })

  it('a buyer who backs out in Xaman releases the ticket on their next poll', async () => {
    const { buyer, event, listingId } = await held()
    tryGetPayload.mockResolvedValue({ signed: false, cancelled: true, expired: false, account: null, txid: null })

    const res = await request(app).get(`/api/listings/${listingId}`).set('Authorization', as(buyer))

    // Not "returned to sale for nobody": released, so someone else can have it.
    expect(res.body).toMatchObject({ state: 'cancelled', status: 'CANCELLED' })
    expect(await ticketStatuses(event.id)).toEqual(['MINTED'])
    expect(fake.cancelled).toHaveLength(1)
  })

  it('a buyer whose request expired unsigned releases it too', async () => {
    const { buyer, event, listingId } = await held()
    tryGetPayload.mockResolvedValue({ signed: false, cancelled: false, expired: true, account: null, txid: null })

    const res = await request(app).get(`/api/listings/${listingId}`).set('Authorization', as(buyer))

    expect(res.body.state).toBe('cancelled')
    expect(await ticketStatuses(event.id)).toEqual(['MINTED'])
  })

  it('a resale listing is untouched by all of this: backing out still returns it to sale', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const seller = await mkUser('seller')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    const [id] = await mkTickets(event, org, 1)
    const ticket = await prisma.ticket.update({
      where: { network_nfTokenId: { network: NETWORK, nfTokenId: id! } },
      data: { ownerId: seller.id, ownerAddress: seller.address, status: 'LISTED' },
    })
    const listing = await prisma.listing.create({
      data: {
        network: NETWORK,
        ticketId: ticket.id,
        sellerId: seller.id,
        sellerAddress: seller.address,
        brokerAddress: BROKER,
        priceDrops: PRICE,
        platformFeeDrops: FEE,
        listPayloadUuid: `00000000-0000-4000-8000-${uniq.padStart(5, '0').replace(/[^0-9a-f]/g, '0')}0000aa`,
        buyPayloadUuid: `00000000-0000-4000-8000-${uniq.padStart(5, '0').replace(/[^0-9a-f]/g, '0')}0000bb`,
        offerIndex: 'RESALEOFFER'.padEnd(64, '0'),
        buyerId: buyer.id,
        buyerAddress: buyer.address,
        status: 'BUYER_PENDING',
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    tryGetPayload.mockResolvedValue({ signed: false, cancelled: true, expired: false, account: null, txid: null })

    const res = await request(app).get(`/api/listings/${listing.id}`).set('Authorization', as(buyer))

    expect(res.body.state).toBe('active')
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe('ACTIVE')
    expect(fake.cancelled).toHaveLength(0)
  })
})
