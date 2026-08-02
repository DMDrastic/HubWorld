/**
 * The authorization boundaries, over HTTP.
 *
 * Every other backend suite is pure logic — fee arithmetic, policy predicates,
 * state machines — and those are the right tests for that code. But a policy
 * function that returns the correct verdict is worth nothing if the route never
 * calls it, and nothing in the suite could tell the difference. `canAuction`,
 * `checkDoorAccess` and `requireOrganizer` are all individually tested and all
 * individually irrelevant if a handler forgets to await one.
 *
 * So this suite asserts the boundary from OUTSIDE: a real Express app, a real
 * session cookie, a real database, and a request that a hostile client could
 * actually send. What it pins is who is refused, with which status — the four
 * boundaries that decide who can issue admission, who can take money, who can
 * admit at a door, and who can be promoted.
 *
 * The database is real for the same reason it is in `settlement.integration`:
 * the interesting behaviour IS the database work. A mocked Prisma would let a
 * missing `where` clause pass, and a missing `where` clause on an ownership
 * check is precisely the bug worth catching.
 *
 * Only the NETWORK is stubbed — Xaman and the two ledger reads. `holdsNft` in
 * particular is stubbed rather than removed, because "the ledger disagrees with
 * our cache" is a case these routes are supposed to handle and there is no way
 * to provoke it against a real ledger on demand.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

const holdsNft = vi.fn<(address: string, nfTokenId: string) => Promise<boolean>>()
const accountNfts = vi.fn<(address: string) => Promise<{ NFTokenID: string }[]>>()

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return {
    ...actual,
    // Real fee maths and real transaction builders; only the network is faked.
    holdsNft: (...a: Parameters<typeof holdsNft>) => holdsNft(...a),
    accountNfts: (...a: Parameters<typeof accountNfts>) => accountNfts(...a),
  }
})

// Xaman is stubbed unconditionally. A developer with live credentials in .env
// would otherwise have this suite spend real payload quota on every run — and
// that quota is already exhausted, so the tests would fail for a reason that has
// nothing to do with the code under test.
vi.mock('../src/xaman.js', async () => {
  const actual = await vi.importActual<typeof import('../src/xaman.js')>('../src/xaman.js')
  let n = 0
  const created = () => {
    n += 1
    return {
      uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      next: 'https://xumm.app/sign/stub',
      qrPng: 'https://xumm.app/sign/stub.png',
    }
  }
  return {
    ...actual,
    xaman: {
      mode: 'stub' as const,
      createPayload: async () => created(),
      createSignInPayload: async () => created(),
      getPayload: async () => null,
      cancelPayload: async () => true,
    },
  }
})

// The broker is forced live, because `brokerMode` is read from PLATFORM_SEED and
// the sell and auction routes answer 503 without it — BEFORE they reach the
// holder and redemption checks this suite exists to assert. Left to the ambient
// environment, these tests pass on a developer machine with a seed in `.env` and
// fail in CI, which has none: the guard is never actually exercised, and the
// suite reports on the environment rather than on the code. Nothing here brokers
// a real sale, so no seed is needed — `Wallet.fromSeed` is only reached when a
// settlement is actually submitted.
vi.mock('../src/env.js', async () => {
  const actual = await vi.importActual<typeof import('../src/env.js')>('../src/env.js')
  return { ...actual, brokerMode: 'live' as const }
})

const { prisma } = await import('../src/prisma.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')
const { env } = await import('../src/env.js')

const app = createApp()

// Usernames are [a-z0-9_] only, so the tag has to be underscore-separated;
// slugs are [a-z0-9-]. Both are prefixed so cleanup can find exactly the rows
// this suite made and nothing a developer has in their dev database.
const UTAG = 'rt_'
const STAG = 'rt-'

type Actor = { id: string; username: string; address: string; token: string }

let uniq = ''
/** Separate from `uniq`, because an NFTokenID must be 64 HEX characters and
 *  base36 would fail the routes' param validation before reaching any guard —
 *  which would make a 400 look like a passing authorization test. */
let hexUniq = ''

