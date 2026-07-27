/**
 * Becoming an organizer, and creating events once you are.
 *
 * Organizers issue real admission and take real money, so the role is **reviewed
 * rather than self-declared**. A regular user applies; an admin approves. Nothing
 * a user sends can promote them.
 *
 * The other rule enforced here: **`platformBps` is platform policy, never
 * organizer input.** An organizer choosing Hubworld's cut would choose zero, and
 * because the fee is frozen onto each Listing at creation it would not be
 * retroactively fixable. `royaltyBps` IS theirs to choose — it is their revenue —
 * but it is capped, since an unbounded royalty makes resale pointless and the
 * ticket effectively non-transferable.
 */
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { env } from '../env.js'
import { issuesOf, slugSchema } from '../schemas.js'
import { requireAdmin, requireAuth, requireOrganizer } from '../session.js'

export const organizersRouter = Router()

const ApplyBody = z.object({
  orgName: z.string().trim().min(2).max(80),
  contact: z.string().trim().min(3).max(120),
  pitch: z.string().trim().min(10).max(1000),
})

/**
 * POST /api/organizers/apply
 * Any signed-in user may apply. Re-applying updates the existing row.
 */
organizersRouter.post('/organizers/apply', requireAuth, async (req, res) => {
  const parsed = ApplyBody.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid application', details: issuesOf(parsed.error) })
    return
  }

  if (req.userRole === 'ORGANIZER' || req.userRole === 'ADMIN') {
    res.status(409).json({ error: 'You are already an organizer' })
    return
  }

  const existing = await prisma.organizerApplication.findUnique({
    where: { userId: req.userId! },
  })
  if (existing?.status === 'PENDING') {
    res.status(409).json({ error: 'Your application is already under review' })
    return
  }

  // Upsert rather than insert: one application per user, so a rejected applicant
  // can revise and resubmit without filling the review queue with duplicates.
  const application = await prisma.organizerApplication.upsert({
    where: { userId: req.userId! },
    create: { userId: req.userId!, ...parsed.data },
    update: {
      ...parsed.data,
      status: 'PENDING',
      reviewedById: null,
      reviewedAt: null,
      reviewNote: null,
    },
  })

  res.status(201).json({
    state: application.status.toLowerCase(),
    orgName: application.orgName,
    submittedAt: application.createdAt.toISOString(),
  })
})

/** GET /api/organizers/me — my role and application status. */
organizersRouter.get('/organizers/me', requireAuth, async (req, res) => {
  const application = await prisma.organizerApplication.findUnique({
    where: { userId: req.userId! },
  })

  res.json({
    role: req.userRole ?? 'USER',
    application: application
      ? {
          state: application.status.toLowerCase(),
          orgName: application.orgName,
          submittedAt: application.createdAt.toISOString(),
          reviewNote: application.reviewNote,
        }
      : null,
  })
})

// ------------------------------------------------------------------ admin --

/** GET /api/admin/organizer-applications?state=pending */
organizersRouter.get(
  '/admin/organizer-applications',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const state = z
      .enum(['pending', 'approved', 'rejected'])
      .default('pending')
      .safeParse(req.query.state)
    if (!state.success) {
      res.status(400).json({ error: 'Invalid state' })
      return
    }

    const applications = await prisma.organizerApplication.findMany({
      where: { status: state.data.toUpperCase() as 'PENDING' | 'APPROVED' | 'REJECTED' },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: { user: { select: { username: true, xrplAddress: true } } },
    })

    res.json({
      applications: applications.map((a) => ({
        id: a.id,
        applicant: `@${a.user.username}`,
        orgName: a.orgName,
        contact: a.contact,
        pitch: a.pitch,
        state: a.status.toLowerCase(),
        submittedAt: a.createdAt.toISOString(),
      })),
    })
  },
)

const ReviewBody = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(500).optional(),
})

