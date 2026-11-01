import { useEffect, useState } from 'react'
import { QrCode } from '@/components/QrCode'
import {
  ApiError,
  checkout,
  dropsToXrp,
  pollListing,
  type CheckoutCreated,
  type EventSummary,
  type Listing,
} from '@/lib/api'
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
  | { kind: 'stopped'; reason: string }

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
  const shown = event.primaryAllInDrops ?? event.primaryPriceDrops
  const price = shown ? dropsToXrp(shown) : null
  const fee = event.primaryAllInDrops && event.primaryFeeDrops ? dropsToXrp(event.primaryFeeDrops) : null

  async function start() {
    setPhase({ kind: 'reserving' })
    try {
      const created = await checkout(event.slug)
      setPhase({ kind: 'buying', created, state: 'buyer_pending', signed: false })
    } catch (err) {
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
          setPhase({
            kind: 'stopped',
            reason: 'Your hold ran out before the purchase was signed. Nothing was charged — you can try again.',
          })
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
  }, [listingId, onSold])

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
            {price ? `${price} XRP per ticket${fee ? `, fee included` : ''}.` : 'Tickets for this event.'}
          </DialogDescription>
        </DialogHeader>

        {phase.kind === 'idle' && (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm leading-relaxed">
              Pressing buy holds one ticket for you for a few minutes. You sign once in Xaman, and the
              ticket goes into your wallet. {fee
                ? `That price includes a ${fee} XRP HubWorld fee.`
                : "A small HubWorld fee is added, and you'll see the exact total before you sign."}
            </p>
            {signedIn ? (
              <Button onClick={() => void start()} className="w-full">
                {price ? `Buy a ticket for ${price} XRP` : 'Buy a ticket'}
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
                <QrCode
                  src={phase.created.qrPng}
                  alt="Xaman purchase QR code"
                  next={phase.created.next}
                  mode={phase.created.mode}
                />
                <p className="text-center text-sm">
                  Scan in Xaman to pay {dropsToXrp(phase.created.paysDrops)} XRP.
                </p>
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
