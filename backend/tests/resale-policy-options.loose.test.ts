/** The setting that turns the loose resale policies back on, even with the new fee model on. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.FEE_MODEL = 'v2'
  process.env.ALLOW_LOOSE_RESALE_POLICIES = 'true'
})

import request from 'supertest'

const { prisma } = await import('../src/prisma.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')
const { Wallet } = await import('xrpl')

const app = createApp()
const P = 'rpoptl_'
const S = 'rpoptl-'

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

describe('ALLOW_LOOSE_RESALE_POLICIES=true', () => {
  it('turns the loose options back on: unrestricted is accepted and is the default again', async () => {
    const u = await prisma.user.create({ data: { username: `${P}org`, xrplAddress: Wallet.generate().classicAddress, role: 'ORGANIZER' } })
    const { token } = await createSession(u.id)
    const cookie = `hubworld_session=${token}`
    expect((await request(app).get('/api/policy')).body).toMatchObject({ feeModel: 'v2', looseResalePolicies: true })

    const body = { title: 'Loose Night', startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), ticketCount: 10, royaltyBps: 500 }
    const open = await request(app).post('/api/events').set('Cookie', cookie).send({ ...body, slug: `${S}a`, resalePolicy: 'UNRESTRICTED' })
    expect(open.status).toBe(201)
    const dflt = await request(app).post('/api/events').set('Cookie', cookie).send({ ...body, slug: `${S}b` })
    expect(dflt.status).toBe(201)
    expect((await prisma.event.findUniqueOrThrow({ where: { slug: `${S}b` } })).resalePolicy).toBe('UNRESTRICTED')
    expect((await request(app).post('/api/events').set('Cookie', cookie).send({ ...body, slug: `${S}c`, resalePolicy: 'PERCENTAGE_CAP', resaleCapBps: 15_000 })).status).toBe(201)
  })
})
