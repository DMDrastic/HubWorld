import { useCallback, useEffect, useState } from 'react'
import { QrCode } from '@/components/QrCode'
import {
  ApiError,
  fetchDelegation,
  pollDelegation,
  requestGrant,
  requestRevoke,
  type DelegationCreated,
  type DelegationMe,
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

const POLL_MS = 2500

type Action = 'grant' | 'revoke'

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; me: DelegationMe }
  | { kind: 'awaiting'; action: Action; payload: DelegationCreated; signed: boolean }
  | { kind: 'failed'; reason: string }

/**
 * Lets an organizer sign ONE grant instead of one signature per ticket, and take
 * it back whenever they like.
 *
 * What is granted is exactly "mint tickets as you" and nothing else, and the
 * words here say so — this is the moment an organizer agrees HubWorld may act as
 * them at all, so the screen states the limit and names the exit before asking
 * for the signature. Revoking is as prominent as granting, deliberately: a
 * permission that is easy to give and hard to withdraw is not revocable in any
 * sense that matters.
 *
 * Absent entirely where the network cannot do it, rather than disabled — a
 * greyed-out control still advertises a capability that is not there.
 */
export function DelegationPanel() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setPhase({ kind: 'ready', me: await fetchDelegation() })
    } catch (err) {
      // A failed read says nothing about the grant. Never present it as one.
      setPhase({
        kind: 'failed',
        reason: err instanceof ApiError ? err.message : 'Could not check your minting access',
      })
    }
  }, [])

  // Per-run flag, not a ref: StrictMode's mount -> cleanup -> remount would
  // leave a ref set during cleanup permanently true (the SignIn bug).
  useEffect(() => {
    let stopped = false
    fetchDelegation().then(
      (me) => {
        if (!stopped) setPhase({ kind: 'ready', me })
      },
      (err) => {
        if (stopped) return
        setPhase({
          kind: 'failed',
          reason: err instanceof ApiError ? err.message : 'Could not check your minting access',
        })
      },
    )
    return () => {
      stopped = true
    }
  }, [])

  async function start(action: Action) {
    setBusy(true)
    try {
      const result = await (action === 'grant' ? requestGrant() : requestRevoke())
      if ('uuid' in result) {
        setPhase({ kind: 'awaiting', action, payload: result, signed: false })
      } else {
        // Already in the state asked for — no signature needed.
        await load()
      }
    } catch (err) {
      setPhase({
        kind: 'failed',
        reason: err instanceof ApiError ? err.message : 'Could not start the request',
      })
    } finally {
      setBusy(false)
    }
  }

  // Keyed on the payload id, a primitive. Keying on `phase` would re-run this on
  // every poll result and fire the next request immediately instead of after
  // POLL_MS — the GiftPanel runaway.
  const awaitingUuid = phase.kind === 'awaiting' ? phase.payload.uuid : null
  useEffect(() => {
    if (!awaitingUuid) return
    let stopped = false
    let timer: number

    const tick = async () => {
      if (stopped) return
      try {
        const result = await pollDelegation(awaitingUuid)
        if (stopped) return

        switch (result.state) {
          case 'pending':
            // Surface the signed-but-unvalidated gap so a slow ledger does not
            // look like the signature never landed.
            setPhase((p) =>
              p.kind === 'awaiting' && p.signed !== (result.signed ?? false)
                ? { ...p, signed: result.signed ?? false }
                : p,
            )
            timer = window.setTimeout(tick, POLL_MS)
            return
          case 'granted':
          case 'revoked':
            await load()
            return
          case 'rejected':
            setPhase({ kind: 'failed', reason: 'The request was declined in Xaman.' })
            return
          case 'expired':
            setPhase({ kind: 'failed', reason: 'The request expired. Try again.' })
            return
          case 'failed':
            setPhase({ kind: 'failed', reason: result.reason })
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

    void tick()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [awaitingUuid, load])

  if (phase.kind === 'loading') return null
  if (phase.kind === 'ready' && !phase.me.available) return null

  const granted = phase.kind === 'ready' && phase.me.available && phase.me.state === 'granted'
  const unknown = phase.kind === 'ready' && phase.me.available && phase.me.state === 'unknown'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Minting for you
          {phase.kind === 'awaiting' && phase.payload.mode === 'stub' && (
            <Badge variant="secondary">stub mode</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Sign once and HubWorld can mint your event's tickets without asking for a signature on
          every one. It can mint and nothing else: it cannot touch your funds or move your tickets,
          and you can take the permission back here at any time.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {phase.kind === 'ready' && (
          <div className="space-y-3">
            <p className="text-sm" role="status">
              {granted && 'HubWorld can mint tickets for you.'}
              {unknown && "We couldn't read your account just now. Your access hasn't changed."}
              {!granted && !unknown && 'HubWorld cannot mint for you yet.'}
            </p>

            {phase.me.available && phase.me.staleGrant && (
              <p className="text-muted-foreground text-xs">
                Your earlier approval names a minting account that has since been replaced, so it
                no longer applies. Approve again to continue.
              </p>
            )}

            {granted ? (
              <Button
                variant="secondary"
                onClick={() => void start('revoke')}
                disabled={busy}
                className="w-full"
              >
                {busy ? 'Preparing…' : 'Revoke minting access'}
              </Button>
            ) : unknown ? (
              <Button variant="secondary" onClick={() => void load()} className="w-full">
                Check again
              </Button>
            ) : (
              <Button onClick={() => void start('grant')} disabled={busy} className="w-full">
                {busy ? 'Preparing…' : 'Let HubWorld mint for me'}
              </Button>
            )}
          </div>
        )}

        {phase.kind === 'awaiting' && (
          <div className="flex flex-col items-center gap-3">
            <QrCode
              src={phase.payload.qrPng}
              alt={phase.action === 'grant' ? 'Xaman approval QR code' : 'Xaman revoke QR code'}
              next={phase.payload.next}
              mode={phase.payload.mode}
            />
            <p className="text-muted-foreground text-center text-sm">
              {phase.signed
                ? 'Signed — waiting for the ledger to confirm…'
                : phase.action === 'grant'
                  ? 'Scan in Xaman to approve minting.'
                  : 'Scan in Xaman to take the permission back.'}
            </p>
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              Cancel
            </Button>
          </div>
        )}

        {phase.kind === 'failed' && (
          <div className="space-y-3">
            <p className="text-destructive text-sm">{phase.reason}</p>
            <Button variant="secondary" onClick={() => void load()}>
              Back
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
