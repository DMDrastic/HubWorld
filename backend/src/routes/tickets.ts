/**
 * Ticket inventory.
 *
 * These reads are served from Postgres, which is a CACHE of ledger ownership.
 * `syncedAt` is returned alongside every ticket so a client can tell how stale
 * that claim is. Anything that acts on ownership (gifting, listing, settling an
 * auction) must re-read the ledger instead — see `holdsNft` in ledger.ts.
 */
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { issuesOf } from '../schemas.js'
import { requireAuth } from '../session.js'
import { accountNfts } from '../ledger.js'

export const ticketsRouter = Router()

const MineQuery = z.object({
  // Opt-in ledger reconciliation. Off by default because it costs a network
  // round-trip; on when the client is about to act on ownership.
  verify: z.enum(['true', 'false']).default('false'),
})

/** GET /api/tickets/mine?verify=true */
ticketsRouter.get('/tickets/mine', requireAuth, async (req, res) => {
  const parsed = MineQuery.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', details: issuesOf(parsed.error) })
    return
  }

  const me = await prisma.user.findUnique({ where: { id: req.userId! } })
  if (!me) {
    res.status(404).json({ error: 'User no longer exists' })
    return
  }

  const tickets = await prisma.ticket.findMany({
    where: { ownerId: me.id },
    include: { event: { select: { slug: true, title: true, startsAt: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  let heldOnLedger: Set<string> | null = null
  if (parsed.data.verify === 'true') {
    try {
      const nfts = await accountNfts(me.xrplAddress)
      heldOnLedger = new Set(nfts.map((n) => n.NFTokenID))
    } catch {
      // A ledger hiccup must not break the inventory view — fall back to the
      // cache and say so via `verified: false`.
      heldOnLedger = null
    }
  }

  res.json({
    address: me.xrplAddress,
    verified: heldOnLedger !== null,
    tickets: tickets.map((t) => ({
      nfTokenId: t.nfTokenId,
      seat: t.seat,
      tier: t.tier,
      status: t.status,
      syncedAt: t.syncedAt?.toISOString() ?? null,
      // Null when unverified; false means the ledger disagrees with our cache,
      // which is the case worth showing a user.
      onLedger: heldOnLedger === null ? null : heldOnLedger.has(t.nfTokenId),
      event: {
        slug: t.event.slug,
        title: t.event.title,
        startsAt: t.event.startsAt.toISOString(),
      },
    })),
  })
})
