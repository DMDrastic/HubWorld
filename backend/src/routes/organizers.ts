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
import { NETWORK } from '../network.js'
import { env, doorTokenMode, feeModelV2, looseResalePolicies, privyMode, signersEnabled } from '../env.js'
import { currentMinimumResaleDrops } from '../listing-terms.js'
import { issuesOf, slugSchema } from '../schemas.js'
import { requireAdmin, requireAuth, requireOrganizer } from '../session.js'
import {
  resendWaitSeconds,
  sendDecision,
  sendVerification,
  verifyEmail,
} from '../organizer-email.js'

export const organizersRouter = Router()

const ApplyBody = z.object({
  orgName: z.string().trim().min(2).max(80),
  // Lower-cased so the same address typed two ways is one address, which matters
  // because a verification link vouches for an exact string.
  email: z.string().trim().toLowerCase().email().max(254),
  // Anything else worth knowing (a phone, a handle). Optional: email is how we reach them.
  contact: z.string().trim().max(120).optional(),
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
  const { email, contact, ...rest } = parsed.data
  // Verification belongs to an ADDRESS, not to the applicant: resubmitting with the
  // same email keeps it verified, and any other address starts unverified.
  const keepsVerification = existing?.email === email && existing.emailVerifiedAt !== null
  const application = await prisma.organizerApplication.upsert({
    where: { userId: req.userId! },
    create: { userId: req.userId!, ...rest, email, contact: contact ?? '' },
    update: {
      ...rest,
      email,
      contact: contact ?? '',
      emailVerifiedAt: keepsVerification ? existing.emailVerifiedAt : null,
      status: 'PENDING',
      reviewedById: null,
      reviewedAt: null,
      reviewNote: null,
    },
  })

  // Best-effort: the application stands whether or not the email goes out, and the
  // response says which, so the page can offer a resend instead of waiting for nothing.
  const emailSent = keepsVerification
    ? null
    : (await sendVerification(application)) === 'sent'

  res.status(201).json({
    state: application.status.toLowerCase(),
    orgName: application.orgName,
    submittedAt: application.createdAt.toISOString(),
    emailVerified: application.emailVerifiedAt !== null,
    emailSent,
  })
})

/**
 * POST /api/organizers/email/resend — send the verification link again.
 * Cooldown-limited, and only for an application whose address is still unverified.
 */
organizersRouter.post('/organizers/email/resend', requireAuth, async (req, res) => {
  const application = await prisma.organizerApplication.findUnique({
    where: { userId: req.userId! },
  })
  if (!application?.email) {
    res.status(404).json({ error: 'No application with an email' })
    return
  }
  if (application.emailVerifiedAt) {
    res.status(409).json({ error: 'Your email is already confirmed' })
    return
  }
  const wait = await resendWaitSeconds(application.id)
  if (wait > 0) {
    res.setHeader('Retry-After', String(wait))
    res.status(429).json({ error: `Wait ${wait}s before asking for another email` })
    return
  }
  res.json({ emailSent: (await sendVerification(application)) === 'sent' })
})

const VerifyBody = z.object({ token: z.string().min(20).max(200) })

/**
 * POST /api/organizers/email/verify — consume an emailed link.
 *
 * Unauthenticated on purpose: people open the link on whatever device holds the
 * email, which is often not the one they signed in on. The 256-bit token is the proof.
 * It is a POST, issued by the page the link opens, never a GET, because mail
 * scanners and link previewers fetch every URL in a message and would burn the token.
 */
organizersRouter.post('/organizers/email/verify', async (req, res) => {
  const body = VerifyBody.safeParse(req.body ?? {})
  const outcome = body.success ? await verifyEmail(body.data.token) : 'invalid'
  if (outcome !== 'verified') {
    res.status(400).json({ error: 'This link is invalid or has expired' })
    return
  }
  res.json({ verified: true })
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
          // Their own address, back to them. Null for applications from before email.
          email: application.email,
          emailVerified: application.emailVerifiedAt !== null,
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
        email: a.email,
        emailVerified: a.emailVerifiedAt !== null,
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

    // After the transaction, never inside it: a mail outage must not undo a review.
    // Goes only to a verified address (see `sendDecision`).
    const notified = await sendDecision(application, approved, body.data.note ?? null)

    res.json({ state: approved ? 'approved' : 'rejected', notified: notified === 'sent' })
  },
)

const FoundingBody = z.object({ founding: z.boolean() })

