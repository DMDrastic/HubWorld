/**
 * Door entry by a displayed code, over HTTP.
 *
 * Real Express app, session and database; only the ledger read is faked. What is
 * pinned is every way a code could admit someone it should not (replayed,
 * forged, expired, for another event, made before the ticket was given away,
 * scanned twice at once) and every way it could refuse someone it should admit.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { randomBytes } from 'node:crypto'

const SECRET = 'a-door-secret-that-is-at-least-32-chars-long'
const state = vi.hoisted(() => ({ mode: 'live' as 'live' | 'disabled' }))
const holdsNft = vi.fn<(address: string, nfTokenId: string) => Promise<boolean>>()

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return { ...actual, holdsNft: (...a: Parameters<typeof holdsNft>) => holdsNft(...a) }
})
vi.mock('../src/env.js', async () => {
  const actual = await vi.importActual<typeof import('../src/env.js')>('../src/env.js')
  return {
    ...actual,
    env: { ...actual.env, DOOR_TOKEN_SECRET: SECRET },
    get doorTokenMode() {
      return state.mode
    },
  }
})

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')
const { signDoorToken, verifyDoorToken } = await import('../src/door-token.js')

const app = createApp()
const UTAG = 'dq_'
const STAG = 'dq-'
let uniq = ''
/** An NFTokenID is 64 HEX characters; base36 would be refused by the routes' own validation. */
let hex = ''
let n = 0

type Actor = { id: string; username: string; address: string; token: string }

async function mkUser(name: string, role: 'USER' | 'ORGANIZER' | 'ADMIN' = 'USER'): Promise<Actor> {
  const user = await prisma.user.create({
    data: {
      username: `${UTAG}${name}_${uniq}`.slice(0, 20),
      xrplAddress: `r${UTAG}${name}${uniq}`.padEnd(28, 'x').slice(0, 33),
      role,
    },
  })
  const { token } = await createSession(user.id)
  return { id: user.id, username: user.username, address: user.xrplAddress, token }
}
const as = (a: Actor) => `Bearer ${a.token}`

async function cleanup() {
  const ev = { event: { slug: { startsWith: STAG } } }
  await prisma.redemption.deleteMany({ where: ev })
  await prisma.transfer.deleteMany({ where: { ticket: ev } })
  await prisma.ticket.deleteMany({ where: ev })
  await prisma.eventStaff.deleteMany({ where: ev })
  await prisma.event.deleteMany({
    where: { OR: [{ slug: { startsWith: STAG } }, { organizer: { username: { startsWith: UTAG } } }] },
  })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: UTAG } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: UTAG } } })
}

beforeEach(async () => {
  uniq = Math.random().toString(36).slice(2, 8)
  hex = randomBytes(3).toString('hex').toUpperCase()
  n = 0
  state.mode = 'live'
  await cleanup()
  holdsNft.mockReset()
  holdsNft.mockResolvedValue(true)
})
afterEach(cleanup)
afterAll(async () => {
  await prisma.$disconnect()
})

async function mkEvent(org: Actor, over: { doorMode?: 'QR' | 'SIGNATURE'; status?: 'PUBLISHED' | 'CANCELLED'; slug?: string } = {}) {
  n += 1
  return prisma.event.create({
    data: {
      network: NETWORK,
      slug: over.slug ?? `${STAG}${uniq}${n}`,
      title: 'Door QR Test',
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: org.id,
      nftTaxon: 74_000 + n,
      royaltyBps: 500,
      platformBps: 250,
      ticketCount: 10,
      status: over.status ?? 'PUBLISHED',
      doorMode: over.doorMode ?? 'QR',
    },
  })
}

async function mkTicket(eventId: string, owner: Actor | null, status: 'MINTED' | 'REDEEMED' | 'BURNED' = 'MINTED') {
  n += 1
  return prisma.ticket.create({
    data: {
      network: NETWORK,
      nfTokenId: `${n}${hex}${'0'.repeat(64)}`.slice(0, 64),
      eventId,
      ownerId: owner?.id ?? null,
      ownerAddress: owner?.address ?? null,
      status,
    },
  })
}

