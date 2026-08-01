/**
 * Realtime auction updates.
 *
 * Bids are pushed rather than polled. Polling was never right here — a live price
 * tracker that lags by a poll interval is not live, and the 429 we took from
 * Xaman came from exactly that shape of loop. Pushing also scales the opposite
 * way: viewers cost a socket each rather than a request each per interval.
 *
 * Rooms are per auction, so a viewer only receives traffic for the auction they
 * have open.
 *
 * Everything emitted here is **already public** — bids, amounts, and @handles are
 * visible through `GET /events/:slug/auction`. Nothing is broadcast that a
 * viewer could not fetch, so no authentication is required to listen. Placing a
 * bid still goes through the authenticated HTTP route; sockets are read-only.
 */
import type { Server as HttpServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import { env } from './env.js'
import type { Pool } from 'pg'

export type AuctionEvent =
  /** A bid's buy offer is now on-ledger and counts toward the price. */
  | { type: 'bid'; auctionId: string; amountDrops: string; bidder: string; placedAt: string }
  /** The auction closed. */
  | { type: 'settled'; auctionId: string; amountDrops: string; winner: string; txHash: string }
  | { type: 'closed'; auctionId: string; reason: 'no-bids' | 'reserve-not-met' }

let io: Server | null = null
/** Held so shutdown can close it; the adapter owns its own connections. */
let adapterPool: Pool | null = null

const room = (auctionId: string) => `auction:${auctionId}`

/**
 * Share rooms across processes, when asked to.
 *
 * Without an adapter, Socket.IO keeps rooms in memory. That is correct for one
 * instance and quietly wrong for two: `publishAuctionEvent` on instance A
 * reaches only the viewers connected to A, so half the audience watches a price
 * that never moves. Nothing errors, which is what makes it dangerous.
 *
 * Postgres rather than Redis because the database is already there. It costs no
 * new service, no new credential, and nothing new to be down at 2am — and the
 * events are tiny (an id, an amount, a handle), far inside NOTIFY's 8000-byte
 * payload limit, so the adapter's overflow table should never be touched.
 *
 * Failing to attach is NOT fatal. Realtime is an accelerator, never the source
 * of truth — `AuctionDialog` refreshes over HTTP regardless, and the chart is
 * authoritative from the API. A degraded socket layer is worth far less than a
 * server that refuses to start.
 */
async function attachAdapter(server: Server): Promise<void> {
  if (env.REALTIME_ADAPTER !== 'postgres') return

  try {
    const [{ Pool }, { createAdapter }] = await Promise.all([
      import('pg'),
      import('@socket.io/postgres-adapter'),
    ])
    const pool = new Pool({ connectionString: env.DATABASE_URL })
    // Fail here rather than on the first bid, when it would be invisible.
    await pool.query('SELECT 1')
    server.adapter(createAdapter(pool))
    adapterPool = pool as unknown as Pool
    console.log('realtime: postgres adapter attached (events shared across instances)')
  } catch (err) {
    console.error(
      'realtime: postgres adapter FAILED to attach — running in-memory. ' +
        'With more than one instance, viewers will miss events published elsewhere.',
      err instanceof Error ? err.message : err,
    )
  }
}

export function attachRealtime(server: HttpServer): Server {
  io = new Server(server, {
    // Same origin policy as the REST API; the Vite proxy makes dev same-origin.
    cors: { origin: env.CORS_ORIGIN, credentials: true },
    // Long polling stays available as a fallback for networks that block
    // websockets, which is the default and worth keeping.
    path: '/socket.io',
  })

  // Deliberately not awaited: the HTTP server should start serving immediately.
  // Events published in the gap reach this instance's own viewers either way,
  // which is exactly the single-instance behaviour we already had.
  void attachAdapter(io)

  io.on('connection', (socket: Socket) => {
    socket.on('watch-auction', (auctionId: unknown) => {
      // Validate: a client controls this string, and an unchecked value would let
      // anyone join arbitrary rooms or blow up memory with junk names.
      if (typeof auctionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(auctionId)) return
      void socket.join(room(auctionId))
    })

    socket.on('unwatch-auction', (auctionId: unknown) => {
      if (typeof auctionId !== 'string') return
      void socket.leave(room(auctionId))
    })
  })

  return io
}

/**
 * Publish an auction event. A no-op when realtime is not attached, so the HTTP
 * paths work identically with or without it — the socket layer is an
 * accelerator, never the source of truth.
 */
export function publishAuctionEvent(event: AuctionEvent): void {
  io?.to(room(event.auctionId)).emit('auction', event)
}

export async function closeRealtime(): Promise<void> {
  if (!io) return
  await new Promise<void>((resolve) => io!.close(() => resolve()))
  io = null
  // The adapter's pool is ours to close: like the XRPL websocket, an open pool
  // holds the event loop and the process never exits.
  if (adapterPool) {
    await adapterPool.end().catch(() => undefined)
    adapterPool = null
  }
}