async function mkUser(name: string, role: 'USER' | 'ORGANIZER' | 'ADMIN' = 'USER'): Promise<Actor> {
  const username = `${UTAG}${name}_${uniq}`.slice(0, 20)
  const user = await prisma.user.create({
    data: {
      username,
      // Not a real r-address; nothing in this suite submits to a ledger.
      xrplAddress: `r${UTAG}${name}${uniq}`.padEnd(28, 'x').slice(0, 33),
      role,
    },
  })
  // A real session, not a forged header: the token path is part of the boundary.
  const { token } = await createSession(user.id)
  return { id: user.id, username: user.username, address: user.xrplAddress, token }
}

function as(actor: Actor) {
  return `Bearer ${actor.token}`
}

async function mkEvent(organizer: Actor, opts: { slug?: string; ticketCount?: number } = {}) {
  return prisma.event.create({
    data: {
      slug: opts.slug ?? `${STAG}${uniq}`,
      title: 'Route Test Event',
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: organizer.id,
      nftTaxon: 70_000 + Math.floor(Math.random() * 9_000),
      royaltyBps: 500,
      platformBps: 250,
      ticketCount: opts.ticketCount ?? 10,
      status: 'PUBLISHED',
    },
  })
}

async function mkTicket(eventId: string, owner: Actor, suffix = '1') {
  return prisma.ticket.create({
    data: {
      nfTokenId: `${suffix}${hexUniq}${'0'.repeat(64)}`.slice(0, 64).toUpperCase(),
      eventId,
      ownerId: owner.id,
      ownerAddress: owner.address,
      status: 'MINTED',
    },
  })
}

/**
 * Rows this suite made, found two ways.
 *
 * By slug catches what the fixtures create; by organizer catches what a HANDLER
 * creates, which is not the same set. A negative test asserts a request is
 * refused, so it deliberately does not know the slug of the event that request
 * would have made — and if the guard under test is ever broken, that event gets
 * created for real. Keying only on the slug leaves it behind, `user.deleteMany`
 * then fails on a foreign key, and every later test in the file dies during
 * cleanup instead of reporting its own result. That turns one broken guard into
 * an unreadable wall of failures, which is exactly when the signal matters most.
 */
const eventWhere = {
  OR: [{ slug: { startsWith: STAG } }, { organizer: { username: { startsWith: UTAG } } }],
}

async function cleanup() {
  const byEvent = { ticket: { event: eventWhere } }
  await prisma.transfer.deleteMany({ where: byEvent })
  await prisma.redemption.deleteMany({ where: { event: eventWhere } })
  await prisma.eventStaff.deleteMany({ where: { event: eventWhere } })
  await prisma.bid.deleteMany({ where: { auction: byEvent } })
  await prisma.gift.deleteMany({ where: { from: { username: { startsWith: UTAG } } } })
  await prisma.listing.deleteMany({ where: { seller: { username: { startsWith: UTAG } } } })
  await prisma.auction.deleteMany({ where: byEvent })
  await prisma.mintRequest.deleteMany({ where: { event: eventWhere } })
  await prisma.ticket.deleteMany({ where: { event: eventWhere } })
  await prisma.event.deleteMany({ where: eventWhere })
  await prisma.organizerApplication.deleteMany({
    where: { user: { username: { startsWith: UTAG } } },
  })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: UTAG } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: UTAG } } })
}

beforeEach(async () => {
  uniq = Math.random().toString(36).slice(2, 8)
  hexUniq = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0')
  await cleanup()
  holdsNft.mockReset()
  accountNfts.mockReset()
  // Default: the ledger agrees you hold what our cache says you hold. Tests
  // that care about disagreement override this.
  holdsNft.mockResolvedValue(true)
  accountNfts.mockResolvedValue([])
})

afterEach(cleanup)
afterAll(async () => {
  await prisma.$disconnect()
})

// --------------------------------------------------------------- 401 sweep --

/**
 * Every guarded route, unauthenticated.
 *
 * Table-driven on purpose: the failure this catches is a NEW route added
 * without `requireAuth`, and that is caught by the list being exhaustive rather
 * than by any single case being clever. If you add a mutating route, add it
 * here.
 */
