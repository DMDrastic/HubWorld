/** With the new fee model off, an event's all-in price is price + the event's own rate, exactly what checkout asks for. */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { Wallet } from 'xrpl'
import { prisma } from '../src/prisma.js'
import { NETWORK } from '../src/network.js'
import { createApp } from '../src/app.js'

const app = createApp()
afterEach(async () => {
  await prisma.event.deleteMany({ where: { slug: 'eav1-x' } })
  await prisma.user.deleteMany({ where: { username: 'eav1_o' } })
})
afterAll(async () => {
  await prisma.$disconnect()
})

describe('the all-in price with the model off', () => {
  it('uses the event\'s own platform rate: 2.5% on 25 XRP is 0.625', async () => {
    const org = await prisma.user.create({ data: { username: 'eav1_o', xrplAddress: Wallet.generate().classicAddress, role: 'ORGANIZER' } })
    await prisma.event.create({
      data: { network: NETWORK, slug: 'eav1-x', title: 'V1', startsAt: new Date(Date.now() + 86_400_000), organizerId: org.id, nftTaxon: 50_001, royaltyBps: 500, platformBps: 250, ticketCount: 5, status: 'PUBLISHED', primaryPriceDrops: 25_000_000n },
    })
    expect((await request(app).get('/api/events/eav1-x')).body).toMatchObject({ primaryFeeDrops: '625000', primaryAllInDrops: '25625000' })
  })
})
