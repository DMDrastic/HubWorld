/**
 * The auction view, contained in its own dialog opened from an event row.
 *
 * This module is the lazy-loading boundary: it is the only thing that imports
 * BidChart, and therefore Recharts (~410kB). Importing it eagerly anywhere would
 * defeat the code split, so keep the `lazy()` in App.tsx pointed here.
 *
 * Data comes from `GET /api/events/:slug/auction`, then Socket.IO pushes updates
 * as bids commit. A poll interval is not "live" — a tracker that lags by 5s
 * shows a stale price during exactly the closing minutes people care about.
 *
 * The fetch stays authoritative and a slow fallback refresh remains, so the
 * dialog is still correct if the socket never connects. Realtime accelerates it;
 * it does not own the data.
 */
import { useCallback, useEffect, useState } from 'react'
import { BidChart } from '@/components/BidChart'
import { BidForm } from '@/components/BidForm'
import { ApiError, fetchAuction, type Auction } from '@/lib/api'
import { watchAuction } from '@/lib/realtime'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/** Fallback only — realtime carries the load, this covers a dead socket. */
const FALLBACK_REFRESH_MS = 30_000

export function AuctionDialog({
  slug,
  title,
  open,
  signedIn,
  onOpenChange,
}: {
  slug: string
  title: string
  open: boolean
  signedIn: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [auction, setAuction] = useState<Auction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      setAuction(await fetchAuction(slug))
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the auction')
    }
  }, [slug])

  // Refresh on a timer keyed to primitives only. Putting the fetched auction in
  // this effect's dependencies would restart it on every response and turn the
  // interval into a tight request loop — the GiftPanel mistake.
  useEffect(() => {
    if (!open) {
      setAuction(null)
      setError(null)
      return
    }
    let stopped = false
    let timer: number

    const tick = async () => {
      if (stopped) return
      await load()
      if (stopped) return
      timer = window.setTimeout(tick, FALLBACK_REFRESH_MS)
    }
    void tick()

    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [open, load])

  // Push updates. Keyed on the auction id alone: including the auction object
  // would resubscribe on every refetch, which is the dependency mistake that
  // turned GiftPanel's poll into a request loop.
  const auctionId = auction?.id ?? null
  useEffect(() => {
    if (!open || !auctionId) return
    return watchAuction(auctionId, (event) => {
      // Refetch rather than patching state from the event. The event says
      // something changed; the API says what the truth now is, and that keeps
      // one code path deciding what counts as price.
      if (event.type === 'bid' || event.type === 'settled' || event.type === 'closed') {
        void load()
      }
    })
  }, [open, auctionId, load])

  // Only tick the countdown while the dialog is on screen.
  useEffect(() => {
    if (!open) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 pr-6 tracking-tight">
            {auction?.eventTitle ?? title}
            {auction &&
              (auction.state === 'live' ? (
                // Live is a state, not a category, so it wears the live token
                // and pairs the colour with a label — never colour alone.
                <span className="border-live/25 bg-live/10 text-live inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium">
                  <span className="relative flex size-1.5">
                    <span className="bg-live absolute inline-flex size-full animate-ping rounded-full opacity-70" />
                    <span className="bg-live relative inline-flex size-1.5 rounded-full" />
                  </span>
                  live
                </span>
              ) : (
                <Badge variant="secondary">{auction.state}</Badge>
              ))}
          </DialogTitle>
          <DialogDescription className="leading-relaxed">
            Each bid is a buy offer on the XRP Ledger. Only bids committed on-ledger count
            toward the price.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="text-destructive text-sm">{error}</p>
        ) : auction ? (
          <div className="space-y-5">
            <BidChart auction={auction} now={now} />
            {/* Bidding is only offered when signed in; the backend enforces it
                regardless, this just avoids a pointless 401. */}
            {signedIn && <BidForm auction={auction} onPlaced={load} />}
          </div>
        ) : (
          // A skeleton in the chart's shape, so opening the dialog does not
          // collapse and then jump when the data lands.
          <div className="space-y-3" aria-busy="true" aria-label="Loading auction">
            <div className="bg-muted h-10 w-40 animate-pulse rounded-lg" />
            <div className="bg-muted h-48 w-full animate-pulse rounded-xl" />
            <div className="bg-muted h-16 w-full animate-pulse rounded-xl" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
