/**
 * A process must not serve a database belonging to another ledger.
 *
 * `DATABASE_URL` and `XRPL_NETWORK` are independent, so nothing stopped a
 * testnet process opening the mainnet database and writing TESTNET rows into it.
 * The `network` column is what makes that detectable; this is what makes it
 * refused.
 *
 * Both directions are pinned, because a guard that only ever reports a problem
 * passes just as well when it reports one that is not there — and a false
 * positive here refuses to boot a perfectly good deployment.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { XrplNetwork } from '@prisma/client'
import { prisma } from '../src/prisma.js'
import { NETWORK } from '../src/network.js'
import { foreignNetworkRows, mismatchMessage } from '../src/network-guard.js'

/** Prefixed so a failed run is identifiable and cannot collide with fixtures. */
const SLUG = 'network-guard-foreign-fixture'

async function cleanup() {
  await prisma.event.deleteMany({ where: { slug: SLUG } })
}

afterEach(cleanup)

/** A ledger this process is definitely not on, whatever it is configured for. */
const FOREIGN = NETWORK === XrplNetwork.DEVNET ? XrplNetwork.MAINNET : XrplNetwork.DEVNET

async function organizerId(): Promise<string> {
  const user = await prisma.user.upsert({
    where: { username: 'network-guard-organizer' },
    update: {},
    create: {
      username: 'network-guard-organizer',
      xrplAddress: 'rNetworkGuardFixtureAddress00000000',
      role: 'ORGANIZER',
    },
  })
  return user.id
}

/** An Event on a ledger this process is not configured for. */
async function createForeignEvent() {
  return prisma.event.create({
    data: {
      slug: SLUG,
      title: 'Foreign ledger fixture',
      organizerId: await organizerId(),
      startsAt: new Date('2030-01-01T00:00:00Z'),
      nftTaxon: 999_001,
      ticketCount: 1,
      royaltyBps: 0,
      platformBps: 250,
      network: FOREIGN,
    },
  })
}

describe('foreignNetworkRows', () => {
  it('reports nothing when every row belongs to this network', async () => {
    // The control. Suites share one database, so this asserts the guard is quiet
    // on whatever else happens to be here — which is the state a real boot is in.
    await expect(foreignNetworkRows()).resolves.toEqual([])
  })

  it('finds a row written for another ledger, and names the model', async () => {
    await createForeignEvent()

    const rows = await foreignNetworkRows()

    expect(rows).toEqual([{ model: 'Event', count: 1 }])
  })

  it('goes quiet again once the foreign row is gone', async () => {
    // Pins that the check reads the database every time rather than latching. A
    // guard that stayed tripped after the mistake was corrected would be a
    // deployment that cannot be recovered without a code change.
    await createForeignEvent()
    expect(await foreignNetworkRows()).toHaveLength(1)

    await cleanup()

    await expect(foreignNetworkRows()).resolves.toEqual([])
  })
})

describe('mismatchMessage', () => {
  it('names both sides, not just that something is wrong', () => {
    const msg = mismatchMessage([
      { model: 'Ticket', count: 3 },
      { model: 'Bid', count: 7 },
    ])

    // The actionable part: which process, and which rows. "Wrong network" alone
    // tells an operator nothing about which of the two variables to change.
    expect(msg).toContain(NETWORK)
    expect(msg).toContain('Ticket: 3')
    expect(msg).toContain('Bid: 7')
    expect(msg).toContain('DATABASE_URL')
    expect(msg).toContain('XRPL_NETWORK')
  })
})
