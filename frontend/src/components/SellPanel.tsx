import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  buyListing,
  cancelListing,
  createListing,
  openAuction,
  dropsToXrp,
  fetchInventory,
  fetchMarket,
  fetchMyListings,
  pollListing,
  xrpToDrops,
  type Listing,
  type ListingCreated,
  type OwnedTicket,
} from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

const POLL_MS = 2500

type Phase =
  | { kind: 'idle' }
  // `payload` is null when resuming a listing we already know the id of but
  // hold no QR for — same reason as GiftPanel.
  | { kind: 'active'; listingId: string; payload: ListingCreated | null; label: string }
  | { kind: 'failed'; reason: string }

/** States where a signature is still outstanding, so the QR belongs on screen. */
const NEEDS_SIGNATURE = new Set(['pending_offer', 'active', 'buyer_pending'])

const MESSAGES: Record<Listing['state'], string> = {
  pending_offer: 'Waiting for the listing to be signed…',
  active: 'Listed. Waiting for a buyer.',
  buyer_pending: 'Buyer committed — waiting for their signature…',
  settling: 'Both offers placed. Hubworld is settling the sale…',
  sold: 'Sold. The ticket and the money have moved.',
  cancelling: 'Withdrawing — waiting for the ledger…',
  cancelled: 'The listing was withdrawn.',
  expired: 'The listing expired before it was signed.',
  failed: 'The sale failed.',
}

function priceLine(l: Listing) {
  return `${dropsToXrp(l.priceDrops)} XRP` + (l.platformFeeDrops === '0'
    ? ''
    : ` · buyer pays ${dropsToXrp(l.buyerPaysDrops)}`)
}

