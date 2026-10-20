import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, scanCode, type CheckInState } from '@/lib/api'
import { VerdictCard } from '@/components/DoorVerdict'
import { Button } from '@/components/ui/button'

// Loaded when staff open the scanner: it is the only importer of the decoder.
const DoorScanner = lazy(() => import('@/components/DoorScanner'))

/** The same code seen again inside this long is the same person still holding it up. */
const REPEAT_MS = 10_000
/**
 * A verdict stays up this long, then the screen says "ready" again.
 *
 * Not a nicety: the verdict belongs to ONE person. A green "Admitted" left on
 * screen while the next guest walks up is an invitation to wave them through on
 * the last person's tick.
 */
const VERDICT_MS = 4_000

const PREFIX = 'HWD1.'

const local = (state: CheckInState['state'], reason: string): CheckInState => ({
  checkInId: 'local',
  state,
  holder: null,
  ticket: null,
  reason,
})

/**
 * Door entry by code, staff side: aim the camera, get a verdict.
 *
 * What this decides is only the handling of a stream of scans, because the
 * camera reports the same code many times a second:
 *
 * - **One at a time.** While a code is being checked, others are ignored, so two
 *   people's codes in frame cannot cross.
 * - **The same code twice is one person.** It is ignored for a few seconds, so
 *   holding a phone up for a moment is not "admitted" and then "already checked
 *   in".
 * - **Not ours, not sent.** A QR that is not a HubWorld code (a poster, a menu)
 *   is refused here, without asking the server.
 */
export function DoorCodeScan({
  slug,
  onDone,
  onAdmitted,
}: {
  slug: string
  onDone: () => void
  onAdmitted: () => void
}) {
  const [result, setResult] = useState<CheckInState | null>(null)
  const [checking, setChecking] = useState(false)
  const inFlight = useRef(false)
  const last = useRef<{ code: string; at: number } | null>(null)
  const clearTimer = useRef<number | undefined>(undefined)

  const show = useCallback((r: CheckInState) => {
    setResult(r)
    window.clearTimeout(clearTimer.current)
    clearTimer.current = window.setTimeout(() => setResult(null), VERDICT_MS)
  }, [])

  useEffect(() => () => window.clearTimeout(clearTimer.current), [])

  const handle = useCallback(
    async (text: string) => {
      if (inFlight.current) return
      const now = Date.now()
      if (last.current && last.current.code === text && now - last.current.at < REPEAT_MS) return
      last.current = { code: text, at: now }

      if (!text.startsWith(PREFIX)) {
        show(local('rejected', 'That is not a HubWorld ticket code'))
        return
      }
      inFlight.current = true
      setChecking(true)
      try {
        const r = await scanCode(slug, text)
        show(r)
        // A phone buzz is a second channel when the screen is not being looked at.
        navigator.vibrate?.(r.state === 'redeemed' ? 60 : [80, 60, 80])
        if (r.state === 'redeemed') onAdmitted()
      } catch (err) {
        // Not a verdict about the guest: the check did not happen. Say so plainly
        // rather than leave the last guest's result on screen.
        show(local('rejected', err instanceof ApiError ? err.message : 'Could not check that code. Try again.'))
      } finally {
        inFlight.current = false
        setChecking(false)
      }
    },
    [slug, show, onAdmitted],
  )

  return (
    <div className="flex flex-col items-center gap-3">
      <Suspense fallback={<p className="text-muted-foreground text-sm">Starting the camera…</p>}>
        <DoorScanner onCode={(t) => void handle(t)} paused={checking} />
      </Suspense>

      {result ? (
        <VerdictCard result={result} />
      ) : (
        <p className="text-muted-foreground text-center text-sm" role="status">
          {checking ? 'Checking…' : "Ready. Point the camera at a guest's code."}
        </p>
      )}

      <Button variant="ghost" size="sm" onClick={onDone}>
        Done
      </Button>
    </div>
  )
}
