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
  type DelegationScope,
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

/**
 * Two permissions, each its own consent and its own card.
 *
 * They are separate because they are not the same size of trust. Minting only
 * ever creates value for the organizer. Selling lets HubWorld put one of their
 * EXISTING tickets up for sale, so it is described in those words, asked for
 * separately, and revoked separately — a button that quietly also ended minting
 * (or the reverse) is exactly the surprise this screen exists to prevent.
 */
const COPY: Record<
  DelegationScope,
  {
    title: string
    description: string
    on: string
    off: string
    grant: string
    revoke: string
    scanGrant: string
    scanRevoke: string
    qrGrant: string
    qrRevoke: string
  }
> = {
  mint: {
    title: 'Minting for you',
    description:
      "Sign once and HubWorld can mint your event's tickets without asking for a signature on every one. It can mint and nothing else: it cannot touch your funds or move your tickets, and you can take the permission back here at any time.",
    on: 'HubWorld can mint tickets for you.',
    off: 'HubWorld cannot mint for you yet.',
    grant: 'Let HubWorld mint for me',
    revoke: 'Revoke minting access',
    scanGrant: 'Scan in Xaman to approve minting.',
    scanRevoke: 'Scan in Xaman to take the permission back.',
    qrGrant: 'Xaman approval QR code',
    qrRevoke: 'Xaman revoke QR code',
  },
  offers: {
    title: 'Selling for you',
    description:
      "Let HubWorld put one of your tickets up for sale at the moment someone buys it, at the price you set, so you never have to list them all up front. It can list your tickets and nothing else: it cannot touch your funds. Because it can list any ticket in your account, approve this when you're ready to open sales, and take it back here at any time.",
    on: 'HubWorld can list your tickets for sale.',
    off: 'HubWorld cannot list tickets for you yet.',
    grant: 'Let HubWorld sell for me',
    revoke: 'Revoke selling access',
    scanGrant: 'Scan in Xaman to approve selling.',
    scanRevoke: 'Scan in Xaman to take selling back.',
    qrGrant: 'Xaman selling approval QR code',
    qrRevoke: 'Xaman selling revoke QR code',
  },
}

/**
 * Lets an organizer sign ONE grant per permission instead of one signature per
 * ticket, and take each back whenever they like.
 *
 * Absent entirely where the network cannot do it, rather than disabled — a
 * greyed-out control still advertises a capability that is not there.
 */
export function DelegationPanel() {
  const [me, setMe] = useState<DelegationMe | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setMe(await fetchDelegation())
      setError(null)
    } catch (err) {
      // A failed read says nothing about the grant. Never present it as one.
      setError(err instanceof ApiError ? err.message : 'Could not check your access')
    }
  }, [])

  // Per-run flag, not a ref: StrictMode's mount -> cleanup -> remount would
  // leave a ref set during cleanup permanently true (the SignIn bug).
  useEffect(() => {
    let stopped = false
    fetchDelegation().then(
      (next) => {
        if (!stopped) setMe(next)
      },
      (err) => {
        if (!stopped) setError(err instanceof ApiError ? err.message : 'Could not check your access')
      },
    )
    return () => {
      stopped = true
    }
  }, [])

  if (error && !me) {
    return (
      <Card>
        <CardContent className="space-y-3 pt-6">
          <p className="text-destructive text-sm">{error}</p>
          <Button variant="secondary" onClick={() => void load()}>
            Back
          </Button>
        </CardContent>
      </Card>
    )
  }
  if (!me || !me.available) return null

  const perms = me.permissions
  return (
    <>
      <PermissionCard scope="mint" reading={perms?.mint ?? me.state} onChanged={load} />
      {/* A server that predates the second permission reports only the first. */}
      {perms && <PermissionCard scope="offers" reading={perms.offers} onChanged={load} />}
      {me.staleGrant && (
        <p className="text-muted-foreground text-xs">
          Your earlier approval names a minting account that has since been replaced, so it no
          longer applies. Approve again to continue.
        </p>
      )}
    </>
  )
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'awaiting'; action: Action; payload: DelegationCreated; signed: boolean }
  | { kind: 'failed'; reason: string }

function PermissionCard({
  scope,
  reading,
  onChanged,
}: {
  scope: DelegationScope
  reading: 'granted' | 'not_granted' | 'unknown'
  onChanged: () => Promise<void>
}) {
  const copy = COPY[scope]
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)

  const done = useCallback(async () => {
    await onChanged()
    setPhase({ kind: 'idle' })
  }, [onChanged])

  async function start(action: Action) {
    setBusy(true)
    try {
      const result = await (action === 'grant' ? requestGrant(scope) : requestRevoke(scope))
      if ('uuid' in result) {
        setPhase({ kind: 'awaiting', action, payload: result, signed: false })
      } else {
        // Already in the state asked for — no signature needed.
        await done()
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
            await done()
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
  }, [awaitingUuid, done])

  const granted = reading === 'granted'
  const unknown = reading === 'unknown'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {copy.title}
          {phase.kind === 'awaiting' && phase.payload.mode === 'stub' && (
            <Badge variant="secondary">stub mode</Badge>
          )}
        </CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {phase.kind === 'idle' && (
          <div className="space-y-3">
            <p className="text-sm" role="status">
              {granted && copy.on}
              {unknown && "We couldn't read your account just now. Your access hasn't changed."}
              {!granted && !unknown && copy.off}
            </p>

            {granted ? (
              <Button
                variant="secondary"
                onClick={() => void start('revoke')}
                disabled={busy}
                className="w-full"
              >
                {busy ? 'Preparing…' : copy.revoke}
              </Button>
            ) : unknown ? (
              <Button variant="secondary" onClick={() => void onChanged()} className="w-full">
                Check again
              </Button>
            ) : (
              <Button onClick={() => void start('grant')} disabled={busy} className="w-full">
                {busy ? 'Preparing…' : copy.grant}
              </Button>
            )}
          </div>
        )}

        {phase.kind === 'awaiting' && (
          <div className="flex flex-col items-center gap-3">
            <QrCode
              src={phase.payload.qrPng}
              alt={phase.action === 'grant' ? copy.qrGrant : copy.qrRevoke}
              next={phase.payload.next}
              mode={phase.payload.mode}
            />
            <p className="text-muted-foreground text-center text-sm">
              {phase.signed
                ? 'Signed — waiting for the ledger to confirm…'
                : phase.action === 'grant'
                  ? copy.scanGrant
                  : copy.scanRevoke}
            </p>
            <Button variant="ghost" size="sm" onClick={() => setPhase({ kind: 'idle' })}>
              Cancel
            </Button>
          </div>
        )}

        {phase.kind === 'failed' && (
          <div className="space-y-3">
            <p className="text-destructive text-sm">{phase.reason}</p>
            <Button variant="secondary" onClick={() => setPhase({ kind: 'idle' })}>
              Back
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
