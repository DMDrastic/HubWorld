/**
 * What the Tickets page is drawn from.
 *
 * A held ticket is shown as a ticket: the event's title, date and PLACE, and its
 * artwork. The inventory used to carry only slug, title and date, so the card had
 * nothing to put where the venue goes.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')

const app = createApp()
const UTAG = 'tm_'
let uniq = ''

async function cleanup() {
  const ev = { event: { slug: { startsWith: 'tm-' } } }
  await prisma.transfer.deleteMany({ where: { ticket: ev } })
  await prisma.ticket.deleteMany({ where: ev })
  await prisma.event.deleteMany({ where: { slug: { startsWith: 'tm-' } } })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: UTAG } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: UTAG } } })
}

beforeEach(async () => {
  uniq = Math.random().toString(36).slice(2, 8)
  await cleanup()
})
afterEach(cleanup)
afterAll(async () => {
  await prisma.$disconnect()
})

async function holderWithTicket(event: { venue: string | null; imageUrl: string | null }) {
  const org = await prisma.user.create({
    data: { username: `${UTAG}org_${uniq}`.slice(0, 20), xrplAddress: `r${UTAG}org${uniq}`.padEnd(28, 'x').slice(0, 33), role: 'ORGANIZER' },
  })
  const holder = await prisma.user.create({
    data: { username: `${UTAG}hold_${uniq}`.slice(0, 20), xrplAddress: `r${UTAG}hold${uniq}`.padEnd(28, 'x').slice(0, 33) },
  })
  const ev = await prisma.event.create({
    data: {
      network: NETWORK,
      slug: `tm-${uniq}`,
      title: 'Ticket Wallet Test',
      venue: event.venue,
      imageUrl: event.imageUrl,
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: org.id,
      nftTaxon: 71_000,
      royaltyBps: 500,
      platformBps: 250,
      ticketCount: 10,
      status: 'PUBLISHED',
    },
  })
  await prisma.ticket.create({
    data: { nfTokenId: `${UTAG}${uniq}`.padEnd(64, '0').slice(0, 64), network: NETWORK, eventId: ev.id, ownerId: holder.id, ownerAddress: holder.xrplAddress },
  })
  const { token } = await createSession(holder.id)
  return token
}

describe('GET /tickets/mine', () => {
  it('carries the venue and artwork a ticket card needs', async () => {
    const token = await holderWithTicket({ venue: 'Openfield Stadium', imageUrl: 'https://img.example/poster.png' })

    const res = await request(app).get('/api/tickets/mine').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.tickets).toHaveLength(1)
    expect(res.body.tickets[0].event).toMatchObject({
      slug: `tm-${uniq}`,
      title: 'Ticket Wallet Test',
      venue: 'Openfield Stadium',
      imageUrl: 'https://img.example/poster.png',
    })
  })

  it('says null, not nothing, for an event with no venue or artwork', async () => {
    const token = await holderWithTicket({ venue: null, imageUrl: null })

    const res = await request(app).get('/api/tickets/mine').set('Authorization', `Bearer ${token}`)

    expect(res.body.tickets[0].event.venue).toBeNull()
    expect(res.body.tickets[0].event.imageUrl).toBeNull()
  })
})
