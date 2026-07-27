/**
 * Realtime auction updates.
 *
 * One shared socket for the whole page: a connection per component would open
 * several to the same server for no benefit. Components join and leave per-
 * auction rooms instead.
 *
 * This is an accelerator, never the source of truth. Every screen still works if
 * the socket never connects — the HTTP fetch remains authoritative, and a slow
 * fallback refresh covers a dropped connection.
 */
import { io, type Socket } from 'socket.io-client'

export type AuctionEvent =
  | { type: 'bid'; auctionId: string; amountDrops: string; bidder: string; placedAt: string }
  | { type: 'settled'; auctionId: string; amountDrops: string; winner: string; txHash: string }
  | { type: 'closed'; auctionId: string; reason: 'no-bids' | 'reserve-not-met' }

let socket: Socket | null = null

function connection(): Socket {
  // Same origin: the Vite proxy forwards /socket.io in dev.
  socket ??= io({ path: '/socket.io', transports: ['websocket', 'polling'] })
  return socket
}

/**
 * Watch one auction. Returns an unsubscribe that leaves the room and detaches
 * the handler — without it, remounting would stack duplicate handlers and the
 * chart would apply each event repeatedly.
 */
export function watchAuction(auctionId: string, onEvent: (e: AuctionEvent) => void): () => void {
  const s = connection()

  const handler = (event: AuctionEvent) => {
    if (event.auctionId !== auctionId) return
    onEvent(event)
  }

  const join = () => s.emit('watch-auction', auctionId)
  join()
  // Rejoin after a reconnect, or the socket comes back deaf to this room.
  s.on('connect', join)
  s.on('auction', handler)

  return () => {
    s.emit('unwatch-auction', auctionId)
    s.off('auction', handler)
    s.off('connect', join)
  }
}