describe('unauthenticated requests are refused', () => {
  const guarded: Array<[method: 'get' | 'post', path: string]> = [
    ['get', '/api/auth/me'],
    ['get', '/api/tickets/mine'],
    ['get', '/api/organizers/me'],
    ['get', '/api/admin/organizer-applications'],
    ['get', '/api/listings/mine'],
    ['get', '/api/door/events'],
    ['get', '/api/gifts'],
    ['get', '/api/gifts/00000000-0000-4000-8000-000000000000'],
    ['get', '/api/listings/00000000-0000-4000-8000-000000000000'],
    ['get', '/api/bids/00000000-0000-4000-8000-000000000000'],
    ['get', '/api/checkin/00000000-0000-4000-8000-000000000000'],
    ['get', '/api/mint/00000000-0000-4000-8000-000000000000'],
    ['get', '/api/events/x/door'],
    ['get', '/api/events/x/staff'],
    ['post', '/api/events'],
    ['post', '/api/events/x/mint'],
    ['post', '/api/events/x/checkin'],
    ['post', '/api/events/x/staff'],
    ['post', '/api/events/x/staff/remove'],
    ['post', '/api/organizers/apply'],
    ['post', '/api/admin/organizer-applications/00000000-0000-4000-8000-000000000000/review'],
    ['post', '/api/tickets/ABC/gift'],
    ['post', '/api/tickets/ABC/list'],
    ['post', '/api/tickets/ABC/auction'],
    ['post', '/api/listings/00000000-0000-4000-8000-000000000000/buy'],
    ['post', '/api/listings/00000000-0000-4000-8000-000000000000/cancel'],
    ['post', '/api/auctions/00000000-0000-4000-8000-000000000000/bid'],
    ['post', '/api/gifts/00000000-0000-4000-8000-000000000000/accept'],
    ['post', '/api/gifts/00000000-0000-4000-8000-000000000000/cancel'],
  ]

  it.each(guarded)('%s %s → 401', async (method, path) => {
    const res = await request(app)[method](path).send({})
    expect(res.status).toBe(401)
  })

  it('refuses a token that has been revoked', async () => {
    const user = await mkUser('rev')
    await prisma.session.updateMany({
      where: { userId: user.id },
      data: { revokedAt: new Date() },
    })

    const res = await request(app).get('/api/auth/me').set('authorization', as(user))
    expect(res.status).toBe(401)
  })

  it('refuses a token that has expired', async () => {
    const user = await mkUser('exp')
    await prisma.session.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    const res = await request(app).get('/api/auth/me').set('authorization', as(user))
    expect(res.status).toBe(401)
  })
})

// ------------------------------------------------------------ organizers --

