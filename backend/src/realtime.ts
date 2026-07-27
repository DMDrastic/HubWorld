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

export type AuctionEvent =
  /** A bid's buy offer is now on-ledger and counts toward the price. */
  | { type: 'bid'; auctionId: string; amountDrops: string; bidder: string; placedAt: string }
  /** The auction closed. */
  | { type: 'settled'; auctionId: string; amountDrops: string; winner: string; txHash: string }
  | { type: 'closed'; auctionId: string; reason: 'no-bids' | 'reserve-not-met' }

let io: Server | null = null

const room = (auctionId: string) => `auction:${auctionId}`

export function attachRealtime(server: HttpServer): Server {
  io = new Server(server, {
    // Same origin policy as the REST API; the Vite proxy makes dev same-origin.
    cors: { origin: env.CORS_ORIGIN, credentials: true },
    // Long polling stays available as a fallback for networks that block
    // websockets, which is the default and worth keeping.
    path: '/socket.io',
  })

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
}
