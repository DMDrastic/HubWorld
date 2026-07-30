import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  claimUsername,
  createSignIn,
  pollSignIn,
  simulateSign,
  type AuthUser,
  type SignInCreated,
} from '@/lib/api'
import { QrCode } from '@/components/QrCode'
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
  | { kind: 'awaiting'; payload: SignInCreated }
  | { kind: 'claiming'; payload: SignInCreated; address: string }
  | { kind: 'failed'; reason: string }

export function SignIn({ onAuthenticated }: { onAuthenticated: (u: AuthUser) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const [handle, setHandle] = useState('')
  const [claimError, setClaimError] = useState<string | null>(null)

  const start = useCallback(async () => {
    setBusy(true)
    try {
      setPhase({ kind: 'awaiting', payload: await createSignIn() })
    } catch (err) {
      setPhase({
        kind: 'failed',
        reason: err instanceof ApiError ? err.message : 'Could not start sign-in',
      })
    } finally {
      setBusy(false)
    }
  }, [])

  // Poll only while a payload is outstanding.
  //
  // `stopped` is scoped to THIS effect run, not a ref. StrictMode mounts,
  // cleans up, then mounts again — a ref set during that first cleanup stays
  // true forever and silently kills polling. A per-run flag cannot.
  useEffect(() => {
    if (phase.kind !== 'awaiting') return
    const { payload } = phase
    let stopped = false
    let timer: number

    const tick = async () => {
      if (stopped) return
      try {
        const result = await pollSignIn(payload.uuid)
        if (stopped) return

        switch (result.state) {
          case 'pending':
            timer = window.setTimeout(tick, POLL_MS)
            return
          case 'authenticated':
            onAuthenticated(result.user)
            return
          case 'needs_username':
            setPhase({ kind: 'claiming', payload, address: result.address })
            return
          case 'rejected':
            setPhase({ kind: 'failed', reason: 'Sign-in was rejected in Xaman.' })
            return
          case 'expired':
            setPhase({ kind: 'failed', reason: 'Sign-in request expired. Try again.' })
            return
          case 'consumed':
            setPhase({ kind: 'failed', reason: 'That sign-in was already used.' })
            return
        }
      } catch (err) {
        if (stopped) return
        setPhase({
          kind: 'failed',
          reason: err instanceof ApiError ? err.message : 'Polling failed',
        })
      }
    }

    // Poll straight away, not after a 2s dead zone — the user may have already
    // signed by the time this mounts.
    void tick()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [phase, onAuthenticated])

  async function claim(e: React.FormEvent) {
    e.preventDefault()
    if (phase.kind !== 'claiming') return
    setBusy(true)
    try {
      const result = await claimUsername(phase.payload.uuid, handle)
      onAuthenticated(result.user)
    } catch (err) {
      setClaimError(err instanceof ApiError ? err.message : 'Could not claim that handle')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="elevate ring-foreground/10 rounded-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Sign in with Xaman
          {phase.kind === 'awaiting' && phase.payload.mode === 'stub' && (
            <Badge variant="secondary">stub mode</Badge>
          )}
        </CardTitle>
        <CardDescription className="leading-relaxed">
          Signing proves you control the wallet — no password, no seed shared.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {phase.kind === 'idle' && (
          <Button onClick={() => void start()} disabled={busy} size="lg" className="w-full">
            {busy ? 'Starting…' : 'Sign in'}
          </Button>
        )}

        {phase.kind === 'awaiting' && (
          <div className="flex flex-col items-center gap-3">
            <QrCode src={phase.payload.qrPng} alt="Xaman sign-in QR code" />
            <p className="text-muted-foreground flex items-center gap-2 text-center text-sm">
              <span className="relative flex size-1.5">
                <span className="bg-primary absolute inline-flex size-full animate-ping rounded-full opacity-70" />
                <span className="bg-primary relative inline-flex size-1.5 rounded-full" />
              </span>
              Scan in the Xaman app. Waiting for signature…
            </p>

            {phase.payload.mode === 'stub' && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void simulateSign(phase.payload.uuid)}
              >
                Simulate signing (dev)
              </Button>
            )}
          </div>
        )}

        {phase.kind === 'claiming' && (
          <form onSubmit={claim} className="space-y-3">
            <div className="bg-muted/50 rounded-xl border p-3 text-sm">
              <div className="text-muted-foreground text-xs">Wallet verified</div>
              <div className="mt-0.5 font-mono text-xs break-all">{phase.address}</div>
            </div>
            <p className="text-sm">Pick your handle — this is how others will find you.</p>
            <div className="flex gap-2">
              <Input
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="@yourhandle"
                aria-label="choose a username"
              />
              <Button type="submit" disabled={busy || !handle.trim()}>
                {busy ? '…' : 'Claim'}
              </Button>
            </div>
            {claimError && <p className="text-destructive text-sm">{claimError}</p>}
          </form>
        )}

        {phase.kind === 'failed' && (
          <div className="space-y-3">
            <p className="text-destructive text-sm">{phase.reason}</p>
            <Button variant="secondary" onClick={() => setPhase({ kind: 'idle' })}>
              Start over
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
