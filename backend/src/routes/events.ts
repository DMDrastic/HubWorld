import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { issuesOf, slugSchema } from '../schemas.js'

import { ticketMetadata } from '../nft-metadata.js'

export const eventsRouter = Router()

const ListQuery = z.object({
  status: z.enum(['DRAFT', 'PUBLISHED', 'SOLD_OUT', 'COMPLETED', 'CANCELLED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

/** GET /api/events?status=PUBLISHED&limit=20 */
eventsRouter.get('/events', async (req, res) => {
  const parsed = ListQuery.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', details: issuesOf(parsed.error) })
    return
  }

  const { status, limit } = parsed.data

  const events = await prisma.event.findMany({
    where: status ? { status } : {},
    orderBy: { startsAt: 'asc' },
    take: limit,
    select: {
      slug: true,
      title: true,
      venue: true,
      startsAt: true,
      imageUrl: true,
      status: true,
      ticketCount: true,
      primaryPriceDrops: true,
      organizerId: true,
      organizer: { select: { username: true, displayName: true } },
      _count: { select: { tickets: true } },
    },
  })

  const forSale = await ticketsForSale(events)
  res.json({
    events: events.map(({ _count, organizerId, ...e }) => ({
      ...e,
      ticketsMinted: _count.tickets,
      ticketsForSale: forSale.get(e.slug) ?? 0,
    })),
  })
})

/**
 * How many tickets a buyer could take right now, per event slug.
 *
 * Unsold means: minted, still the organizer's, and not held by someone's
 * checkout (a held ticket is LISTED). Only events with a price have a box
 * office; the rest report 0 rather than a number a buyer could not act on.
 */
async function ticketsForSale(
  events: Array<{ slug: string; organizerId: string; primaryPriceDrops: bigint | null }>,
): Promise<Map<string, number>> {
  const priced = events.filter((e) => e.primaryPriceDrops !== null)
  const out = new Map<string, number>()
  if (priced.length === 0) return out

  const rows = await prisma.ticket.groupBy({
    by: ['eventId', 'ownerId'],
    where: { event: { slug: { in: priced.map((e) => e.slug) } }, status: 'MINTED' },
    _count: { _all: true },
  })
  const slugById = new Map(
    (await prisma.event.findMany({ where: { slug: { in: priced.map((e) => e.slug) } }, select: { id: true, slug: true } })).map(
      (e) => [e.id, e.slug] as const,
    ),
  )
  const organizerBySlug = new Map(priced.map((e) => [e.slug, e.organizerId] as const))
  for (const r of rows) {
    const slug = slugById.get(r.eventId)
    if (slug && organizerBySlug.get(slug) === r.ownerId) out.set(slug, (out.get(slug) ?? 0) + r._count._all)
  }
  return out
}

const SlugParams = z.object({ slug: slugSchema })

/** GET /api/events/:slug */
eventsRouter.get('/events/:slug', async (req, res) => {
  const parsed = SlugParams.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid slug', details: issuesOf(parsed.error) })
    return
  }

  const event = await prisma.event.findUnique({
    where: { slug: parsed.data.slug },
    select: {
      slug: true,
      title: true,
      description: true,
      venue: true,
      startsAt: true,
      imageUrl: true,
      status: true,
      ticketCount: true,
      nftTaxon: true,
      royaltyBps: true,
      platformBps: true,
      primaryPriceDrops: true,
      organizerId: true,
      organizer: { select: { username: true, displayName: true, xrplAddress: true } },
      _count: { select: { tickets: true } },
    },
  })

  if (!event) {
    res.status(404).json({ error: `No event "${parsed.data.slug}"` })
    return
  }

  const { _count, organizerId, ...rest } = event
  const forSale = await ticketsForSale([{ slug: event.slug, organizerId, primaryPriceDrops: event.primaryPriceDrops }])
  res.json({ ...rest, ticketsMinted: _count.tickets, ticketsForSale: forSale.get(event.slug) ?? 0 })
})

/**
 * GET /api/events/:slug/nft.json
 *
 * The XLS-24 document every ticket for this event points at. **Public and
 * unauthenticated on purpose**: it is read by wallets, indexers and explorers
 * that will never hold a session, and the URI is on a public ledger already.
 *
 * Cached for an hour rather than indefinitely — an organizer who fixes a typo
 * or uploads a poster should see it reflected, and nothing here is expensive
 * enough to need more.
 */
eventsRouter.get('/events/:slug/nft.json', async (req, res) => {
  const parsed = SlugParams.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: issuesOf(parsed.error) })
    return
  }

  const event = await prisma.event.findUnique({
    where: { slug: parsed.data.slug },
    select: { title: true, description: true, venue: true, startsAt: true, imageUrl: true },
  })

  if (!event) {
    res.status(404).json({ error: 'Event not found' })
    return
  }

  res.set('Cache-Control', 'public, max-age=3600')
  res.json(ticketMetadata(event))
})
