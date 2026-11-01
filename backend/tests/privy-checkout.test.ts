/**
 * Buying at the box office with a Privy wallet: the buyer is handed the transaction to approve in the browser. Written before the code.
 * (Harness shared with primary-sale-v2.test.ts.)
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.FEE_MODEL = 'v2'
  process.env.XRP_USD_CENTS = '134'
  process.env.SIGNERS = 'xaman,privy'
  process.env.PRIVY_APP_ID = 'cmprivyco0000000000000000'
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
const UTAG = 'pc_'
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
      slug: `pc-${uniq}`,
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
  const ev = { event: { slug: { startsWith: 'pc-' } } }
  await prisma.listing.deleteMany({ where: { ticket: ev } })
  await prisma.transfer.deleteMany({ where: { ticket: ev } })
  await prisma.ticket.deleteMany({ where: ev })
  await prisma.event.deleteMany({ where: { slug: { startsWith: 'pc-' } } })
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

describe('a box-office purchase by a Privy buyer', () => {
  it('hands back the buy offer to approve (all-in 25.875 XRP, owner the organizer, restricted to the broker), and holds the ticket for them', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await privyBuyer('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 2)

    const res = await checkout(buyer, event.slug)

    expect(res.status).toBe(201)
    expect(res.body.paysDrops).toBe('25875000')
    expect(res.body.sign.tx).toMatchObject({
      TransactionType: 'NFTokenCreateOffer', Account: buyer.address, Owner: org.address, Destination: BROKER, Amount: '25875000',
    })
    expect(res.body.sign.account).toBe(buyer.address)
    expect(createPayload).not.toHaveBeenCalled() // Xaman was never asked for the buyer's signature
    const row = await prisma.xamanPayload.findFirstOrThrow({ where: { userId: buyer.id } })
    expect(row).toMatchObject({ signer: 'privy', flow: 'LISTING_BUY' })
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: res.body.listingId } })
    expect(listing).toMatchObject({ status: 'BUYER_PENDING', buyerId: buyer.id, buyPayloadUuid: res.body.uuid })
  })
})

import { RippledError } from 'xrpl'
const reset = () => {
  funds.read = async () => ({ spendableDrops: 1_000n * XRP, reserveIncDrops: 200_000n })
}
beforeEach(reset)

describe('a Privy buyer whose wallet cannot pay is told so BEFORE anything is held', () => {
  const setup = async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const buyer = await privyBuyer('buyer')
    const event = await mkEvent(org)
    await mkTickets(event, org, 2)
    return { org, buyer, event }
  }
  const nothingHeld = async (eventId: string, buyerId: string) => {
    expect(await prisma.listing.count({ where: { ticket: { eventId } } })).toBe(0)
    expect(await ticketStatuses(eventId)).toEqual(['MINTED', 'MINTED'])
    expect(await prisma.xamanPayload.count({ where: { userId: buyerId } })).toBe(0)
    expect(fake.created).toHaveLength(0) // and no offer was made on the organizer's account either
  }

  it('an account that does not exist yet: asks for the price, the reserves and the fee, and names the address', async () => {
    const { buyer, event } = await setup()
    funds.read = async () => { throw new RippledError('Account not found.', { error: 'actNotFound' }) }

    const res = await checkout(buyer, event.slug)

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      code: 'WALLET_NEEDS_FUNDS',
      address: buyer.address,
      // 25.875 price + 0.2 the offer locks + 0.1 fee headroom + 1 base reserve for the account to exist
      neededDrops: '27175000',
      haveDrops: '0',
      canFund: true, // testnet
    })
    expect(res.body.error).toMatch(/needs more XRP/i)
    await nothingHeld(event.id, buyer.id)
  })

  it('a funded account that is simply short: says how much it has', async () => {
    const { buyer, event } = await setup()
    funds.read = async () => ({ spendableDrops: 5n * XRP, reserveIncDrops: 200_000n })
    const res = await checkout(buyer, event.slug)
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'WALLET_NEEDS_FUNDS', neededDrops: '26175000', haveDrops: '5000000' })
    await nothingHeld(event.id, buyer.id)
  })

  it('exactly enough is enough', async () => {
    const { buyer, event } = await setup()
    funds.read = async () => ({ spendableDrops: 26_175_000n, reserveIncDrops: 200_000n })
    expect((await checkout(buyer, event.slug)).status).toBe(201)
  })

  it('and one drop less is not', async () => {
    const { buyer, event } = await setup()
    funds.read = async () => ({ spendableDrops: 26_174_999n, reserveIncDrops: 200_000n })
    expect((await checkout(buyer, event.slug)).status).toBe(409)
  })

  it('a ledger that cannot be read is NOT "empty": the purchase goes ahead', async () => {
    const { buyer, event } = await setup()
    funds.read = async () => { throw new Error('node down') }
    expect((await checkout(buyer, event.slug)).status).toBe(201)
  })

  it('does not apply to a Xaman buyer, whose own wallet shows its balance', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    const xaman = await mkUser('xbuyer')
    // A real Xaman buyer HAS a wallet record (signer XAMAN); it is the signer that decides, not whether a record exists.
    await prisma.wallet.create({ data: { userId: xaman.id, xrplAddress: xaman.address, signerKind: 'XAMAN' } })
    const event = await mkEvent(org)
    await mkTickets(event, org, 1)
    funds.read = async () => ({ spendableDrops: 0n, reserveIncDrops: 200_000n })
    expect((await checkout(xaman, event.slug)).status).toBe(201)
  })
})
