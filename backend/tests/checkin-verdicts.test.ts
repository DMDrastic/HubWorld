/**
 * What door check-in decides once the attendee has signed, over HTTP.
 *
 * `GET /checkin/:uuid` is where an NFT becomes admission, and until now nothing
 * pinned its verdicts: the authorization suite covers who may START a check-in,
 * not what the answer is. These tests pin the behaviour as it stands BEFORE the
 * admit logic is shared with a second entry path (a scanned code), so that the
 * extraction cannot change a verdict without a test saying so.
 *
 * Real Express app, session and database. Only the network is faked: the Xaman
 * payload state, and the two ledger reads. A Redemption row is written directly
 * rather than through POST /checkin, because the thing under test is what the
 * poll concludes from a payload state, and creating payloads is not.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { randomUUID } from 'node:crypto'

type Payload = { signed?: boolean; cancelled?: boolean; expired?: boolean; account?: string } | null | 'unavailable'

const holdsNft = vi.fn<(address: string, nfTokenId: string) => Promise<boolean>>()
const tryGetPayload = vi.fn<(uuid: string) => Promise<Payload>>()

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return { ...actual, holdsNft: (...a: Parameters<typeof holdsNft>) => holdsNft(...a) }
})
vi.mock('../src/xaman.js', async () => {
  const actual = await vi.importActual<typeof import('../src/xaman.js')>('../src/xaman.js')
  return { ...actual, tryGetPayload: (u: string) => tryGetPayload(u) }
})

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')

const app = createApp()
const UTAG = 'cv_'
const STAG = 'cv-'
let uniq = ''
let n = 0

type Actor = { id: string; username: string; address: string; token: string }

async function mkUser(name: string, role: 'USER' | 'ORGANIZER' = 'USER'): Promise<Actor> {
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
  await prisma.event.deleteMany({ where: { slug: { startsWith: STAG } } })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: UTAG } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: UTAG } } })
}

beforeEach(async () => {
  uniq = Math.random().toString(36).slice(2, 8)
  n = 0
  await cleanup()
  holdsNft.mockReset()
  holdsNft.mockResolvedValue(true)
  tryGetPayload.mockReset()
})
afterEach(cleanup)
afterAll(async () => {
  await prisma.$disconnect()
})

async function world() {
  const org = await mkUser('org', 'ORGANIZER')
  const holder = await mkUser('holder')
  const event = await prisma.event.create({
    data: {
      network: NETWORK,
      slug: `${STAG}${uniq}`,
      title: 'Verdict Test',
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: org.id,
      nftTaxon: 73_000,
      royaltyBps: 500,
      platformBps: 250,
      ticketCount: 10,
      status: 'PUBLISHED',
    },
  })
  return { org, holder, event }
}

async function mkTicket(eventId: string, owner: Actor | null, status: 'MINTED' | 'REDEEMED' = 'MINTED') {
  n += 1
  return prisma.ticket.create({
    data: {
      network: NETWORK,
      nfTokenId: `${n}${uniq}${'0'.repeat(64)}`.slice(0, 64).toUpperCase(),
      eventId,
      ownerId: owner?.id ?? null,
      ownerAddress: owner?.address ?? null,
      status,
    },
  })
}

async function mkRedemption(eventId: string, staff: Actor, over: { expiresAt?: Date } = {}) {
  return prisma.redemption.create({
    data: {
      payloadUuid: randomUUID(),
      network: NETWORK,
      eventId,
      staffId: staff.id,
      expiresAt: over.expiresAt ?? new Date(Date.now() + 600_000),
    },
  })
}

const signedBy = (a: Actor): Payload => ({ signed: true, account: a.address })
const poll = (staff: Actor, uuid: string) => request(app).get(`/api/checkin/${uuid}`).set('Authorization', as(staff))

describe('GET /checkin/:uuid, once the attendee has signed', () => {
  it('admits a holder whose ticket the ledger confirms, and records who admitted them', async () => {
    const { org, holder, event } = await world()
    const ticket = await mkTicket(event.id, holder)
    const r = await mkRedemption(event.id, org)
    tryGetPayload.mockResolvedValue(signedBy(holder))

    const res = await poll(org, r.payloadUuid)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ state: 'redeemed', holder: `@${holder.username}` })
    expect(res.body.ticket.nfTokenId).toBe(ticket.nfTokenId)
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('REDEEMED')
    const row = await prisma.redemption.findUniqueOrThrow({ where: { id: r.id } })
    expect(row).toMatchObject({ status: 'REDEEMED', staffId: org.id, holderId: holder.id, ticketId: ticket.id })
    expect(row.redeemedAt).not.toBeNull()
  })

  it('says "already checked in" for a ticket that was used, distinct from having none', async () => {
    const { org, holder, event } = await world()
    await mkTicket(event.id, holder, 'REDEEMED')
    const r = await mkRedemption(event.id, org)
    tryGetPayload.mockResolvedValue(signedBy(holder))

    const res = await poll(org, r.payloadUuid)

    expect(res.body.state).toBe('already_used')
    expect(res.body.reason).toMatch(/already been checked in/i)
  })

  it('says "no valid ticket" for a signer who holds none for this event', async () => {
    const { org, holder, event } = await world()
    const r = await mkRedemption(event.id, org)
    tryGetPayload.mockResolvedValue(signedBy(holder))

    const res = await poll(org, r.payloadUuid)

    expect(res.body.state).toBe('no_ticket')
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('NO_TICKET')
  })

  it('refuses, and clears the cache, when the LEDGER says the holder no longer has it', async () => {
    const { org, holder, event } = await world()
    const ticket = await mkTicket(event.id, holder)
    const r = await mkRedemption(event.id, org)
    tryGetPayload.mockResolvedValue(signedBy(holder))
    holdsNft.mockResolvedValue(false)

    const res = await poll(org, r.payloadUuid)

    expect(res.body.state).toBe('no_ticket')
    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })
    expect(t.status).toBe('MINTED')
    expect(t.ownerId).toBeNull()
    expect(t.ownerAddress).toBeNull()
  })

  it('admits on the cached claim when the ledger cannot be read, rather than turning a real attendee away', async () => {
    const { org, holder, event } = await world()
    await mkTicket(event.id, holder)
    const r = await mkRedemption(event.id, org)
    tryGetPayload.mockResolvedValue(signedBy(holder))
    holdsNft.mockRejectedValue(new Error('node down'))

    expect((await poll(org, r.payloadUuid)).body.state).toBe('redeemed')
  })

  it('admits the holder\'s FIRST unused ticket and leaves the rest', async () => {
    const { org, holder, event } = await world()
    const first = await mkTicket(event.id, holder)
    const second = await mkTicket(event.id, holder)
    const r = await mkRedemption(event.id, org)
    tryGetPayload.mockResolvedValue(signedBy(holder))

    await poll(org, r.payloadUuid)

    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('REDEEMED')
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('MINTED')
  })

  it('only ever admits once: the verdict is final and re-polling does not touch the payload again', async () => {
    const { org, holder, event } = await world()
    await mkTicket(event.id, holder)
    await mkTicket(event.id, holder)
    const r = await mkRedemption(event.id, org)
    tryGetPayload.mockResolvedValue(signedBy(holder))

    await poll(org, r.payloadUuid)
    const calls = tryGetPayload.mock.calls.length
    const again = await poll(org, r.payloadUuid)

    expect(again.body.state).toBe('redeemed')
    expect(tryGetPayload.mock.calls.length).toBe(calls)
    // The second ticket was NOT burned by the second poll.
    expect(await prisma.ticket.count({ where: { eventId: event.id, status: 'REDEEMED' } })).toBe(1)
  })

  it('admits exactly one of two check-ins racing for the same ticket', async () => {
    const { org, holder, event } = await world()
    const ticket = await mkTicket(event.id, holder)
    const a = await mkRedemption(event.id, org)
    const b = await mkRedemption(event.id, org)
    tryGetPayload.mockResolvedValue(signedBy(holder))
    // Widen the window between "is it unused?" and "mark it used": this is the
    // gap a conditional update has to close.
    holdsNft.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 40))
      return true
    })

    const [ra, rb] = await Promise.all([poll(org, a.payloadUuid), poll(org, b.payloadUuid)])

    expect([ra.body.state, rb.body.state].sort()).toEqual(['already_used', 'redeemed'])
    expect(await prisma.redemption.count({ where: { eventId: event.id, status: 'REDEEMED' } })).toBe(1)
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('REDEEMED')
  })
})

describe('GET /checkin/:uuid, before the attendee has signed', () => {
  it('is pending while the payload is unsigned and in time', async () => {
    const { org, event } = await world()
    const r = await mkRedemption(event.id, org)
    tryGetPayload.mockResolvedValue({ signed: false })

    expect((await poll(org, r.payloadUuid)).body.state).toBe('pending')
  })

  it('expires once the window has passed, and says so', async () => {
    const { org, event } = await world()
    const r = await mkRedemption(event.id, org, { expiresAt: new Date(Date.now() - 1000) })
    tryGetPayload.mockResolvedValue({ signed: false })

    expect((await poll(org, r.payloadUuid)).body.state).toBe('expired')
  })

  it('records a declined signature as rejected', async () => {
    const { org, event } = await world()
    const r = await mkRedemption(event.id, org)
    tryGetPayload.mockResolvedValue({ cancelled: true })

    expect((await poll(org, r.payloadUuid)).body.state).toBe('rejected')
  })

  it('stays pending, not failed, when Xaman cannot be reached', async () => {
    const { org, event } = await world()
    const r = await mkRedemption(event.id, org)
    tryGetPayload.mockResolvedValue('unavailable')

    expect((await poll(org, r.payloadUuid)).body.state).toBe('pending')
  })
})

describe('GET /checkin/:uuid, who may read the verdict', () => {
  it('shows it only to the staff member who started that check-in', async () => {
    const { org, event } = await world()
    const other = await mkUser('other', 'ORGANIZER')
    const r = await mkRedemption(event.id, org)

    expect((await poll(other, r.payloadUuid)).status).toBe(403)
    expect((await poll(org, r.payloadUuid)).status).toBe(200)
  })

  it('404s a check-in that does not exist', async () => {
    const { org } = await world()
    expect((await poll(org, '00000000-0000-4000-8000-0000000000ff')).status).toBe(404)
  })
})
