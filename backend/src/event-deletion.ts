import { prisma } from './prisma.js'

/**
 * An event row can be deleted. The tickets minted from it cannot.
 *
 * Every ticket carries an on-ledger URI pointing at
 * `/api/events/:slug/nft.json`, which is where a wallet reads its name and
 * image from. That URI is written into the NFT and is public, permanent, and
 * outside our control — so **serving it is a promise the database must not be
 * able to revoke.**
 *
 * Found the hard way on 2026-08-26. A test event was purged from production
 * after its ticket had been minted; the URI began returning 404, and the token
 * only still rendered because Xaman had cached the metadata. Anything fetching
 * fresh would have got nothing. Tokens minted since carry `tfMutable`, so a
 * broken URI is recoverable — but only by an organizer-signed transaction per
 * ticket, against the wallet-interaction budget that caps event size.
 *
 * So deleting an event that has tickets is refused. The escape hatch is
 * explicit, because fixtures genuinely do need clearing and a guard with no way
 * through gets commented out the first time it is inconvenient.
 */

export const FORCE_FLAG = '--delete-minted-tickets'

export type EventDeletionBlock = { slug: string; tickets: number; onLedger: number }

/**
 * Which of these events still have tickets, and how many reached a ledger.
 *
 * `onLedger` counts tickets with a MINT provenance row carrying a transaction
 * hash — the ones that exist in somebody's wallet rather than as a fixture.
 * Both numbers are reported because they answer different questions: whether
 * anything would be orphaned at all, and whether it matters to a real holder.
 */
export async function eventsWithTickets(eventIds: string[]): Promise<EventDeletionBlock[]> {
  if (eventIds.length === 0) return []

  const events = await prisma.event.findMany({
    where: { id: { in: eventIds } },
    select: {
      slug: true,
      tickets: {
        select: {
          id: true,
          transfers: { where: { kind: 'MINT', txHash: { not: '' } }, select: { id: true } },
        },
      },
    },
  })

  return events
    .filter((e) => e.tickets.length > 0)
    .map((e) => ({
      slug: e.slug,
      tickets: e.tickets.length,
      onLedger: e.tickets.filter((t) => t.transfers.length > 0).length,
    }))
}

export function orphanedMetadataMessage(blocked: EventDeletionBlock[]): string {
  const detail = blocked
    .map((b) => `  ${b.slug}: ${b.tickets} ticket(s), ${b.onLedger} minted on-ledger`)
    .join('\n')

  return (
    `Refusing to delete ${blocked.length} event(s) that still have tickets.\n\n${detail}\n\n` +
    `Every minted ticket carries an on-ledger URI pointing at this event's ` +
    `metadata. Deleting the event makes that URI return 404, so wallets lose the ` +
    `ticket's name and image — permanently for tokens minted before tfMutable, ` +
    `and otherwise only recoverable with one organizer signature per ticket.\n\n` +
    `If these are fixtures nobody holds, re-run with ${FORCE_FLAG}.`
  )
}

/**
 * Refuse, unless told explicitly.
 *
 * Called before the cascade rather than inside it: by the time children are
 * being deleted the evidence of what was minted has already gone.
 */
export async function assertEventsDeletable(
  eventIds: string[],
  argv: string[] = process.argv,
): Promise<void> {
  const blocked = await eventsWithTickets(eventIds)
  if (blocked.length === 0) return

  if (argv.includes(FORCE_FLAG)) {
    const total = blocked.reduce((n, b) => n + b.onLedger, 0)
    console.warn(
      `${FORCE_FLAG} given — deleting ${blocked.length} event(s); ` +
        `${total} ticket(s) minted on-ledger will lose their metadata.`,
    )
    return
  }

  console.error(orphanedMetadataMessage(blocked))
  process.exit(1)
}
