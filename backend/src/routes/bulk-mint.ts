/**
 * Unattended bulk minting: start it, watch it, stop it, resume it.
 *
 *   POST /api/events/:slug/mint/bulk   → start a run of N tickets
 *   GET  /api/events/:slug/mint/jobs   → recent runs for an event
 *   GET  /api/mint/jobs/:id            → progress
 *   POST /api/mint/jobs/:id/cancel     → stop (a wave in flight still lands)
 *   POST /api/mint/jobs/:id/resume     → carry on after a pause
 *
 * Starting a run signs nothing and spends no Xaman payload: the organizer's
 * earlier grant is what authorises it. Everything refusable is refused HERE,
 * before a job exists, because a job that fails half-way has already minted
 * tickets that cannot be taken back.
 */
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { NETWORK } from '../network.js'
import { issuesOf, slugSchema } from '../schemas.js'
import { requireAuth, requireOrganizer } from '../session.js'
import { accountFunding } from '../ledger.js'
import { currentDelegate } from '../delegate-account.js'
import { delegationAvailable, readPermission, MINT_PERMISSION } from '../delegation.js'
import { assertPublicBaseUrl } from '../nft-metadata.js'
import { planBulkMint, reserveNeededDrops, estimateMintSeconds, waitKind, MAX_JOB_TICKETS } from '../bulk-mint-policy.js'

export const bulkMintRouter = Router()

const SlugParams = z.object({ slug: slugSchema })
const IdParams = z.object({ id: z.string().uuid() })
const StartBody = z.object({ count: z.number().int().min(1).max(MAX_JOB_TICKETS) })

type JobRow = Awaited<ReturnType<typeof prisma.mintJob.findUniqueOrThrow>>

function view(job: JobRow, slug?: string) {
  return {
    id: job.id,
    eventSlug: slug,
    status: job.status,
    statusReason: job.statusReason,
    // Why a queued run is waiting, in a kind the page can put in plain words.
    waiting: waitKind(job.status, job.statusReason),
    total: job.total,
    minted: job.minted,
    failedTxs: job.failedTxs,
    cancelRequested: job.cancelRequested,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  }
}

const OPEN = ['QUEUED', 'RUNNING', 'PAUSED'] as const

/** Mints committed but not yet recorded: other requests in flight, and runs still to finish. */
async function committedFor(eventId: string): Promise<number> {
  const [requests, jobs] = await Promise.all([
    prisma.mintRequest.count({
      where: { eventId, status: { in: ['PENDING', 'SIGNED'] }, expiresAt: { gt: new Date() } },
    }),
    prisma.mintJob.findMany({ where: { eventId, status: { in: [...OPEN] } }, select: { total: true, minted: true } }),
  ])
  return requests + jobs.reduce((n, j) => n + Math.max(0, j.total - j.minted), 0)
}

const EstimateQuery = z.object({ count: z.coerce.number().int().min(1).max(MAX_JOB_TICKETS) })

/**
 * What a run of N tickets will ask of the organizer, BEFORE they start one.
 *
 * Reserve is the thing an organizer can get wrong (it is locked while the
 * tickets sit in their account and returns as they sell), and until now it was
 * only mentioned in the refusal. The figure is the same one the start route
 * enforces, so the page can never promise what the server then refuses.
 * `spendableDrops` is null when the ledger could not be read: "we do not know"
 * must not render as "you have nothing", the rule the health endpoint follows.
 */
