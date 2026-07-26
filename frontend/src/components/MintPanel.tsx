import { useEffect, useState } from 'react'
import {
  ApiError,
  createMint,
  pollMint,
  type EventSummary,
  type MintCreated,
  type MintedTicket,
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

const POLL_MS = 2500

type Phase =
  | { kind: 'idle' }
  | { kind: 'awaiting'; payload: MintCreated; signed: boolean }
  | { kind: 'minted'; ticket: MintedTicket | null }
  | { kind: 'failed'; reason: string }

export function MintPanel({
  token,
  events,
  onMinted,
}: {
  token: string
  events: EventSummary[]
  onMinted: () => void
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [slug, setSlug] = useState(events[0]?.slug ?? '')
  const [seat, setSeat] = useState('')
  const [tier, setTier] = useState('')
  const [busy, setBusy] = useState(false)

  // Keep the selection valid if the caller's event list changes underneath us.
  useEffect(() => {
    if (events.length > 0 && !events.some((e) => e.slug === slug)) {
      setSlug(events[0]!.slug)
    }
  }, [events, slug])

  async function start() {
    setBusy(true)
    try {
      const payload = await createMint(slug, token, {
        seat: seat.trim() || undefined,
        tier: tier.trim() || undefined,
      })
      setPhase({ kind: 'awaiting', payload, signed: false })
    } catch (err) {
      setPhase({
        kind: 'failed',
        reason: err instanceof ApiError ? err.message : 'Could not start the mint',
      })
    } finally {
      setBusy(false)
    }
  }

  // Same per-run flag as SignIn — a ref set during StrictMode's first cleanup
  // would stay true forever and silently kill polling.
  useEffect(() => {
    if (phase.kind !== 'awaiting') return
    const { payload } = phase
    let stopped = false
    let timer: number

    const tick = async () => {
      if (stopped) return
      try {
        const result = await pollMint(payload.uuid, token)
        if (stopped) return

        switch (result.state) {
          case 'pending':
            // Surface the signed-but-unvalidated gap so a slow ledger doesn't
            // look like the user never scanned.
            setPhase((p) =>
              p.kind === 'awaiting' && p.signed !== (result.signed ?? false)
                ? { ...p, signed: result.signed ?? false }
                : p,
            )
            timer = window.setTimeout(tick, POLL_MS)
            return
          case 'minted':
            setPhase({ kind: 'minted', ticket: result.ticket })
            onMinted()
            return
          case 'rejected':
            setPhase({ kind: 'failed', reason: 'The mint was rejected in Xaman.' })
            return
          case 'expired':
            setPhase({ kind: 'failed', reason: 'The mint request expired. Try again.' })
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
  }, [phase, token, onMinted])

  if (events.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Mint tickets</CardTitle>
          <CardDescription>
            You don't organize any events yet, so there's nothing to issue tickets for.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Mint tickets
          {phase.kind === 'awaiting' && phase.payload.mode === 'stub' && (
            <Badge variant="secondary">stub mode</Badge>
          )}
        </CardTitle>
        <CardDescription>
          You're the issuer — the ticket is minted from your wallet and carries your royalty.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {phase.kind === 'idle' && (
          <div className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="mint-event" className="text-muted-foreground text-xs">
                Event
              </label>
              <select
                id="mint-event"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
              >
                {events.map((e) => (
                  <option key={e.slug} value={e.slug}>
                    {e.title} ({e.ticketsMinted}/{e.ticketCount})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex gap-2">
              <Input
                value={seat}
                onChange={(e) => setSeat(e.target.value)}
                placeholder="Seat (optional)"
                aria-label="seat"
              />
              <Input
                value={tier}
                onChange={(e) => setTier(e.target.value)}
                placeholder="Tier (optional)"
                aria-label="tier"
              />
            </div>

            <Button onClick={() => void start()} disabled={busy || !slug} className="w-full">
              {busy ? 'Preparing…' : 'Mint a ticket'}
            </Button>
          </div>
        )}

        {phase.kind === 'awaiting' && (
          <div className="flex flex-col items-center gap-3">
            <img
              src={phase.payload.qrPng}
              alt="Xaman mint QR code"
              className="size-44 rounded-md border"
            />
            <p className="text-muted-foreground text-center text-sm">
              {phase.signed
                ? 'Signed — waiting for the ledger to validate…'
                : 'Scan in Xaman to sign the mint.'}
            </p>
            <Button variant="ghost" size="sm" onClick={() => setPhase({ kind: 'idle' })}>
              Cancel
            </Button>
          </div>
        )}

        {phase.kind === 'minted' && (
          <div className="space-y-3">
            <p className="text-sm font-medium">Ticket minted on-ledger.</p>
            {phase.ticket && (
              <div className="space-y-1 rounded-md border p-3 text-sm">
                <div>{phase.ticket.event.title}</div>
                <div className="text-muted-foreground text-xs">NFTokenID</div>
                <div className="font-mono text-xs break-all">{phase.ticket.nfTokenId}</div>
                {(phase.ticket.seat || phase.ticket.tier) && (
                  <div className="text-muted-foreground text-xs">
                    {[phase.ticket.tier, phase.ticket.seat].filter(Boolean).join(' · ')}
                  </div>
                )}
              </div>
            )}
            <Button variant="secondary" onClick={() => setPhase({ kind: 'idle' })}>
              Mint another
            </Button>
          </div>
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
