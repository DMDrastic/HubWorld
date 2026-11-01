/**
 * A buyer whose bid was let go is told, on the screen that lists what they are buying. Written before the code.
 *
 * The sale goes back to ACTIVE for the next buyer, so it no longer belongs to them; without a record of what
 * happened to theirs, a bid would simply vanish. The notice is that record, shown as a failed purchase with its
 * reason, for a week, and only to the buyer it concerns.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { Wallet } from 'xrpl'
import { prisma } from '../src/prisma.js'
import { NETWORK } from '../src/network.js'
import { createApp } from '../src/app.js'
import { createSession } from '../src/session.js'

const app = createApp()
const UTAG = 'ln_'
let uniq = ''
let n = 0

async function user(name: string) {
  const u = await prisma.user.create({ data: { username: `${UTAG}${name}_${uniq}`.slice(0, 20), xrplAddress: Wallet.generate().classicAddress } })
  return { id: u.id, token: (await createSession(u.id)).token }
}

async function fixture() {
  n += 1
  const seller = await user('s')
  const buyer = await user('b')
  const other = await user('x')
  const event = await prisma.event.create({
    data: { network: NETWORK, slug: `ln-${uniq}-${n}`, title: 'Notice Test', startsAt: new Date(Date.now() + 864e5), organizerId: seller.id, nftTaxon: 60_000 + n, royaltyBps: 500, platformBps: 250, ticketCount: 1, status: 'PUBLISHED' },
  })
  const ticket = await prisma.ticket.create({
    data: { nfTokenId: `${uniq}${n}`.padEnd(64, 'C').toUpperCase().replace(/[^0-9A-F]/g, 'C'), network: NETWORK, eventId: event.id, ownerId: seller.id, ownerAddress: Wallet.generate().classicAddress, status: 'LISTED' },
  })
  const listing = await prisma.listing.create({
    data: { network: NETWORK, ticketId: ticket.id, sellerId: seller.id, sellerAddress: ticket.ownerAddress!, priceDrops: 10_000_000n, platformFeeDrops: 500_000n, feeModel: 'SELLER_PAYS_V2', feeBps: 500, listPayloadUuid: `delegate:${uniq}${n}`, offerIndex: 'AA'.repeat(32), status: 'ACTIVE', expiresAt: new Date(Date.now() + 864e5) },
  })
  return { seller, buyer, other, listing }
}

async function cleanup() {
  const ev = { event: { slug: { startsWith: 'ln-' } } }
  await prisma.listingBuyerNotice.deleteMany({ where: { listing: { ticket: ev } } })
  await prisma.listing.deleteMany({ where: { ticket: ev } })
  await prisma.ticket.deleteMany({ where: ev })
  await prisma.event.deleteMany({ where: { slug: { startsWith: 'ln-' } } })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: UTAG } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: UTAG } } })
}
beforeEach(async () => {
  uniq = Math.random().toString(36).slice(2, 7)
  await cleanup()
})
afterEach(cleanup)
afterAll(async () => {
  await prisma.$disconnect()
})

const mine = (token: string) => request(app).get('/api/listings/mine').set('Authorization', `Bearer ${token}`)

describe('GET /api/listings/mine and a bid that was let go', () => {
  it('shows the buyer a failed purchase with the reason, as a buyer-side row', async () => {
    const f = await fixture()
    await prisma.listingBuyerNotice.create({ data: { listingId: f.listing.id, userId: f.buyer.id, reason: 'The bid could not be paid.', amountDrops: 10_000_000n } })

    const res = await mine(f.buyer.token)

    expect(res.status).toBe(200)
    expect(res.body.listings).toHaveLength(1)
    expect(res.body.listings[0]).toMatchObject({
      listingId: f.listing.id,
      state: 'failed',
      reason: 'The bid could not be paid.',
      role: 'buyer',
      buyerPaysDrops: '10000000',
    })
    expect(res.body.listings[0].ticket.event.title).toBe('Notice Test')
  })

  it('does not show it to the seller or to anyone else', async () => {
    const f = await fixture()
    await prisma.listingBuyerNotice.create({ data: { listingId: f.listing.id, userId: f.buyer.id, reason: 'x', amountDrops: 1n } })
    const seller = (await mine(f.seller.token)).body.listings as Array<{ role: string; state: string }>
    expect(seller.some((l) => l.state === 'failed')).toBe(false)
    expect((await mine(f.other.token)).body.listings).toHaveLength(0)
  })

  it('stops showing it after a week', async () => {
    const f = await fixture()
    await prisma.listingBuyerNotice.create({
      data: { listingId: f.listing.id, userId: f.buyer.id, reason: 'x', amountDrops: 1n, createdAt: new Date(Date.now() - 8 * 86_400_000) },
    })
    expect((await mine(f.buyer.token)).body.listings).toHaveLength(0)
  })

  it('shows the amount the buyer had offered, not the listing\'s current terms', async () => {
    const f = await fixture()
    await prisma.listingBuyerNotice.create({ data: { listingId: f.listing.id, userId: f.buyer.id, reason: 'x', amountDrops: 10_500_000n } })
    expect((await mine(f.buyer.token)).body.listings[0].buyerPaysDrops).toBe('10500000')
  })
})