/**
 * POST /api/admin/organizers/:username/founding   { founding: true | false }
 *
 * Marks an organizer as one of the first ~10 "founding" organizers, who pay the lower fan fee on events
 * starting before the promo's end date. ADMIN ONLY, and deliberately a route of its own: it is not a field
 * on any body an organizer controls (applying, creating an event), because an organizer choosing their own
 * discount would choose the discount. Only an organizer can be flagged; the flag means nothing otherwise.
 * Marking someone who is already marked keeps the original grant time.
 */
organizersRouter.post('/admin/organizers/:username/founding', requireAuth, requireAdmin, async (req, res) => {
  const body = FoundingBody.safeParse(req.body ?? {})
  if (!body.success) {
    res.status(400).json({ error: 'Send { "founding": true } or { "founding": false }' })
    return
  }
  const username = String(req.params.username ?? '').replace(/^@/, '').toLowerCase()
  const user = await prisma.user.findUnique({ where: { username } })
  if (!user) {
    res.status(404).json({ error: 'No such user' })
    return
  }
  if (user.role !== 'ORGANIZER') {
    res.status(409).json({ error: 'Only an organizer can be a founding organizer' })
    return
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: body.data.founding
      ? { foundingOrganizer: true, foundingGrantedAt: user.foundingGrantedAt ?? new Date() }
      : { foundingOrganizer: false, foundingGrantedAt: null },
  })
  res.json({ username: updated.username, founding: updated.foundingOrganizer, grantedAt: updated.foundingGrantedAt })
})

// ------------------------------------------------------- event creation ----

