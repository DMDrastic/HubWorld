/**
 * With a Privy wallet, every holder action answers with the transaction to approve in the browser, not a QR. Written before the code.
 *
 * Listing, withdrawing, buying, opening an auction and bidding: each used to hand back a Xaman payload only. A person whose
 * wallet is Privy now gets `sign` {tx, hash, account} instead, built by the same route and checks as before, stored on the
 * server, and signed in the browser. A Xaman user is untouched (the existing route tests cover that).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.FEE_MODEL = 'v2'
  process.env.PRICE_FEED = 'off'
  process.env.XRP_USD_CENTS = '134'
  process.env.SIGNERS = 'xaman,privy'
  process.env.PRIVY_APP_ID = 'cmprivyrt0000000000000000'
})

import request from 'supertest'
import { maxAskForCap } from '../src/resale-policy.js'

const payloadTxs: Array<Record<string, unknown>> = []
const holdsNft = vi.fn<(address: string, nfTokenId: string) => Promise<boolean>>()
const accountNfts = vi.fn<(address: string) => Promise<{ NFTokenID: string }[]>>()
const accountFunding =
  vi.fn<(address: string) => Promise<{ spendableDrops: bigint; reserveIncDrops: bigint }>>()

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return {
    ...actual,
    holdsNft: (...a: Parameters<typeof holdsNft>) => holdsNft(...a),
    accountNfts: (...a: Parameters<typeof accountNfts>) => accountNfts(...a),
    accountFunding: (...a: Parameters<typeof accountFunding>) => accountFunding(...a),
    // listings.ts/open-auction.ts resolve this for real (unconditionally) when
    // creating a listing/auction, and it throws without PLATFORM_SEED set —
    // which CI genuinely has unset. Forcing brokerMode live (below) gets past
    // the "broker not configured" guard but does not make the real seed exist,
    // so this must be stubbed too, same as broker-health.test.ts does. Found
    // the hard way: this suite passed locally only because a real PLATFORM_SEED
    // happened to sit in .env, and failed in CI with none.
    platformAddress: () => 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
  }
})

vi.mock('../src/xaman.js', async () => {
  const actual = await vi.importActual<typeof import('../src/xaman.js')>('../src/xaman.js')
  let n = 0
  const created = () => {
    n += 1
    return {
      uuid: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
      next: 'https://xumm.app/sign/stub',
      qrPng: 'https://xumm.app/sign/stub.png',
    }
  }
  return {
    ...actual,
    xaman: {
      mode: 'stub' as const,
      createPayload: async (tx: unknown) => {
        payloadTxs.push(tx as Record<string, unknown>)
        return created()
      },
      createSignInPayload: async () => created(),
      getPayload: async () => null,
      cancelPayload: async () => true,
    },
  }
})

// Same reasoning as routes.authorization.test.ts: brokerMode is read from
// PLATFORM_SEED, and the routes under test answer 503 without it — before
// ever reaching the cap check this suite exists to pin.
vi.mock('../src/env.js', async () => {
  const actual = await vi.importActual<typeof import('../src/env.js')>('../src/env.js')
  return { ...actual, brokerMode: 'live' as const }
})

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')

const app = createApp()

const UTAG = 'pr_'
const STAG = 'pr-'
const XRP = 1_000_000n

type Actor = { id: string; username: string; address: string; token: string }

let uniq = ''
let hexUniq = ''

async function mkUser(name: string, role: 'USER' | 'ORGANIZER' | 'ADMIN' = 'USER', founding = false): Promise<Actor> {
  const username = `${UTAG}${name}_${uniq}`.slice(0, 20)
  const user = await prisma.user.create({
    data: {
      username,
      xrplAddress: `r${UTAG}${name}${uniq}`.padEnd(28, 'x').slice(0, 33),
      role,
      foundingOrganizer: founding,
    },
  })
  const { token } = await createSession(user.id)
  return { id: user.id, username: user.username, address: user.xrplAddress, token }
}

function as(actor: Actor) {
  return `Bearer ${actor.token}`
}

type ResaleConfig = {
  resalePolicy?: 'UNRESTRICTED' | 'PERCENTAGE_CAP' | 'FIXED_CAP' | 'FACE_VALUE_ONLY' | 'DISABLED'
  resaleCapBps?: number
  resaleCapDrops?: bigint
}

async function mkEvent(organizer: Actor, opts: { ticketCount?: number } & ResaleConfig = {}) {
  return prisma.event.create({
    data: {
      network: NETWORK,
      slug: `${STAG}${uniq}`,
      title: 'Resale Cap Test Event',
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: organizer.id,
      nftTaxon: 70_000 + Math.floor(Math.random() * 9_000),
      royaltyBps: 500,
      platformBps: 250,
      ticketCount: opts.ticketCount ?? 10,
      status: 'PUBLISHED',
      resalePolicy: opts.resalePolicy ?? 'UNRESTRICTED',
      resaleCapBps: opts.resaleCapBps ?? null,
      resaleCapDrops: opts.resaleCapDrops ?? null,
    },
  })
}

async function mkTicket(
  eventId: string,
  owner: Actor,
  faceValueDrops: bigint | null = null,
  paid: { minor: bigint; currency: 'XRP' | 'USD' | 'RLUSD' } | null = null,
) {
  return prisma.ticket.create({
    data: {
      network: NETWORK,
      nfTokenId: `${hexUniq}${'0'.repeat(64)}`.slice(0, 64).toUpperCase(),
      eventId,
      ownerId: owner.id,
      ownerAddress: owner.address,
      status: 'MINTED',
      faceValueDrops,
      originalCostMinor: paid?.minor ?? null,
      originalCostCurrency: paid?.currency ?? null,
    },
  })
}

const eventWhere = {
  OR: [{ slug: { startsWith: STAG } }, { organizer: { username: { startsWith: UTAG } } }],
}

async function cleanup() {
  const byEvent = { ticket: { event: eventWhere } }
  await prisma.bid.deleteMany({ where: { auction: byEvent } })
  await prisma.listing.deleteMany({ where: { seller: { username: { startsWith: UTAG } } } })
  await prisma.auction.deleteMany({ where: byEvent })
  await prisma.ticket.deleteMany({ where: { event: eventWhere } })
  await prisma.event.deleteMany({ where: eventWhere })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: UTAG } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: UTAG } } })
}

beforeEach(async () => {
  uniq = Math.random().toString(36).slice(2, 8)
  hexUniq = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0')
  await cleanup()
  payloadTxs.length = 0
  holdsNft.mockReset()
  accountNfts.mockReset()
  accountFunding.mockReset()
  holdsNft.mockResolvedValue(true)
  accountNfts.mockResolvedValue([])
  accountFunding.mockResolvedValue({ spendableDrops: 100_000n * XRP, reserveIncDrops: 200_000n })
})

afterEach(cleanup)
afterAll(async () => {
  await prisma.$disconnect()
})

const paid = (xrp: number) => ({ minor: BigInt(Math.round(xrp * 1_000_000)), currency: 'XRP' as const })

const list = (holder: Actor, nfTokenId: string, price: bigint) =>
  request(app).post(`/api/tickets/${nfTokenId}/list`).set('Authorization', as(holder)).send({ priceDrops: price.toString() })


import { ECDSA, Wallet as XWallet } from 'xrpl'
const priv = await import('../src/privy-signing.js')
const BROKER_ADDR = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'

beforeEach(() => {
  priv.setLedgerPortForTests({
    currentLedger: async () => 1_000,
    autofill: async (tx) => ({ ...tx, Fee: '12', Sequence: 5, LastLedgerSequence: 1_020 }),
    submit: async () => ({ engineResult: 'tesSUCCESS', hash: 'H'.repeat(64) }),
  })
})
afterAll(() => priv.setLedgerPortForTests(null))

/** A real person with a Privy wallet: a real key, so the address and public key are genuinely each other's. */
async function privyActor(name: string, role: 'USER' | 'ORGANIZER' = 'USER'): Promise<Actor & { key: XWallet }> {
  const key = XWallet.generate(ECDSA.secp256k1)
  const user = await prisma.user.create({
    data: {
      username: `${UTAG}${name}_${uniq}`.slice(0, 20),
      xrplAddress: key.classicAddress,
      role,
      wallet: { create: { xrplAddress: key.classicAddress, signerKind: 'PRIVY', providerUserId: `did:privy:${UTAG}${name}${uniq}`, publicKey: key.publicKey } },
    },
  })
  const { token } = await createSession(user.id)
  return { id: user.id, username: user.username, address: key.classicAddress, token, key }
}

