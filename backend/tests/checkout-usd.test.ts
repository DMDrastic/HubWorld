/**
 * A box office priced in US$ (item 1b-i). Written before the code. (Harness from privy-checkout.test.ts.)
 *
 * The organizer's US$ price is the price. XRP exists only when someone pays: worked out from a fresh price at the start of
 * the checkout, and held for two minutes (the hold, the Xaman request and the Privy request all end with it). With no
 * fresh price there is no XRP payment, and the event still shows its US$ price.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.FEE_MODEL = 'v2'
  process.env.XRP_USD_CENTS = '134'
  process.env.SIGNERS = 'xaman,privy'
  process.env.PRIVY_APP_ID = 'cmprivyco0000000000000000'
  process.env.PRICE_FEED = 'on'
})

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

const funds = vi.hoisted(() => ({
  read: async (_a: string): Promise<{ spendableDrops: bigint; reserveIncDrops: bigint }> => ({ spendableDrops: 1_000n * 1_000_000n, reserveIncDrops: 200_000n }),
}))

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return { ...actual, platformAddress: () => BROKER, delegateAddress: () => DELEGATE, accountFunding: (a: string) => funds.read(a) }
})

const rate = vi.hoisted(() => ({ value: { microUsdPerXrp: 1_250_000n, at: new Date() } as { microUsdPerXrp: bigint; at: Date } | null }))
vi.mock('../src/xrp-quote.js', async () => {
  const actual = await vi.importActual<typeof import('../src/xrp-quote.js')>('../src/xrp-quote.js')
  return { ...actual, currentQuoteRate: async () => rate.value }
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
const UTAG = 'pu_'
const XRP = 1_000_000n
const PRICE = 25n * XRP
const FEE = (PRICE * 250n) / 10_000n // 2.5% platform fee

type Actor = { id: string; username: string; address: string; token: string }
let uniq = ''
let n = 0

async function mkUser(name: string, role: 'USER' | 'ORGANIZER' = 'USER', founding = false): Promise<Actor> {
  const address = Wallet.generate().classicAddress
  const user = await prisma.user.create({
    data: { username: `${UTAG}${name}_${uniq}`.slice(0, 20), xrplAddress: address, role, foundingOrganizer: founding },
  })
  const { token } = await createSession(user.id)
  return { id: user.id, username: user.username, address, token }
}
const as = (a: Actor) => `Bearer ${a.token}`

async function mkEvent(organizer: Actor, over: Record<string, unknown> = {}) {
  return prisma.event.create({
    data: {
      network: NETWORK,
      slug: `pu-${uniq}`,
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
  const ev = { event: { slug: { startsWith: 'pu-' } } }
  await prisma.listing.deleteMany({ where: { ticket: ev } })
  await prisma.transfer.deleteMany({ where: { ticket: ev } })
  await prisma.ticket.deleteMany({ where: ev })
  await prisma.event.deleteMany({ where: { slug: { startsWith: 'pu-' } } })
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


import { ECDSA, Wallet as XWallet } from 'xrpl'
const priv = await import('../src/privy-signing.js')
beforeEach(() => {
  priv.setLedgerPortForTests({
    currentLedger: async () => 1_000,
    autofill: async (tx) => ({ ...tx, Fee: '12', Sequence: 5, LastLedgerSequence: 1_020 }),
    submit: async () => ({ engineResult: 'tesSUCCESS', hash: 'H'.repeat(64) }),
  })
})

async function privyBuyer(name: string): Promise<Actor & { key: XWallet }> {
  const key = XWallet.generate(ECDSA.secp256k1)
  const user = await prisma.user.create({
    data: {
      username: `${UTAG}${name}_${uniq}`.slice(0, 20),
      xrplAddress: key.classicAddress,
      wallet: { create: { xrplAddress: key.classicAddress, signerKind: 'PRIVY', providerUserId: `did:privy:${UTAG}${name}${uniq}`, publicKey: key.publicKey } },
    },
  })
  const { token } = await createSession(user.id)
  return { id: user.id, username: user.username, address: key.classicAddress, token, key }
}


const USD = (cents: bigint) => ({ primaryPriceDrops: null, primaryPriceMinor: cents, primaryPriceCurrency: 'USD' as const })

describe('a box office priced in US$', () => {
  beforeEach(() => {
    rate.value = { microUsdPerXrp: 1_250_000n, at: new Date() }
  })

  it('quotes the XRP at the start of the checkout: US$35.00 at US$1.25 is 28 XRP, plus the 3.5% fee on it', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org, USD(3500n))
    await mkTickets(event, org, 1)

    const res = await checkout(buyer, event.slug)
    expect(res.status).toBe(201)
    // 28 XRP, and the on-ledger first-sale fee (3.5%) on it: 0.98 XRP.
    expect(res.body.paysDrops).toBe(String(28_000_000n + 980_000n))
    // The organizer's sell offer is for the quoted price itself.
    expect(fake.created[0]).toMatchObject({ Amount: '28000000' })
    expect(res.body.quote).toMatchObject({ priceMinor: '3500', currency: 'USD', microUsdPerXrp: '1250000' })
  })

  it('the same US$ price is a different XRP amount when XRP moves, and the event\'s price does not change', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const event = await mkEvent(org, USD(3500n))
    await mkTickets(event, org, 2)

    rate.value = { microUsdPerXrp: 1_250_000n, at: new Date() }
    const a = await checkout(await mkUser('a'), event.slug)
    rate.value = { microUsdPerXrp: 1_750_000n, at: new Date() }
    const b = await checkout(await mkUser('b'), event.slug)
    expect(a.body.paysDrops).not.toBe(b.body.paysDrops)
    expect(fake.created.map((t) => t.Amount)).toEqual(['28000000', '20000000'])
    const shown = (await request(app).get(`/api/events/${event.slug}`)).body
    expect(shown.boxOffice).toMatchObject({ currency: 'USD', priceMinor: '3500' })
  })

  it('holds the quote for two minutes: the hold and the signing request end with it', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const event = await mkEvent(org, USD(3500n))
    await mkTickets(event, org, 1)
    const before = Date.now()
    const res = await checkout(await mkUser('buyer'), event.slug)
    expect(res.status).toBe(201)
    const held = new Date(res.body.expiresAt).getTime() - before
    expect(held).toBeGreaterThan(110_000)
    expect(held).toBeLessThanOrEqual(125_000)
    expect(createPayload.mock.calls[0]![1]).toMatchObject({ expireMinutes: 2 })
  })

  it('a Privy buyer\'s request ends with the quote too, so an approval after it cannot be submitted', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const event = await mkEvent(org, USD(3500n))
    await mkTickets(event, org, 1)
    const buyer = await privyBuyer('buyer')
    const res = await checkout(buyer, event.slug)
    expect(res.status).toBe(201)
    const row = await prisma.xamanPayload.findUniqueOrThrow({ where: { uuid: res.body.uuid } })
    expect(row.expiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(121_000)
    // And on the ledger: no more than ~40 ledgers (about two minutes) to land.
    expect(res.body.sign.tx.LastLedgerSequence).toBeLessThanOrEqual(1_000 + 40)
  })

  it('after the quote lapses, a new checkout quotes again at the new price', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const event = await mkEvent(org, USD(3500n))
    await mkTickets(event, org, 1)
    const buyer = await mkUser('buyer')
    const first = await checkout(buyer, event.slug)
    // The two minutes pass: the hold lapses and is reclaimed.
    await prisma.listing.update({ where: { id: first.body.listingId }, data: { expiresAt: new Date(Date.now() - 10 * 60_000) } })
    await releaseExpiredHolds(defaultPrimarySaleLedger())
    rate.value = { microUsdPerXrp: 1_400_000n, at: new Date() }
    const second = await checkout(buyer, event.slug)
    expect(second.status).toBe(201)
    expect(second.body.quote.microUsdPerXrp).toBe('1400000')
    expect(second.body.paysDrops).not.toBe(first.body.paysDrops)
  })

  it('with no fresh price there is no XRP payment: nothing is held, and the event still shows its US$ price', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const event = await mkEvent(org, USD(3500n))
    await mkTickets(event, org, 1)
    rate.value = null

    const res = await checkout(await mkUser('buyer'), event.slug)
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ code: 'XRP_PRICE_UNAVAILABLE', error: 'XRP payment unavailable right now' })
    expect(await prisma.listing.count({ where: { ticket: { eventId: event.id } } })).toBe(0)
    expect(fake.created).toHaveLength(0)

    const shown = (await request(app).get(`/api/events/${event.slug}`)).body
    expect(shown.boxOffice).toMatchObject({ currency: 'USD', priceMinor: '3500', allInMinor: '3622', xrpPayable: false })
  })

  it('the event list carries the US$ price and its all-in, with the XRP-rail fee in cents', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const event = await mkEvent(org, USD(3500n))
    await mkTickets(event, org, 1)
    const listed = (await request(app).get('/api/events?limit=100')).body.events.find((e: { slug: string }) => e.slug === event.slug)
    // US$35.00 + 3.5% = US$36.22 (fee floored: 122.5 -> 122)
    expect(listed.boxOffice).toEqual({ currency: 'USD', priceMinor: '3500', feeMinor: '122', allInMinor: '3622', xrpPayable: true })
    expect(listed.ticketsForSale).toBe(1)
  })

  it('an event still priced in XRP (not yet converted) checks out exactly as before', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)
    rate.value = null
    const res = await checkout(await mkUser('buyer'), event.slug)
    expect(res.status).toBe(201)
    expect(fake.created[0]).toMatchObject({ Amount: String(PRICE) })
    expect(res.body.quote).toBeUndefined()
  })
})

describe('an organizer sets the box-office price in US$', () => {
  const body = (extra: Record<string, unknown> = {}) => ({
    title: `Usd Price ${uniq}`,
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    ticketCount: 10,
    royaltyBps: 500,
    slug: `pu-make-${uniq}`,
    resalePolicy: 'FACE_VALUE_ONLY',
    ...extra,
  })
  let made = 0
  const create = async (extra: Record<string, unknown> = {}) => {
    made += 1
    const org = await mkUser(`org${made}`, 'ORGANIZER')
    return request(app).post('/api/events').set('Authorization', as(org)).send(body(extra))
  }

  it('stores it in US cents as the canonical price, with no XRP price at all', async () => {
    const res = await create({ primaryPriceUsdCents: '3500' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ primaryPriceMinor: '3500', primaryPriceCurrency: 'USD', primaryPriceDrops: null })
    const row = await prisma.event.findUniqueOrThrow({ where: { slug: `pu-make-${uniq}` } })
    expect(row).toMatchObject({ primaryPriceMinor: 3500n, primaryPriceCurrency: 'USD', primaryPriceDrops: null })
  })

  it('refuses a price in both currencies at once, and a malformed or zero price', async () => {
    expect((await create({ primaryPriceUsdCents: '3500', primaryPriceDrops: '28000000' })).status).toBe(400)
    expect((await create({ primaryPriceUsdCents: '35.00' })).status).toBe(400)
    expect((await create({ primaryPriceUsdCents: '0' })).status).toBe(400)
  })

  it('a fixed resale cap (still in XRP until resale moves to US$) cannot go with a US$ price, said plainly', async () => {
    const res = await create({ primaryPriceUsdCents: '3500', resalePolicy: 'FIXED_CAP', resaleCapDrops: '28000000' })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toMatch(/percentage cap/i)
  })
})

describe('after conversion: the US$ price wins over the XRP price kept as history', () => {
  it('a converted event (both prices stored) is sold and shown at its US$ price', async () => {
    rate.value = { microUsdPerXrp: 1_250_000n, at: new Date() }
    const org = await mkUser('org', 'ORGANIZER')
    const event = await mkEvent(org, { primaryPriceDrops: 99n * XRP, primaryPriceMinor: 3500n, primaryPriceCurrency: 'USD' })
    await mkTickets(event, org, 1)
    const res = await checkout(await mkUser('buyer'), event.slug)
    expect(res.status).toBe(201)
    expect(fake.created[0]).toMatchObject({ Amount: '28000000' })
    const shown = (await request(app).get(`/api/events/${event.slug}`)).body
    expect(shown.boxOffice).toMatchObject({ priceMinor: '3500' })
    expect(shown.primaryPriceDrops).toBeNull()
  })

  it('the event LIST says XRP cannot be paid when the price is stale, too', async () => {
    rate.value = null
    const org = await mkUser('org', 'ORGANIZER')
    const event = await mkEvent(org, USD(3500n))
    await mkTickets(event, org, 1)
    const listed = (await request(app).get('/api/events?limit=100')).body.events.find((e: { slug: string }) => e.slug === event.slug)
    expect(listed.boxOffice).toMatchObject({ priceMinor: '3500', xrpPayable: false })
  })
})
