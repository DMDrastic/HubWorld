/**
 * Starting, watching, cancelling and resuming a bulk mint, over HTTP. Real
 * Express app, session and database; the ledger reads and Xaman are faked.
 *
 * Everything refusable must be refused BEFORE a job exists: a run that dies
 * half-way has already minted tickets that cannot be taken back.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

const DELEGATE = 'rBRDelegateFixture0000000000'

const readPermission = vi.fn<(...a: unknown[]) => Promise<'granted' | 'absent' | 'unknown'>>()
const delegationAvailable = vi.fn<() => Promise<boolean>>()
const accountFunding = vi.fn<(a: string) => Promise<{ spendableDrops: bigint; reserveIncDrops: bigint }>>()

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return {
    ...actual,
    accountFunding: (a: string) => accountFunding(a),
    delegateAddress: () => DELEGATE,
  }
})
vi.mock('../src/delegation.js', async () => {
  const actual = await vi.importActual<typeof import('../src/delegation.js')>('../src/delegation.js')
  return {
    ...actual,
    delegationAvailable: () => delegationAvailable(),
    readPermission: (...a: unknown[]) => readPermission(...a),
  }
})
vi.mock('../src/env.js', async () => {
  const actual = await vi.importActual<typeof import('../src/env.js')>('../src/env.js')
  return { ...actual, delegateMode: 'live' as const }
})

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')

const app = createApp()
const UTAG = 'br_'
const XRP = 1_000_000n

type Actor = { id: string; username: string; address: string; token: string }
let uniq = ''

async function mkUser(name: string, role: 'USER' | 'ORGANIZER' = 'ORGANIZER'): Promise<Actor> {
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

async function mkEvent(organizer: Actor, ticketCount = 1000) {
  return prisma.event.create({
    data: {
      network: NETWORK,
      slug: `br-${uniq}`,
      title: 'Bulk Route Test',
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: organizer.id,
      nftTaxon: 72_000 + Math.floor(Math.random() * 900),
      royaltyBps: 500,
      platformBps: 250,
      ticketCount,
      status: 'PUBLISHED',
    },
  })
}

async function cleanup() {
  const ev = { event: { slug: { startsWith: 'br-' } } }
  await prisma.mintRequest.deleteMany({ where: ev })
  await prisma.transfer.deleteMany({ where: { ticket: ev } })
  await prisma.ticket.deleteMany({ where: ev })
  await prisma.mintJob.deleteMany({ where: ev })
  await prisma.event.deleteMany({ where: { slug: { startsWith: 'br-' } } })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: UTAG } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: UTAG } } })
}

beforeEach(async () => {
  uniq = Math.random().toString(36).slice(2, 8)
  await cleanup()
  readPermission.mockReset()
  readPermission.mockResolvedValue('granted')
  delegationAvailable.mockReset()
  delegationAvailable.mockResolvedValue(true)
  accountFunding.mockReset()
  accountFunding.mockResolvedValue({ spendableDrops: 1_000n * XRP, reserveIncDrops: 200_000n })
})
afterEach(cleanup)
afterAll(async () => {
  await prisma.$disconnect()
})

const start = (actor: Actor, slug: string, count: number) =>
  request(app).post(`/api/events/${slug}/mint/bulk`).set('Authorization', as(actor)).send({ count })

describe('POST /events/:slug/mint/bulk', () => {
  it('starts a run, naming the delegate the grant named', async () => {
    const org = await mkUser('org')
    const event = await mkEvent(org)

    const res = await start(org, event.slug, 200)

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ status: 'QUEUED', total: 200, minted: 0, eventSlug: event.slug })
    const job = await prisma.mintJob.findFirstOrThrow({ where: { eventId: event.id } })
    expect(job).toMatchObject({
      delegateAddress: DELEGATE,
      organizerAddress: org.address,
      organizerId: org.id,
      network: NETWORK,
    })
  })

  it('needs a session, and an organizer', async () => {
    const org = await mkUser('org')
    const event = await mkEvent(org)
    expect((await request(app).post(`/api/events/${event.slug}/mint/bulk`).send({ count: 5 })).status).toBe(401)

    const plain = await mkUser('plain', 'USER')
    expect((await start(plain, event.slug, 5)).status).toBe(403)
  })

  it('only mints an event as ITS organizer — never another organizer\'s', async () => {
    const owner = await mkUser('owner')
    const intruder = await mkUser('intruder')
    const event = await mkEvent(owner)

    const res = await start(intruder, event.slug, 5)

    expect(res.status).toBe(403)
    expect(await prisma.mintJob.count({ where: { eventId: event.id } })).toBe(0)
  })

  it('rejects nonsense counts', async () => {
    const org = await mkUser('org')
    const event = await mkEvent(org)
    for (const count of [0, -5, 1.5, 5001]) {
      expect((await start(org, event.slug, count)).status).toBe(400)
    }
  })

  it('refuses without a grant, from the LEDGER rather than from our table', async () => {
    const org = await mkUser('org')
    const event = await mkEvent(org)
    readPermission.mockResolvedValue('absent')

    const res = await start(org, event.slug, 10)

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('NO_DELEGATION')
    expect(await prisma.mintJob.count({ where: { eventId: event.id } })).toBe(0)
  })

  it('does not treat an unreadable ledger as a missing grant', async () => {
    const org = await mkUser('org')
    const event = await mkEvent(org)
    readPermission.mockResolvedValue('unknown')

    const res = await start(org, event.slug, 10)

    expect(res.status).toBe(503)
    expect(res.body.code).toBeUndefined()
  })

  it('refuses when the organizer cannot carry the reserve, and says how much', async () => {
    const org = await mkUser('org')
    const event = await mkEvent(org)
    // 1000 tickets needs 47 pages x 0.2 = 9.4 XRP (41 pages measured, with margin).
    accountFunding.mockResolvedValue({ spendableDrops: 5n * XRP, reserveIncDrops: 200_000n })

    const res = await start(org, event.slug, 1000)

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('INSUFFICIENT_RESERVE')
    expect(res.body.error).toMatch(/9\.4 XRP/)
    expect(res.body.error).toMatch(/5 XRP spendable/)
  })

  it('does not let an unreadable balance block a legitimate run', async () => {
    const org = await mkUser('org')
    const event = await mkEvent(org)
    accountFunding.mockRejectedValue(new Error('node down'))

    expect((await start(org, event.slug, 10)).status).toBe(201)
  })

  it('refuses where the amendment is unusable', async () => {
    const org = await mkUser('org')
    const event = await mkEvent(org)
    delegationAvailable.mockResolvedValue(false)

    expect((await start(org, event.slug, 10)).status).toBe(503)
  })

  it('allows one open run per event', async () => {
    const org = await mkUser('org')
    const event = await mkEvent(org)
    expect((await start(org, event.slug, 10)).status).toBe(201)

    const second = await start(org, event.slug, 10)
    expect(second.status).toBe(409)
    expect(second.body.error).toMatch(/already open/)
  })

  it('two simultaneous starts create exactly one run', async () => {
    const org = await mkUser('org')
    const event = await mkEvent(org)

    const [a, b] = await Promise.all([start(org, event.slug, 10), start(org, event.slug, 10)])

    expect([a.status, b.status].sort()).toEqual([201, 409])
    expect(await prisma.mintJob.count({ where: { eventId: event.id } })).toBe(1)
  })

  it('counts existing tickets, pending mints AND unfinished runs against the size', async () => {
    const org = await mkUser('org')
    const event = await mkEvent(org, 100)
    for (let i = 0; i < 40; i++) {
      await prisma.ticket.create({
        data: {
          nfTokenId: `BR${uniq}F${String(i).padStart(3, "0")}`.padEnd(64, '0').toUpperCase(),
          network: NETWORK,
          eventId: event.id,
          ownerId: org.id,
          ownerAddress: org.address,
          status: 'MINTED',
        },
      })
    }
    await prisma.mintRequest.create({
      data: {
        payloadUuid: '00000000-0000-4000-8000-0000000000aa',
        network: NETWORK,
        eventId: event.id,
        requestedById: org.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    // 40 exist + 1 pending = 41 committed, 59 left.
    expect((await start(org, event.slug, 60)).status).toBe(409)
    expect((await start(org, event.slug, 59)).status).toBe(201)
  })
})

describe('the single-ticket mint beside a bulk run', () => {
  it('sees the run\'s unfinished remainder, so the event cannot be overshot', async () => {
    const org = await mkUser('org')
    const event = await mkEvent(org, 10)
    expect((await start(org, event.slug, 10)).status).toBe(201)

    const res = await request(app).post(`/api/events/${event.slug}/mint`).set('Authorization', as(org)).send({})

    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/minted or pending/)
  })
})

describe('managing a run', () => {
  async function mkRun(org: Actor, overrides: object = {}) {
    const event = await mkEvent(org)
    return prisma.mintJob.create({
      data: {
        network: NETWORK,
        eventId: event.id,
        organizerId: org.id,
        organizerAddress: org.address,
        delegateAddress: DELEGATE,
        total: 100,
        ...overrides,
      },
    })
  }

  it('shows progress to its organizer only', async () => {
    const org = await mkUser('org')
    const other = await mkUser('other')
    const job = await mkRun(org, { minted: 40, status: 'RUNNING' })

    const res = await request(app).get(`/api/mint/jobs/${job.id}`).set('Authorization', as(org))
    expect(res.body).toMatchObject({ status: 'RUNNING', total: 100, minted: 40 })
    expect((await request(app).get(`/api/mint/jobs/${job.id}`).set('Authorization', as(other))).status).toBe(403)
    expect((await request(app).get(`/api/mint/jobs/00000000-0000-4000-8000-000000000000`).set('Authorization', as(org))).status).toBe(404)
  })

  it('cancels a run with nothing in flight at once', async () => {
    const org = await mkUser('org')
    const job = await mkRun(org, { status: 'PAUSED' })

    const res = await request(app).post(`/api/mint/jobs/${job.id}/cancel`).set('Authorization', as(org))

    expect(res.body.status).toBe('CANCELLED')
    expect(res.body.finishedAt).not.toBeNull()
  })

  it('only ASKS a run with a wave in flight to stop, because that wave will land', async () => {
    const org = await mkUser('org')
    const job = await mkRun(org, {
      status: 'RUNNING',
      pendingWave: { hashes: ['AA'], firstSequence: 1, lastLedgerSequence: 99 },
    })

    const res = await request(app).post(`/api/mint/jobs/${job.id}/cancel`).set('Authorization', as(org))

    // Still RUNNING: the worker settles the wave, records its tickets, then stops.
    expect(res.body).toMatchObject({ status: 'RUNNING', cancelRequested: true })
  })

  it('cannot cancel or resume what is already finished', async () => {
    const org = await mkUser('org')
    const job = await mkRun(org, { status: 'DONE' })
    expect((await request(app).post(`/api/mint/jobs/${job.id}/cancel`).set('Authorization', as(org))).status).toBe(409)
    expect((await request(app).post(`/api/mint/jobs/${job.id}/resume`).set('Authorization', as(org))).status).toBe(409)
  })

  it('resumes only a paused run, clearing the reason', async () => {
    const org = await mkUser('org')
    const job = await mkRun(org, { status: 'PAUSED', statusReason: 'Add XRP and resume' })

    const res = await request(app).post(`/api/mint/jobs/${job.id}/resume`).set('Authorization', as(org))

    expect(res.body).toMatchObject({ status: 'QUEUED', statusReason: null })
  })

  it('lists recent runs for the event owner only', async () => {
    const org = await mkUser('org')
    const other = await mkUser('other')
    const job = await mkRun(org)
    const event = await prisma.event.findUniqueOrThrow({ where: { id: job.eventId } })

    const res = await request(app).get(`/api/events/${event.slug}/mint/jobs`).set('Authorization', as(org))
    expect(res.body.jobs).toHaveLength(1)
    expect((await request(app).get(`/api/events/${event.slug}/mint/jobs`).set('Authorization', as(other))).status).toBe(403)
  })
})

describe('GET /events/:slug/mint/estimate', () => {
  const estimate = (actor: Actor, slug: string, count: number | string) =>
    request(app).get(`/api/events/${slug}/mint/estimate?count=${count}`).set('Authorization', as(actor))

  it('quotes the same reserve the start route enforces, and what the organizer has', async () => {
    const org = await mkUser('org')
    const event = await mkEvent(org)
    accountFunding.mockResolvedValue({ spendableDrops: 15n * XRP, reserveIncDrops: 200_000n })

    const res = await estimate(org, event.slug, 1000)

    expect(res.status).toBe(200)
    // 47 pages x 0.2 XRP, as the start route's refusal states it.
    expect(res.body).toMatchObject({ count: 1000, reserveDrops: '9400000', spendableDrops: '15000000', enough: true })
    expect(res.body.seconds).toBeGreaterThan(600)
    expect(res.body.seconds).toBeLessThan(1000)
  })

  it('says "not enough" at the very figure the start route refuses at (positive control)', async () => {
    const org = await mkUser('org')
    const event = await mkEvent(org)
    accountFunding.mockResolvedValue({ spendableDrops: 5n * XRP, reserveIncDrops: 200_000n })

    const quoted = await estimate(org, event.slug, 1000)
    const started = await start(org, event.slug, 1000)

    expect(quoted.body.enough).toBe(false)
    expect(started.status).toBe(409)
    // And exactly enough is enough, on both.
    accountFunding.mockResolvedValue({ spendableDrops: 9_400_000n, reserveIncDrops: 200_000n })
    expect((await estimate(org, event.slug, 1000)).body.enough).toBe(true)
    expect((await start(org, event.slug, 1000)).status).toBe(201)
  })

  it('says "unknown", never "nothing", when the ledger cannot be read', async () => {
    const org = await mkUser('org')
    const event = await mkEvent(org)
    accountFunding.mockRejectedValue(new Error('node down'))

    const res = await estimate(org, event.slug, 1000)

    expect(res.status).toBe(200)
    expect(res.body.spendableDrops).toBeNull()
    expect(res.body.enough).toBeNull()
    expect(res.body.reserveDrops).toBe('9400000')
  })

  it('is the event organizer\'s alone, and validates the count', async () => {
    const org = await mkUser('org')
    const other = await mkUser('other')
    const event = await mkEvent(org)

    expect((await request(app).get(`/api/events/${event.slug}/mint/estimate?count=10`)).status).toBe(401)
    expect((await estimate(other, event.slug, 10)).status).toBe(403)
    expect((await estimate(org, event.slug, 0)).status).toBe(400)
    expect((await estimate(org, event.slug, 'lots')).status).toBe(400)
    expect((await estimate(org, event.slug, 5001)).status).toBe(400)
    expect((await estimate(org, 'no-such-event', 10)).status).toBe(404)
  })
})

describe('the job view says why a queued run is waiting', () => {
  it('names a fee wait, and only a queued run waits', async () => {
    const org = await mkUser('org')
    const event = await mkEvent(org)
    const job = await prisma.mintJob.create({
      data: {
        network: NETWORK, eventId: event.id, organizerId: org.id, organizerAddress: org.address, delegateAddress: DELEGATE, total: 10,
        status: 'QUEUED', statusReason: 'Network fees are high right now (6266 drops per ticket); waiting for them to fall',
      },
    })

    const queued = await request(app).get(`/api/mint/jobs/${job.id}`).set('Authorization', as(org))
    expect(queued.body.waiting).toBe('fees')

    await prisma.mintJob.update({ where: { id: job.id }, data: { status: 'PAUSED' } })
    const paused = await request(app).get(`/api/mint/jobs/${job.id}`).set('Authorization', as(org))
    expect(paused.body.waiting).toBeNull()
  })
})