const rows = (userId: string) => prisma.xamanPayload.findMany({ where: { userId } })
const post = (path: string, a: Actor, body: object = {}) => request(app).post(path).set('Authorization', as(a)).send(body)

async function fixture() {
  const organizer = await mkUser('org', 'ORGANIZER')
  const holder = await privyActor('holder')
  const event = await mkEvent(organizer, { ticketCount: 1 })
  const ticket = await mkTicket(event.id, holder, 6n * XRP, paid(12))
  return { organizer, holder, event, ticket }
}

describe('a Privy holder gets the transaction to approve, built by the same route', () => {
  it('LISTING_CREATE: a sell offer for price minus the 5% fee, restricted to the broker, no QR and no Xaman payload', async () => {
    const { holder, ticket } = await fixture()
    const res = await post(`/api/tickets/${ticket.nfTokenId}/list`, holder, { priceDrops: (10n * XRP).toString() })
    expect(res.status).toBe(201)
    expect(res.body.sign).toMatchObject({ account: holder.address })
    expect(res.body.sign.tx).toMatchObject({ TransactionType: 'NFTokenCreateOffer', Account: holder.address, Amount: '9500000', Flags: 1 })
    expect(res.body.sign.hash).toMatch(/^[0-9A-F]{64}$/)
    expect(res.body.qrPng).toBe('')
    expect(payloadTxs).toHaveLength(0) // Xaman was never asked
    const [row] = await rows(holder.id)
    expect(row).toMatchObject({ signer: 'privy', flow: 'LISTING_CREATE', expectedAccount: holder.address })
    // The listing waits on THIS request, exactly as it waited on a Xaman payload.
    expect((await prisma.listing.findFirstOrThrow({ where: { ticketId: ticket.id } })).listPayloadUuid).toBe(res.body.uuid)
  })

  it('LISTING_BUY: a buy offer for exactly the price, naming the seller as owner', async () => {
    const { holder, event, ticket } = await fixture()
    const buyer = await privyActor('buyer')
    await prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'LISTED' } })
    const listing = await prisma.listing.create({
      data: { network: NETWORK, ticketId: ticket.id, sellerId: holder.id, sellerAddress: holder.address, brokerAddress: BROKER_ADDR, priceDrops: 10n * XRP, platformFeeDrops: 500_000n, feeModel: 'SELLER_PAYS_V2', feeBps: 500, listPayloadUuid: `x:${uniq}`, offerIndex: 'AA'.repeat(32), status: 'ACTIVE', listedAt: new Date(), expiresAt: new Date(Date.now() + 1e6) },
    })
    void event
    const res = await post(`/api/listings/${listing.id}/buy`, buyer)
    expect(res.status).toBe(201)
    expect(res.body.sign.tx).toMatchObject({ TransactionType: 'NFTokenCreateOffer', Account: buyer.address, Owner: holder.address, Amount: '10000000' })
    expect((res.body.sign.tx.Flags ?? 0) & 1).toBe(0)
    expect(payloadTxs).toHaveLength(0)
    expect((await rows(buyer.id))[0]).toMatchObject({ signer: 'privy', flow: 'LISTING_BUY' })
  })

  it('LISTING_CANCEL: a cancel of exactly that listing\'s offer', async () => {
    const { holder, ticket } = await fixture()
    await prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'LISTED' } })
    const listing = await prisma.listing.create({
      data: { network: NETWORK, ticketId: ticket.id, sellerId: holder.id, sellerAddress: holder.address, brokerAddress: BROKER_ADDR, priceDrops: 10n * XRP, platformFeeDrops: 500_000n, feeModel: 'SELLER_PAYS_V2', feeBps: 500, listPayloadUuid: `x:${uniq}`, offerIndex: 'AB'.repeat(32), status: 'ACTIVE', listedAt: new Date(), expiresAt: new Date(Date.now() + 1e6) },
    })
    const res = await post(`/api/listings/${listing.id}/cancel`, holder)
    expect(res.status).toBe(201)
    expect(res.body.sign.tx).toMatchObject({ TransactionType: 'NFTokenCancelOffer', Account: holder.address, NFTokenOffers: ['AB'.repeat(32)] })
    expect((await rows(holder.id))[0]).toMatchObject({ signer: 'privy', flow: 'LISTING_CANCEL' })
  })

  it('AUCTION_OPEN: a sell offer for the reserve minus the fee, restricted to the broker', async () => {
    const { holder, ticket } = await fixture()
    const res = await post(`/api/tickets/${ticket.nfTokenId}/auction`, holder, { reserveDrops: (10n * XRP).toString() })
    expect(res.status).toBe(201)
    expect(res.body.sign.tx).toMatchObject({ TransactionType: 'NFTokenCreateOffer', Account: holder.address, Amount: '9500000', Flags: 1 })
    expect((await rows(holder.id))[0]).toMatchObject({ signer: 'privy', flow: 'AUCTION_OPEN' })
  })

  it('AUCTION_BID: a buy offer for exactly the bid', async () => {
    const { holder, ticket } = await fixture()
    const open = await post(`/api/tickets/${ticket.nfTokenId}/auction`, holder, { reserveDrops: (10n * XRP).toString() })
    await prisma.auction.update({ where: { id: open.body.auctionId }, data: { status: 'LIVE' } })
    await prisma.listing.update({ where: { id: open.body.listingId }, data: { status: 'ACTIVE', offerIndex: 'AC'.repeat(32) } })
    const bidder = await privyActor('bidder')
    const res = await post(`/api/auctions/${open.body.auctionId}/bid`, bidder, { amountDrops: (12n * XRP).toString() })
    expect(res.status).toBe(201)
    expect(res.body.sign.tx).toMatchObject({ TransactionType: 'NFTokenCreateOffer', Account: bidder.address, Owner: holder.address, Amount: '12000000' })
    expect((await rows(bidder.id))[0]).toMatchObject({ signer: 'privy', flow: 'AUCTION_BID' })
  })

  it('a Xaman user gets no sign block and the same QR as ever', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('holder')
    const event = await mkEvent(organizer, { ticketCount: 1 })
    const ticket = await mkTicket(event.id, holder, 6n * XRP, paid(12))
    const res = await post(`/api/tickets/${ticket.nfTokenId}/list`, holder, { priceDrops: (10n * XRP).toString() })
    expect(res.status).toBe(201)
    expect(res.body.sign).toBeUndefined()
    expect(res.body.qrPng).toMatch(/^https:/)
  })

  it('gifting is still not built for Privy and says so, rather than asking Xaman', async () => {
    const { holder, ticket } = await fixture()
    const other = await mkUser('friend')
    const res = await post(`/api/tickets/${ticket.nfTokenId}/gift`, holder, { to: other.username })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(res.body)).toMatch(/not available|email sign-in/i)
    expect(payloadTxs).toHaveLength(0)
  })
})