/** POST /api/admin/organizer-applications/:id/review */
organizersRouter.post(
  '/admin/organizer-applications/:id/review',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id)
    const body = ReviewBody.safeParse(req.body ?? {})
    if (!id.success || !body.success) {
      res.status(400).json({ error: 'Invalid review' })
      return
    }

    const application = await prisma.organizerApplication.findUnique({ where: { id: id.data } })
    if (!application) {
      res.status(404).json({ error: 'Application not found' })
      return
    }
    if (application.status !== 'PENDING') {
      res.status(409).json({ error: `Already ${application.status.toLowerCase()}` })
      return
    }

    const approved = body.data.decision === 'approve'

    // Role and application move together: an approval that failed to grant the
    // role would leave someone told they are an organizer who cannot act.
    await prisma.$transaction([
      prisma.organizerApplication.update({
        where: { id: application.id },
        data: {
          status: approved ? 'APPROVED' : 'REJECTED',
          reviewedById: req.userId!,
          reviewedAt: new Date(),
          reviewNote: body.data.note ?? null,
        },
      }),
      ...(approved
        ? [
            prisma.user.update({
              where: { id: application.userId },
              data: { role: 'ORGANIZER' },
            }),
          ]
        : []),
    ])

    res.json({ state: approved ? 'approved' : 'rejected' })
  },
)

// ------------------------------------------------------- event creation ----

const CreateEventBody = z.object({
  title: z.string().trim().min(3).max(120),
  venue: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  startsAt: z.coerce.date(),
  ticketCount: z.coerce.number().int().min(1).max(100_000),
  // Theirs to set, within policy.
  royaltyBps: z.coerce.number().int().min(0),
  slug: slugSchema.optional(),
  // NOTE: platformBps is deliberately absent. It is policy, not input.
})

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * POST /api/events — organizer-only.
 */
organizersRouter.post('/events', requireAuth, requireOrganizer, async (req, res) => {
  const parsed = CreateEventBody.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid event', details: issuesOf(parsed.error) })
    return
  }
  const data = parsed.data

  if (data.royaltyBps > env.MAX_ROYALTY_BPS) {
    res.status(400).json({
      error: `Royalty cannot exceed ${env.MAX_ROYALTY_BPS} bps`,
      maxRoyaltyBps: env.MAX_ROYALTY_BPS,
    })
    return
  }
  if (data.startsAt.getTime() < Date.now()) {
    res.status(400).json({ error: 'An event cannot start in the past' })
    return
  }

  const slug = data.slug ?? slugify(data.title)
  if (await prisma.event.findUnique({ where: { slug } })) {
    res.status(409).json({ error: `The URL "${slug}" is taken — choose a different title or slug` })
    return
  }

  // Taxon groups an event's tickets on-ledger, so it must be unique per event or
  // account_nfts could not separate two events' tickets.
  const highest = await prisma.event.findFirst({
    orderBy: { nftTaxon: 'desc' },
    select: { nftTaxon: true },
  })

  const event = await prisma.event.create({
    data: {
      slug,
      title: data.title,
      venue: data.venue ?? null,
      description: data.description ?? null,
      startsAt: data.startsAt,
      organizerId: req.userId!,
      nftTaxon: (highest?.nftTaxon ?? 1000) + 1,
      royaltyBps: data.royaltyBps,
      // Policy, taken from the server. Never from the request body.
      platformBps: env.PLATFORM_FEE_BPS,
      ticketCount: data.ticketCount,
      status: 'PUBLISHED',
    },
  })

  res.status(201).json({
    slug: event.slug,
    title: event.title,
    startsAt: event.startsAt.toISOString(),
    ticketCount: event.ticketCount,
    royaltyBps: event.royaltyBps,
    platformBps: event.platformBps,
    nftTaxon: event.nftTaxon,
  })
})

/** GET /api/policy — the terms a would-be organizer needs to see up front. */
organizersRouter.get('/policy', (_req, res) => {
  res.json({
    platformBps: env.PLATFORM_FEE_BPS,
    maxRoyaltyBps: env.MAX_ROYALTY_BPS,
  })
})
