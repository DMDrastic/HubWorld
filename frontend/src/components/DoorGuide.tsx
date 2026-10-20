import { Suspense, lazy, useEffect, useState } from 'react'
import { CalendarDays, MapPin } from 'lucide-react'
import { fetchInventory, type OwnedTicket } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// Loaded when the guide opens on a code-mode event, not with the page: it is the
// only importer of the QR encoder.
const DoorQr = lazy(() => import('@/components/DoorQr'))

const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

type Readiness = 'checking' | 'confirmed' | 'missing' | 'unknown'

/**
 * What to do at the door, and whether the ticket is ready for it.
 *
 * An event lets people in one of two ways, and this screen follows it.
 *
 * SIGNATURE: staff show a code, the attendee signs it in Xaman, and the verdict
 * appears on the STAFF device. This screen is only a GUIDE: nothing on it looks
 * like admission, because a QR or a green tick here would be a screenshot that
 * could be forwarded.
 *
 * QR: the attendee shows a code and staff scan it. It is safe to display because
 * it is signed, lives under a minute and is renewed while this screen is open
 * (`DoorQr`); a screenshot dies and a live code admits only the first person who
 * presents it. Even so, this screen never says "admitted": that verdict belongs
 * on the staff device.
 *
 * What it does do is the part a queue is bad at: tell a first-timer the three
 * things to do before they reach the front, and re-read the ledger now so a
 * ticket that was gifted or sold is found out here and not at the barrier.
 *
 * An unreadable ledger is "unknown", never "missing": it must not tell someone
 * their ticket is gone because a public node blinked.
 */
export function DoorGuide({
  ticket,
  open,
  onClose,
}: {
  ticket: OwnedTicket
  open: boolean
  onClose: () => void
}) {
  const [readiness, setReadiness] = useState<Readiness>('checking')
  const id = ticket.nfTokenId

  // Asked once each time the guide opens. `verify` reconciles against the ledger,
  // which is the point: the cached owner may be out of date.
  useEffect(() => {
    if (!open) return
    let stopped = false
    setReadiness('checking')
    fetchInventory(true).then(
      (inv) => {
        if (stopped) return
        const found = inv.tickets.find((t) => t.nfTokenId === id)
        if (!found || found.onLedger === false) setReadiness('missing')
        else if (found.onLedger === true) setReadiness('confirmed')
        else setReadiness('unknown')
      },
      () => {
        if (!stopped) setReadiness('unknown')
      },
    )
    return () => {
      stopped = true
    }
  }, [open, id])

  // Keep the screen awake while someone is reading it in a queue, where the
  // browser allows it. Never required, so every failure is ignored.
  useEffect(() => {
    if (!open) return
    let lock: { release: () => Promise<void> } | null = null
    let stopped = false
    const wakeLock = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<typeof lock> } }).wakeLock
    wakeLock?.request('screen').then(
      (l) => {
        if (stopped) void l?.release()
        else lock = l
      },
      () => undefined,
    )
    return () => {
      stopped = true
      void lock?.release().catch(() => undefined)
    }
  }, [open])

  const when = new Date(ticket.event.startsAt)
  const byCode = ticket.event.doorMode === 'QR'
  const used = ticket.status === 'REDEEMED'
  const admission = [ticket.tier, ticket.seat].filter(Boolean).join(' · ') || 'General admission'

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>At the door</DialogTitle>
          <DialogDescription>
            {byCode ? 'Hold this up to the door staff.' : 'When you reach the front, do these three things.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-1.5">
            <p className="text-xl leading-tight font-semibold tracking-[-0.01em]">{ticket.event.title}</p>
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <CalendarDays className="size-4 shrink-0" aria-hidden />
              {dateFmt.format(when)} · {timeFmt.format(when)}
            </p>
            {ticket.event.venue && (
              <p className="text-muted-foreground flex items-center gap-2 text-sm">
                <MapPin className="size-4 shrink-0" aria-hidden />
                {ticket.event.venue}
              </p>
            )}
            <p className="text-sm">{admission}</p>
          </div>

          <p
            role="status"
            className={
              used || readiness === 'missing'
                ? 'text-destructive text-sm font-medium'
                : readiness === 'confirmed'
                  ? 'text-sm font-medium text-emerald-600 dark:text-emerald-400'
                  : 'text-muted-foreground text-sm'
            }
          >
            {used
              ? 'This ticket has already been used.'
              : readiness === 'checking'
                ? 'Checking your wallet…'
                : readiness === 'confirmed'
                  ? 'Confirmed in your wallet just now.'
                  : readiness === 'missing'
                    ? "We can't find this ticket in your wallet. If you gifted or sold it, it's no longer yours."
                    : "We couldn't check just now. You can still go to the door."}
          </p>

          {ticket.status === 'LISTED' && (
            <p className="text-muted-foreground text-sm">
              This ticket is listed for sale. If it sells before you get in, it won't be yours any more.
            </p>
          )}

          {byCode ? (
            // Only while the ticket can still be used: a used ticket has no code to show.
            !used && (
              <Suspense fallback={<p className="text-muted-foreground text-center text-sm">Getting your code…</p>}>
                <DoorQr nfTokenId={ticket.nfTokenId} />
              </Suspense>
            )
          ) : (
          <ol className="space-y-2.5 text-sm">
            {[
              "Point your phone's camera at the door staff's screen. (Or open Xaman and tap Scan.)",
              'Xaman opens a request. Approve it.',
              "The door staff's screen confirms you.",
            ].map(
              (step, i) => (
                <li key={step} className="flex gap-3">
                  <span
                    aria-hidden
                    className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-xs"
                  >
                    {i + 1}
                  </span>
                  <span className="pt-0.5">{step}</span>
                </li>
              ),
            )}
          </ol>
          )}

          <p className="text-muted-foreground border-border border-t pt-4 text-xs leading-relaxed">
            {byCode
              ? "The door scans this code and confirms your ticket on their own screen. Nothing on this page says you are in."
              : 'The door confirms your ticket on their own screen. Nothing on this page gets you in by itself.'}
          </p>

          <Button variant="secondary" onClick={onClose} className="w-full">
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