import { RippledError } from 'xrpl'

describe('a Privy buyer whose wallet cannot pay is told so, with the address to fill', () => {
  it('buying a resale: 409 WALLET_NEEDS_FUNDS, and no request to sign is created', async () => {
    const { holder, ticket } = await fixture()
    const buyer = await privyActor('broke')
    await prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'LISTED' } })
    const listing = await prisma.listing.create({
      data: { network: NETWORK, ticketId: ticket.id, sellerId: holder.id, sellerAddress: holder.address, brokerAddress: BROKER_ADDR, priceDrops: 10n * XRP, platformFeeDrops: 500_000n, feeModel: 'SELLER_PAYS_V2', feeBps: 500, listPayloadUuid: `x:${uniq}`, offerIndex: 'AA'.repeat(32), status: 'ACTIVE', listedAt: new Date(), expiresAt: new Date(Date.now() + 1e6) },
    })
    accountFunding.mockRejectedValue(new RippledError('Account not found.', { error: 'actNotFound' }))

    const res = await post(`/api/listings/${listing.id}/buy`, buyer)

    expect(res.status).toBe(409)
    // 10 price + 0.2 the offer locks + 0.1 fee headroom + 1 base reserve for the account to exist
    expect(res.body).toMatchObject({ code: 'WALLET_NEEDS_FUNDS', address: buyer.address, neededDrops: '11300000', haveDrops: '0', canFund: true })
    expect(await rows(buyer.id)).toHaveLength(0)
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe('ACTIVE') // still for sale
  })

  it('bidding with a wallet that does not exist yet: the same answer', async () => {
    const { holder, ticket } = await fixture()
    const open = await post(`/api/tickets/${ticket.nfTokenId}/auction`, holder, { reserveDrops: (10n * XRP).toString() })
    await prisma.auction.update({ where: { id: open.body.auctionId }, data: { status: 'LIVE' } })
    await prisma.listing.update({ where: { id: open.body.listingId }, data: { status: 'ACTIVE', offerIndex: 'AC'.repeat(32) } })
    const bidder = await privyActor('brokebid')
    accountFunding.mockRejectedValue(new RippledError('Account not found.', { error: 'actNotFound' }))
    const res = await post(`/api/auctions/${open.body.auctionId}/bid`, bidder, { amountDrops: (12n * XRP).toString() })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'WALLET_NEEDS_FUNDS', address: bidder.address })
    expect(await rows(bidder.id)).toHaveLength(0)
  })

  it('a bid from a wallet that exists but is short keeps its existing refusal and now carries the same fields', async () => {
    const { holder, ticket } = await fixture()
    const open = await post(`/api/tickets/${ticket.nfTokenId}/auction`, holder, { reserveDrops: (10n * XRP).toString() })
    await prisma.auction.update({ where: { id: open.body.auctionId }, data: { status: 'LIVE' } })
    await prisma.listing.update({ where: { id: open.body.listingId }, data: { status: 'ACTIVE', offerIndex: 'AC'.repeat(32) } })
    const xaman = await mkUser('xbidder')
    accountFunding.mockResolvedValue({ spendableDrops: 5n * XRP, reserveIncDrops: 200_000n })
    const res = await post(`/api/auctions/${open.body.auctionId}/bid`, xaman, { amountDrops: (12n * XRP).toString() })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'WALLET_NEEDS_FUNDS', address: xaman.address, haveDrops: '5000000', canFund: true })
    expect(res.body.error).toMatch(/spendable balance is below/i)
  })

  it('/api/policy tells the browser which account is HubWorld\'s broker, so it can check an offer is restricted to it', async () => {
    const res = await request(app).get('/api/policy')
    expect(res.body.brokerAddress).toBe(BROKER_ADDR)
  })
})
