import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import { env } from './env.js'
import { healthRouter } from './routes/health.js'
import { usersRouter } from './routes/users.js'
import { eventsRouter } from './routes/events.js'
import { authRouter } from './routes/auth.js'
import { mintRouter } from './routes/mint.js'

export function createApp() {
  const app = express()

  // Prisma returns BigInt for drops columns, and JSON.stringify throws on
  // BigInt. Serialise as strings — JS numbers cannot hold large drop amounts
  // without precision loss anyway, so clients must treat them as strings.
  app.set('json replacer', (_key: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  )

  app.use(cors({ origin: env.CORS_ORIGIN }))
  app.use(express.json())

  app.use('/api', healthRouter)
  app.use('/api', authRouter)
  app.use('/api', usersRouter)
  app.use('/api', eventsRouter)
  app.use('/api', mintRouter)

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  // Express 5 forwards rejected async handlers here automatically.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  })

  return app
}
