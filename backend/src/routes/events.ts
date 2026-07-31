import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { issuesOf, slugSchema } from '../schemas.js'

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
      organizer: { select: { username: true, displayName: true } },
      _count: { select: { tickets: true } },
    },
  })

  res.json({
    events: events.map(({ _count, ...e }) => ({ ...e, ticketsMinted: _count.tickets })),
  })
})

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
      organizer: { select: { username: true, displayName: true, xrplAddress: true } },
      _count: { select: { tickets: true } },
    },
  })

  if (!event) {
    res.status(404).json({ error: `No event "${parsed.data.slug}"` })
    return
  }

  const { _count, ...rest } = event
  res.json({ ...rest, ticketsMinted: _count.tickets })
})
