import { useEffect, useMemo, useState } from 'react'
import { encode } from 'uqr'
import { ApiError, fetchDoorToken } from '@/lib/api'

/** A failed fetch is tried again this often while there is no code to show. */
const RETRY_MS = 5_000
/** Stop showing a code this long before it dies, so nobody holds up one that will not scan. */
const SAFETY_MS = 2_000

type Code = { token: string; showUntil: number }
type Problem = { final: boolean; message: string }

/**
 * The rotating code an attendee holds up at the door.
 *
 * The only importer of the QR encoder, so it loads when someone opens the door
 * guide and not before (the same arrangement as the auction chart).
 *
 * Three rules, each there because the alternative is a code that LOOKS valid and
 * is not:
 *
 * **A dead code is never shown.** It blanks when its own lifetime is up, counted
 * from when this page received it by this page's clock. Comparing the server's
 * absolute expiry against a phone clock that is minutes out would blank a good
 * code at once or show a dead one for minutes.
 *
 * **It is renewed before it dies, not after.** Fresh code every 30s against a 45s
 * life, so a slow request still lands inside the window.
 *
 * **It stops when nobody is looking.** A hidden tab asks for nothing, and asks at
 * once when it comes back; a code fetched for a locked screen is wasted.
 *
 * Everything keys on the ticket id, a primitive: a poll keyed on its own result
 * restarts itself on every answer (the GiftPanel runaway).
 */
export default function DoorQr({ nfTokenId }: { nfTokenId: string }) {
  const [code, setCode] = useState<Code | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)

  useEffect(() => {
    let stopped = false
    let timer: number | undefined
    const later = (ms: number) => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void load(), ms)
    }

    async function load() {
      if (stopped || document.hidden) return
      try {
        const t = await fetchDoorToken(nfTokenId)
        if (stopped) return
        setCode({ token: t.token, showUntil: Date.now() + t.expiresInSeconds * 1000 - SAFETY_MS })
        setProblem(null)
        later(t.refreshInSeconds * 1000)
      } catch (err) {
        if (stopped) return
        // A refusal (this is not your ticket, it has been used) will not change by
        // asking again; a network failure will.
        if (err instanceof ApiError && err.status !== undefined && err.status >= 400 && err.status < 500 && err.status !== 429) {
          setCode(null)
          setProblem({ final: true, message: err.message })
          return
        }
        setProblem({ final: false, message: 'No signal. Trying again…' })
        later(RETRY_MS)
      }
    }

    const onVisibility = () => {
      if (document.hidden) window.clearTimeout(timer)
      else void load()
    }
    document.addEventListener('visibilitychange', onVisibility)
    void load()

    return () => {
      stopped = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [nfTokenId])

  // Blank the code when its life is up, if no replacement has arrived.
  const showUntil = code?.showUntil ?? null
  useEffect(() => {
    if (showUntil === null) return
    const timer = window.setTimeout(() => setCode(null), Math.max(0, showUntil - Date.now()))
    return () => window.clearTimeout(timer)
  }, [showUntil])

  const matrix = useMemo(() => (code ? encode(code.token, { ecc: 'M', border: 0 }) : null), [code])
  const path = useMemo(() => {
    if (!matrix) return ''
    const cells: string[] = []
    matrix.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) cells.push(`M${x} ${y}h1v1h-1z`)
      }),
    )
    return cells.join('')
  }, [matrix])

  return (
    <div className="space-y-3">
      <div className="mx-auto flex aspect-square w-full max-w-72 items-center justify-center rounded-xl bg-white p-4">
        {matrix ? (
          <svg
            viewBox={`0 0 ${matrix.size} ${matrix.size}`}
            role="img"
            aria-label="Your entry code"
            shapeRendering="crispEdges"
            className="size-full"
          >
            <path d={path} fill="#000" />
          </svg>
        ) : (
          <p className="text-center text-sm text-neutral-600" role="status">
            {problem ? problem.message : 'Getting your code…'}
          </p>
        )}
      </div>
      {matrix && (
        <p className="text-muted-foreground text-center text-xs leading-relaxed">
          Turn your screen brightness up. This code keeps changing, so a screenshot won't work.
        </p>
      )}
      {problem && matrix && (
        <p className="text-muted-foreground text-center text-xs" role="status">
          {problem.message}
        </p>
      )}
    </div>
  )
}
