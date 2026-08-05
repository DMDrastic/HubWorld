/**
 * `GET /api/admin/payload-usage` — Xaman quota consumption, by flow.
 *
 * The roadmap's ask was to make quota "a metric on a dashboard, not a surprise
 * 503", and the 503 is the point: an exhausted quota is not recoverable in code.
 * Cancelling gives nothing back, so by the time signing starts failing the only
 * remedies are a higher application limit or fresh credentials, both of which
 * take time we would not have. Consumption has to be watchable *before* then.
 *
 * **Admin-only, and that is not decoration.** The response is a usage profile of
 * the whole platform — how many people signed in, minted, bid — which is
 * commercially sensitive and belongs to nobody but the operator.
 *
 * It reports what has been SPENT, never what remains. Xaman owns the limit and
 * exposes no endpoint for it, so any local estimate would drift from the real
 * number while looking authoritative. A figure that would be believed and is
 * wrong is worse than an absent one.
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAdmin, requireAuth } from '../session.js'
import { issuesOf } from '../schemas.js'
import { payloadUsage } from '../payload-metrics.js'
import { NETWORK } from '../network.js'

export const payloadUsageRouter = Router()

const Query = z.object({
  /** Window in days. Absent means all time. */
  days: z.coerce.number().int().positive().max(365).optional(),
  network: z.enum(['TESTNET', 'DEVNET', 'MAINNET']).optional(),
  /**
   * Defaults to real spend. `stub` costs no quota and the e2e suite creates
   * them freely, so including them by default would overstate consumption —
   * which is the one direction of error that hides a problem.
   */
  signer: z.enum(['xaman', 'stub', 'unknown']).optional(),
})

payloadUsageRouter.get('/admin/payload-usage', requireAuth, requireAdmin, async (req, res) => {
  const q = Query.safeParse(req.query)
  if (!q.success) {
    res.status(400).json({ error: 'Invalid query', details: issuesOf(q.error) })
    return
  }

  const usage = await payloadUsage({
    since: q.data.days ? new Date(Date.now() - q.data.days * 86_400_000) : undefined,
    network: q.data.network ?? NETWORK,
    signer: q.data.signer ?? 'xaman',
  })

  res.json({
    network: usage.network,
    signer: usage.signer,
    since: usage.since?.toISOString() ?? null,
    until: usage.until.toISOString(),
    created: usage.created,
    signed: usage.signed,
    wasted: usage.wasted,
    byFlow: usage.byFlow.map((f) => ({
      flow: f.flow ? f.flow.toLowerCase() : null,
      created: f.created,
      signed: f.signed,
    })),
    distinctUsers: usage.distinctUsers,
    // Named for what it is. It excludes signin and door_checkin, which carry no
    // user and which every attendee goes through, so it is a lower bound on the
    // cost of a person rather than the cost of a person.
    attributedPerUser: usage.perIdentifiedUser,
  })
})
