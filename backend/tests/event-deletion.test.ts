/**
 * Deleting an event orphans the metadata of every ticket minted from it.
 *
 * Each ticket carries an on-ledger URI pointing at `/api/events/:slug/nft.json`.
 * That URI is written into the NFT: public, permanent, and outside our control.
 * **Serving it is a promise the database must not be able to revoke.**
 *
 * Found on 2026-08-26. A test event was purged from production after its ticket
 * had been minted; the URI began returning 404 and the token only still rendered
 * because Xaman had cached the metadata. Anything fetching fresh would have got
 * nothing. Tokens minted since carry `tfMutable`, so it is recoverable — but only
 * with one organizer signature per ticket, against the wallet-interaction budget
 * that caps event size in the first place.
 *
 * The count that matters is not "does this event have rows" but "did any of its
 * tickets reach a LEDGER", because that is the difference between a fixture
 * nobody holds and a ticket in somebody's wallet.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/prisma.js'
import { NETWORK } from '../src/network.js'
import {
  FORCE_FLAG,
  eventsWithTickets,
  orphanedMetadataMessage,
} from '../src/event-deletion.js'

const TAG = 'evt-del'

async function cleanup() {
  const where = { event: { slug: { startsWith: TAG } } }
  await prisma.transfer.deleteMany({ where: { ticket: where } })
  await prisma.ticket.deleteMany({ where })
  await prisma.event.deleteMany({ where: { slug: { startsWith: TAG } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: TAG } } })
}

beforeEach(cleanup)
afterEach(cleanup)

async function seedEvent(opts: { tickets: number; minted: number }) {
  const uniq = Math.random().toString(36).slice(2, 8)
  const organizer = await prisma.user.create({
    data: { username: `${TAG}-org-${uniq}`, xrplAddress: `r${TAG}${uniq}`.padEnd(28, 'x') },
  })
  const event = await prisma.event.create({
    data: {
      network: NETWORK,
      slug: `${TAG}-${uniq}`,
      title: 'Deletion fixture',
      startsAt: new Date('2030-01-01T00:00:00Z'),
      organizerId: organizer.id,
      nftTaxon: 960_000,
      royaltyBps: 0,
      platformBps: 250,
      ticketCount: Math.max(opts.tickets, 1),
    },
  })

  for (let i = 0; i < opts.tickets; i++) {
    const ticket = await prisma.ticket.create({
      data: {
        network: NETWORK,
        nfTokenId: `EVTDEL${uniq}${i}`.padEnd(64, '0').toUpperCase(),
        eventId: event.id,
        ownerId: organizer.id,
        ownerAddress: organizer.xrplAddress,
      },
    })
    // Only the first `minted` tickets carry real on-ledger provenance.
    if (i < opts.minted) {
      await prisma.transfer.create({
        data: {
          ticketId: ticket.id,
          network: NETWORK,
          fromAddress: null,
          toAddress: organizer.xrplAddress,
          txHash: `TX${uniq}${i}`.padEnd(64, '0').toUpperCase(),
          kind: 'MINT',
          occurredAt: new Date(),
        },
      })
    }
  }

  return event
}

describe('events that still have tickets', () => {
  it('are reported, with how many reached a ledger', async () => {
    const event = await seedEvent({ tickets: 3, minted: 2 })

    const blocked = await eventsWithTickets([event.id])

    expect(blocked).toHaveLength(1)
    expect(blocked[0]).toMatchObject({ slug: event.slug, tickets: 3, onLedger: 2 })
  })

  it('are reported even when nothing reached a ledger', async () => {
    // A fixture is still worth stopping on: the person deleting should decide,
    // rather than the script deciding for them by finding no transaction hash.
    const event = await seedEvent({ tickets: 2, minted: 0 })

    const blocked = await eventsWithTickets([event.id])

    expect(blocked[0]).toMatchObject({ tickets: 2, onLedger: 0 })
  })
})

describe('an event with no tickets', () => {
  it('is not blocked', async () => {
    // The control. A guard that blocks everything would pass the tests above.
    const event = await seedEvent({ tickets: 0, minted: 0 })

    await expect(eventsWithTickets([event.id])).resolves.toEqual([])
  })

  it('is not blocked when nothing is passed at all', async () => {
    await expect(eventsWithTickets([])).resolves.toEqual([])
  })
})

describe('the refusal message', () => {
  it('explains the consequence rather than just refusing', () => {
    // "Refusing to delete" without saying why invites someone to reach for the
    // force flag immediately, which defeats the guard.
    const msg = orphanedMetadataMessage([{ slug: 'summer-fest', tickets: 40, onLedger: 40 }])

    expect(msg).toContain('summer-fest')
    expect(msg).toContain('40')
    expect(msg).toMatch(/404|metadata/i)
    expect(msg).toContain(FORCE_FLAG)
  })
})
