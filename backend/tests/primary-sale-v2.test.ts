/**
 * The box-office checkout under the NEW fee model (the fan fee on a first sale). Written before the code.
 * (Harness shared with primary-sale.test.ts, whose header follows.)
 *
 * The lazy primary sale, over HTTP. Real Express app, session and database; the
 * ledger and Xaman are faked.
 *
 * What is pinned is everything that can go wrong without looking wrong: two
 * buyers handed one ticket, an offer left on the ledger for a buyer who left, a
 * ticket stuck behind a hold that nothing will ever clear, and — above all — the
 * delegate being talked into listing something it was not asked to.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.FEE_MODEL = 'v2'
  process.env.XRP_USD_CENTS = '134'
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
const UTAG = 'pv_'
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
      slug: `pv-${uniq}`,
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
  const ev = { event: { slug: { startsWith: 'pv-' } } }
  await prisma.listing.deleteMany({ where: { ticket: ev } })
  await prisma.transfer.deleteMany({ where: { ticket: ev } })
  await prisma.ticket.deleteMany({ where: ev })
  await prisma.event.deleteMany({ where: { slug: { startsWith: 'pv-' } } })
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

describe('a box-office checkout under the new model', () => {
  it('25 XRP: the organizer is offered the full 25, the buyer is asked for 25.875 (3.5% on top), and the first-sale fee is recorded', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)

    const res = await checkout(buyer, event.slug)

    expect(res.status).toBe(201)
    // 25_000_000 x 350 / 10_000 = 875_000.
    expect(res.body.paysDrops).toBe('25875000')
    expect(fake.created[0]).toMatchObject({ Amount: '25000000' }) // the organizer receives the whole price
    expect(createPayload.mock.calls[0]![0]).toMatchObject({ Amount: '25875000' })
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: res.body.listingId } })
    expect(listing).toMatchObject({
      priceDrops: 25_000_000n,
      platformFeeDrops: 875_000n,
      feeModel: 'BUYER_PAYS_V1', // the buyer pays the fee on top, as a first sale always did
      feeBps: 350,
      isPrimarySale: true,
    })
  })

  it('a founding organizer\'s event inside the window pays the lower fan fee: 0.75 on 25, at 300 bps', async () => {
    const org = await mkUser('org', 'ORGANIZER', true)
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)
    const res = await checkout(buyer, event.slug)
    expect(res.body.paysDrops).toBe('25750000')
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: res.body.listingId } })).feeBps).toBe(300)
  })

  it('a founding organizer\'s event after the window pays the standard fan fee', async () => {
    const org = await mkUser('org', 'ORGANIZER', true)
    const buyer = await mkUser('buyer')
    const event = await mkEvent(org, { startsAt: new Date('2028-06-01T12:00:00Z') })
    await mkTickets(event, org, 1)
    expect((await checkout(buyer, event.slug)).body.paysDrops).toBe('25875000')
  })

  it('the window is the EVENT\'s local time: 04:30 UTC on 1 Jan 2028 is 00:30 in St. Lucia (outside) but 23:30 on New Year\'s Eve in Toronto (inside)', async () => {
    const at = new Date('2028-01-01T04:30:00Z')
    const org = await mkUser('org', 'ORGANIZER', true)
    const lucia = await mkEvent(org, { startsAt: at, timeZone: 'America/St_Lucia', slug: `pv-${uniq}-a` })
    const toronto = await mkEvent(org, { startsAt: at, timeZone: 'America/Toronto', feeRegion: 'CANADA', slug: `pv-${uniq}-b` })
    await mkTickets(lucia, org, 1)
    await mkTickets(toronto, org, 1)
    const b1 = await mkUser('buyer1')
    const b2 = await mkUser('buyer2')
    expect((await checkout(b1, lucia.slug)).body.paysDrops).toBe('25875000') // 3.5%: outside the window
    expect((await checkout(b2, toronto.slug)).body.paysDrops).toBe('25750000') // 3%: inside it
  })
})