describe('issuing admission is gated on the organizer role', () => {
  it('refuses a plain user creating an event', async () => {
    const user = await mkUser('plain')

    const res = await request(app)
      .post('/api/events')
      .set('authorization', as(user))
      .send({
        title: 'Not Allowed',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        ticketCount: 10,
        royaltyBps: 500,
      })

    // 403, not 404: they are authenticated, just not permitted.
    expect(res.status).toBe(403)
    expect(await prisma.event.count({ where: { organizerId: user.id } })).toBe(0)
  })

  it('refuses a plain user minting', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const event = await mkEvent(organizer)
    const user = await mkUser('plain')

    const res = await request(app)
      .post(`/api/events/${event.slug}/mint`)
      .set('authorization', as(user))
      .send({})

    expect(res.status).toBe(403)
  })

  it('lets an organizer create an event', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')

    const res = await request(app)
      .post('/api/events')
      .set('authorization', as(organizer))
      .send({
        slug: `${STAG}made-${uniq}`,
        title: 'Allowed',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        ticketCount: 10,
        royaltyBps: 500,
      })

    expect(res.status).toBe(201)
  })

  /**
   * The role is a role, not ownership. An organizer holding a valid role still
   * may not mint into someone else's event: the issuer is the royalty
   * recipient, so a mint signed by the wrong organizer sends that event's
   * royalties to the wrong account permanently.
   */
  it('refuses an organizer minting into another organizer’s event', async () => {
    const owner = await mkUser('owner', 'ORGANIZER')
    const other = await mkUser('other', 'ORGANIZER')
    const event = await mkEvent(owner)

    const res = await request(app)
      .post(`/api/events/${event.slug}/mint`)
      .set('authorization', as(other))
      .send({})

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/only the event organizer/i)
  })

  /**
   * `platformBps` is policy, set by the server on every event. It is absent
   * from `CreateEventBody` deliberately — and "absent from the schema" is only
   * a real defence if the handler also ignores it when a client sends it
   * anyway. The fee is frozen onto each Listing at creation, so a zero that got
   * through would not be recoverable retroactively: the revenue is simply never
   * earned.
   */
  it('ignores platformBps in the request body', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')

    const res = await request(app)
      .post('/api/events')
      .set('authorization', as(organizer))
      .send({
        slug: `${STAG}policy-${uniq}`,
        title: 'Fee Policy',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        ticketCount: 10,
        royaltyBps: 500,
        platformBps: 0,
      })

    expect(res.status).toBe(201)
    expect(res.body.platformBps).toBe(env.PLATFORM_FEE_BPS)

    const stored = await prisma.event.findUniqueOrThrow({ where: { slug: `${STAG}policy-${uniq}` } })
    expect(stored.platformBps).toBe(env.PLATFORM_FEE_BPS)
  })

  it('caps royaltyBps at the configured maximum', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')

    const res = await request(app)
      .post('/api/events')
      .set('authorization', as(organizer))
      .send({
        slug: `${STAG}greedy-${uniq}`,
        title: 'Greedy',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        ticketCount: 10,
        royaltyBps: env.MAX_ROYALTY_BPS + 1,
      })

    expect(res.status).toBe(400)
  })
})

// ----------------------------------------------------------------- admin --

describe('promotion to organizer is reviewed, never self-declared', () => {
  it('refuses an organizer reading the review queue', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')

    const res = await request(app)
      .get('/api/admin/organizer-applications')
      .set('authorization', as(organizer))

    expect(res.status).toBe(403)
  })

  it('refuses a non-admin approving an application', async () => {
    const applicant = await mkUser('appl')
    const organizer = await mkUser('org', 'ORGANIZER')
    const application = await prisma.organizerApplication.create({
      data: { userId: applicant.id, orgName: 'Org', contact: 'a@b.co', pitch: 'ten chars ok' },
    })

    const res = await request(app)
      .post(`/api/admin/organizer-applications/${application.id}/review`)
      .set('authorization', as(organizer))
      .send({ decision: 'approve' })

    expect(res.status).toBe(403)

    // The escalation that matters: the role must not have moved.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: applicant.id } })
    expect(after.role).toBe('USER')
  })

  /**
   * The whole point of an account-property role: nothing a client sends can
   * promote an account. An applicant posting the role they would like is the
   * obvious first thing anyone tries.
   */
  it('cannot promote itself through the application body', async () => {
    const applicant = await mkUser('appl')

    const res = await request(app)
      .post('/api/organizers/apply')
      .set('authorization', as(applicant))
      .send({ orgName: 'Org', contact: 'a@b.co', pitch: 'ten chars ok', role: 'ADMIN' })

    expect(res.status).toBe(201)
    const after = await prisma.user.findUniqueOrThrow({ where: { id: applicant.id } })
    expect(after.role).toBe('USER')
  })

  it('lets an admin approve, and the role moves with the application', async () => {
    const applicant = await mkUser('appl')
    const admin = await mkUser('adm', 'ADMIN')
    const application = await prisma.organizerApplication.create({
      data: { userId: applicant.id, orgName: 'Org', contact: 'a@b.co', pitch: 'ten chars ok' },
    })

    const res = await request(app)
      .post(`/api/admin/organizer-applications/${application.id}/review`)
      .set('authorization', as(admin))
      .send({ decision: 'approve' })

    expect(res.status).toBe(200)
    const after = await prisma.user.findUniqueOrThrow({ where: { id: applicant.id } })
    expect(after.role).toBe('ORGANIZER')
  })
})

// ------------------------------------------------------- holder-only acts --

