/**
 * The door.
 *
 * Organizer-facing check-in, in the way the event chose. Either the attendee signs
 * a code in Xaman, or staff scan a short-lived code the attendee displays. Either
 * way **the verdict shows here, on the staff device** — if it appeared on the
 * attendee's phone, a screenshot of a green tick would be a ticket.
 *
 * The verdict is deliberately loud and colour-coded: this is used standing up, in
 * the dark, with a queue waiting, and "already checked in" must be impossible to
 * mistake for "admitted".
 */
import { useCallback, useEffect, useState } from 'react'
import { QrCode } from '@/components/QrCode'
import { VerdictCard } from '@/components/DoorVerdict'
import { DoorCodeScan } from '@/components/DoorCodeScan'
import {
  addStaff,
  ApiError,
  fetchDoor,
  fetchDoorEvents,
  fetchStaff,
  removeStaff,
  pollCheckIn,
  startCheckIn,
  type CheckInCreated,
  type CheckInState,
  type Door,
  type DoorEvent,
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

const POLL_MS = 2000

type Phase =
  | { kind: 'idle' }
  | { kind: 'scanning'; payload: CheckInCreated }
  /** Code mode: the staff camera is open, reading guests' codes. */
  | { kind: 'camera' }
  | { kind: 'failed'; reason: string }

export function DoorPanel() {
  // Fetched here rather than passed in: door access is per event and a
  // volunteer is a plain USER, so the caller cannot know from the role alone.
  const [events, setEvents] = useState<DoorEvent[]>([])
  const [slug, setSlug] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [result, setResult] = useState<CheckInState | null>(null)
  const [door, setDoor] = useState<Door | null>(null)
  const [busy, setBusy] = useState(false)
  // Staff management is organizer-only; the request simply 403s for staff, and
  // the section stays hidden.
  const [staff, setStaff] = useState<Array<{ username: string }> | null>(null)
  const [newStaff, setNewStaff] = useState('')

  useEffect(() => {
    void fetchDoorEvents()
      .then((list) => {
        setEvents(list)
        setSlug((cur) => (cur && list.some((e) => e.slug === cur) ? cur : (list[0]?.slug ?? '')))
      })
      .catch(() => setEvents([]))
  }, [])

  const loadDoor = useCallback(async () => {
    if (!slug) return
    try {
      setDoor(await fetchDoor(slug))
    } catch {
      setDoor(null)
    }
  }, [slug])

  const loadStaff = useCallback(async () => {
    if (!slug) return
    try {
      setStaff(await fetchStaff(slug))
    } catch {
      // 403 for a staff member rather than the organizer — hide the section.
      setStaff(null)
    }
  }, [slug])

  useEffect(() => {
    void loadDoor()
    void loadStaff()
  }, [loadDoor, loadStaff])

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

  // How this event lets people in decides what the button does.
  const byCode = events.find((e) => e.slug === slug)?.doorMode === 'QR'

  if (events.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Door</CardTitle>
          <CardDescription>
            You're not on the door for any event.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

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
          {byCode
            ? "Scan each guest's code. It is signed and changes every few seconds, so a screenshot won't get anyone in."
            : "The attendee signs in Xaman — a screenshot can't sign, so this proves they hold the ticket right now."}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {phase.kind === 'idle' && (
          <div className="space-y-3">
            <select
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              aria-label="event to check in for"
              className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
            >
              {events.map((e) => (
                <option key={e.slug} value={e.slug}>
                  {e.title}
                </option>
              ))}
            </select>
            {byCode ? (
              <Button onClick={() => setPhase({ kind: 'camera' })} disabled={!slug} className="w-full">
                Scan tickets
              </Button>
            ) : (
              <Button onClick={() => void scan()} disabled={busy || !slug} className="w-full">
                {busy ? 'Preparing…' : 'Check someone in'}
              </Button>
            )}

            {staff !== null && (
              <div className="space-y-2 border-t pt-3">
                <div className="text-muted-foreground text-xs">
                  Door staff — can check people in, nothing else
                </div>
                {staff.map((m) => (
                  <div key={m.username} className="flex items-center justify-between text-xs">
                    <span>{m.username}</span>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive underline"
                      onClick={async () => {
                        await removeStaff(slug, m.username)
                        void loadStaff()
                      }}
                    >
                      remove
                    </button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <Input
                    value={newStaff}
                    onChange={(e) => setNewStaff(e.target.value)}
                    placeholder="@handle"
                    aria-label="add door staff"
                    className="h-8 text-xs"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy || !newStaff.trim()}
                    onClick={async () => {
                      setBusy(true)
                      try {
                        await addStaff(slug, newStaff)
                        setNewStaff('')
                        void loadStaff()
                      } catch {
                        // Surfaced by the list not changing.
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    Add
                  </Button>
                </div>
              </div>
            )}

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
                {/* DELIBERATELY NO `next`, and this must stay that way.
                    
                    Everywhere else in the app the QR is for the device showing
                    it, so on a phone a deep link is strictly better. The door is
                    the exact opposite: this payload is signed by the ATTENDEE,
                    and the code is displayed on the STAFF device for their phone
                    to scan. A door volunteer is holding a phone, so offering the
                    link here would open Xaman on the STAFF's device and have the
                    wrong person sign — admitting nobody at best, and the wrong
                    person if that volunteer happens to hold a ticket. */}
                <QrCode src={phase.payload.qrPng} alt="Check-in QR code" className="size-48" />
                <p className="text-muted-foreground text-center text-sm">
                  Ask them to scan this and sign.
                </p>
              </>
            )}

            {result && result.state !== 'pending' && <VerdictCard result={result} />}

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

        {phase.kind === 'camera' && (
          <DoorCodeScan slug={slug} onDone={() => setPhase({ kind: 'idle' })} onAdmitted={() => void loadDoor()} />
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
