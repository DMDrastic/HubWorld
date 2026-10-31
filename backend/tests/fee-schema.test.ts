/**
 * The data the fee model needs, before any fee is wired: which region and time zone an event is in, which
 * organizers are founding (admin-only), and where a listing's terms and a ticket's all-in cost are kept.
 *
 * Nothing here changes a fee. It pins that the columns exist with the right defaults (existing rows must
 * read as today's behaviour), that only an admin can mark an organizer as founding, and that nobody can
 * grant it to themselves through any body they control.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { Wallet } from 'xrpl'

const { prisma } = await import('../src/prisma.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')

const app = createApp()
const P = 'feeschema_'
// Event slugs are URLs: lowercase letters, digits and hyphens, so they cannot share the usernames' prefix.
const S = 'feeschema-'
const addr = () => Wallet.generate().classicAddress

async function cleanup() {
  await prisma.organizerApplication.deleteMany({ where: { user: { username: { startsWith: P } } } })
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

async function person(name: string, role: 'USER' | 'ORGANIZER' | 'ADMIN') {
  const user = await prisma.user.create({ data: { username: `${P}${name}`, xrplAddress: addr(), role } })
  const { token } = await createSession(user.id)
  return { id: user.id, username: user.username, cookie: `hubworld_session=${token}` }
}

const future = () => new Date(Date.now() + 30 * 86_400_000).toISOString()
const eventBody = (over: object = {}) => ({
  title: 'Fee Schema Night',
  startsAt: future(),
  ticketCount: 10,
  royaltyBps: 500,
  ...over,
})

describe('where an event is, for fees', () => {
  it('defaults to the pilot: America/St_Lucia and the Caribbean processing region', async () => {
    const org = await person('org1', 'ORGANIZER')
    const res = await request(app).post('/api/events').set('Cookie', org.cookie).send(eventBody({ slug: `${S}one` }))
    expect(res.status).toBe(201)
    const row = await prisma.event.findUniqueOrThrow({ where: { slug: `${S}one` } })
    expect(row.timeZone).toBe('America/St_Lucia')
    expect(row.feeRegion).toBe('CARIBBEAN')
  })

  it('stores a different zone and region when the organizer gives them', async () => {
    const org = await person('org2', 'ORGANIZER')
    const res = await request(app)
      .post('/api/events')
      .set('Cookie', org.cookie)
      .send(eventBody({ slug: `${S}toronto`, timeZone: 'America/Toronto', feeRegion: 'CANADA' }))
    expect(res.status).toBe(201)
    const row = await prisma.event.findUniqueOrThrow({ where: { slug: `${S}toronto` } })
    expect(row).toMatchObject({ timeZone: 'America/Toronto', feeRegion: 'CANADA' })
  })

  it('refuses a time zone that is not real, and a region that is not one of ours, creating nothing', async () => {
    const org = await person('org3', 'ORGANIZER')
    const bad = await request(app).post('/api/events').set('Cookie', org.cookie).send(eventBody({ slug: `${S}bad1`, timeZone: 'Not/AZone' }))
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.body)).toMatch(/timeZone/)
    const worse = await request(app).post('/api/events').set('Cookie', org.cookie).send(eventBody({ slug: `${S}bad2`, feeRegion: 'MARS' }))
    expect(worse.status).toBe(400)
    expect(JSON.stringify(worse.body)).toMatch(/feeRegion/)
    expect(await prisma.event.count({ where: { slug: { in: [`${S}bad1`, `${S}bad2`] } } })).toBe(0)
  })
})

describe('the founding flag (admin-only)', () => {
  it('is off for everyone by default', async () => {
    const org = await person('org4', 'ORGANIZER')
    const row = await prisma.user.findUniqueOrThrow({ where: { id: org.id } })
    expect(row.foundingOrganizer).toBe(false)
    expect(row.foundingGrantedAt).toBeNull()
  })

  it('an admin can mark an organizer as founding, and unmark them', async () => {
    const admin = await person('admin1', 'ADMIN')
    const org = await person('org5', 'ORGANIZER')
    const on = await request(app).post(`/api/admin/organizers/${org.username}/founding`).set('Cookie', admin.cookie).send({ founding: true })
    expect(on.status).toBe(200)
    expect(on.body).toMatchObject({ username: org.username, founding: true })
    const set = await prisma.user.findUniqueOrThrow({ where: { id: org.id } })
    expect(set.foundingOrganizer).toBe(true)
    expect(set.foundingGrantedAt).not.toBeNull()

    const off = await request(app).post(`/api/admin/organizers/${org.username}/founding`).set('Cookie', admin.cookie).send({ founding: false })
    expect(off.status).toBe(200)
    const cleared = await prisma.user.findUniqueOrThrow({ where: { id: org.id } })
    expect(cleared.foundingOrganizer).toBe(false)
    expect(cleared.foundingGrantedAt).toBeNull()
  })

  it('is idempotent: marking twice keeps the first grant time', async () => {
    const admin = await person('admin2', 'ADMIN')
    const org = await person('org6', 'ORGANIZER')
    await request(app).post(`/api/admin/organizers/${org.username}/founding`).set('Cookie', admin.cookie).send({ founding: true })
    const first = (await prisma.user.findUniqueOrThrow({ where: { id: org.id } })).foundingGrantedAt!
    await new Promise((r) => setTimeout(r, 15))
    await request(app).post(`/api/admin/organizers/${org.username}/founding`).set('Cookie', admin.cookie).send({ founding: true })
    const second = (await prisma.user.findUniqueOrThrow({ where: { id: org.id } })).foundingGrantedAt!
    expect(second.getTime()).toBe(first.getTime())
  })

  it('an organizer cannot mark themselves, nor anyone else', async () => {
    const org = await person('org7', 'ORGANIZER')
    const other = await person('org8', 'ORGANIZER')
    for (const target of [org, other]) {
      const res = await request(app).post(`/api/admin/organizers/${target.username}/founding`).set('Cookie', org.cookie).send({ founding: true })
      expect(res.status).toBe(403)
    }
    expect(await prisma.user.count({ where: { username: { startsWith: P }, foundingOrganizer: true } })).toBe(0)
  })

  it('needs a login at all', async () => {
    const org = await person('org9', 'ORGANIZER')
    const res = await request(app).post(`/api/admin/organizers/${org.username}/founding`).send({ founding: true })
    expect(res.status).toBe(401)
  })

  it('only means something for an organizer: an ordinary user cannot be flagged', async () => {
    const admin = await person('admin3', 'ADMIN')
    const plain = await person('user1', 'USER')
    const res = await request(app).post(`/api/admin/organizers/${plain.username}/founding`).set('Cookie', admin.cookie).send({ founding: true })
    expect(res.status).toBe(409)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: plain.id } })).foundingOrganizer).toBe(false)
  })

  it('answers 404 for someone who does not exist, and 400 for a body that is not a yes or no', async () => {
    const admin = await person('admin4', 'ADMIN')
    expect((await request(app).post('/api/admin/organizers/feeschema_nobody/founding').set('Cookie', admin.cookie).send({ founding: true })).status).toBe(404)
    const org = await person('org10', 'ORGANIZER')
    expect((await request(app).post(`/api/admin/organizers/${org.username}/founding`).set('Cookie', admin.cookie).send({ founding: 'yes please' })).status).toBe(400)
  })

  it('cannot be set through the bodies an organizer controls: event creation and applying', async () => {
    const org = await person('org11', 'ORGANIZER')
    // Both requests must actually go through, so that "the flag stayed off" is not just "the request failed".
    const made = await request(app).post('/api/events').set('Cookie', org.cookie).send(eventBody({ slug: `${S}sneak`, foundingOrganizer: true, founding: true }))
    expect(made.status).toBe(201)
    const plain = await person('user2', 'USER')
    const applied = await request(app).post('/api/organizers/apply').set('Cookie', plain.cookie).send({ orgName: 'Sneaky Collective', email: 'sneaky@example.com', pitch: 'A pitch that is comfortably long enough to be accepted.', foundingOrganizer: true })
    expect(applied.status).toBeLessThan(300)
    expect(await prisma.user.count({ where: { username: { startsWith: P }, foundingOrganizer: true } })).toBe(0)
  })
})

describe('where a listing\'s terms and a ticket\'s all-in cost are kept', () => {
  const defaultOf = async (table: string, column: string) =>
    (await prisma.$queryRawUnsafe<Array<{ column_default: string | null; is_nullable: string }>>(
      `SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = '${table}' AND column_name = '${column}'`,
    ))[0]

  it('every existing and new listing reads as today\'s buyer-pays terms unless it says otherwise', async () => {
    const col = await defaultOf('Listing', 'feeModel')
    expect(col?.column_default).toContain('BUYER_PAYS_V1')
    expect(col?.is_nullable).toBe('NO')
  })

  it('a listing\'s fee rate, an auction\'s fee rate and a ticket\'s all-in cost start empty, so older rows are not guessed at', async () => {
    for (const [table, column] of [['Listing', 'feeBps'], ['Auction', 'feeBps'], ['Ticket', 'originalCostMinor'], ['Ticket', 'originalCostCurrency']] as const) {
      const col = await defaultOf(table, column)
      expect(col?.is_nullable, `${table}.${column}`).toBe('YES')
      expect(col?.column_default, `${table}.${column}`).toBeNull()
    }
  })
})
