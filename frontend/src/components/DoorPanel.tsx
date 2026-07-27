/**
 * The door.
 *
 * Organizer-facing check-in. The attendee signs in Xaman and **the verdict shows
 * here, on the staff device** — if it appeared on the attendee's phone, a
 * screenshot of a green tick would be a ticket.
 *
 * The verdict is deliberately loud and colour-coded: this is used standing up, in
 * the dark, with a queue waiting, and "already checked in" must be impossible to
 * mistake for "admitted".
 */
import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  fetchDoor,
  pollCheckIn,
  startCheckIn,
  type CheckInCreated,
  type CheckInState,
  type Door,
  type EventSummary,
} from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

const POLL_MS = 2000

type Phase =
  | { kind: 'idle' }
  | { kind: 'scanning'; payload: CheckInCreated }
  | { kind: 'failed'; reason: string }

/** Verdict presentation. Admission is the only green outcome. */
const VERDICT: Record<
  CheckInState['state'],
  { label: string; detail: string; tone: 'good' | 'bad' | 'wait' }
> = {
  pending: { label: 'Waiting', detail: 'Ask them to scan and sign.', tone: 'wait' },
  redeemed: { label: 'Admitted', detail: 'Valid ticket, checked in.', tone: 'good' },
  already_used: {
    label: 'Already checked in',
    detail: 'This ticket has been used. Do not admit.',
    tone: 'bad',
  },
  no_ticket: {
    label: 'No valid ticket',
    detail: 'They hold no ticket for this event.',
    tone: 'bad',
  },
  rejected: { label: 'Declined', detail: 'They cancelled in Xaman.', tone: 'bad' },
  expired: { label: 'Expired', detail: 'Took too long — start another.', tone: 'bad' },
}

export function DoorPanel({ events }: { events: EventSummary[] }) {
  const [slug, setSlug] = useState(events[0]?.slug ?? '')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [result, setResult] = useState<CheckInState | null>(null)
  const [door, setDoor] = useState<Door | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (events.length > 0 && !events.some((e) => e.slug === slug)) setSlug(events[0]!.slug)
  }, [events, slug])

  const loadDoor = useCallback(async () => {
    if (!slug) return
    try {
      setDoor(await fetchDoor(slug))
    } catch {
      setDoor(null)
    }
  }, [slug])

  useEffect(() => {
    void loadDoor()
  }, [loadDoor])

  // Keyed on the payload uuid, not the polled result — the dependency mistake
  // that turned GiftPanel's poll into a request loop.
  const activeUuid = phase.kind === 'scanning' ? phase.payload.uuid : null

  useEffect(() => {
    if (!activeUuid) return
    let stopped = false
    let timer: number

    const tick = async () => {
      if (stopped) return
      try {
        const next = await pollCheckIn(activeUuid)
        if (stopped) return
        setResult(next)
        if (next.state !== 'pending') {
          void loadDoor()
          return
        }
        timer = window.setTimeout(tick, POLL_MS)
      } catch (err) {
        if (stopped) return
        setPhase({
          kind: 'failed',
          reason: err instanceof ApiError ? err.message : 'Check-in failed',
        })
      }
    }

    void tick()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [activeUuid, loadDoor])

  async function scan() {
    setBusy(true)
    try {
      setResult(null)
      setPhase({ kind: 'scanning', payload: await startCheckIn(slug) })
    } catch (err) {
      setPhase({
        kind: 'failed',
        reason: err instanceof ApiError ? err.message : 'Could not start check-in',
      })
    } finally {
      setBusy(false)
    }
  }

  if (events.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Door</CardTitle>
          <CardDescription>
            You don't organize any events, so there's no door to run.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const verdict = result ? VERDICT[result.state] : null
  const toneClass =
    verdict?.tone === 'good'
      ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
      : verdict?.tone === 'bad'
        ? 'border-destructive/60 bg-destructive/10 text-destructive'
        : 'border-border'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Door
          {door && (
            <Badge variant="secondary">
              {door.admitted}/{door.issued} in
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          The attendee signs in Xaman — a screenshot can't sign, so this proves they hold the
          ticket right now.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {phase.kind === 'idle' && (
          <div className="space-y-3">
            <select
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              aria-label="event to check in for"
              className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
            >
              {events.map((e) => (
                <option key={e.slug} value={e.slug}>
                  {e.title}
                </option>
              ))}
            </select>
            <Button onClick={() => void scan()} disabled={busy || !slug} className="w-full">
              {busy ? 'Preparing…' : 'Check someone in'}
            </Button>

            {door && door.recent.length > 0 && (
              <div className="space-y-1 pt-2">
                <div className="text-muted-foreground text-xs">Recently admitted</div>
                {door.recent.slice(0, 5).map((r, i) => (
                  <div key={i} className="flex justify-between text-xs">
                    <span>{r.holder ?? 'unknown'}</span>
                    <span className="text-muted-foreground">
                      {[r.tier, r.seat].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {phase.kind === 'scanning' && (
          <div className="flex flex-col items-center gap-3">
            {(!result || result.state === 'pending') && (
              <>
                <img
                  src={phase.payload.qrPng}
                  alt="Check-in QR code"
                  className="size-48 rounded-md border"
                />
                <p className="text-muted-foreground text-center text-sm">
                  Ask them to scan this and sign.
                </p>
              </>
            )}

            {verdict && result && result.state !== 'pending' && (
              <div className={`w-full rounded-lg border-2 p-4 text-center ${toneClass}`}>
                <div className="text-xl font-semibold">{verdict.label}</div>
                <div className="mt-1 text-sm">{result.reason ?? verdict.detail}</div>
                {result.holder && <div className="mt-2 text-sm font-medium">{result.holder}</div>}
                {result.ticket && (result.ticket.tier || result.ticket.seat) && (
                  <div className="text-xs opacity-80">
                    {[result.ticket.tier, result.ticket.seat].filter(Boolean).join(' · ')}
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <Button size="sm" onClick={() => void scan()} disabled={busy}>
                Next person
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setPhase({ kind: 'idle' })}>
                Done
              </Button>
            </div>
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
