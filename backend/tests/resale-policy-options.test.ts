/**
 * Which resale policies an organizer may pick for a NEW event, with the new fee model ON.
 *
 * The resale cap is now the lower of the organizer's policy and what the buyer paid, so a policy that
 * allows more than was paid (UNRESTRICTED, a percentage above 100%, a fixed cap above the price) promises
 * the organizer something that will not happen. For new events those options are refused and the default is
 * the face-value-only policy. The code paths and every existing event stay as they were, and one setting
 * (ALLOW_LOOSE_RESALE_POLICIES) turns them back on.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.FEE_MODEL = 'v2'
})

import request from 'supertest'

const { prisma } = await import('../src/prisma.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')
const { Wallet } = await import('xrpl')

const app = createApp()
const P = 'rpopt_'
const S = 'rpopt-'

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

async function organizer() {
  const u = await prisma.user.create({ data: { username: `${P}org`, xrplAddress: Wallet.generate().classicAddress, role: 'ORGANIZER' } })
  const { token } = await createSession(u.id)
  return `hubworld_session=${token}`
}

let n = 0
const make = async (cookie: string, over: object = {}) => {
  n += 1
  return request(app)
    .post('/api/events')
    .set('Cookie', cookie)
    .send({
      title: 'Options Night',
      slug: `${S}${n}-${Date.now().toString(36)}`,
      startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      ticketCount: 10,
      royaltyBps: 500,
      ...over,
    })
}

describe('with the new fee model on', () => {
  it('the policy endpoint says so, and that loose resale policies are off', async () => {
    const res = await request(app).get('/api/policy')
    expect(res.body).toMatchObject({ feeModel: 'v2', looseResalePolicies: false })
  })

  it('an event with no policy named gets face value only, not unrestricted', async () => {
    const cookie = await organizer()
    const res = await make(cookie)
    expect(res.status).toBe(201)
    const row = await prisma.event.findFirstOrThrow({ where: { slug: res.body.slug ?? res.body.event?.slug } })
    expect(row.resalePolicy).toBe('FACE_VALUE_ONLY')
  })

  it('refuses UNRESTRICTED, naming the field and the reason', async () => {
    const cookie = await organizer()
    const res = await make(cookie, { resalePolicy: 'UNRESTRICTED' })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toMatch(/resalePolicy/)
    expect(JSON.stringify(res.body)).toMatch(/what the buyer paid/i)
  })

  it('refuses a percentage cap above 100%, and allows 100% or less', async () => {
    const cookie = await organizer()
    expect((await make(cookie, { resalePolicy: 'PERCENTAGE_CAP', resaleCapBps: 12_000 })).status).toBe(400)
    expect((await make(cookie, { resalePolicy: 'PERCENTAGE_CAP', resaleCapBps: 10_001 })).status).toBe(400)
    expect((await make(cookie, { resalePolicy: 'PERCENTAGE_CAP', resaleCapBps: 10_000 })).status).toBe(201)
    expect((await make(cookie, { resalePolicy: 'PERCENTAGE_CAP', resaleCapBps: 8_000 })).status).toBe(201)
  })

  it('refuses a fixed cap above the ticket price, and allows one at or below it', async () => {
    const cookie = await organizer()
    const price = (20n * 1_000_000n).toString()
    expect((await make(cookie, { resalePolicy: 'FIXED_CAP', resaleCapDrops: (20n * 1_000_000n + 1n).toString(), primaryPriceDrops: price })).status).toBe(400)
    expect((await make(cookie, { resalePolicy: 'FIXED_CAP', resaleCapDrops: price, primaryPriceDrops: price })).status).toBe(201)
    expect((await make(cookie, { resalePolicy: 'FIXED_CAP', resaleCapDrops: (10n * 1_000_000n).toString(), primaryPriceDrops: price })).status).toBe(201)
  })

  it('still allows face value only and disabled', async () => {
    const cookie = await organizer()
    expect((await make(cookie, { resalePolicy: 'FACE_VALUE_ONLY' })).status).toBe(201)
    expect((await make(cookie, { resalePolicy: 'DISABLED' })).status).toBe(201)
  })

  it('leaves events that already exist exactly as they are', async () => {
    const cookie = await organizer()
    const org = await prisma.user.findFirstOrThrow({ where: { username: `${P}org` } })
    const old = await prisma.event.create({
      data: { network: 'TESTNET', slug: `${S}old`, title: 'Old', startsAt: new Date(Date.now() + 86_400_000), organizerId: org.id, nftTaxon: 91_001, royaltyBps: 500, platformBps: 250, ticketCount: 5, status: 'PUBLISHED', resalePolicy: 'UNRESTRICTED' },
    })
    expect(cookie).toBeTruthy()
    expect((await prisma.event.findUniqueOrThrow({ where: { id: old.id } })).resalePolicy).toBe('UNRESTRICTED')
  })
})
