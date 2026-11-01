/**
 * Claims are OFF unless CLAIMS_ENABLED=true, and off means the route does not exist.
 *
 * Merging the claim code must change nothing in production. A disabled feature answers 404, the same as a path that was
 * never registered, so it advertises nothing and cannot be probed; and it must refuse BEFORE reading the session or the
 * ticket, or the response would still tell a caller whether a ticket exists.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { Wallet } from 'xrpl'
import { makeNftId } from './nft-id.js'

const submitted: unknown[] = []
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
const { claimsEnabled } = await import('../src/env.js')

const app = createApp()
let uniq = ''

async function cleanup() {
  const ev = { event: { slug: { startsWith: 'co-' } } }
  await prisma.ticketClaim.deleteMany({ where: { ticket: ev } })
  await prisma.ticket.deleteMany({ where: ev })
  await prisma.event.deleteMany({ where: { slug: { startsWith: 'co-' } } })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: 'co_' } } } })
  await prisma.wallet.deleteMany({ where: { user: { username: { startsWith: 'co_' } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: 'co_' } } })
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

async function fixture() {
  const mk = async (name: string, role: 'USER' | 'ORGANIZER') => {
    const address = Wallet.generate().classicAddress
    const u = await prisma.user.create({ data: { username: `co_${name}_${uniq}`, xrplAddress: address, role } })
    await prisma.wallet.create({ data: { userId: u.id, xrplAddress: address, signerKind: 'PRIVY', providerUserId: `did:co:${name}:${uniq}` } })
    return { u, address, token: (await createSession(u.id)).token }
  }
  const org = await mk('org', 'ORGANIZER')
  const holder = await mk('holder', 'USER')
  const event = await prisma.event.create({
    data: { network: NETWORK, slug: `co-${uniq}`, title: 'Off', startsAt: new Date(Date.now() + 864e5), organizerId: org.u.id, nftTaxon: 10_000 + Math.floor(Math.random() * 900), royaltyBps: 500, platformBps: 250, ticketCount: 1, status: 'PUBLISHED' },
  })
  const nfTokenId = makeNftId(org.address, event.nftTaxon, 1)
  await prisma.ticket.create({ data: { nfTokenId, network: NETWORK, eventId: event.id, ownerId: holder.u.id, ownerAddress: org.address, status: 'MINTED' } })
  return { holder, nfTokenId }
}

describe('with CLAIMS_ENABLED unset (the default, and production)', () => {
  it('the flag reads as off', () => {
    expect(claimsEnabled).toBe(false)
  })

  it('the route answers 404 to the real holder with a valid session, and makes no offer', async () => {
    const f = await fixture()
    const res = await request(app).post(`/api/tickets/${f.nfTokenId}/claim`).set('Authorization', `Bearer ${f.holder.token}`)
    expect(res.status).toBe(404)
    expect(submitted).toHaveLength(0)
    expect(await prisma.ticketClaim.count({ where: { ticket: { nfTokenId: f.nfTokenId } } })).toBe(0)
  })

  it('answers the same 404 without a session, so it cannot be told apart from a path that does not exist', async () => {
    const f = await fixture()
    const off = await request(app).post(`/api/tickets/${f.nfTokenId}/claim`)
    const missing = await request(app).post(`/api/tickets/${f.nfTokenId}/nothing-here`)
    expect(off.status).toBe(404)
    expect(off.status).toBe(missing.status)
    expect(off.body).toEqual(missing.body)
  })
})