const CreateEventBody = z
  .object({
    title: z.string().trim().min(3).max(120),
    venue: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
    startsAt: z.coerce.date(),
    ticketCount: z.coerce.number().int().min(1).max(100_000),
    // Theirs to set, within policy.
    royaltyBps: z.coerce.number().int().min(0),
    slug: slugSchema.optional(),
    // NOTE: platformBps is deliberately absent. It is policy, not input.

    // Create-time only — there is no event-edit route, same as the fields
    // above. Governs resale price only; gifting is untouched regardless of
    // policy, since the two are deliberately not coupled.
    resalePolicy: z
      .enum(['UNRESTRICTED', 'PERCENTAGE_CAP', 'FIXED_CAP', 'FACE_VALUE_ONLY', 'DISABLED'])
      // Under the new fee model an unrestricted default would promise more than will happen.
      .default(looseResalePolicies ? 'UNRESTRICTED' : 'FACE_VALUE_ONLY'),
    // Where the event is, for fees. The founding promo is decided by when the event starts in ITS OWN
    // zone, and the region chooses the card-processing rates. Both default to the pilot (St. Lucia).
    timeZone: z
      .string()
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: zone })
          return true
        } catch {
          return false
        }
      }, 'timeZone must be a real IANA time zone, e.g. America/St_Lucia')
      .optional(),
    feeRegion: z.enum(['CARIBBEAN', 'CANADA']).optional(),
    // The box-office price of one ticket, in drops. Optional: an event without
    // one has no checkout (tickets are held, gifted or listed by hand). Money is
    // a string of integer drops, never a float.
    primaryPriceDrops: z
      .string()
      .regex(/^[1-9][0-9]{0,17}$/, 'primaryPriceDrops must be a positive integer string of drops')
      .optional(),
    // How people are let in. Absent: the Xaman signature door, always. The code
    // door is faster but proves less (a session, not a wallet key), so an
    // organizer opts into it knowingly; it is never what an event drifts into.
    doorMode: z.enum(['QR', 'SIGNATURE']).optional(),
    // 10000 = 100% of face value, so 12000 = 120%.
    resaleCapBps: z.coerce.number().int().positive().optional(),
    resaleCapDrops: z
      .string()
      .regex(/^[1-9][0-9]{0,17}$/, 'resaleCapDrops must be a positive integer string of drops')
      .optional(),
  })
  .superRefine((data, ctx) => {
    const needs = { PERCENTAGE_CAP: 'resaleCapBps', FIXED_CAP: 'resaleCapDrops' } as const
    for (const [policy, field] of Object.entries(needs)) {
      const has = field === 'resaleCapBps' ? data.resaleCapBps !== undefined : data.resaleCapDrops !== undefined
      if (data.resalePolicy === policy && !has) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${field} is required when resalePolicy is ${policy}` })
      }
    }
    if (data.resalePolicy !== 'PERCENTAGE_CAP' && data.resaleCapBps !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['resaleCapBps'], message: 'resaleCapBps only applies to PERCENTAGE_CAP' })
    }
    if (data.resalePolicy !== 'FIXED_CAP' && data.resaleCapDrops !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['resaleCapDrops'], message: 'resaleCapDrops only applies to FIXED_CAP' })
    }

    // A ticket can never be resold for more than its buyer paid, so a policy that allows more than that
    // promises the organizer something that will not happen. Refused for NEW events unless re-enabled; the
    // paths and every existing event are untouched.
    if (!looseResalePolicies) {
      const note = 'resale is capped at what the buyer paid, so a policy that allows more than that is not offered'
      if (data.resalePolicy === 'UNRESTRICTED') {
        ctx.addIssue({ code: 'custom', path: ['resalePolicy'], message: `UNRESTRICTED is not available: ${note}` })
      }
      if (data.resalePolicy === 'PERCENTAGE_CAP' && data.resaleCapBps !== undefined && data.resaleCapBps > 10_000) {
        ctx.addIssue({ code: 'custom', path: ['resaleCapBps'], message: `A cap above 100% is not available: ${note}` })
      }
      if (data.resalePolicy === 'FIXED_CAP' && data.resaleCapDrops !== undefined && data.primaryPriceDrops !== undefined) {
        if (BigInt(data.resaleCapDrops) > BigInt(data.primaryPriceDrops)) {
          ctx.addIssue({ code: 'custom', path: ['resaleCapDrops'], message: `A cap above the ticket price is not available: ${note}` })
        }
      }
    }
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
  if (data.doorMode === 'QR' && doorTokenMode !== 'live') {
    res.status(409).json({ error: 'Door codes are not set up on this server yet', code: 'DOOR_CODES_OFF' })
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

  const doorMode = data.doorMode ?? 'SIGNATURE'
  const event = await prisma.event.create({
    data: {
      slug,
      network: NETWORK,
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
      resalePolicy: data.resalePolicy,
      resaleCapBps: data.resaleCapBps ?? null,
      resaleCapDrops: data.resaleCapDrops ? BigInt(data.resaleCapDrops) : null,
      primaryPriceDrops: data.primaryPriceDrops ? BigInt(data.primaryPriceDrops) : null,
      doorMode,
      // Left to the column defaults (the pilot's zone and region) when the organizer says nothing.
      ...(data.timeZone ? { timeZone: data.timeZone } : {}),
      ...(data.feeRegion ? { feeRegion: data.feeRegion } : {}),
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
    doorMode: event.doorMode,
    resalePolicy: event.resalePolicy,
    resaleCapBps: event.resaleCapBps,
    resaleCapDrops: event.resaleCapDrops?.toString() ?? null,
    primaryPriceDrops: event.primaryPriceDrops?.toString() ?? null,
  })
})

/** GET /api/policy — the terms a would-be organizer needs to see up front. */
organizersRouter.get('/policy', async (_req, res) => {
  // Only under the new model, which is the only one with a floor. `null`: there is no usable XRP price right now.
  const floor = feeModelV2 ? await currentMinimumResaleDrops() : undefined
  res.json({
    platformBps: env.PLATFORM_FEE_BPS,
    maxRoyaltyBps: env.MAX_ROYALTY_BPS,
    // Whether this server can sign door codes, so the form offers the choice only
    // where it will work.
    doorCodes: doorTokenMode === 'live',
    // Which ways a person may sign in and sign. `privyAppId` is public (it is the audience of
    // every Privy token and the browser needs it to start the login), and is omitted unless
    // Privy is actually on, so a deploy with the flag off reveals nothing and offers nothing.
    signers: [...signersEnabled],
    privyAppId: privyMode === 'live' ? env.PRIVY_APP_ID : undefined,
    // Which fee model new sales use, and whether the resale policies that allow more than was paid are still
    // offered, so the organizer form shows only choices that will be honoured.
    feeModel: feeModelV2 ? 'v2' : 'v1',
    looseResalePolicies,
    // The US$5 resale floor in drops at the configured XRP price, so a seller's form can show it. Only under the new
    // model: the old one has no floor.
    ...(floor !== undefined ? { resaleFloorAvailable: floor !== null } : {}),
    ...(floor ? { minResaleDrops: floor.toString() } : {}),
  })
})
