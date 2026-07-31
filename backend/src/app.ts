import fs from 'node:fs'
import path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { env } from './env.js'
import { healthRouter } from './routes/health.js'
import { usersRouter } from './routes/users.js'
import { eventsRouter } from './routes/events.js'
import { eventImageRouter } from './routes/event-image.js'
import { authRouter } from './routes/auth.js'
import { mintRouter } from './routes/mint.js'
import { giftsRouter } from './routes/gifts.js'
import { ticketsRouter } from './routes/tickets.js'
import { listingsRouter } from './routes/listings.js'
import { auctionsRouter } from './routes/auctions.js'
import { bidsRouter } from './routes/bids.js'
import { openAuctionRouter } from './routes/open-auction.js'
import { redemptionRouter } from './routes/redemption.js'
import { organizersRouter } from './routes/organizers.js'
import { webhooksRouter } from './routes/webhooks.js'

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

/**
 * Serve the built frontend from this process, on the same origin as the API.
 *
 * The SPA fallback is the half that is easy to forget and impossible to miss
 * once it bites: the router owns `/tickets`, `/market` and the rest, but those
 * paths exist only in the browser. Without a rewrite, loading one directly — or
 * simply refreshing — asks the server for a file that was never built, and the
 * user gets a 404 on a page that works fine when navigated to. Vite hides this
 * in dev by serving index.html for unknown paths.
 */
function serveWebApp(app: express.Express, dist: string): void {
  const indexHtml = path.join(dist, 'index.html')

  if (!fs.existsSync(indexHtml)) {
    // Failing loudly at boot beats serving 404s for every page and leaving
    // someone to work out that WEB_DIST pointed at nothing.
    console.error(`WEB_DIST is set to "${dist}" but no index.html is there.`)
    console.error('Build the frontend first (npm run build in frontend/).')
    process.exit(1)
  }

  app.use(
    express.static(dist, {
      // index.html is served by the fallback below so it gets its own
      // cache policy; letting static serve it would cache it like an asset.
      index: false,
      setHeaders: (res, filePath) => {
        // Vite fingerprints everything under /assets, so those URLs can never
        // change meaning and are safe to cache forever. Anything else
        // (favicon.svg, robots.txt) keeps its name across deploys and must not
        // be pinned for a year.
        const oneYear = 'public, max-age=31536000, immutable'
        const oneHour = 'public, max-age=3600'
        res.setHeader('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`) ? oneYear : oneHour)
      },
    }),
  )

  app.get(/.*/, (req, res, next) => {
    // A client asking for JSON or an image that does not exist wants a 404, not
    // a page. Only hand back the shell to something that would render it.
    if (!req.accepts('html')) return next()

    // Never cache the shell: it names the current hashed bundles, so a stale
    // copy points at assets a later deploy has already deleted.
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(indexHtml)
  })
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
  app.use('/api', eventImageRouter)
  app.use('/api', mintRouter)
  app.use('/api', giftsRouter)
  app.use('/api', ticketsRouter)
  app.use('/api', listingsRouter)
  app.use('/api', auctionsRouter)
  app.use('/api', bidsRouter)
  app.use('/api', openAuctionRouter)
  app.use('/api', redemptionRouter)
  app.use('/api', organizersRouter)
  app.use('/api', webhooksRouter)

  // An unmatched /api route must 404 as JSON, and must do so BEFORE the static
  // and SPA handlers below. Without this an API typo falls through to the SPA
  // fallback and answers 200 with index.html — the client then tries to parse
  // HTML as JSON and reports a syntax error instead of "no such route".
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  if (env.WEB_DIST) {
    serveWebApp(app, env.WEB_DIST)
  }

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
    // Xaman's open-payload cap. Distinct from a network blip: waiting does not
    // help by itself, and "internal server error" hides an operational limit
    // that has a specific remedy.
    if (err instanceof Error && err.name === 'XamanPayloadLimit') {
      res.status(503).json({
        error:
          'Too many sign-in requests are open at once. Old ones are cleared automatically — try again shortly.',
      })
      return
    }

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
