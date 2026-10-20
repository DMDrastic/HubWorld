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
import { useCallback, useEffect, useRef, useState } from 'react'
import { QrCode } from '@/components/QrCode'
import { VerdictCard } from '@/components/DoorVerdict'
import { DoorCodeScan } from '@/components/DoorCodeScan'
import {
  addStaff,
  ApiError,
  fetchDoor,
  fetchDoorEvents,
  fetchPolicy,
  fetchStaff,
  removeStaff,
  setDoorMode,
  pollCheckIn,
  startCheckIn,
  type CheckInCreated,
  type CheckInState,
  type Door,
  type DoorEvent,
  type DoorMode,
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

/** After a verdict, the next guest's QR is up this soon, with no tap. */
const ADVANCE_MS = 300
/**
 * An unused QR rolls over by itself, but each roll is a Xaman payload, so after
 * this many in a row with nobody signing it stops and waits to be tapped. An idle
 * screen left open overnight must not spend a day's quota.
 */
const MAX_IDLE_ROLLS = 3
/** The last guest's verdict stays beside the next QR this long, labelled as theirs. */
const PREVIOUS_MS = 8_000

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
  // The guest before this one: kept on screen, labelled, while the next QR is up.
  const [previous, setPrevious] = useState<CheckInState | null>(null)
  // The next QR could not be made; the verdict stays and a tap retries.
  const [advanceError, setAdvanceError] = useState<string | null>(null)
  // Set once unused QRs have rolled over MAX_IDLE_ROLLS times in a row.
  const [paused, setPaused] = useState(false)
  const idleRolls = useRef(0)
  // Whether this server can run the code door, so the organizer is only offered it where it will work.
  const [doorCodes, setDoorCodes] = useState(false)

  useEffect(() => {
    fetchPolicy().then(
      (p) => setDoorCodes(p.doorCodes === true),
      () => undefined,
    )
  }, [])

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

  async function changeMode(mode: DoorMode) {
    setBusy(true)
    try {
      const done = await setDoorMode(slug, mode)
      setEvents((list) => list.map((e) => (e.slug === done.slug ? { ...e, doorMode: done.doorMode } : e)))
    } catch (err) {
      setPhase({ kind: 'failed', reason: err instanceof ApiError ? err.message : 'Could not change the door' })
    } finally {
      setBusy(false)
    }
  }

  const startNext = useCallback(
    async (auto: boolean) => {
      setBusy(true)
      try {
        const payload = await startCheckIn(slug)
        setAdvanceError(null)
        setResult(null)
        setPhase({ kind: 'scanning', payload })
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Could not start check-in'
        // Automatic: keep the verdict on screen and offer a retry. Manual: the old behaviour.
        if (auto) setAdvanceError(message)
        else setPhase({ kind: 'failed', reason: message })
      } finally {
        setBusy(false)
      }
    },
    [slug],
  )

  /** Staff pressed "Check someone in" or "Next person". */
  function scan() {
    idleRolls.current = 0
    setPaused(false)
    setPrevious(null)
    void startNext(false)
  }

  // The next guest, with no tap. Keyed on the payload and the verdict state, both
  // primitives: this must run once per verdict, not once per render.
  const resultState = result?.state ?? null
  useEffect(() => {
    if (!activeUuid || !resultState || resultState === 'pending') return

    // An unused QR timing out is not a guest, so it is not shown as a verdict: it
    // is replaced. Bounded, because each replacement costs a Xaman payload.
    if (resultState === 'expired') {
      if (idleRolls.current >= MAX_IDLE_ROLLS) {
        setPaused(true)
        return
      }
      idleRolls.current += 1
      void startNext(true)
      return
    }

    idleRolls.current = 0
    const timer = window.setTimeout(() => {
      setPrevious(result)
      void startNext(true)
    }, ADVANCE_MS)
    return () => window.clearTimeout(timer)
    // `result` is read when the timer fires; it does not change once a verdict is final.
  }, [activeUuid, resultState, result, startNext])

  // The previous guest's verdict fades from the screen, so it cannot be mistaken for the next one's.
  const previousId = previous?.checkInId ?? null
  useEffect(() => {
    if (!previousId) return
    const timer = window.setTimeout(() => setPrevious(null), PREVIOUS_MS)
    return () => window.clearTimeout(timer)
  }, [previousId])

  // An unused QR timing out is replaced, not shown as an alarming verdict, until it stops rolling.
  const showVerdict = !!result && result.state !== 'pending' && (result.state !== 'expired' || paused)
  const refreshing = result?.state === 'expired' && !paused

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
              <Button onClick={() => scan()} disabled={busy || !slug} className="w-full">
                {busy ? 'Preparing…' : 'Check someone in'}
              </Button>
            )}

            {/* The organizer's choice, not door staff's: `staff` only loads for the organizer. */}
            {staff !== null && (doorCodes || byCode) && (
              <div className="space-y-1 border-t pt-3">
                <label htmlFor="door-mode" className="text-muted-foreground text-xs">
                  How guests get in
                </label>
                <select
                  id="door-mode"
                  value={byCode ? 'QR' : 'SIGNATURE'}
                  disabled={busy}
                  onChange={(e) => void changeMode(e.target.value as DoorMode)}
                  className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
                >
                  <option value="QR" disabled={!doorCodes}>
                    Guests show a code (fast)
                  </option>
                  <option value="SIGNATURE">Guests approve in Xaman (strictest)</option>
                </select>
              </div>
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
            {/* The last guest's verdict, labelled as theirs, while the next QR is up. Hidden
                as soon as THIS guest has a verdict of their own, so two never show at once. */}
            {previous && !showVerdict && (
              <div className="w-full space-y-1">
                <p className="text-muted-foreground text-center text-xs">Previous guest</p>
                <VerdictCard result={previous} compact />
              </div>
            )}

            {!showVerdict && refreshing && (
              <p className="text-muted-foreground flex size-48 items-center justify-center text-center text-sm" role="status">
                Getting a new code…
              </p>
            )}

            {!showVerdict && !refreshing && (
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

            {showVerdict && result && <VerdictCard result={result} />}

            {paused && result?.state === 'expired' && (
              <p className="text-muted-foreground text-center text-xs">
                Nobody has scanned for a while, so this stopped making new codes. Tap to continue.
              </p>
            )}
            {advanceError && (
              <p className="text-destructive text-center text-sm" role="alert">
                {advanceError}
              </p>
            )}

            <div className="flex gap-2">
              <Button size="sm" onClick={() => scan()} disabled={busy}>
                {paused || advanceError ? 'Continue' : 'Next person'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  idleRolls.current = 0
                  setPaused(false)
                  setPrevious(null)
                  setAdvanceError(null)
                  setPhase({ kind: 'idle' })
                }}
              >
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
