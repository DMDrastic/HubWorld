import { useEffect, useState } from 'react'
import { SigningPrompt } from '@/components/SigningPrompt'
import { WalletFunding } from '@/components/WalletFunding'
import {
  ApiError,
  checkout,
  dropsToXrp,
  pollListing,
  type CheckoutCreated,
  type EventSummary,
  type Listing,
  type WalletNeedsFunds,
  walletNeedsFunds,
} from '@/lib/api'
import { PRICE_UNAVAILABLE, formatFiat } from '@/lib/fiat'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const POLL_MS = 2500

type Phase =
  | { kind: 'idle' }
  | { kind: 'reserving' }
  | { kind: 'buying'; created: CheckoutCreated; state: Listing['state']; signed: boolean }
  | { kind: 'done' }
  /** The wallet cannot pay: nothing was held. Shows the address to fund and how much. */
  | { kind: 'needs-funds'; info: WalletNeedsFunds }
  | { kind: 'stopped'; reason: string }
  /** An XRP quote's two minutes passed before it was signed. Nothing was charged; one press quotes again. */
  | { kind: 'requote' }

/** Shown in place of "Pay with XRP" when there is no fresh XRP price. The US$ price stays on screen. */
const XRP_UNAVAILABLE = 'XRP payment unavailable right now'

/** States in which the buyer still has something to sign, so the QR belongs on screen. */
const NEEDS_SIGNATURE = new Set<Listing['state']>(['pending_offer', 'active', 'buyer_pending'])

/**
 * Buy a ticket from the box office.
 *
 * Nothing is listed until you press the button: pressing it holds one ticket for
 * you, and from then on it is the ordinary sale — you sign once, and HubWorld
 * completes the purchase. The hold is the reason for the wording about time. It
 * is real and short, and a buyer who wanders off should know their ticket goes
 * back on sale rather than finding out by losing it.
 *
 * Every refusal is shown in the server's own words ("Sold out", "Lots of people
 * are buying right now"), because those were written to be acted on.
 */