async function world(over: Parameters<typeof mkEvent>[1] = {}) {
  const org = await mkUser('org', 'ORGANIZER')
  const holder = await mkUser('holder')
  const event = await mkEvent(org, over)
  const ticket = await mkTicket(event.id, holder)
  return { org, holder, event, ticket }
}

const getCode = (holder: Actor, nfTokenId: string) =>
  request(app).post(`/api/tickets/${nfTokenId}/door-token`).set('Authorization', as(holder))
const scan = (staff: Actor, slug: string, token: string) =>
  request(app).post(`/api/events/${slug}/checkin/scan`).set('Authorization', as(staff)).send({ token })
/** A code the way the page would have fetched it. */
async function codeFor(holder: Actor, nfTokenId: string) {
  const res = await getCode(holder, nfTokenId)
  expect(res.status).toBe(200)
  return res.body.token as string
}

describe('POST /tickets/:nfTokenId/door-token', () => {
  it('gives the holder a code that names their ticket, their event and them, and says when to refresh', async () => {
    const { holder, event, ticket } = await world()

    const res = await getCode(holder, ticket.nfTokenId)

    expect(res.status).toBe(200)
    expect(res.body.refreshInSeconds).toBe(30)
    expect(res.body.expiresInSeconds).toBe(45)
    const check = verifyDoorToken(res.body.token, { secret: SECRET })
    expect(check.ok && check.claims).toMatchObject({ t: ticket.nfTokenId, e: event.id, u: holder.id })
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('refuses someone else\'s ticket, and a ticket the LEDGER says they no longer hold', async () => {
    const { holder, ticket } = await world()
    const stranger = await mkUser('stranger')
    expect((await getCode(stranger, ticket.nfTokenId)).status).toBe(403)

    holdsNft.mockResolvedValue(false)
    const res = await getCode(holder, ticket.nfTokenId)
    expect(res.status).toBe(403)
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })
    expect(row.ownerId).toBeNull()
  })

  it('still issues a code when the ledger cannot be read (the door checks again)', async () => {
    const { holder, ticket } = await world()
    holdsNft.mockRejectedValue(new Error('node down'))

    expect((await getCode(holder, ticket.nfTokenId)).status).toBe(200)
  })

  it('refuses a used, burned, or cancelled-event ticket', async () => {
    const w = await world()
    for (const status of ['REDEEMED', 'BURNED'] as const) {
      const t = await mkTicket(w.event.id, w.holder, status)
      expect((await getCode(w.holder, t.nfTokenId)).status).toBe(409)
    }
    const cancelled = await mkEvent(w.org, { status: 'CANCELLED' })
    const t = await mkTicket(cancelled.id, w.holder)
    expect((await getCode(w.holder, t.nfTokenId)).status).toBe(409)
  })

  it('says so, with a code, when the event checks people in by Xaman signature', async () => {
    const { holder, ticket } = await world({ doorMode: 'SIGNATURE' })

    const res = await getCode(holder, ticket.nfTokenId)

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('DOOR_MODE_SIGNATURE')
  })

  it('needs a session and a well-formed ticket id, and is off when the server cannot sign', async () => {
    const { holder, ticket } = await world()
    expect((await request(app).post(`/api/tickets/${ticket.nfTokenId}/door-token`)).status).toBe(401)
    expect((await request(app).post('/api/tickets/nope/door-token').set('Authorization', as(holder))).status).toBe(400)

    state.mode = 'disabled'
    const res = await getCode(holder, ticket.nfTokenId)
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('DOOR_CODES_OFF')
  })
})

