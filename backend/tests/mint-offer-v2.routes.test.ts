/**
 * A mint that carries its own sell offer, under the NEW fee model. Written before the code.
 *
 * The organizer mints a ticket and lists it for sale in the SAME signature. That is a first sale like any other,
 * so when the mint lands it must get the first-sale fan fee, the rate that produced it, and the first-sale flag
 * (which is what later records what the buyer paid). With the new model off it is recorded exactly as before.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.FEE_MODEL = 'v2'
  process.env.XRP_USD_CENTS = '134'
})

import request from 'supertest'
import { Wallet } from 'xrpl'
import { makeNftId } from './nft-id.js'

const BROKER = Wallet.generate().classicAddress
const offerAmount = { drops: 20_000_000n }

const tryGetPayload = vi.fn<(uuid: string) => Promise<unknown>>()

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return {
    ...actual,
    platformAddress: () => BROKER,
    nftokenIdFromTx: async () => lastNftId,
    offerIndexFromTx: async () => 'AB'.repeat(32),
    readNftOffer: async () => ({ amountDrops: offerAmount.drops, destination: BROKER, owner: lastOwner }),
  }
})
vi.mock('../src/xaman.js', async () => {
  const actual = await vi.importActual<typeof import('../src/xaman.js')>('../src/xaman.js')
  return { ...actual, tryGetPayload: (u: string) => tryGetPayload(u) }
})
vi.mock('../src/env.js', async () => {
  const actual = await vi.importActual<typeof import('../src/env.js')>('../src/env.js')
  return { ...actual, brokerMode: 'live' as const }
})

let lastNftId = ''
let lastOwner = ''

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')

const app = createApp()
const UTAG = 'mo_'
let uniq = ''
let n = 0

async function organizer(founding: boolean) {
  const address = Wallet.generate().classicAddress
  const user = await prisma.user.create({
    data: { username: `${UTAG}org_${uniq}`.slice(0, 20), xrplAddress: address, role: 'ORGANIZER', foundingOrganizer: founding },
  })
  const { token } = await createSession(user.id)
  return { id: user.id, address, token }
}

async function cleanup() {
  const ev = { event: { slug: { startsWith: 'mo-' } } }
  await prisma.listing.deleteMany({ where: { ticket: ev } })
  await prisma.transfer.deleteMany({ where: { ticket: ev } })
  await prisma.mintRequest.deleteMany({ where: ev })
  await prisma.ticket.deleteMany({ where: ev })
  await prisma.event.deleteMany({ where: { slug: { startsWith: 'mo-' } } })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: UTAG } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: UTAG } } })
}
beforeEach(async () => {
  uniq = Math.random().toString(36).slice(2, 7)
  n += 1
  await cleanup()
  offerAmount.drops = 20_000_000n
})
afterEach(cleanup)
afterAll(async () => {
  await prisma.$disconnect()
})

async function landMint(opts: { founding?: boolean; startsAt?: Date }) {
  const org = await organizer(opts.founding ?? false)
  const event = await prisma.event.create({
    data: {
      network: NETWORK,
      slug: `mo-${uniq}`,
      title: 'Mint Offer Test',
      startsAt: opts.startsAt ?? new Date(Date.now() + 86_400_000),
      organizerId: org.id,
      nftTaxon: 70_000 + n,
      royaltyBps: 500,
      platformBps: 250,
      ticketCount: 5,
      status: 'PUBLISHED',
    },
  })
  lastNftId = makeNftId(org.address, event.nftTaxon, n)
  lastOwner = org.address
  const uuid = `00000000-0000-4000-9000-${uniq.padStart(5, '0').replace(/[^0-9a-f]/g, '0')}${String(n).padStart(7, '0')}`
  await prisma.mintRequest.create({
    data: { payloadUuid: uuid, network: NETWORK, eventId: event.id, requestedById: org.id, expiresAt: new Date(Date.now() + 600_000) },
  })
  tryGetPayload.mockResolvedValue({ signed: true, cancelled: false, expired: false, account: org.address, txid: 'T'.repeat(64) })
  const res = await request(app).get(`/api/mint/${uuid}`).set('Authorization', `Bearer ${org.token}`)
  const ticket = await prisma.ticket.findFirst({ where: { eventId: event.id } })
  const listing = ticket ? await prisma.listing.findFirst({ where: { ticketId: ticket.id } }) : null
  return { res, ticket, listing }
}

describe('the listing a mint creates for its own sell offer', () => {
  it('20 XRP: the first-sale fan fee is 0.7 (3.5%), the rate is recorded, and it is marked as a first sale', async () => {
    const { res, listing } = await landMint({})
    expect(res.body.state).toBe('minted')
    expect(listing).toMatchObject({ priceDrops: 20_000_000n, platformFeeDrops: 700_000n, feeBps: 350, isPrimarySale: true, feeModel: 'BUYER_PAYS_V1' })
  })

  it('a founding organizer\'s event inside the window pays 0.6, at 300 bps', async () => {
    const { listing } = await landMint({ founding: true })
    expect(listing).toMatchObject({ platformFeeDrops: 600_000n, feeBps: 300 })
  })

  it('a founding organizer\'s event after the window pays the standard fee', async () => {
    const { listing } = await landMint({ founding: true, startsAt: new Date('2028-06-01T12:00:00Z') })
    expect(listing).toMatchObject({ platformFeeDrops: 700_000n, feeBps: 350 })
  })

  it('keeps recording the face value from the offer, as it always did', async () => {
    const { ticket } = await landMint({})
    expect(ticket?.faceValueDrops).toBe(20_000_000n)
  })
})