export function CheckoutDialog({
  event,
  open,
  signedIn,
  onOpenChange,
  onSold,
}: {
  event: EventSummary
  open: boolean
  signedIn: boolean
  onOpenChange: (open: boolean) => void
  onSold: () => void
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  // The all-in amount from the server (the figure the checkout charges); the bare ticket price against a server that
  // sends none. The fee inside it is named so the total is never a surprise at the signing screen.
  // A box office priced in US$ shows its own price whatever XRP is doing; only paying in XRP needs a fresh price, and
  // only that is unavailable without one. An event still priced in XRP pauses instead (never XRP, never an old figure).
  // The exact XRP is shown where it belongs: on the approval screen, under Details.
  const box = event.boxOffice
  const shown = box ? box.allInMinor : (event.primaryAllInDrops ?? event.primaryPriceDrops)
  const shownFiat = box
    ? { currency: 'USD' as const, minor: box.allInMinor }
    : event.fiat?.[event.primaryAllInDrops ? 'primaryAllInDrops' : 'primaryPriceDrops']
  const price = shownFiat ? formatFiat(shownFiat) : null
  const feeFiat = box ? { currency: 'USD' as const, minor: box.feeMinor } : event.primaryAllInDrops ? event.fiat?.primaryFeeDrops : undefined
  const xrpUnavailable = box !== undefined && !box.xrpPayable

  async function start() {
    setPhase({ kind: 'reserving' })
    try {
      const created = await checkout(event.slug)
      setPhase({ kind: 'buying', created, state: 'buyer_pending', signed: false })
    } catch (err) {
      const short = walletNeedsFunds(err)
      if (short) {
        setPhase({ kind: 'needs-funds', info: short })
        return
      }
      setPhase({
        kind: 'stopped',
        reason:
          err instanceof ApiError && err.code === 'IN_PROGRESS'
            ? 'You already have a purchase in progress for this event. Finish it, or wait a few minutes for it to lapse.'
            : err instanceof ApiError
              ? err.message
              : 'Could not start the purchase',
      })
    }
  }

  // Keyed on the listing id, a primitive. Keying on `phase` would re-run this on
  // every poll result and fire the next request at once instead of after POLL_MS
  // (the GiftPanel runaway).
  const listingId = phase.kind === 'buying' ? phase.created.listingId : null
  // A primitive for the effect, like the listing id: whether this purchase was quoted from a US$ price.
  const quoted = phase.kind === 'buying' && phase.created.quote !== undefined
  useEffect(() => {
    if (!listingId) return
    let stopped = false
    let timer: number

    const tick = async () => {
      if (stopped) return
      try {
        const l = await pollListing(listingId)
        if (stopped) return

        if (l.state === 'sold') {
          setPhase({ kind: 'done' })
          onSold()
          return
        }
        if (l.state === 'cancelled' || l.state === 'expired') {
          setPhase(
            quoted
              ? { kind: 'requote' }
              : { kind: 'stopped', reason: 'Your hold ran out before the purchase was signed. Nothing was charged — you can try again.' },
          )
          return
        }
        if (l.state === 'failed') {
          setPhase({ kind: 'stopped', reason: l.reason ?? 'The purchase could not be completed.' })
          return
        }

        setPhase((p) =>
          p.kind === 'buying' && (p.state !== l.state || p.signed !== (l.signed ?? false))
            ? { ...p, state: l.state, signed: l.signed ?? false }
            : p,
        )
      } catch {
        // A blip in the poll is not a failed purchase; keep watching.
      }
      timer = window.setTimeout(tick, POLL_MS)
    }

    timer = window.setTimeout(tick, POLL_MS)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [listingId, onSold, quoted])

  // Closing mid-purchase abandons the poll but not the hold: it lapses on its own.
  function close(next: boolean) {
    if (!next) setPhase({ kind: 'idle' })
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{event.title}</DialogTitle>
          <DialogDescription>
            {price ? `${price} per ticket${feeFiat ? ', fee included' : ''}.` : 'Tickets for this event.'}
          </DialogDescription>
        </DialogHeader>

        {phase.kind === 'idle' && (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm leading-relaxed">
              Pressing buy holds one ticket for you for a few minutes. You approve it once with your wallet, and the
              ticket goes into it. {feeFiat
                ? `That price includes a ${formatFiat(feeFiat)} HubWorld fee.`
                : "A small HubWorld fee is added, and you'll see the exact total before you approve."}
            </p>
            {shown && !price ? (
              <p className="text-sm" role="status">
                {PRICE_UNAVAILABLE}. Try again in a few minutes.
              </p>
            ) : signedIn && box ? (
              <div className="space-y-2">
                <Button onClick={() => void start()} className="w-full" disabled={xrpUnavailable}>
                  Pay with XRP
                </Button>
                {xrpUnavailable && (
                  <p className="text-muted-foreground text-sm" role="status">
                    {XRP_UNAVAILABLE}
                  </p>
                )}
              </div>
            ) : signedIn ? (
              <Button onClick={() => void start()} className="w-full">
                {price ? `Buy a ticket for ${price}` : 'Buy a ticket'}
              </Button>
            ) : (
              <p className="text-sm">Sign in to buy a ticket.</p>
            )}
          </div>
        )}

        {phase.kind === 'reserving' && (
          <p className="text-muted-foreground text-sm" role="status">
            Holding a ticket for you…
          </p>
        )}

        {phase.kind === 'buying' && (
          <div className="flex flex-col items-center gap-3">
            {NEEDS_SIGNATURE.has(phase.state) && !phase.signed ? (
              <>
                {phase.created.quote && (
                  <p className="text-muted-foreground text-center text-xs">
                    This XRP amount is held for 2 minutes. After that, get a new quote; nothing is charged.
                  </p>
                )}
                <SigningPrompt
                  payload={phase.created}
                  action={{ kind: 'buy', amountDrops: phase.created.paysDrops, label: event.title }}
                  qrAlt="Xaman purchase QR code"
                  // The held amount's own figure; the exact XRP is under Details on the approval screen, and in Xaman.
                  shownPrice={phase.created.fiat?.paysDrops ? formatFiat(phase.created.fiat.paysDrops) : undefined}
                  qrHint={`Scan in Xaman to approve. Exact amount: ${dropsToXrp(phase.created.paysDrops)} XRP.`}
                />
                <p className="text-muted-foreground text-center text-xs">
                  Your ticket is held for a few minutes. If you don't sign, it goes back on sale and
                  nothing is charged.
                </p>
              </>
            ) : (
              <p className="text-muted-foreground text-center text-sm" role="status">
                Signed — HubWorld is completing your purchase…
              </p>
            )}
          </div>
        )}

        {phase.kind === 'needs-funds' && <WalletFunding info={phase.info} onRetry={() => void start()} />}

        {phase.kind === 'done' && (
          <div className="space-y-3">
            <p className="text-sm font-medium">The ticket is yours.</p>
            <p className="text-muted-foreground text-sm">
              It's in your wallet now, and you'll find it under <a className="underline" href="/tickets">Tickets</a>.
            </p>
            <Button variant="secondary" onClick={() => close(false)}>
              Close
            </Button>
          </div>
        )}

        {phase.kind === 'requote' && (
          <div className="space-y-3">
            <p className="text-sm" role="status">
              The XRP quote expired after 2 minutes. Nothing was charged.
            </p>
            <Button onClick={() => void start()} className="w-full">
              Get a new quote
            </Button>
          </div>
        )}

        {phase.kind === 'stopped' && (
          <div className="space-y-3">
            <p className="text-destructive text-sm" role="alert">
              {phase.reason}
            </p>
            <Button variant="secondary" onClick={() => setPhase({ kind: 'idle' })}>
              Back
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