describe('POST /events/:slug/checkin/scan', () => {
  it('admits the holder, marks the ticket used, and records the audit row as a QR entry', async () => {
    const { org, holder, event, ticket } = await world()
    const token = await codeFor(holder, ticket.nfTokenId)

    const res = await scan(org, event.slug, token)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ state: 'redeemed', holder: `@${holder.username}` })
    expect(res.body.ticket.nfTokenId).toBe(ticket.nfTokenId)
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('REDEEMED')
    const row = await prisma.redemption.findUniqueOrThrow({ where: { id: res.body.checkInId } })
    expect(row).toMatchObject({ method: 'QR', status: 'REDEEMED', staffId: org.id, holderId: holder.id, ticketId: ticket.id })
  })

  it('tells the second scanner "already checked in": a code has no memory, the ticket does', async () => {
    const { org, holder, event, ticket } = await world()
    const token = await codeFor(holder, ticket.nfTokenId)

    expect((await scan(org, event.slug, token)).body.state).toBe('redeemed')
    const again = await scan(org, event.slug, token)

    expect(again.body.state).toBe('already_used')
    expect(await prisma.redemption.count({ where: { eventId: event.id, status: 'REDEEMED' } })).toBe(1)
  })

  it('admits exactly one of two scanners reading the same code at the same moment', async () => {
    const { org, holder, event, ticket } = await world()
    const token = await codeFor(holder, ticket.nfTokenId)
    holdsNft.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 40))
      return true
    })

    const [a, b] = await Promise.all([scan(org, event.slug, token), scan(org, event.slug, token)])

    expect([a.body.state, b.body.state].sort()).toEqual(['already_used', 'redeemed'])
  })

  it('refuses an expired code, saying so, and admits nothing', async () => {
    const { org, holder, event, ticket } = await world()
    const { token } = signDoorToken({ t: ticket.nfTokenId, e: event.id, u: holder.id }, { secret: SECRET, now: Date.now() - 60_000 })

    const res = await scan(org, event.slug, token)

    expect(res.body.state).toBe('expired')
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('MINTED')
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: res.body.checkInId } })).status).toBe('EXPIRED')
  })

  it('refuses a forged or foreign code, and still leaves an audit row for the scan', async () => {
    const { org, holder, event, ticket } = await world()
    const { token } = signDoorToken({ t: ticket.nfTokenId, e: event.id, u: holder.id }, { secret: 'not-the-servers-secret-but-32-characters!!' })

    for (const junk of [token, 'https://example.com', 'HWD1.x.y']) {
      const res = await scan(org, event.slug, junk)
      expect(res.body.state).toBe('rejected')
      expect(res.body.reason).toMatch(/not a hubworld ticket code/i)
    }
    expect(await prisma.redemption.count({ where: { eventId: event.id, status: 'REJECTED', method: 'QR' } })).toBe(3)
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('MINTED')
  })

  it('refuses a perfectly good code made for a different event', async () => {
    const { org, holder, ticket } = await world()
    const other = await mkEvent(org)
    const token = await codeFor(holder, ticket.nfTokenId)

    const res = await scan(org, other.slug, token)

    expect(res.body.state).toBe('no_ticket')
    expect(res.body.reason).toMatch(/different event/i)
  })

  it('refuses a code made BEFORE the ticket was given away (the ledger is read again at the door)', async () => {
    const { org, holder, event, ticket } = await world()
    const token = await codeFor(holder, ticket.nfTokenId)
    // The holder gifts it in Xaman, and our cache and the ledger now both say so.
    const friend = await mkUser('friend')
    await prisma.ticket.update({ where: { id: ticket.id }, data: { ownerId: friend.id, ownerAddress: friend.address } })

    expect((await scan(org, event.slug, token)).body.state).toBe('no_ticket')

    // And when only the ledger knows (our cache is stale):
    await prisma.ticket.update({ where: { id: ticket.id }, data: { ownerId: holder.id, ownerAddress: holder.address } })
    holdsNft.mockResolvedValue(false)
    expect((await scan(org, event.slug, token)).body.state).toBe('no_ticket')
  })

  it('admits the ONE ticket the code names, not another the holder also has', async () => {
    const { org, holder, event, ticket } = await world()
    const second = await mkTicket(event.id, holder)
    const token = await codeFor(holder, second.nfTokenId)

    const res = await scan(org, event.slug, token)

    expect(res.body.ticket.nfTokenId).toBe(second.nfTokenId)
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('REDEEMED')
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('MINTED')
  })

  it('is for door staff: the organizer, added staff, and an admin, but not a stranger', async () => {
    const { org, holder, event, ticket } = await world()
    const stranger = await mkUser('stranger')
    const volunteer = await mkUser('vol')
    await prisma.eventStaff.create({ data: { eventId: event.id, userId: volunteer.id, addedById: org.id } })
    const token = await codeFor(holder, ticket.nfTokenId)

    expect((await scan(stranger, event.slug, token)).status).toBe(403)
    expect((await scan(volunteer, event.slug, token)).body.state).toBe('redeemed')
  })

  it('answers 409 on a signature-mode or cancelled event, 401 without a session, 503 when off', async () => {
    const { org, holder, event, ticket } = await world()
    const token = await codeFor(holder, ticket.nfTokenId)
    const sig = await mkEvent(org, { doorMode: 'SIGNATURE' })
    const cancelled = await mkEvent(org, { status: 'CANCELLED' })

    const wrong = await scan(org, sig.slug, token)
    expect(wrong.status).toBe(409)
    expect(wrong.body.code).toBe('DOOR_MODE_SIGNATURE')
    expect((await scan(org, cancelled.slug, token)).status).toBe(409)
    expect((await request(app).post(`/api/events/${event.slug}/checkin/scan`).send({ token })).status).toBe(401)

    state.mode = 'disabled'
    expect((await scan(org, event.slug, token)).status).toBe(503)
  })
})