bulkMintRouter.get('/events/:slug/mint/estimate', requireAuth, requireOrganizer, async (req, res) => {
  const params = SlugParams.safeParse(req.params)
  const query = EstimateQuery.safeParse(req.query)
  if (!params.success || !query.success) {
    res.status(400).json({ error: 'Invalid request' })
    return
  }
  const event = await prisma.event.findUnique({
    where: { slug: params.data.slug },
    include: { organizer: true },
  })
  if (!event) {
    res.status(404).json({ error: 'Event not found' })
    return
  }
  if (event.organizerId !== req.userId) {
    res.status(403).json({ error: 'Only the event organizer can mint tickets' })
    return
  }

  const count = query.data.count
  let spendableDrops: bigint | null = null
  let reserveNeeded: bigint
  try {
    const funding = await accountFunding(event.organizer.xrplAddress)
    spendableDrops = funding.spendableDrops
    reserveNeeded = reserveNeededDrops(count, funding.reserveIncDrops)
  } catch {
    // The per-object reserve is 0.2 XRP on every network we run; used only to
    // size the figure when the ledger cannot be read.
    reserveNeeded = reserveNeededDrops(count, 200_000n)
  }
  res.json({
    count,
    reserveDrops: reserveNeeded.toString(),
    spendableDrops: spendableDrops === null ? null : spendableDrops.toString(),
    enough: spendableDrops === null ? null : spendableDrops >= reserveNeeded,
    seconds: estimateMintSeconds(count),
  })
})

bulkMintRouter.post('/events/:slug/mint/bulk', requireAuth, requireOrganizer, async (req, res) => {
  const params = SlugParams.safeParse(req.params)
  if (!params.success) {
    res.status(400).json({ error: 'Invalid event slug', details: issuesOf(params.error) })
    return
  }
  const body = StartBody.safeParse(req.body ?? {})
  if (!body.success) {
    res.status(400).json({ error: 'Invalid request', details: issuesOf(body.error) })
    return
  }

  const event = await prisma.event.findUnique({
    where: { slug: params.data.slug },
    include: { organizer: true },
  })
  if (!event) {
    res.status(404).json({ error: 'Event not found' })
    return
  }
  // The delegate signs with Account = whoever is named here, so an event must
  // only ever be minted as its own organizer. Anything else issues tickets from
  // the wrong account, and the issuer is baked into the NFTokenID for good.
  if (event.organizerId !== req.userId) {
    res.status(403).json({ error: 'Only the event organizer can mint tickets' })
    return
  }
  if (event.status === 'CANCELLED' || event.status === 'COMPLETED') {
    res.status(409).json({ error: `Cannot mint for a ${event.status.toLowerCase()} event` })
    return
  }

  const delegate = currentDelegate()
  if (!delegate || !(await delegationAvailable())) {
    res.status(503).json({ error: 'Delegated minting is not available on this server' })
    return
  }

  // Read from the ledger, not from our table: the organizer may have withdrawn
  // it in Xaman since they granted it.
  const permission = await readPermission(
    { organizerAddress: event.organizer.xrplAddress, delegateAddress: delegate },
    MINT_PERMISSION,
  )
  if (permission === 'absent') {
    res.status(409).json({ error: 'Approve minting access first', code: 'NO_DELEGATION' })
    return
  }
  if (permission === 'unknown') {
    res.status(503).json({ error: 'Could not confirm your minting access just now. Try again shortly.' })
    return
  }

  try {
    // A URI no wallet can reach is correctable only by another organizer-signed
    // transaction per ticket. Refuse before minting thousands of them.
    assertPublicBaseUrl()
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Metadata URL is not public' })
    return
  }

  // Can the organizer carry the reserve? Placed after the cheap refusals, and a
  // failed READ is not a refusal: an unreachable public node must not block a
  // legitimate run (the settlement-time check still catches a real shortfall).
  try {
    const funding = await accountFunding(event.organizer.xrplAddress)
    const need = reserveNeededDrops(body.data.count, funding.reserveIncDrops)
    if (funding.spendableDrops < need) {
      res.status(409).json({
        error:
          `Minting ${body.data.count} tickets locks about ${Number(need) / 1e6} XRP of reserve on your ` +
          `account, and you have ${Number(funding.spendableDrops) / 1e6} XRP spendable`,
        code: 'INSUFFICIENT_RESERVE',
      })
      return
    }
  } catch {
    // carry on
  }

  // Serializable, so two requests racing cannot both pass the one-open-run and
  // the cap checks and overshoot the advertised event size together.
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const open = await tx.mintJob.findFirst({ where: { eventId: event.id, status: { in: [...OPEN] } } })
        if (open) return { kind: 'busy' as const }

        const plan = planBulkMint({
          requested: body.data.count,
          ticketCount: event.ticketCount,
          existing: await tx.ticket.count({ where: { eventId: event.id, network: NETWORK } }),
          committed: await committedFor(event.id),
        })
        if (!plan.ok) return { kind: 'refused' as const, reason: plan.reason }

        const job = await tx.mintJob.create({
          data: {
            network: NETWORK,
            eventId: event.id,
            organizerId: event.organizerId,
            organizerAddress: event.organizer.xrplAddress,
            // Frozen: the delegate this run signs as is the one the grant named.
            delegateAddress: delegate,
            total: plan.count,
          },
        })
        return { kind: 'created' as const, job }
      },
      { isolationLevel: 'Serializable' },
    )

    if (result.kind === 'busy') {
      res.status(409).json({ error: 'A minting run is already open for this event' })
      return
    }
    if (result.kind === 'refused') {
      res.status(409).json({ error: result.reason })
      return
    }
    res.status(201).json(view(result.job, event.slug))
  } catch {
    // A serialization conflict means someone else got in first.
    res.status(409).json({ error: 'Another request changed this event just now. Try again.' })
  }
})