/**
 * Gifting, listing and auctioning all move someone's ticket, and all three ask
 * the LEDGER rather than `Ticket.ownerId`. The cache exists to render a page
 * quickly; it is not evidence, and a holder can move a ticket in Xaman without
 * telling us.
 */
describe('acting on a ticket requires holding it on-ledger', () => {
  const holderOnly: Array<[label: string, path: (nfTokenId: string) => string, body: object]> = [
    ['gift', (id) => `/api/tickets/${id}/gift`, { to: 'placeholder' }],
    ['list', (id) => `/api/tickets/${id}/list`, { priceDrops: '10000000' }],
    ['auction', (id) => `/api/tickets/${id}/auction`, { reserveDrops: '10000000', minutes: 60 }],
  ]

  it.each(holderOnly)('refuses a stranger trying to %s', async (_label, path, body) => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('hold')
    const stranger = await mkUser('strange')
    const event = await mkEvent(organizer)
    const ticket = await mkTicket(event.id, holder)

    // The ledger says the stranger holds nothing.
    holdsNft.mockResolvedValue(false)

    const send = { ...body, ...('to' in body ? { to: holder.username } : {}) }
    const res = await request(app)
      .post(path(ticket.nfTokenId))
      .set('authorization', as(stranger))
      .send(send)

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/ledger says you do not hold/i)
  })

  /**
   * The cache is not merely ignored when the ledger disagrees — it is cleared.
   * Leaving a stale `ownerId` behind means the next page render still shows the
   * ticket in an inventory it has already left.
   */
  it('clears the ownership cache when the ledger disagrees', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('hold')
    const event = await mkEvent(organizer)
    const ticket = await mkTicket(event.id, holder)

    holdsNft.mockResolvedValue(false)

    const res = await request(app)
      .post(`/api/tickets/${ticket.nfTokenId}/list`)
      .set('authorization', as(holder))
      .send({ priceDrops: '10000000' })

    expect(res.status).toBe(403)
    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })
    expect(after.ownerId).toBeNull()
    expect(after.ownerAddress).toBeNull()
    expect(after.syncedAt).not.toBeNull()
  })

  /**
   * Admission that has been used cannot be passed on. The NFT still exists and
   * is still moveable in Xaman as a collectible — Hubworld simply stops
   * presenting it as a ticket.
   */
  it('refuses to gift, list or auction a redeemed ticket', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('hold')
    const recipient = await mkUser('recip')
    const event = await mkEvent(organizer)
    const ticket = await mkTicket(event.id, holder)
    await prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'REDEEMED' } })

    const paths: Array<[string, object]> = [
      [`/api/tickets/${ticket.nfTokenId}/gift`, { to: recipient.username }],
      [`/api/tickets/${ticket.nfTokenId}/list`, { priceDrops: '10000000' }],
      [`/api/tickets/${ticket.nfTokenId}/auction`, { reserveDrops: '10000000', minutes: 60 }],
    ]

    for (const [path, body] of paths) {
      const res = await request(app).post(path).set('authorization', as(holder)).send(body)
      expect(res.status).toBe(409)
      expect(res.body.error).toMatch(/checked in/i)
    }
  })
})

// -------------------------------------------------- seller / sender only --