describe('POST /events/:slug/door-mode', () => {
  const setMode = (actor: Actor, slug: string, mode: string) =>
    request(app).post(`/api/events/${slug}/door-mode`).set('Authorization', as(actor)).send({ mode })

  it('lets the organizer switch the door either way, and nobody else', async () => {
    const { org, event } = await world()
    const other = await mkUser('other', 'ORGANIZER')
    const admin = await mkUser('admin', 'ADMIN')

    expect((await setMode(org, event.slug, 'SIGNATURE')).body.doorMode).toBe('SIGNATURE')
    expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).doorMode).toBe('SIGNATURE')
    expect((await setMode(org, event.slug, 'QR')).body.doorMode).toBe('QR')
    expect((await setMode(other, event.slug, 'SIGNATURE')).status).toBe(403)
    expect((await setMode(admin, event.slug, 'SIGNATURE')).status).toBe(200)
    expect((await setMode(org, event.slug, 'bogus')).status).toBe(400)
  })

  it('will not switch an event into a mode this server cannot run', async () => {
    const { org, event } = await world({ doorMode: 'SIGNATURE' })
    state.mode = 'disabled'

    expect((await setMode(org, event.slug, 'QR')).status).toBe(503)
    expect((await setMode(org, event.slug, 'SIGNATURE')).status).toBe(200)
  })
})

describe('POST /events chooses the door mode', () => {
  const body = (extra: Record<string, unknown> = {}) => ({
    title: `Door Mode ${uniq}`,
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    ticketCount: 10,
    royaltyBps: 500,
    slug: `${STAG}create-${uniq}`,
    ...extra,
  })
  const create = (org: Actor, extra: Record<string, unknown> = {}) =>
    request(app).post('/api/events').set('Authorization', as(org)).send(body(extra))

  it('defaults to the QR door where the server can sign codes, and to Xaman where it cannot', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    expect((await create(org)).body.doorMode).toBe('QR')

    await prisma.event.deleteMany({ where: { slug: `${STAG}create-${uniq}` } })
    state.mode = 'disabled'
    expect((await create(org)).body.doorMode).toBe('SIGNATURE')
  })

  it('honours an explicit choice, but not a QR door the server cannot run', async () => {
    const org = await mkUser('org', 'ORGANIZER')
    expect((await create(org, { doorMode: 'SIGNATURE' })).body.doorMode).toBe('SIGNATURE')

    await prisma.event.deleteMany({ where: { slug: `${STAG}create-${uniq}` } })
    state.mode = 'disabled'
    const res = await create(org, { doorMode: 'QR' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('DOOR_CODES_OFF')
  })
})

describe('GET /policy says whether door codes exist', () => {
  it('is true where this server can sign codes and false where it cannot, so the form offers only what works', async () => {
    expect((await request(app).get('/api/policy')).body.doorCodes).toBe(true)

    state.mode = 'disabled'
    expect((await request(app).get('/api/policy')).body.doorCodes).toBe(false)
  })
})
