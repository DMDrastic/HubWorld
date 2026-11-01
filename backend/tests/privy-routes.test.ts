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
const readNftOffer = vi.fn<(i: string) => Promise<{ amountDrops: bigint; destination: string | null; owner: string } | null>>()
const offerOnLedgerState = vi.fn<(i: string) => Promise<'present' | 'gone' | 'unknown'>>()
const accountFunding =
  vi.fn<(address: string) => Promise<{ spendableDrops: bigint; reserveIncDrops: bigint }>>()

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return {
    ...actual,
    holdsNft: (...a: Parameters<typeof holdsNft>) => holdsNft(...a),
    accountNfts: (...a: Parameters<typeof accountNfts>) => accountNfts(...a),
    accountFunding: (...a: Parameters<typeof accountFunding>) => accountFunding(...a),
    readNftOffer: (i: string) => readNftOffer(i),
    offerOnLedgerState: (i: string) => offerOnLedgerState(i),
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
// The display rate is controlled per test: the estimate must never reach what is signed, whatever it says.
const display = vi.hoisted(() => ({ rate: null as { microUsdPerXrp: bigint } | null }))
vi.mock('../src/fiat-display.js', async () => {
  const actual = await vi.importActual<typeof import('../src/fiat-display.js')>('../src/fiat-display.js')
  return { ...actual, currentDisplayRate: async () => display.rate }
})

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
  await prisma.gift.deleteMany({ where: { from: { username: { startsWith: UTAG } } } })
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

describe('gifts with a Privy wallet', () => {
  beforeEach(() => {
    readNftOffer.mockReset()
    offerOnLedgerState.mockReset().mockResolvedValue('present')
  })

  async function offered(opts: { recipient?: 'privy' | 'xaman' } = {}) {
    const { holder, ticket } = await fixture()
    const friend = opts.recipient === 'xaman' ? await mkUser('xfriend') : await privyActor('friend')
    const gift = await prisma.gift.create({
      data: {
        network: NETWORK, ticketId: ticket.id, fromId: holder.id, toId: friend.id, fromAddress: holder.address, toAddress: friend.address,
        status: 'OFFERED', offerPayloadUuid: `00000000-0000-4000-8000-${uniq.padEnd(12, '0').slice(0, 12).replace(/[^0-9a-f]/g, '0')}`,
        offerIndex: 'AD'.repeat(32), expiresAt: new Date(Date.now() + 600_000),
      },
    })
    return { holder, friend, ticket, gift }
  }

  it('GIFT_OFFER: a free sell offer to exactly the person named, to approve in the browser', async () => {
    const { holder, ticket } = await fixture()
    const friend = await privyActor('friend')
    const res = await post(`/api/tickets/${ticket.nfTokenId}/gift`, holder, { to: friend.username })
    expect(res.status).toBe(201)
    expect(res.body.sign.tx).toMatchObject({ TransactionType: 'NFTokenCreateOffer', Account: holder.address, Amount: '0', Destination: friend.address, Flags: 1 })
    expect(res.body.to).toEqual({ username: friend.username, xrplAddress: friend.address })
    expect(payloadTxs).toHaveLength(0)
    expect((await rows(holder.id))[0]).toMatchObject({ signer: 'privy', flow: 'GIFT_OFFER' })
  })

  it('GIFT_OFFER to HubWorld\'s broker is refused by the signer, whatever builds it', async () => {
    const holder = await privyActor('tobroker')
    const tx = { TransactionType: 'NFTokenCreateOffer', Account: holder.address, NFTokenID: 'AB'.repeat(32), Amount: '0', Destination: BROKER_ADDR, Flags: 1 }
    await expect(priv.privySigner.createPayload(tx, { flow: 'GIFT_OFFER', userId: holder.id })).rejects.toThrow(/broker/i)
  })

  it('GIFT_ACCEPT: checks on the LEDGER that the gift is free, for them, from the sender, then hands back the accept to approve', async () => {
    const { holder, friend, gift } = await offered()
    readNftOffer.mockResolvedValue({ amountDrops: 0n, destination: friend.address, owner: holder.address })
    const res = await post(`/api/gifts/${gift.id}/accept`, friend)
    expect(res.status).toBe(201)
    expect(res.body.sign.tx).toMatchObject({ TransactionType: 'NFTokenAcceptOffer', Account: friend.address, NFTokenSellOffer: 'AD'.repeat(32) })
    expect(res.body.offer).toEqual({ index: 'AD'.repeat(32) })
    expect((await rows(friend.id))[0]).toMatchObject({ signer: 'privy', flow: 'GIFT_ACCEPT' })
  })

  it.each([
    ['is not free (accepting it would PAY for the ticket)', (h: string, f: string) => ({ amountDrops: 1_000_000n, destination: f, owner: h })],
    ['is addressed to someone else', (h: string) => ({ amountDrops: 0n, destination: 'rSomeoneElse', owner: h })],
    ['is open to anyone', (h: string) => ({ amountDrops: 0n, destination: null, owner: h })],
    ['is from someone other than the sender', (_h: string, f: string) => ({ amountDrops: 0n, destination: f, owner: 'rSomeoneElse' })],
  ])('GIFT_ACCEPT is REFUSED when the offer on the ledger %s, and nothing is created', async (_n, make) => {
    const { holder, friend, gift } = await offered()
    readNftOffer.mockResolvedValue(make(holder.address, friend.address))
    const res = await post(`/api/gifts/${gift.id}/accept`, friend)
    expect(res.status).toBe(409)
    expect(await rows(friend.id)).toHaveLength(0)
  })

  it('GIFT_ACCEPT when the offer is gone says so, and creates nothing', async () => {
    const { friend, gift } = await offered()
    offerOnLedgerState.mockResolvedValue('gone')
    const res = await post(`/api/gifts/${gift.id}/accept`, friend)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/no longer/i)
    expect(await rows(friend.id)).toHaveLength(0)
  })

  it('GIFT_ACCEPT when the ledger cannot be read: a Privy wallet waits (its screen cannot see the amount), and nothing is created', async () => {
    const { friend, gift } = await offered()
    offerOnLedgerState.mockResolvedValue('unknown')
    const res = await post(`/api/gifts/${gift.id}/accept`, friend)
    expect(res.status).toBe(503)
    expect(await rows(friend.id)).toHaveLength(0)
  })

  it('GIFT_ACCEPT when the ledger cannot be read: a Xaman wallet carries on (Xaman shows the amount itself)', async () => {
    const { gift, friend } = await offered({ recipient: 'xaman' })
    offerOnLedgerState.mockResolvedValue('unknown')
    expect((await post(`/api/gifts/${gift.id}/accept`, friend)).status).toBe(201)
  })

  it('GIFT_ACCEPT by a Privy wallet that does not exist yet: WALLET_NEEDS_FUNDS (enough to exist and hold the ticket), nothing created', async () => {
    const { holder, friend, gift } = await offered()
    readNftOffer.mockResolvedValue({ amountDrops: 0n, destination: friend.address, owner: holder.address })
    accountFunding.mockRejectedValue(new RippledError('Account not found.', { error: 'actNotFound' }))
    const res = await post(`/api/gifts/${gift.id}/accept`, friend)
    expect(res.status).toBe(409)
    // nothing to pay + 0.2 for the page the ticket lands on + 0.1 fee headroom + 1 base reserve
    expect(res.body).toMatchObject({ code: 'WALLET_NEEDS_FUNDS', address: friend.address, neededDrops: '1300000' })
    expect(await rows(friend.id)).toHaveLength(0)
  })

  it('GIFT_CANCEL: a cancel of exactly that gift\'s offer', async () => {
    const { holder, gift } = await offered()
    const res = await post(`/api/gifts/${gift.id}/cancel`, holder)
    expect(res.status).toBe(201)
    expect(res.body.sign.tx).toMatchObject({ TransactionType: 'NFTokenCancelOffer', Account: holder.address, NFTokenOffers: ['AD'.repeat(32)] })
    expect((await rows(holder.id))[0]).toMatchObject({ signer: 'privy', flow: 'GIFT_CANCEL' })
  })
})

