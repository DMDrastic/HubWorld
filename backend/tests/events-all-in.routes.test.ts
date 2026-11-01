/**
 * The price an event SHOWS is the price its checkout CHARGES. Written before the code.
 *
 * Under the new fee model the buyer pays the ticket price plus a fan fee, so a page that shows only the ticket price
 * asks for more than it advertised. The server therefore sends the all-in amount, worked out by the same function the
 * checkout uses, and the screen does no fee arithmetic of its own.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.FEE_MODEL = 'v2'
  process.env.XRP_USD_CENTS = '134'
})

import request from 'supertest'
import { Wallet } from 'xrpl'

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { createApp } = await import('../src/app.js')
const { firstSaleQuote } = await import('../src/listing-terms.js')

const app = createApp()
const UTAG = 'ea_'
let uniq = ''

async function cleanup() {
  await prisma.event.deleteMany({ where: { slug: { startsWith: 'ea-' } } })
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

async function mk(over: Record<string, unknown> = {}, founding = false) {
  const org = await prisma.user.create({
    data: { username: `${UTAG}o_${uniq}`.slice(0, 20), xrplAddress: Wallet.generate().classicAddress, role: 'ORGANIZER', foundingOrganizer: founding },
  })
  return prisma.event.create({
    data: {
      network: NETWORK,
      slug: `ea-${uniq}`,
      title: 'All In',
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: org.id,
      nftTaxon: 50_000,
      royaltyBps: 500,
      platformBps: 250,
      ticketCount: 5,
      status: 'PUBLISHED',
      primaryPriceDrops: 25_000_000n,
      ...over,
    },
  })
}

describe('the all-in price on an event', () => {
  it('detail: 25 XRP shows 25.875 all in, with the fee beside it', async () => {
    const e = await mk()
    const body = (await request(app).get(`/api/events/${e.slug}`)).body
    expect(body).toMatchObject({ primaryPriceDrops: '25000000', primaryFeeDrops: '875000', primaryAllInDrops: '25875000' })
  })

  it('the list gives the same figures as the detail', async () => {
    const e = await mk()
    const list = (await request(app).get('/api/events?limit=100')).body.events.find((x: { slug: string }) => x.slug === e.slug)
    expect(list).toMatchObject({ primaryFeeDrops: '875000', primaryAllInDrops: '25875000' })
  })

  it('a founding organizer inside the window shows the lower all-in price', async () => {
    const e = await mk({}, true)
    expect((await request(app).get(`/api/events/${e.slug}`)).body.primaryAllInDrops).toBe('25750000')
  })

  it('an event with no price shows no all-in price', async () => {
    const e = await mk({ primaryPriceDrops: null })
    const body = (await request(app).get(`/api/events/${e.slug}`)).body
    expect(body.primaryAllInDrops).toBeNull()
    expect(body.primaryFeeDrops).toBeNull()
  })

  it('is the very figure the quote function gives, so the page and the charge cannot drift', async () => {
    const e = await mk({}, true)
    const org = await prisma.user.findUniqueOrThrow({ where: { id: e.organizerId } })
    const q = firstSaleQuote({ priceDrops: 25_000_000n, event: e, organizerFounding: org.foundingOrganizer })
    expect((await request(app).get(`/api/events/${e.slug}`)).body.primaryAllInDrops).toBe((25_000_000n + q.feeDrops).toString())
  })
})