export function SellPanel({ onChanged }: { onChanged: () => void }) {
  const [tickets, setTickets] = useState<OwnedTicket[]>([])
  const [market, setMarket] = useState<Listing[]>([])
  const [mine, setMine] = useState<Listing[]>([])
  const [nfTokenId, setNfTokenId] = useState('')
  const [priceXrp, setPriceXrp] = useState('')
  const [mode, setMode] = useState<'sell' | 'auction'>('sell')
  const [minutes, setMinutes] = useState('60')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [listing, setListing] = useState<Listing | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [inv, m, own] = await Promise.all([
        fetchInventory(true),
        fetchMarket(),
        fetchMyListings(),
      ])
      // A ticket already committed elsewhere cannot be sold or auctioned: LISTED
      // has a live sell offer and IN_AUCTION is mid-auction.
      setTickets(inv.tickets.filter((t) => t.status !== 'LISTED' && t.status !== 'IN_AUCTION'))
      setMarket(m)
      setMine(own)
      setNfTokenId((cur) => cur || (inv.tickets[0]?.nfTokenId ?? ''))
    } catch {
      // Non-fatal.
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const activeId = phase.kind === 'active' ? phase.listingId : null

  // Keyed on a primitive, and the polled state lives outside `phase` — putting
  // it inside makes the dependency change every tick and turns this into a tight
  // request loop. See GiftPanel.
  useEffect(() => {
    if (!activeId) return
    let stopped = false
    let timer: number

    const tick = async () => {
      if (stopped) return
      try {
        const next = await pollListing(activeId)
        if (stopped) return
        setListing(next)

        if (['sold', 'cancelled', 'expired', 'failed'].includes(next.state)) {
          void refresh()
          onChanged()
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
  }, [activeId, refresh, onChanged])

  function track(listingId: string, payload: ListingCreated | null, label: string) {
    setListing(null)
    setPhase({ kind: 'active', listingId, payload, label })
  }

  async function list() {
    setBusy(true)
    try {
      const drops = xrpToDrops(priceXrp)
      if (BigInt(drops) <= 0n) throw new ApiError('Enter a price above zero')
      const payload = await createListing(nfTokenId, drops)
      track(payload.listingId, payload, `List for ${priceXrp} XRP`)
    } catch (err) {
      setPhase({
        kind: 'failed',
        reason: err instanceof ApiError ? err.message : 'Could not create the listing',
      })
    } finally {
      setBusy(false)
    }
  }

  /**
   * Opening an auction is one signature that creates both the bidding rules and
   * the holder's sell offer. We poll the LISTING, because the auction only goes
   * live once that offer reaches the ledger.
   */
  async function startAuction() {
    setBusy(true)
    try {
      const drops = xrpToDrops(priceXrp)
      if (BigInt(drops) <= 0n) throw new ApiError('Enter a reserve above zero')
      const result = await openAuction(nfTokenId, drops, Number(minutes))
      track(result.listingId, { ...result, priceDrops: drops }, `Auction at ${priceXrp} XRP reserve`)
    } catch (err) {
      setPhase({
        kind: 'failed',
        reason: err instanceof ApiError ? err.message : 'Could not open the auction',
      })
    } finally {
      setBusy(false)
    }
  }

  async function buy(l: Listing) {
    setBusy(true)
    try {
      const payload = await buyListing(l.listingId)
      track(l.listingId, payload, `Buy for ${dropsToXrp(l.buyerPaysDrops)} XRP`)
    } catch (err) {
      setPhase({
        kind: 'failed',
        reason: err instanceof ApiError ? err.message : 'Could not start the purchase',
      })
    } finally {
      setBusy(false)
    }
  }

  async function withdraw(listingId: string) {
    setBusy(true)
    try {
      const result = await cancelListing(listingId)
      if ('uuid' in result) {
        track(listingId, result, 'Withdraw listing')
      } else {
        setPhase({ kind: 'idle' })
        void refresh()
        onChanged()
      }
    } catch (err) {
      setPhase({
        kind: 'failed',
        reason: err instanceof ApiError ? err.message : 'Could not withdraw',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Marketplace</CardTitle>
        <CardDescription>
          Sell at a fixed price or open an auction. The organizer's royalty is taken by the
          ledger itself, and Hubworld brokers the match — the money never passes through us.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {phase.kind === 'idle' && (
          <>
            {mine.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-medium">Your listings</div>
                {mine.map((l) => (
                  <div
                    key={l.listingId}
                    className="flex items-center justify-between gap-3 rounded-md border p-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm">{l.ticket.event.title}</div>
                      <div className="text-muted-foreground text-xs">
                        {priceLine(l)} · {l.state.replace('_', ' ')}
                        {l.role === 'buyer' ? ' · buying' : ''}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => track(l.listingId, null, l.ticket.event.title)}
                      >
                        Check
                      </Button>
                      {l.role !== 'buyer' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void withdraw(l.listingId)}
                        >
                          Withdraw
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {market.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-medium">For sale</div>
                {market.map((l) => (
                  <div
                    key={l.listingId}
                    className="flex items-center justify-between gap-3 rounded-md border p-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm">{l.ticket.event.title}</div>
                      <div className="text-muted-foreground text-xs">
                        {dropsToXrp(l.buyerPaysDrops)} XRP · from {l.seller}
                      </div>
                    </div>
                    <Button size="sm" disabled={busy} onClick={() => void buy(l)}>
                      Buy
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-3 border-t pt-4">
              <div className="flex items-center gap-2">
                <div className="text-sm font-medium">
                  {mode === 'sell' ? 'Sell a ticket' : 'Auction a ticket'}
                </div>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground text-xs underline"
                  onClick={() => setMode(mode === 'sell' ? 'auction' : 'sell')}
                >
                  {mode === 'sell' ? 'auction instead' : 'sell at a fixed price instead'}
                </button>
              </div>
              {tickets.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No unlisted tickets to sell.
                </p>
              ) : (
                <>
                  <select
                    value={nfTokenId}
                    onChange={(e) => setNfTokenId(e.target.value)}
                    aria-label="ticket to sell"
                    className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                  >
                    {tickets.map((t) => (
                      <option key={t.nfTokenId} value={t.nfTokenId}>
                        {[t.event.title, t.tier, t.seat].filter(Boolean).join(' · ')}
                      </option>
                    ))}
                  </select>
                  <div className="flex gap-2">
                    <Input
                      value={priceXrp}
                      onChange={(e) => setPriceXrp(e.target.value)}
                      placeholder={mode === 'sell' ? 'Price in XRP' : 'Reserve in XRP'}
                      inputMode="decimal"
                      aria-label={mode === 'sell' ? 'price in XRP' : 'reserve in XRP'}
                    />
                    {mode === 'auction' && (
                      <Input
                        value={minutes}
                        onChange={(e) => setMinutes(e.target.value)}
                        placeholder="Minutes"
                        inputMode="numeric"
                        aria-label="auction length in minutes"
                        className="w-28"
                      />
                    )}
                    <Button
                      disabled={busy || !nfTokenId || !priceXrp.trim()}
                      onClick={() => void (mode === 'sell' ? list() : startAuction())}
                    >
                      {busy ? '…' : mode === 'sell' ? 'List' : 'Open'}
                    </Button>
                  </div>
                  {mode === 'auction' && (
                    <p className="text-muted-foreground text-xs">
                      One signature opens the auction and places your sell offer. The reserve is
                      the minimum — bids above it pay you more, and the ticket cannot be bought
                      outright while the auction runs.
                    </p>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {phase.kind === 'active' && (
          <div className="flex flex-col items-center gap-3">
            <div className="text-sm font-medium">{phase.label}</div>

            {phase.payload !== null &&
              (listing === null || NEEDS_SIGNATURE.has(listing.state)) && (
                <>
                  <img
                    src={phase.payload.qrPng}
                    alt="Xaman signing QR code"
                    className="size-44 rounded-md border"
                  />
                  <p className="text-muted-foreground text-center text-sm">
                    Scan in Xaman to sign.
                  </p>
                </>
              )}

            {listing && (
              <>
                <Badge variant="secondary">{listing.state.replace('_', ' ')}</Badge>
                <p className="text-center text-sm">
                  {listing.state === 'failed'
                    ? (listing.reason ?? MESSAGES.failed)
                    : MESSAGES[listing.state]}
                </p>
                {listing.state === 'sold' && (
                  <div className="w-full space-y-1 rounded-md border p-3 text-xs">
                    <div className="text-muted-foreground">seller receives</div>
                    <div>{dropsToXrp(listing.priceDrops)} XRP minus the royalty</div>
                    <div className="text-muted-foreground mt-1">platform fee</div>
                    <div>{dropsToXrp(listing.platformFeeDrops)} XRP</div>
                  </div>
                )}
              </>
            )}

            <Button variant="ghost" size="sm" onClick={() => setPhase({ kind: 'idle' })}>
              Done
            </Button>
          </div>
        )}

        {phase.kind === 'failed' && (
          <div className="space-y-3">
            <p className="text-destructive text-sm">{phase.reason}</p>
            <Button variant="secondary" size="sm" onClick={() => setPhase({ kind: 'idle' })}>
              Start over
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