describe('the US$ estimate is display only', () => {
  afterEach(() => {
    display.rate = null
  })
  const listed = async () => {
    const { holder, event, ticket } = await fixture()
    await prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'LISTED' } })
    const listing = await prisma.listing.create({
      data: { network: NETWORK, ticketId: ticket.id, sellerId: holder.id, sellerAddress: holder.address, brokerAddress: BROKER_ADDR, priceDrops: 10n * XRP, platformFeeDrops: 500_000n, feeModel: 'SELLER_PAYS_V2', feeBps: 500, listPayloadUuid: `x:${uniq}`, offerIndex: 'AA'.repeat(32), status: 'ACTIVE', listedAt: new Date(), expiresAt: new Date(Date.now() + 1e6) },
    })
    return { holder, event, ticket, listing }
  }

  it('a buy signs exactly the XRP amount shown, whatever the dollar price is, and the estimate sits beside it', async () => {
    const amounts: string[] = []
    for (const micro of [1_250_000n, 900_000_000n]) {
      await cleanup()
      uniq = Math.random().toString(36).slice(2, 8)
      display.rate = { microUsdPerXrp: micro }
      const { listing } = await listed()
      const res = await post(`/api/listings/${listing.id}/buy`, await privyActor('buyer'))
      expect(res.status).toBe(201)
      expect(res.body.sign.tx.Amount).toBe(res.body.paysDrops)
      amounts.push(res.body.sign.tx.Amount)
      expect(res.body.fiat.paysDrops.currency).toBe('USD')
    }
    // US$12.50 at one price, US$9,000 at the other: the signed XRP is the same.
    expect(amounts).toEqual(['10000000', '10000000'])
  })

  it('with no fresh price there is no estimate at all, and the buy is unchanged', async () => {
    display.rate = null
    const { listing } = await listed()
    const res = await post(`/api/listings/${listing.id}/buy`, await privyActor('buyer'))
    expect(res.status).toBe(201)
    expect(res.body.fiat).toEqual({})
    expect(res.body.sign.tx.Amount).toBe('10000000')
  })

  it('a listing\'s sell offer is the XRP price minus the fee, whatever the dollar price is', async () => {
    display.rate = { microUsdPerXrp: 900_000_000n }
    const { holder, ticket } = await fixture()
    const res = await post(`/api/tickets/${ticket.nfTokenId}/list`, holder, { priceDrops: (10n * XRP).toString() })
    expect(res.status).toBe(201)
    expect(res.body.sign.tx.Amount).toBe('9500000')
    expect(res.body.fiat.priceDrops).toEqual({ currency: 'USD', minor: '900000' })
  })

  it('the marketplace, the event list, the inventory and the quote carry the estimate when fresh, and nothing when not', async () => {
    const { holder, event, listing } = await listed()
    const read = async () => ({
      market: (await request(app).get('/api/listings')).body.listings.find((l: { listingId: string }) => l.listingId === listing.id),
      ev: (await request(app).get(`/api/events/${event.slug}`)).body,
      mine: (await request(app).get('/api/tickets/mine').set('Authorization', `Bearer ${holder.token}`)).body.tickets[0],
      quote: (await request(app).get('/api/price/quote?drops=28000000,0')).body,
    })

    display.rate = { microUsdPerXrp: 1_250_000n }
    const on = await read()
    expect(on.market.fiat).toEqual({
      priceDrops: { currency: 'USD', minor: '1250' },
      platformFeeDrops: { currency: 'USD', minor: '63' },
      buyerPaysDrops: { currency: 'USD', minor: '1250' },
      // 10 XRP less the 0.5 XRP fee, at US$1.25: what the seller receives before the royalty.
      sellerReceivesDrops: { currency: 'USD', minor: '1188' },
    })
    expect(on.market.priceDrops).toBe('10000000')
    expect(on.ev.fiat).toBeTypeOf('object')
    expect(on.mine.fiat).toBeTypeOf('object')
    expect(on.quote.fiat).toEqual({ '28000000': { currency: 'USD', minor: '3500' }, '0': { currency: 'USD', minor: '0' } })

    display.rate = null
    const off = await read()
    expect(off.market.fiat).toEqual({})
    expect(off.ev.fiat).toEqual({})
    expect(off.mine.fiat).toEqual({})
    expect(off.quote.fiat).toEqual({})
    expect(off.market.priceDrops).toBe('10000000')
  })

  it('the quote refuses malformed amounts and more than ten at once', async () => {
    expect((await request(app).get('/api/price/quote?drops=-5')).status).toBe(400)
    expect((await request(app).get('/api/price/quote?drops=1.5')).status).toBe(400)
    expect((await request(app).get(`/api/price/quote?drops=${Array(11).fill('1').join(',')}`)).status).toBe(400)
  })
})
