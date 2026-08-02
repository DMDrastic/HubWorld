/**
 * Placing a bid.
 *
 * A bid is an XRPL buy offer signed on the bidder's own device, so this is the
 * usual build-payload → scan → poll shape. It is NOT escrowed: the offer is a
 * firm, broker-only commitment, but the funds stay in the bidder's wallet, which
 * is why the backend checks spendable balance before issuing the payload.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { QrCode } from '@/components/QrCode'
import {
  ApiError,
  dropsToXrp,
  placeBid,
  pollBid,
  xrpToDrops,
  type Auction,
  type BidCreated,
  type BidState,
} from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const POLL_MS = 2500

type Phase =
  | { kind: 'idle' }
  | { kind: 'active'; payload: BidCreated }
  | { kind: 'failed'; reason: string }

const MESSAGES: Record<BidState['state'], string> = {
  pending: 'Scan in Xaman to place the bid.',
  committed: 'Bid is live on-ledger. You are the leading bidder.',
  outbid: 'Someone has outbid you.',
  won: 'You won.',
  lost: 'The auction closed without your bid winning.',
  cancelled: 'The bid was cancelled.',
  failed: 'The bid failed.',
}

export function BidForm({
  auction,
  onPlaced,
}: {
  auction: Auction
  /** Refresh the chart once the bid changes the on-ledger picture. */
  onPlaced: () => void
}) {
  const [amountXrp, setAmountXrp] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [bid, setBid] = useState<BidState | null>(null)
  const [busy, setBusy] = useState(false)

  // Keyed on the bid id, never on the polled state — see GiftPanel for what
  // putting poll results in a dependency list does.
  const activeBidId = phase.kind === 'active' ? phase.payload.bidId : null

  useEffect(() => {
    if (!activeBidId) return
    let stopped = false
    let timer: number

    const tick = async () => {
      if (stopped) return
      try {
        const next = await pollBid(activeBidId)
        if (stopped) return
        setBid(next)

        if (['committed', 'cancelled', 'failed', 'won', 'lost'].includes(next.state)) {
          onPlaced()
          return
        }
        timer = window.setTimeout(tick, POLL_MS)
      } catch (err) {
        if (stopped) return
        setPhase({
          kind: 'failed',
          reason: err instanceof ApiError ? err.message : 'Polling failed',
        })
      }
    }

    void tick()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [activeBidId, onPlaced])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const drops = xrpToDrops(amountXrp)
      if (BigInt(drops) <= 0n) throw new ApiError('Enter an amount above zero')
      setBid(null)
      setPhase({ kind: 'active', payload: await placeBid(auction.id, drops) })
    } catch (err) {
      setPhase({
        kind: 'failed',
        reason: err instanceof ApiError ? err.message : 'Could not place the bid',
      })
    } finally {
      setBusy(false)
    }
  }

  const closed = new Date(auction.endsAt).getTime() <= Date.now()

  if (phase.kind === 'active') {
    return (
      <div className="flex flex-col items-center gap-3 border-t pt-4">
        <div className="text-sm font-medium">
          Bidding {dropsToXrp(phase.payload.amountDrops)} XRP
        </div>
        {/*
          Shown BEFORE the QR, because the only useful moment for this is while
          the bid can still be changed. Funds are not locked, so a bid with
          almost nothing behind it is one ordinary payment away from failing at
          settlement — at which point the auction goes to the runner-up and the
          bidder is told nothing beyond having lost.
        */}
        {phase.payload.tight && phase.payload.afterBidDrops !== undefined && (
          <p
            role="status"
            className="border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-left text-xs"
          >
            {/* There is no warning tone in the system, so this borrows the
                destructive one at lower emphasis. The icon is not decoration:
                the same reasoning as the door verdicts, that meaning should not
                rest on hue alone. */}
            <AlertTriangle className="mt-px size-4 shrink-0" aria-hidden="true" />
            <span>
              This leaves {dropsToXrp(phase.payload.afterBidDrops)} XRP spendable. Your bid
              is not held in escrow, so if your balance falls below it before the auction
              closes, the sale cannot settle and the ticket goes to the next bidder.
            </span>
          </p>
        )}
        {(bid === null || bid.state === 'pending') && (
          <>
            <QrCode
              src={phase.payload.qrPng}
              alt="Xaman bid QR code"
              className="size-40"
              next={phase.payload.next}
              mode={phase.payload.mode}
            />
            <p className="text-muted-foreground text-center text-sm">{MESSAGES.pending}</p>
          </>
        )}
        {bid && (
          <>
            <Badge variant="secondary">{bid.state}</Badge>
            <p className="text-center text-sm">
              {bid.state === 'failed' ? (bid.reason ?? MESSAGES.failed) : MESSAGES[bid.state]}
            </p>
          </>
        )}
        <Button variant="ghost" size="sm" onClick={() => setPhase({ kind: 'idle' })}>
          Done
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-2 border-t pt-4">
      {phase.kind === 'failed' && <p className="text-destructive text-sm">{phase.reason}</p>}
      <div className="flex gap-2">
        <Input
          value={amountXrp}
          onChange={(e) => setAmountXrp(e.target.value)}
          placeholder={`Bid in XRP (reserve ${dropsToXrp(auction.reserveDrops)})`}
          inputMode="decimal"
          aria-label="bid amount in XRP"
          disabled={closed}
        />
        <Button type="submit" disabled={busy || closed || !amountXrp.trim()}>
          {busy ? '…' : 'Bid'}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Your bid is a buy offer only Hubworld can match. The funds stay in your wallet until
        the auction settles.
      </p>
    </form>
  )
}