describe('only the counterparty who owns a flow may act on it', () => {
  async function mkListing() {
    const organizer = await mkUser('org', 'ORGANIZER')
    const seller = await mkUser('sell')
    const event = await mkEvent(organizer)
    const ticket = await mkTicket(event.id, seller)
    const listing = await prisma.listing.create({
      data: {
        ticketId: ticket.id,
        sellerId: seller.id,
        sellerAddress: seller.address,
        priceDrops: 10_000_000n,
        platformFeeDrops: 250_000n,
        listPayloadUuid: `${UTAG}${uniq}-list`,
        expiresAt: new Date(Date.now() + 3_600_000),
        offerIndex: `SELL-${uniq}`,
        status: 'ACTIVE',
      },
    })
    return { listing, seller, ticket }
  }

  it('refuses a stranger withdrawing a listing', async () => {
    const { listing } = await mkListing()
    const stranger = await mkUser('strange')

    const res = await request(app)
      .post(`/api/listings/${listing.id}/cancel`)
      .set('authorization', as(stranger))
      .send({})

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/only the seller/i)

    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })
    expect(after.status).toBe('ACTIVE')
  })

  it('refuses a seller buying their own listing', async () => {
    const { listing, seller } = await mkListing()

    const res = await request(app)
      .post(`/api/listings/${listing.id}/buy`)
      .set('authorization', as(seller))
      .send({})

    expect(res.status).toBe(400)
  })

  async function mkGift() {
    const organizer = await mkUser('org', 'ORGANIZER')
    const sender = await mkUser('send')
    const recipient = await mkUser('recip')
    const event = await mkEvent(organizer)
    const ticket = await mkTicket(event.id, sender)
    const gift = await prisma.gift.create({
      data: {
        ticketId: ticket.id,
        fromId: sender.id,
        toId: recipient.id,
        fromAddress: sender.address,
        toAddress: recipient.address,
        offerPayloadUuid: `${UTAG}${uniq}-gift`,
        offerIndex: `GIFT-${uniq}`,
        status: 'OFFERED',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    return { gift, sender, recipient }
  }

  it('refuses a stranger accepting a gift addressed to someone else', async () => {
    const { gift } = await mkGift()
    const stranger = await mkUser('strange')

    const res = await request(app)
      .post(`/api/gifts/${gift.id}/accept`)
      .set('authorization', as(stranger))
      .send({})

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not addressed to you/i)
  })

  it('refuses the recipient withdrawing a gift they did not send', async () => {
    const { gift, recipient } = await mkGift()

    const res = await request(app)
      .post(`/api/gifts/${gift.id}/cancel`)
      .set('authorization', as(recipient))
      .send({})

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/only the sender/i)
  })

  it('refuses a stranger polling a gift they are not party to', async () => {
    const { gift } = await mkGift()
    const stranger = await mkUser('strange')

    const res = await request(app)
      .get(`/api/gifts/${gift.id}`)
      .set('authorization', as(stranger))

    expect(res.status).toBe(403)
  })
})

// ------------------------------------------------------------------ door --

/**
 * Door access is per event and separate from the account role, because a
 * volunteer scanning QRs for one evening is a plain USER and must not have to
 * become an ORGANIZER — which would hand them minting, event creation and
 * auctions for every event they can reach.
 */
