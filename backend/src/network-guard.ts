import { XrplNetwork } from '@prisma/client'
import { prisma } from './prisma.js'
import { NETWORK } from './network.js'

/**
 * Refuse to serve a database that belongs to another ledger.
 *
 * `DATABASE_URL` and `XRPL_NETWORK` are independent variables, and nothing tied
 * them together: a process configured for testnet will happily open the mainnet
 * database, write TESTNET rows into it, and report itself healthy. One stale
 * shell, one forgotten `DOTENV_CONFIG_PATH`, and two ledgers share a table.
 *
 * The `network` column makes that survivable — it is why the mistake can be
 * DETECTED here at all — but it does not make it safe. Read-only list endpoints
 * are not scoped by it, so foreign rows are served as if they were ours, and an
 * `nfTokenId` is only unique PER network: the same seed minting the same taxon
 * at the same sequence on two networks produces byte-identical ids. Mixed rows
 * therefore collide on lookups that look perfectly correct.
 *
 * So this is fatal rather than a warning. The recommendation has always been one
 * database per network; this is what makes it enforced rather than remembered.
 */

/** Every model carrying a `network` column, checked against the schema. */
const MODELS = [
  'Event',
  'MintRequest',
  'Ticket',
  'Gift',
  'Redemption',
  'Listing',
  'Auction',
  'Bid',
  'Transfer',
  'XamanPayload',
] as const

export type ForeignRows = {
  model: (typeof MODELS)[number]
  /** WHICH other ledger. Naming it turns "something is wrong" into a diagnosis. */
  network: XrplNetwork
  count: number
}

/**
 * Rows in this database that belong to a DIFFERENT ledger than this process.
 *
 * Counted per model rather than summed, because "which table" is the first thing
 * anyone asks and a single total answers nothing. Empty is the healthy result.
 *
 * Written out one call per model rather than looped over a dynamic key, so the
 * compiler checks each one: a model that gains a `network` column and is not
 * added here is a gap no test would notice, and `prisma[name]` indexing would
 * hide exactly that.
 */
export async function foreignNetworkRows(): Promise<ForeignRows[]> {
  const foreign = Object.values(XrplNetwork).filter((n) => n !== NETWORK)
  const perNetwork = await Promise.all(foreign.map(countsOn))
  return perNetwork.flat()
}

/**
 * The ten counts, for one foreign ledger.
 *
 * Counted per network rather than "everything that is not us" so the message
 * can name the ledger. At most two foreign networks exist, so this is twenty
 * cheap counts at boot — paid once, at startup, to avoid a whole class of
 * silent data mixing.
 */
async function countsOn(network: XrplNetwork): Promise<ForeignRows[]> {
  const where = { network } as const

  const [event, mintRequest, ticket, gift, redemption, listing, auction, bid, transfer, payload] =
    await Promise.all([
      prisma.event.count({ where }),
      prisma.mintRequest.count({ where }),
      prisma.ticket.count({ where }),
      prisma.gift.count({ where }),
      prisma.redemption.count({ where }),
      prisma.listing.count({ where }),
      prisma.auction.count({ where }),
      prisma.bid.count({ where }),
      prisma.transfer.count({ where }),
      prisma.xamanPayload.count({ where }),
    ])

  const counts: ForeignRows[] = [
    { model: 'Event', network, count: event },
    { model: 'MintRequest', network, count: mintRequest },
    { model: 'Ticket', network, count: ticket },
    { model: 'Gift', network, count: gift },
    { model: 'Redemption', network, count: redemption },
    { model: 'Listing', network, count: listing },
    { model: 'Auction', network, count: auction },
    { model: 'Bid', network, count: bid },
    { model: 'Transfer', network, count: transfer },
    { model: 'XamanPayload', network, count: payload },
  ]

  return counts.filter((c) => c.count > 0)
}

/**
 * The message printed before refusing to start.
 *
 * Split from the exit so it can be asserted without a process boundary, and so
 * the wording is pinned: it must name BOTH sides. "Wrong network" tells someone
 * nothing they can act on; "this process is MAINNET, this database holds TESTNET
 * rows" tells them which of the two variables to change.
 */
export function mismatchMessage(rows: ForeignRows[]): string {
  const detail = rows.map((r) => `  ${r.network} ${r.model}: ${r.count}`).join('\n')
  return (
    `Refusing to start: this process is configured for ${NETWORK}, but the database ` +
    `holds rows belonging to another ledger.\n\n${detail}\n\n` +
    `One database per network. Either point DATABASE_URL at the ${NETWORK} database, ` +
    `or set XRPL_NETWORK to match the data already here.`
  )
}

/**
 * Check at boot, and exit rather than serve a mixed database.
 *
 * A failed QUERY is deliberately not fatal. If Postgres is unreachable this
 * learns nothing either way, and crashing would turn a brief database blip into
 * a crash loop — while `/api/health` already reports `db: unavailable`, which is
 * the honest answer. Refuse on evidence, never on the absence of it.
 */
export async function assertDatabaseNetwork(): Promise<void> {
  let rows: ForeignRows[]
  try {
    rows = await foreignNetworkRows()
  } catch (err) {
    console.warn('Could not verify the database network (is Postgres up?):', err)
    return
  }

  if (rows.length === 0) return

  console.error(mismatchMessage(rows))
  process.exit(1)
}
