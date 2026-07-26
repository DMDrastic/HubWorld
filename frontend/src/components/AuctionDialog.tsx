/**
 * The auction view, contained in its own dialog rather than living on the main
 * page. Opened from an event that has a live auction.
 *
 * This module is the lazy-loading boundary: it is the only thing that imports
 * BidChart, and therefore Recharts (~410kB). Importing it eagerly anywhere would
 * defeat the code split, so keep the `lazy()` in App.tsx pointed here.
 *
 * PLACEHOLDER data: the auction backend does not exist. The "simulate a bid"
 * button stands in for the Socket.IO bid event that will push real bids. When
 * that lands, this component fetches and subscribes; BidChart itself should not
 * change.
 */
import { useEffect, useState } from 'react'
import { BidChart } from '@/components/BidChart'
import { mockAuctionFor, nextMockBid, type Auction } from '@/lib/mock-bids'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

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
  const [now, setNow] = useState(() => Date.now())

  // Build (later: fetch) the auction when the dialog opens, and drop it on close
  // so reopening gives a fresh window rather than a stale one.
  useEffect(() => {
    if (!open) {
      setAuction(null)
      return
    }
    setAuction(mockAuctionFor(slug, title))
  }, [open, slug, title])

  // Only tick the countdown while the dialog is actually on screen.
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
            {title}
            <Badge variant="secondary">mock data</Badge>
          </DialogTitle>
          <DialogDescription>
            Bids are escrow-locked on the XRP Ledger, so only funded bids count toward the
            price.
          </DialogDescription>
        </DialogHeader>

        {auction ? (
          <div className="space-y-4">
            <BidChart auction={auction} now={now} />
            <Button
              size="sm"
              onClick={() => setAuction((a) => (a ? { ...a, bids: [...a.bids, nextMockBid(a)] } : a))}
            >
              Simulate a bid
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">No live auction for this event.</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
