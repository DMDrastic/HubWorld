/**
 * Reconcile Postgres against the XRP Ledger.
 *
 * The ledger owns ownership; Postgres is a cache. A holder can move a ticket in
 * Xaman without touching Hubworld, a settlement can happen out-of-band, and an
 * offer can be consumed or cancelled without us observing it. This walks the
 * ledger and reports — or fixes — every disagreement.
 *
 * Dry run by default. Nothing is written without `--apply`, because a reconciler
 * that silently rewrites ownership is worse than the drift it corrects.
 *
 *   npm run ledger:sync              # report only
 *   npm run ledger:sync -- --apply   # fix what it found
 */
import { prisma } from '../src/prisma.js'
import { accountNfts, disconnectLedger, ledger } from '../src/ledger.js'

const APPLY = process.argv.includes('--apply')

type Finding = { kind: string; detail: string; fixed: boolean }
const findings: Finding[] = []

function note(kind: string, detail: string, fixed = false) {
  findings.push({ kind, detail, fixed })
}

/** Whether an NFTokenOffer still exists on-ledger. */
async function offerExists(index: string): Promise<boolean> {
  const c = await ledger()
  try {
    await c.request({ command: 'ledger_entry', index, ledger_index: 'validated' })
    return true
  } catch {
    return false
  }
}

async function main() {
  const users = await prisma.user.findMany({
    select: { id: true, username: true, xrplAddress: true },
  })

  // nfTokenId -> the account that actually holds it, per the ledger.
  const holders = new Map<string, { id: string; username: string; address: string }>()
  for (const u of users) {
    let nfts: Awaited<ReturnType<typeof accountNfts>> = []
    try {
      nfts = await accountNfts(u.xrplAddress)
    } catch {
      note('unreachable', `could not read NFTs for @${u.username}`)
      continue
    }
    for (const n of nfts) {
      holders.set(n.NFTokenID, { id: u.id, username: u.username, address: u.xrplAddress })
    }
  }

  // ---- tickets: the ledger decides -------------------------------------
  const tickets = await prisma.ticket.findMany({
    include: { owner: { select: { username: true } } },
  })

  for (const t of tickets) {
    const onLedger = holders.get(t.nfTokenId)
    const dbOwner = t.owner?.username ?? '(none)'

    if (!onLedger) {
      // Held by nobody we know. Not necessarily gone — it may sit with an
      // address that has no Hubworld account — so the cache is cleared rather
      // than the ticket deleted.
      if (t.ownerId !== null) {
        note(
          'ticket-left-known-users',
          `${t.nfTokenId.slice(-6)}: db says @${dbOwner}, ledger says nobody we know`,
          APPLY,
        )
        if (APPLY) {
          await prisma.ticket.update({
            where: { id: t.id },
            data: { ownerId: null, ownerAddress: null, syncedAt: new Date() },
          })
        }
      }
      continue
    }

    if (onLedger.username !== dbOwner) {
      note(
        'ticket-owner-drift',
        `${t.nfTokenId.slice(-6)}: db @${dbOwner} -> ledger @${onLedger.username}`,
        APPLY,
      )
      if (APPLY) {
        await prisma.ticket.update({
          where: { id: t.id },
          data: {
            ownerId: onLedger.id,
            ownerAddress: onLedger.address,
            syncedAt: new Date(),
          },
        })
      }
    } else if (APPLY) {
      // Agreement is still worth recording: syncedAt is how a reader knows how
      // fresh the claim is.
      await prisma.ticket.update({ where: { id: t.id }, data: { syncedAt: new Date() } })
    }
  }

  // NFTs on-ledger that we have no Ticket row for, matched to an event by taxon.
  const knownIds = new Set(tickets.map((t) => t.nfTokenId))
  const events = await prisma.event.findMany({ select: { id: true, slug: true, nftTaxon: true } })
  const byTaxon = new Map(events.map((e) => [e.nftTaxon, e]))

  for (const [nfTokenId, holder] of holders) {
    if (knownIds.has(nfTokenId)) continue
    // Taxon is the low-order field of the id but is scrambled inside it, so ask
    // the ledger rather than parsing.
    const nfts = await accountNfts(holder.address)
    const match = nfts.find((n) => n.NFTokenID === nfTokenId)
    const event = match ? byTaxon.get(match.NFTokenTaxon) : undefined
    if (!event) {
      note('unknown-nft', `${nfTokenId.slice(-6)} held by @${holder.username}, taxon not ours`)
      continue
    }
    note('ticket-missing', `${nfTokenId.slice(-6)} held by @${holder.username} (${event.slug})`, APPLY)
    if (APPLY) {
      await prisma.ticket.create({
        data: {
          nfTokenId,
          eventId: event.id,
          ownerId: holder.id,
          ownerAddress: holder.address,
          syncedAt: new Date(),
          status: 'MINTED',
        },
      })
    }
  }

  // ---- listings: is the offer still there? ------------------------------
  const listings = await prisma.listing.findMany({
    where: { status: { in: ['ACTIVE', 'BUYER_PENDING', 'SETTLING', 'CANCELLING', 'FAILED'] } },
    include: { seller: { select: { username: true } }, buyer: { select: { username: true } } },
  })

  for (const l of listings) {
    if (!l.offerIndex) continue
    const live = await offerExists(l.offerIndex)

    if (!live && l.status !== 'FAILED') {
      // The sell offer is gone, so this listing cannot settle through us —
      // whatever happened, happened without us watching.
      note(
        'listing-offer-gone',
        `${l.id.slice(0, 8)} @${l.seller.username} ${l.priceDrops}drops is ${l.status} but its offer is consumed`,
        APPLY,
      )
      if (APPLY) {
        await prisma.listing.update({
          where: { id: l.id },
          data: { status: 'CANCELLED', closedAt: new Date(), failureReason: 'Offer no longer on-ledger' },
        })
      }
      continue
    }

    if (live && l.status === 'FAILED') {
      // Worth surfacing loudly: tecINSUFFICIENT_FUNDS is NOT terminal. Both
      // offers can still be live and the buyer may since have been paid, so a
      // permanently FAILED listing is a settleable sale we have written off.
      note(
        'failed-but-retryable',
        `${l.id.slice(0, 8)} @${l.seller.username} -> @${l.buyer?.username ?? '?'} ` +
          `${l.priceDrops}drops: marked FAILED but its offer is still live`,
      )
    }
  }

  // ---- report -----------------------------------------------------------
  console.log(APPLY ? 'ledger sync — APPLYING\n' : 'ledger sync — dry run (use --apply to fix)\n')

  if (findings.length === 0) {
    console.log('  Postgres and the ledger agree. Nothing to do.')
  } else {
    const groups = new Map<string, Finding[]>()
    for (const f of findings) {
      const list = groups.get(f.kind) ?? []
      list.push(f)
      groups.set(f.kind, list)
    }
    for (const [kind, list] of groups) {
      console.log(`${kind} (${list.length})`)
      for (const f of list) console.log(`  ${f.fixed ? '[fixed]' : '[found]'} ${f.detail}`)
      console.log()
    }
  }

  const fixed = findings.filter((f) => f.fixed).length
  console.log(`${findings.length} finding(s), ${fixed} fixed.`)
  if (!APPLY && findings.length > 0) console.log('Re-run with --apply to write these changes.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    // The XRPL websocket keeps the event loop alive; without closing it the
    // script never exits and its output is never flushed.
    await disconnectLedger()
    await prisma.$disconnect()
  })