describe('the door is per event, not per role', () => {
  async function stage() {
    const organizer = await mkUser('org', 'ORGANIZER')
    const event = await mkEvent(organizer)
    return { organizer, event }
  }

  it('refuses a stranger starting a check-in', async () => {
    const { event } = await stage()
    const stranger = await mkUser('strange')

    const res = await request(app)
      .post(`/api/events/${event.slug}/checkin`)
      .set('authorization', as(stranger))
      .send({})

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not on the door/i)
  })

  it('lets the organizer work their own door', async () => {
    const { organizer, event } = await stage()

    const res = await request(app)
      .post(`/api/events/${event.slug}/checkin`)
      .set('authorization', as(organizer))
      .send({})

    expect(res.status).toBe(201)
  })

  it('lets a plain USER on the staff list work that door', async () => {
    const { organizer, event } = await stage()
    const volunteer = await mkUser('vol')
    await prisma.eventStaff.create({
      data: { eventId: event.id, userId: volunteer.id, addedById: organizer.id },
    })

    const res = await request(app)
      .post(`/api/events/${event.slug}/checkin`)
      .set('authorization', as(volunteer))
      .send({})

    expect(res.status).toBe(201)
  })

  it('refuses a volunteer whose access was revoked', async () => {
    const { organizer, event } = await stage()
    const volunteer = await mkUser('vol')
    await prisma.eventStaff.create({
      data: {
        eventId: event.id,
        userId: volunteer.id,
        addedById: organizer.id,
        revokedAt: new Date(),
      },
    })

    const res = await request(app)
      .post(`/api/events/${event.slug}/checkin`)
      .set('authorization', as(volunteer))
      .send({})

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/revoked/i)
  })

  it('does not let door access leak to another event', async () => {
    const { organizer, event } = await stage()
    const volunteer = await mkUser('vol')
    await prisma.eventStaff.create({
      data: { eventId: event.id, userId: volunteer.id, addedById: organizer.id },
    })
    const otherEvent = await mkEvent(organizer, { slug: `${STAG}other-${uniq}` })

    const res = await request(app)
      .post(`/api/events/${otherEvent.slug}/checkin`)
      .set('authorization', as(volunteer))
      .send({})

    expect(res.status).toBe(403)
  })

  /**
   * The escalation this closes: staff who can add staff means one compromised
   * volunteer account widens access to the event indefinitely.
   */
  it('refuses door staff adding more door staff', async () => {
    const { organizer, event } = await stage()
    const volunteer = await mkUser('vol')
    const friend = await mkUser('friend')
    await prisma.eventStaff.create({
      data: { eventId: event.id, userId: volunteer.id, addedById: organizer.id },
    })

    const res = await request(app)
      .post(`/api/events/${event.slug}/staff`)
      .set('authorization', as(volunteer))
      .send({ username: friend.username })

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/only the organizer/i)
    expect(
      await prisma.eventStaff.count({ where: { eventId: event.id, userId: friend.id } }),
    ).toBe(0)
  })

  it('refuses door staff reading the staff list', async () => {
    const { organizer, event } = await stage()
    const volunteer = await mkUser('vol')
    await prisma.eventStaff.create({
      data: { eventId: event.id, userId: volunteer.id, addedById: organizer.id },
    })

    const res = await request(app)
      .get(`/api/events/${event.slug}/staff`)
      .set('authorization', as(volunteer))

    expect(res.status).toBe(403)
  })

  /**
   * Admins arbitrate disputed check-ins, and cannot depend on the organizer's
   * cooperation to do it.
   */
  it('lets an admin work any door', async () => {
    const { event } = await stage()
    const admin = await mkUser('adm', 'ADMIN')

    const res = await request(app)
      .post(`/api/events/${event.slug}/checkin`)
      .set('authorization', as(admin))
      .send({})

    expect(res.status).toBe(201)
  })

  it('lists only the doors an account may actually work', async () => {
    const { organizer, event } = await stage()
    const volunteer = await mkUser('vol')
    await mkEvent(organizer, { slug: `${STAG}unrelated-${uniq}` })
    await prisma.eventStaff.create({
      data: { eventId: event.id, userId: volunteer.id, addedById: organizer.id },
    })

    const res = await request(app).get('/api/door/events').set('authorization', as(volunteer))

    expect(res.status).toBe(200)
    const slugs = (res.body.events as Array<{ slug: string }>).map((e) => e.slug)
    expect(slugs).toContain(event.slug)
    expect(slugs).not.toContain(`${STAG}unrelated-${uniq}`)
  })
})

// ------------------------------------------- an auction's floor is not a price --

/**
 * An auction's sell offer is priced at the FLOOR — below the reserve by the
 * fee-at-reserve, so that a bid at the reserve still satisfies
 * `buy >= sell + brokerFee`. That makes it the cheapest way to acquire the
 * ticket by a wide margin, and it exists only so settlement has something to
 * broker against.
 *
 * `auction-open.test.ts` already pins the query predicate. This pins the two
 * HTTP surfaces a buyer can actually reach, which is where the money would
 * leave: a listing that is merely hidden but still buyable by id is not
 * protected at all.
 */
