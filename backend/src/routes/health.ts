import { Router } from 'express'
import { prisma } from '../prisma.js'
import { COMMIT_SHA, env } from '../env.js'
import { brokerHealth } from '../broker-health.js'
import { webhookMode } from '../env.js'
import { webhooksArriving } from '../payload-store.js'

export const healthRouter = Router()

/**
 * GET /api/health
 *
 * Always answers 200 so the frontend can render a status even when Postgres is
 * down — a dead database is reported as `degraded`, not as a failed request.
 * Use the `db` field, not the HTTP code, to decide whether the DB is usable.
 *
 * `commit` answers "which build is actually live?". Nothing used to, so
 * confirming a deploy had shipped meant probing for a behaviour change and
 * inferring it — which only works when the release changes behaviour visibly.
 * It is 'unknown' rather than absent when unset, so the field's shape never
 * depends on configuration.
 *
 * `network` answers "is this thing pointed at real money?". That question was
 * previously unanswerable from outside the process: it had to be inferred from
 * the repo's default and a Render dashboard nobody can check in a hurry. Since
 * mainnet is the setting where a mistake costs real XRP, being able to read it
 * back in one request is worth a field.
 *
 * `broker` answers "can sales actually settle?". A broker that runs out of XRP
 * stops settling every sale on the platform at once, and does it silently — no
 * request fails, auctions just close and never complete. See broker-health.ts.
 *
 * All three are safe to expose. `XRPL_NETWORK` is not a secret — every payload
 * already carries it to Xaman as `force_network`, and it names a public ledger.
 * The broker's address and balance are likewise public: every offer in the
 * system names it as `Destination`, and anyone can read its balance from the
 * ledger. Nothing here reveals a key, a seed or a credential.
 *
 * `webhook` answers "is push actually working?" — `receiving` once a callback
 * has been observed, `unverified` while a secret is set but nothing has ever
 * arrived. That distinction matters more now than it did: resolution trusts
 * push, so an unregistered URL is the difference between instant and a
 * background sweep.
 *
 * `status` stays a statement about the DATABASE alone. A low broker balance is
 * worth reporting, but it must not flip the field the host's health check reads
 * — that would take the service out of rotation over a funding problem no
 * restart can fix, turning a warning into an outage.
 */
/**
 * Configured is not the same as working.
 *
 * `XAMAN_WEBHOOK_SECRET` being set says a URL exists; it does not say Xaman can
 * reach it. A deployment where the console entry was never made looks identical
 * from the inside — and is the documented worst case, because payload
 * resolution now trusts push. `unverified` is that state, visible from outside
 * rather than inferred from someone noticing signatures feel slow.
 */
async function webhookState(): Promise<'receiving' | 'unverified' | 'disabled'> {
  if (webhookMode === 'disabled') return 'disabled'
  return (await webhooksArriving()) ? 'receiving' : 'unverified'
}

healthRouter.get('/health', async (_req, res) => {
  let db: 'connected' | 'unavailable' = 'unavailable'

  try {
    await prisma.$queryRaw`SELECT 1`
    db = 'connected'
  } catch {
    db = 'unavailable'
  }

  res.json({
    status: db === 'connected' ? 'ok' : 'degraded',
    db,
    commit: COMMIT_SHA,
    network: env.XRPL_NETWORK,
    broker: await brokerHealth(),
    webhook: await webhookState(),
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  })
})
