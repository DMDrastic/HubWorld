/**
 * Signing in with an email, for organizers.
 *
 * Privy handles the email and the one-time code, and creates a wallet the person owns. This
 * component turns that into a HubWorld session: it asks the server to check Privy's tokens and
 * decide whether this is someone it knows (a session) or someone new (pick a handle first).
 *
 * Rendered only where the Privy runtime was loaded; without it this draws nothing, so a visit that
 * never needed an email login carries none of it.
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiError, privyClaim, privyLogin, type AuthUser } from '@/lib/api'
import { useSignerRuntime, type PrivyWallet } from '@/lib/signer-runtime'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

type Phase =
  | { kind: 'idle' }
  | { kind: 'opening' }
  | { kind: 'connecting' }
  | { kind: 'claiming'; wallet: PrivyWallet }
  | { kind: 'failed'; reason: string }

/** A wallet made seconds ago may not be in the identity token yet; ask again a few times. */
const WALLET_RETRIES = 4
const WALLET_RETRY_MS = 1500

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function EmailSignIn({
  onAuthenticated,
  retryMs = WALLET_RETRY_MS,
}: {
  onAuthenticated: (u: AuthUser) => void
  /** How long to wait between asking again for a just-made wallet. A prop only so tests need not wait. */
  retryMs?: number
}) {
  const runtime = useSignerRuntime()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [handle, setHandle] = useState('')
  const [claimError, setClaimError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const connect = useCallback(async () => {
    if (!runtime) return
    // Leaving 'opening' straight away is what keeps the effect below from starting a second attempt.
    setPhase({ kind: 'connecting' })
    try {
      const wallet = await runtime.ensureWallet()
      for (let attempt = 0; ; attempt += 1) {
        const tokens = await runtime.getTokens()
        if (!tokens) throw new Error('Sign-in did not finish. Try again.')
        try {
          const res = await privyLogin({ ...tokens, publicKey: wallet.publicKey })
          if (res.state === 'authenticated') onAuthenticated(res.user)
          else setPhase({ kind: 'claiming', wallet })
          return
        } catch (err) {
          const waiting = err instanceof ApiError && err.code === 'no_wallet' && attempt < WALLET_RETRIES
          if (!waiting) throw err
          await sleep(retryMs)
        }
      }
    } catch (err) {
      setPhase({
        kind: 'failed',
        reason: err instanceof ApiError || err instanceof Error ? err.message : 'Could not sign in',
      })
    }
  }, [runtime, onAuthenticated, retryMs])

  // Privy's login is a modal that finishes some time after the click, so the next step is driven
  // by "now signed in to Privy", keyed on primitives rather than on `runtime` (a new object every
  // render would restart it).
  const authenticated = runtime?.authenticated ?? false
  const opening = phase.kind === 'opening'
  useEffect(() => {
    if (opening && authenticated) void connect()
  }, [opening, authenticated, connect])

  if (!runtime) return null

  async function claim(e: React.FormEvent) {
    e.preventDefault()
    if (phase.kind !== 'claiming' || !runtime) return
    setBusy(true)
    setClaimError(null)
    try {
      const tokens = await runtime.getTokens()
      if (!tokens) throw new Error('Sign-in did not finish. Try again.')
      const res = await privyClaim({ ...tokens, publicKey: phase.wallet.publicKey, username: handle })
      onAuthenticated(res.user)
    } catch (err) {
      setClaimError(err instanceof ApiError || err instanceof Error ? err.message : 'Could not claim that handle')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="elevate ring-foreground/10 rounded-2xl">
      <CardHeader>
        <CardTitle className="text-base">Sign in with email</CardTitle>
        <CardDescription className="leading-relaxed">
          No app to install. We make you a wallet that only you can sign with.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {(phase.kind === 'idle' || phase.kind === 'opening') && (
          <Button
            size="lg"
            className="w-full"
            disabled={!runtime.ready || phase.kind === 'opening'}
            onClick={() => {
              setPhase({ kind: 'opening' })
              // Already signed in to Privy (a returning visit): go straight on.
              if (runtime.authenticated) void connect()
              else runtime.openLogin()
            }}
          >
            {!runtime.ready ? 'Loading…' : phase.kind === 'opening' ? 'Waiting for your email…' : 'Continue with email'}
          </Button>
        )}

        {phase.kind === 'connecting' && <p className="text-muted-foreground text-sm">Setting up your wallet…</p>}

        {phase.kind === 'claiming' && (
          <form onSubmit={claim} className="space-y-3">
            <div className="bg-muted/50 rounded-xl border p-3 text-sm">
              <div className="text-muted-foreground text-xs">Your wallet</div>
              <div className="mt-0.5 font-mono text-xs break-all">{phase.wallet.address}</div>
            </div>
            <p className="text-sm">Pick your handle. This is how others will find you.</p>
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
              Try again
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
