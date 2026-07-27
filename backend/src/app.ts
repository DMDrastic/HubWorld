import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { env } from './env.js'
import { healthRouter } from './routes/health.js'
import { usersRouter } from './routes/users.js'
import { eventsRouter } from './routes/events.js'
import { authRouter } from './routes/auth.js'
import { mintRouter } from './routes/mint.js'
import { giftsRouter } from './routes/gifts.js'
import { ticketsRouter } from './routes/tickets.js'
import { listingsRouter } from './routes/listings.js'
import { auctionsRouter } from './routes/auctions.js'
import { bidsRouter } from './routes/bids.js'
import { openAuctionRouter } from './routes/open-auction.js'

/** Codes that mean "the network was unreachable", not "the request was wrong". */
const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

/**
 * Walks the error chain, because `fetch` reports these as a bare
 * `TypeError: fetch failed` and hides the real code under `cause`.
 */
export function isTransientNetworkError(err: unknown, depth = 0): boolean {
  if (depth > 4 || err === null || typeof err !== 'object') return false

  const e = err as { code?: unknown; cause?: unknown; errors?: unknown; message?: unknown }
  if (typeof e.code === 'string' && TRANSIENT_CODES.has(e.code)) return true

  // AggregateError from a multi-address connect attempt.
  if (Array.isArray(e.errors) && e.errors.some((x) => isTransientNetworkError(x, depth + 1))) {
    return true
  }
  if (e.cause !== undefined && isTransientNetworkError(e.cause, depth + 1)) return true

  // xrpl.js surfaces a disconnect as its own error type rather than a code.
  return typeof e.message === 'string' && /NotConnectedError|websocket was closed/i.test(e.message)
}

export function createApp() {
  const app = express()

  // Prisma returns BigInt for drops columns, and JSON.stringify throws on
  // BigInt. Serialise as strings — JS numbers cannot hold large drop amounts
  // without precision loss anyway, so clients must treat them as strings.
  app.set('json replacer', (_key: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  )

  // `credentials` lets the session cookie ride cross-origin responses. It
  // requires a specific origin — the spec forbids pairing it with `*`, which is
  // why CORS_ORIGIN is a concrete value rather than a wildcard.
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }))
  app.use(express.json())
  app.use(cookieParser())

  app.use('/api', healthRouter)
  app.use('/api', authRouter)
  app.use('/api', usersRouter)
  app.use('/api', eventsRouter)
  app.use('/api', mintRouter)
  app.use('/api', giftsRouter)
  app.use('/api', ticketsRouter)
  app.use('/api', listingsRouter)
  app.use('/api', auctionsRouter)
  app.use('/api', bidsRouter)
  app.use('/api', openAuctionRouter)

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  // Express 5 forwards rejected async handlers here automatically.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err)

    // Reaching Xaman or the XRP Ledger can simply fail — DNS, a dropped
    // connection, a timeout. That is not a bug in Hubworld and it is not
    // permanent, so it must not read as "Internal server error": the user's
    // transaction may well have gone through, and the honest answer is "try
    // again shortly" rather than something that looks like data loss.
    if (isTransientNetworkError(err)) {
      res.status(503).json({
        error: 'Could not reach the ledger or Xaman just now. Nothing was lost — try again.',
      })
      return
    }

    res.status(500).json({ error: 'Internal server error' })
  })

  return app
}
