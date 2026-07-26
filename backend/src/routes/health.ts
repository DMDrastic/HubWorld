import { Router } from 'express'
import { prisma } from '../prisma.js'

export const healthRouter = Router()

/**
 * GET /api/health
 *
 * Always answers 200 so the frontend can render a status even when Postgres is
 * down — a dead database is reported as `degraded`, not as a failed request.
 * Use the `db` field, not the HTTP code, to decide whether the DB is usable.
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
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  })
})