describe('an auction’s sell offer is never publicly buyable', () => {
  async function stageAuction() {
    const organizer = await mkUser('org', 'ORGANIZER')
    const holder = await mkUser('hold')
    const event = await mkEvent(organizer)
    const ticket = await mkTicket(event.id, holder)
    const auction = await prisma.auction.create({
      data: {
        ticketId: ticket.id,
        startsAt: new Date(Date.now() - 3_600_000),
        endsAt: new Date(Date.now() + 3_600_000),
        reserveDrops: 20_000_000n,
        status: 'LIVE',
      },
    })
    const listing = await prisma.listing.create({
      data: {
        ticketId: ticket.id,
        sellerId: holder.id,
        sellerAddress: holder.address,
        priceDrops: 19_500_000n,
        platformFeeDrops: 0n,
        listPayloadUuid: `${UTAG}${uniq}-alist`,
        expiresAt: new Date(Date.now() + 3_600_000),
        offerIndex: `SELL-${uniq}`,
        status: 'ACTIVE',
        auctionId: auction.id,
      },
    })
    return { auction, listing, holder, organizer, event, ticket }
  }

  it('hides it from the marketplace', async () => {
    const { listing } = await stageAuction()

    const res = await request(app).get('/api/listings')

    expect(res.status).toBe(200)
    const ids = (res.body.listings as Array<{ listingId: string }>).map((l) => l.listingId)
    expect(ids).not.toContain(listing.id)
  })

  it('refuses a direct purchase by id, and points at the auction instead', async () => {
    const { listing, auction } = await stageAuction()
    const buyer = await mkUser('buyer')

    const res = await request(app)
      .post(`/api/listings/${listing.id}/buy`)
      .set('authorization', as(buyer))
      .send({})

    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/place a bid/i)
    expect(res.body.auctionId).toBe(auction.id)

    // Nothing was reserved: the listing must not have moved to BUYER_PENDING.
    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })
    expect(after.status).toBe('ACTIVE')
    expect(after.buyerId).toBeNull()
  })

  it('still shows an ordinary listing in the marketplace', async () => {
    // The negative above is only meaningful if the positive holds — otherwise
    // an empty marketplace would pass it.
    const organizer = await mkUser('org', 'ORGANIZER')
    const seller = await mkUser('sell')
    const event = await mkEvent(organizer)
    const ticket = await mkTicket(event.id, seller)
    const listing = await prisma.listing.create({
      data: {
        ticketId: ticket.id,
        sellerId: seller.id,
        sellerAddress: seller.address,
        priceDrops: 10_000_000n,
        platformFeeDrops: 250_000n,
        listPayloadUuid: `${UTAG}${uniq}-plain`,
        expiresAt: new Date(Date.now() + 3_600_000),
        offerIndex: `SELL-plain-${uniq}`,
        status: 'ACTIVE',
      },
    })

    const res = await request(app).get('/api/listings')

    const ids = (res.body.listings as Array<{ listingId: string }>).map((l) => l.listingId)
    expect(ids).toContain(listing.id)
  })
})

// ------------------------------------------------------------ API shape --

describe('the API answers as an API', () => {
  /**
   * The `/api` 404 is registered BEFORE the static and SPA handlers. Without
   * that ordering a mistyped API route falls through to the SPA fallback and
   * answers 200 with index.html, and the client reports a JSON syntax error
   * instead of "no such route".
   */
  it('404s an unknown /api route as JSON', async () => {
    const res = await request(app).get('/api/nope').set('accept', 'text/html')

    expect(res.status).toBe(404)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.body.error).toBe('Not found')
  })

  it('serialises drops as strings, never as JSON numbers', async () => {
    const organizer = await mkUser('org', 'ORGANIZER')
    const seller = await mkUser('sell')
    const event = await mkEvent(organizer)
    const ticket = await mkTicket(event.id, seller)
    await prisma.listing.create({
      data: {
        ticketId: ticket.id,
        sellerId: seller.id,
        sellerAddress: seller.address,
        // Past 2^53: a client parsing this as a JS number would lose precision,
        // and this is money.
        priceDrops: 9_007_199_254_740_993n,
        platformFeeDrops: 250_000n,
        listPayloadUuid: `${UTAG}${uniq}-big`,
        expiresAt: new Date(Date.now() + 3_600_000),
        offerIndex: `SELL-big-${uniq}`,
        status: 'ACTIVE',
      },
    })

    const res = await request(app).get('/api/listings')
    const found = (res.body.listings as Array<{ priceDrops: unknown }>)[0]

    expect(typeof found?.priceDrops).toBe('string')
    expect(found?.priceDrops).toBe('9007199254740993')
  })

  it('is healthy', async () => {
    const res = await request(app).get('/api/health')

    // Always 200 so the UI can render a status even when Postgres is down;
    // the db field, not the status code, carries that.
    expect(res.status).toBe(200)
    expect(res.body.db).toBe('connected')
    expect(res.body.status).toBe('ok')
  })
})
