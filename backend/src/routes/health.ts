import { Router } from 'express'
import { prisma } from '../prisma.js'
import { COMMIT_SHA, env } from '../env.js'

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
 * Both are safe to expose. `XRPL_NETWORK` is not a secret — every payload
 * already carries it to Xaman as `force_network`, and it names a public ledger.
 * Nothing here reveals a key, a seed or a credential.
 */
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
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  })
})