bulkMintRouter.get('/events/:slug/mint/jobs', requireAuth, requireOrganizer, async (req, res) => {
  const params = SlugParams.safeParse(req.params)
  if (!params.success) {
    res.status(400).json({ error: 'Invalid event slug', details: issuesOf(params.error) })
    return
  }
  const event = await prisma.event.findUnique({ where: { slug: params.data.slug } })
  if (!event) {
    res.status(404).json({ error: 'Event not found' })
    return
  }
  if (event.organizerId !== req.userId) {
    res.status(403).json({ error: 'Not your event' })
    return
  }
  const jobs = await prisma.mintJob.findMany({
    where: { eventId: event.id },
    orderBy: { createdAt: 'desc' },
    take: 5,
  })
  res.json({ jobs: jobs.map((j) => view(j, event.slug)) })
})

async function ownedJob(req: Request, res: Response) {
  const params = IdParams.safeParse(req.params)
  if (!params.success) {
    res.status(400).json({ error: 'Invalid job id', details: issuesOf(params.error) })
    return null
  }
  const job = await prisma.mintJob.findUnique({ where: { id: params.data.id }, include: { event: true } })
  if (!job) {
    res.status(404).json({ error: 'Unknown minting run' })
    return null
  }
  if (job.organizerId !== req.userId) {
    res.status(403).json({ error: 'Not your minting run' })
    return null
  }
  return job
}

bulkMintRouter.get('/mint/jobs/:id', requireAuth, async (req, res) => {
  const job = await ownedJob(req, res)
  if (job) res.json(view(job, job.event.slug))
})

bulkMintRouter.post('/mint/jobs/:id/cancel', requireAuth, async (req, res) => {
  const job = await ownedJob(req, res)
  if (!job) return

  if (!(OPEN as readonly string[]).includes(job.status)) {
    res.status(409).json({ error: `This run is already ${job.status.toLowerCase()}` })
    return
  }

  // A wave already submitted WILL land, and its tickets must be recorded. So a
  // run with one in flight is asked to stop and settles first; only a run with
  // nothing in flight can be closed here directly.
  const inFlight = job.pendingWave !== null
  const updated = inFlight
    ? await prisma.mintJob.update({ where: { id: job.id }, data: { cancelRequested: true } })
    : await prisma.mintJob.update({
        where: { id: job.id },
        data: { status: 'CANCELLED', statusReason: 'Cancelled', finishedAt: new Date(), cancelRequested: true },
      })
  res.json(view(updated, job.event.slug))
})

bulkMintRouter.post('/mint/jobs/:id/resume', requireAuth, async (req, res) => {
  const job = await ownedJob(req, res)
  if (!job) return

  if (job.status !== 'PAUSED') {
    res.status(409).json({ error: 'Only a paused run can be resumed' })
    return
  }
  const updated = await prisma.mintJob.update({
    where: { id: job.id },
    data: { status: 'QUEUED', statusReason: null, nextAttemptAt: null },
  })
  res.json(view(updated, job.event.slug))
})
