/**
 * The auction view, contained in its own dialog opened from an event row.
 *
 * This module is the lazy-loading boundary: it is the only thing that imports
 * BidChart, and therefore Recharts (~410kB). Importing it eagerly anywhere would
 * defeat the code split, so keep the `lazy()` in App.tsx pointed here.
 *
 * Data comes from `GET /api/events/:slug/auction`. Refreshing is a modest poll
 * of OUR OWN API, which is fine — the 429 that bit us earlier was Xaman's rate
 * limit, not ours. It should still become a Socket.IO subscription, because
 * pushing a bid the moment it lands is the entire appeal of a live tracker.
 */
import { useCallback, useEffect, useState } from 'react'
import { BidChart } from '@/components/BidChart'
import { ApiError, fetchAuction, type Auction } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const REFRESH_MS = 5000

export function AuctionDialog({
  slug,
  title,
  open,
  onOpenChange,
}: {
  slug: string
  title: string
  open: boolean
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
      timer = window.setTimeout(tick, REFRESH_MS)
    }
    void tick()

    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [open, load])

  // Only tick the countdown while the dialog is on screen.
  useEffect(() => {
    if (!open) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            {auction?.eventTitle ?? title}
            {auction && <Badge variant="secondary">{auction.state}</Badge>}
          </DialogTitle>
          <DialogDescription>
            Each bid is a buy offer on the XRP Ledger. Only bids committed on-ledger count
            toward the price.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="text-destructive text-sm">{error}</p>
        ) : auction ? (
          <BidChart auction={auction} now={now} />
        ) : (
          <p className="text-muted-foreground text-sm">Loading…</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
