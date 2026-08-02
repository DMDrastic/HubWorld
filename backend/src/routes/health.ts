import { Router } from 'express'
import { prisma } from '../prisma.js'
import { COMMIT_SHA } from '../env.js'

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
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  })
})
