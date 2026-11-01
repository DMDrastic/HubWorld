/**
 * A gift of a ticket that was never sold is a FREE ticket, under the new fee model. Written before the code.
 *
 * Its cost is recorded as nothing, which makes its resale cap nothing: it can be given on, and never sold for money.
 * Tickets that were sold, and tickets from before the amount was recorded, are left exactly as they are, and with
 * the model off nothing is recorded at all.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import request from 'supertest'
import { Wallet } from 'xrpl'

const tryGetPayload = vi.fn<(uuid: string) => Promise<unknown>>()
const txSucceeded = vi.fn<(h: string) => Promise<boolean | null>>()

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return { ...actual, txSucceeded: (h: string) => txSucceeded(h) }
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
const UTAG = 'gv_'
let uniq = ''
let n = 0

async function mkUser(name: string, role: 'USER' | 'ORGANIZER' = 'USER') {
  const address = Wallet.generate().classicAddress
  const user = await prisma.user.create({ data: { username: `${UTAG}${name}_${uniq}`.slice(0, 20), xrplAddress: address, role } })
  const { token } = await createSession(user.id)
  return { id: user.id, address, token }
}

async function cleanup() {
  const ev = { event: { slug: { startsWith: 'gv-' } } }
  await prisma.gift.deleteMany({ where: { ticket: ev } })
  await prisma.transfer.deleteMany({ where: { ticket: ev } })
  await prisma.listing.deleteMany({ where: { ticket: ev } })
  await prisma.ticket.deleteMany({ where: ev })
  await prisma.event.deleteMany({ where: { slug: { startsWith: 'gv-' } } })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: UTAG } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: UTAG } } })
}
beforeEach(async () => {
  uniq = Math.random().toString(36).slice(2, 7)
  n += 1
  await cleanup()
  txSucceeded.mockReset().mockResolvedValue(true)
})
afterEach(cleanup)
afterAll(async () => {
  await prisma.$disconnect()
})

/** A gift whose recipient has signed the acceptance, ready for the poll that completes it. */
async function acceptedGift(opts: { soldBefore?: boolean; faceValue?: bigint | null; recorded?: bigint | null }) {
  const org = await mkUser('org', 'ORGANIZER')
  const from = await mkUser('from')
  const to = await mkUser('to')
  const event = await prisma.event.create({
    data: { network: NETWORK, slug: `gv-${uniq}`, title: 'Gift Test', startsAt: new Date(Date.now() + 86_400_000), organizerId: org.id, nftTaxon: 60_000 + n, royaltyBps: 500, platformBps: 250, ticketCount: 5, status: 'PUBLISHED' },
  })
  const ticket = await prisma.ticket.create({
    data: {
      nfTokenId: `${uniq}${n}`.padEnd(64, 'A').toUpperCase().replace(/[^0-9A-F]/g, 'A'),
      network: NETWORK,
      eventId: event.id,
      ownerId: from.id,
      ownerAddress: from.address,
      status: 'MINTED',
      faceValueDrops: opts.faceValue ?? null,
      ...(opts.recorded != null ? { originalCostMinor: opts.recorded, originalCostCurrency: 'XRP' as const } : {}),
    },
  })
  if (opts.soldBefore) {
    await prisma.transfer.create({
      data: { ticketId: ticket.id, network: NETWORK, fromAddress: org.address, toAddress: from.address, txHash: `S${uniq}${n}`.padEnd(64, '0').toUpperCase().replace(/[^0-9A-F]/g, '0'), kind: 'SALE', occurredAt: new Date() },
    })
  }
  const accept = `00000000-0000-4000-9000-${uniq.padStart(5, '0').replace(/[^0-9a-f]/g, '0')}${String(n).padStart(7, '0')}`
  const gift = await prisma.gift.create({
    data: {
      network: NETWORK,
      ticketId: ticket.id,
      fromId: from.id,
      toId: to.id,
      fromAddress: from.address,
      toAddress: to.address,
      status: 'ACCEPTING',
      offerPayloadUuid: `00000000-0000-4000-8000-${uniq.padStart(5, '0').replace(/[^0-9a-f]/g, '0')}${String(n).padStart(7, '0')}`,
      offerIndex: 'AB'.repeat(32),
      acceptPayloadUuid: accept,
      expiresAt: new Date(Date.now() + 600_000),
    },
  })
  tryGetPayload.mockResolvedValue({ signed: true, cancelled: false, expired: false, account: to.address, txid: 'T'.repeat(64) })
  const res = await request(app).get(`/api/gifts/${gift.id}`).set('Authorization', `Bearer ${to.token}`)
  return { res, ticket: await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } }) }
}

describe('with the fee model off (the default)', () => {
  it('a gift records nothing about cost: the ticket keeps exactly the rules it had', async () => {
    const { res, ticket } = await acceptedGift({})
    expect(res.body.state).toBe('accepted')
    expect(ticket.originalCostMinor).toBeNull()
    expect(ticket.originalCostCurrency).toBeNull()
  })
})
