/** With the fee model at its default (off), nothing about which policies an organizer may pick has changed. */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'

const { prisma } = await import('../src/prisma.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')
const { Wallet } = await import('xrpl')

const app = createApp()
const P = 'rpoptd_'
const S = 'rpoptd-'

async function cleanup() {
  await prisma.event.deleteMany({ where: { slug: { startsWith: S } } })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: P } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: P } } })
}
beforeEach(cleanup)
afterEach(cleanup)
afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('with the fee model off (the default)', () => {
  it('reports it, and every policy is still available, with unrestricted still the default', async () => {
    const u = await prisma.user.create({ data: { username: `${P}org`, xrplAddress: Wallet.generate().classicAddress, role: 'ORGANIZER' } })
    const { token } = await createSession(u.id)
    const cookie = `hubworld_session=${token}`
    expect((await request(app).get('/api/policy')).body).toMatchObject({ feeModel: 'v1', looseResalePolicies: true })

    const body = { title: 'Default Night', startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), ticketCount: 10, royaltyBps: 500 }
    expect((await request(app).post('/api/events').set('Cookie', cookie).send({ ...body, slug: `${S}a` })).status).toBe(201)
    expect((await prisma.event.findUniqueOrThrow({ where: { slug: `${S}a` } })).resalePolicy).toBe('UNRESTRICTED')
    expect((await request(app).post('/api/events').set('Cookie', cookie).send({ ...body, slug: `${S}b`, resalePolicy: 'PERCENTAGE_CAP', resaleCapBps: 15_000 })).status).toBe(201)
  })
})
