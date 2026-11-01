/** `POST /api/tickets/:nfTokenId/claim` over HTTP: the session decides who is claiming, never the body. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.CLAIMS_ENABLED = 'true'
})

import request from 'supertest'
import { Wallet } from 'xrpl'
import { makeNftId } from './nft-id.js'

const DELEGATE = Wallet.generate().classicAddress
const submitted: unknown[] = []

vi.mock('../src/delegate-account.js', async () => {
  const actual = await vi.importActual<typeof import('../src/delegate-account.js')>('../src/delegate-account.js')
  return { ...actual, currentDelegate: () => DELEGATE }
})
vi.mock('../src/primary-sale-ledger.js', () => {
  const ledger = {
    async readPermission() { return 'granted' },
    async holds() { return true },
    async funding() { return { spendableDrops: 10n ** 12n, reserveIncDrops: 200_000n } },
    async startSellOffer(tx: unknown) { submitted.push(tx); return { ok: true, hash: 'AA'.repeat(32), lastLedgerSequence: 0 } },
    async awaitSellOffer() { return { ok: true, txHash: 'AA'.repeat(32), offerIndex: 'BB'.repeat(32) } },
    async cancelOffers() {},
  }
  return { defaultPrimarySaleLedger: () => ledger, realPrimarySaleLedger: () => ledger, stubPrimarySaleLedger: () => ledger }
})

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')

const app = createApp()
const UTAG = 'cr_'
let uniq = ''
let n = 0

async function user(name: string, role: 'USER' | 'ORGANIZER' = 'USER') {
  const address = Wallet.generate().classicAddress
  const u = await prisma.user.create({ data: { username: `${UTAG}${name}_${uniq}`.slice(0, 20), xrplAddress: address, role } })
  await prisma.wallet.create({ data: { userId: u.id, xrplAddress: address, signerKind: 'PRIVY', providerUserId: `did:${name}:${uniq}` } })
  const { token } = await createSession(u.id)
  return { id: u.id, address, token }
}

async function fixture() {
  const org = await user('org', 'ORGANIZER')
  const holder = await user('holder')
  n += 1
  const event = await prisma.event.create({
    data: { network: NETWORK, slug: `cr-${uniq}`, title: 'Route', startsAt: new Date(Date.now() + 864e5), organizerId: org.id, nftTaxon: 20_000 + n, royaltyBps: 500, platformBps: 250, ticketCount: 3, status: 'PUBLISHED' },
  })
  const nfTokenId = makeNftId(org.address, event.nftTaxon, n)
  await prisma.ticket.create({ data: { nfTokenId, network: NETWORK, eventId: event.id, ownerId: holder.id, ownerAddress: org.address, status: 'MINTED' } })
  return { org, holder, nfTokenId }
}

async function cleanup() {
  const ev = { event: { slug: { startsWith: 'cr-' } } }
  await prisma.ticketClaim.deleteMany({ where: { ticket: ev } })
  await prisma.ticket.deleteMany({ where: ev })
  await prisma.event.deleteMany({ where: { slug: { startsWith: 'cr-' } } })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: UTAG } } } })
  await prisma.wallet.deleteMany({ where: { user: { username: { startsWith: UTAG } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: UTAG } } })
}
beforeEach(async () => {
  uniq = Math.random().toString(36).slice(2, 7)
  submitted.length = 0
  await cleanup()
})
afterEach(cleanup)
afterAll(async () => {
  await prisma.$disconnect()
})

const post = (id: string, token?: string) => {
  const r = request(app).post(`/api/tickets/${id}/claim`)
  return token ? r.set('Authorization', `Bearer ${token}`) : r
}

describe('POST /api/tickets/:nfTokenId/claim', () => {
  it('needs a session', async () => {
    const f = await fixture()
    expect((await post(f.nfTokenId)).status).toBe(401)
    expect(submitted).toHaveLength(0)
  })

  it('the holder gets the offer, and asking again gets the same one', async () => {
    const f = await fixture()
    const a = await post(f.nfTokenId, f.holder.token)
    expect(a.status).toBe(201)
    expect(a.body).toMatchObject({ offerIndex: 'BB'.repeat(32), reused: false })
    const b = await post(f.nfTokenId, f.holder.token)
    expect(b.status).toBe(200)
    expect(b.body).toMatchObject({ offerIndex: 'BB'.repeat(32), reused: true })
    expect(submitted).toHaveLength(1)
  })

  it('refuses everyone else, in the server\'s words, without making an offer', async () => {
    const f = await fixture()
    const other = await user('other')
    const res = await post(f.nfTokenId, other.token)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('NOT_THE_HOLDER')
    expect(submitted).toHaveLength(0)
  })

  it('answers 404 for a ticket that does not exist, and 400 for a malformed id', async () => {
    const f = await fixture()
    expect((await post('AB'.repeat(32), f.holder.token)).status).toBe(404)
    expect((await post('not-a-token', f.holder.token)).status).toBe(400)
  })
})
