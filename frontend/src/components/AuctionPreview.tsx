/**
 * Preview harness for the price tracker.
 *
 * PLACEHOLDER: the auction backend does not exist yet, so this drives BidChart
 * from mock data. Its purpose is to make the visual reviewable before any
 * escrow logic is written. When `GET /api/auctions/:id` lands, this component's
 * job shrinks to fetching and subscribing — BidChart itself should not change.
 *
 * The "simulate a bid" button stands in for the Socket.IO bid event that will
 * eventually push new bids. Note that this is a push model, deliberately: the
 * 429 we hit earlier came from polling, and bid updates have no reason to poll.
 */
import { useEffect, useState } from 'react'
import { BidChart } from '@/components/BidChart'
import { mockAuction, nextMockBid, type Auction } from '@/lib/mock-bids'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

export function AuctionPreview() {
  const [auction, setAuction] = useState<Auction>(() => mockAuction())
  // Ticks the countdown without touching the bid data.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  function addBid() {
    setAuction((a) => ({ ...a, bids: [...a.bids, nextMockBid(a)] }))
  }

  function reset() {
    setAuction(mockAuction())
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {auction.eventTitle} — auction
          <Badge variant="secondary">mock data</Badge>
        </CardTitle>
        <CardDescription>
          Price tracker preview. Bids are escrow-locked on the XRP Ledger, so only
          funded bids count toward the price.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <BidChart auction={auction} now={now} />
        <div className="flex gap-2">
          <Button size="sm" onClick={addBid}>
            Simulate a bid
          </Button>
          <Button size="sm" variant="secondary" onClick={reset}>
            Reset
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
