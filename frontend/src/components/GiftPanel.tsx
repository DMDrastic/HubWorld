import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  acceptGift,
  cancelGift,
  createGift,
  fetchGifts,
  fetchInventory,
  pollGift,
  type GiftCreated,
  type GiftListItem,
  type GiftState,
  type OwnedTicket,
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

/**
 * `active` covers both signing and tracking: the QR stays up while the gift is
 * still waiting on a signature, and the same poll drives the state underneath.
 * Splitting them would mean asking the user to tell us they'd signed, which the
 * poll already knows.
 */
type Phase =
  | { kind: 'idle' }
  | { kind: 'active'; payload: GiftCreated; label: string; state: GiftState | null }
  | { kind: 'failed'; reason: string }

/** Which states still need the QR on screen. */
const NEEDS_SIGNATURE = new Set(['pending_offer', 'offered'])

function ticketLabel(t: OwnedTicket) {
  const bits = [t.tier, t.seat].filter(Boolean).join(' · ')
  return bits ? `${t.event.title} — ${bits}` : t.event.title
}

export function GiftPanel({ onChanged }: { onChanged: () => void }) {
  const [tickets, setTickets] = useState<OwnedTicket[]>([])
  const [incoming, setIncoming] = useState<GiftListItem[]>([])
  const [outgoing, setOutgoing] = useState<GiftListItem[]>([])
  const [nfTokenId, setNfTokenId] = useState('')
  const [recipient, setRecipient] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      // verify=true reconciles against the ledger — worth the round-trip here
      // because the next thing the user does is act on ownership.
      const [inv, gifts, sent] = await Promise.all([
        fetchInventory(true),
        fetchGifts('incoming'),
        fetchGifts('outgoing'),
      ])
      setTickets(inv.tickets)
      setIncoming(gifts)
      setOutgoing(sent)
      setNfTokenId((cur) => cur || (inv.tickets[0]?.nfTokenId ?? ''))
    } catch {
      // Non-fatal: the panel just shows nothing to gift.
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Per-run flag, not a ref — same StrictMode trap as SignIn and MintPanel.
  useEffect(() => {
    if (phase.kind !== 'active') return
    const { payload, label } = phase
    let stopped = false
    let timer: number

    const tick = async () => {
      if (stopped) return
      try {
        const state = await pollGift(payload.giftId)
        if (stopped) return

        setPhase({ kind: 'active', payload, label, state })

        const settled = ['accepted', 'declined', 'cancelled', 'expired', 'failed']
        if (settled.includes(state.state)) {
          void refresh()
          onChanged()
          return
        }
        timer = window.setTimeout(tick, POLL_MS)
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
  }, [phase, refresh, onChanged])

  async function send() {
    setBusy(true)
    try {
      const payload = await createGift(nfTokenId, recipient)
      setPhase({
        kind: 'active',
        payload,
        label: `Gift to @${recipient.replace(/^@/, '')}`,
        state: null,
      })
    } catch (err) {
      setPhase({
        kind: 'failed',
        reason: err instanceof ApiError ? err.message : 'Could not start the gift',
      })
    } finally {
      setBusy(false)
    }
  }

  async function accept(giftId: string) {
    setBusy(true)
    try {
      const payload = await acceptGift(giftId)
      setPhase({ kind: 'active', payload, label: 'Accept this gift', state: null })
    } catch (err) {
      setPhase({
        kind: 'failed',
        reason: err instanceof ApiError ? err.message : 'Could not accept',
      })
    } finally {
      setBusy(false)
    }
  }

  /**
   * Withdraw. If the offer is already on-ledger the server hands back a payload
   * to sign; if nothing was ever signed it just comes back cancelled.
   */
  async function withdraw(giftId: string) {
    setBusy(true)
    try {
      const result = await cancelGift(giftId)
      if ('uuid' in result) {
        setPhase({ kind: 'active', payload: result, label: 'Withdraw this gift', state: null })
      } else {
        setPhase({ kind: 'idle' })
        void refresh()
        onChanged()
      }
    } catch (err) {
      setPhase({
        kind: 'failed',
        reason: err instanceof ApiError ? err.message : 'Could not withdraw',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Gift a ticket</CardTitle>
        <CardDescription>
          Free peer-to-peer. Two signatures: you offer it, they accept it — the ticket only
          moves when they do.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {incoming.length > 0 && phase.kind === 'idle' && (
          <div className="space-y-2">
            <div className="text-sm font-medium">Waiting for you</div>
            {incoming.map((g) => (
              <div
                key={g.giftId}
                className="flex items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm">{g.ticket.event.title}</div>
                  <div className="text-muted-foreground text-xs">from {g.from}</div>
                </div>
                <Button size="sm" disabled={busy} onClick={() => void accept(g.giftId)}>
                  Accept
                </Button>
              </div>
            ))}
          </div>
        )}

        {outgoing.length > 0 && phase.kind === 'idle' && (
          <div className="space-y-2">
            <div className="text-sm font-medium">Sent, not yet accepted</div>
            {outgoing.map((g) => (
              <div
                key={g.giftId}
                className="flex items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm">{g.ticket.event.title}</div>
                  <div className="text-muted-foreground text-xs">
                    to {g.to} · {g.state.replace('_', ' ')}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void withdraw(g.giftId)}
                >
                  Withdraw
                </Button>
              </div>
            ))}
          </div>
        )}

        {phase.kind === 'idle' && (
          <div className="space-y-3">
            {tickets.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No tickets to gift yet — mint one first.
              </p>
            ) : (
              <>
                <div className="space-y-1">
                  <label htmlFor="gift-ticket" className="text-muted-foreground text-xs">
                    Ticket
                  </label>
                  <select
                    id="gift-ticket"
                    value={nfTokenId}
                    onChange={(e) => setNfTokenId(e.target.value)}
                    className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                  >
                    {tickets.map((t) => (
                      <option key={t.nfTokenId} value={t.nfTokenId}>
                        {ticketLabel(t)}
                        {t.onLedger === false ? ' (not on ledger!)' : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex gap-2">
                  <Input
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    placeholder="@recipient"
                    aria-label="recipient handle"
                  />
                  <Button
                    disabled={busy || !nfTokenId || !recipient.trim()}
                    onClick={() => void send()}
                  >
                    {busy ? '…' : 'Gift'}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {phase.kind === 'active' && (
          <div className="flex flex-col items-center gap-3">
            <div className="text-sm font-medium">{phase.label}</div>

            {(phase.state === null || NEEDS_SIGNATURE.has(phase.state.state)) && (
              <>
                <img
                  src={phase.payload.qrPng}
                  alt="Xaman signing QR code"
                  className="size-44 rounded-md border"
                />
                <p className="text-muted-foreground text-center text-sm">
                  Scan in Xaman to sign.
                </p>
              </>
            )}

            {phase.state && (
              <>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{phase.state.state.replace('_', ' ')}</Badge>
                  {phase.state.awaitingRecipient && (
                    <span className="text-muted-foreground text-xs">
                      waiting on {phase.state.to}
                    </span>
                  )}
                </div>

                <p className="text-center text-sm">
                  {
                    {
                      pending_offer: 'Waiting for the offer to be signed…',
                      offered: `Offer is live on-ledger. ${phase.state.to} can now accept.`,
                      accepting: 'Accepted — waiting for the ledger to validate…',
                      accepted: 'Done. The ticket has moved.',
                      declined: 'The recipient declined.',
                      cancelling: 'Withdrawing — waiting for the ledger to validate…',
                      cancelled: 'The gift was withdrawn.',
                      expired: 'The gift expired.',
                      failed: phase.state.reason ?? 'The ledger rejected it.',
                    }[phase.state.state]
                  }
                </p>
              </>
            )}

            <Button variant="ghost" size="sm" onClick={() => setPhase({ kind: 'idle' })}>
              Done
            </Button>
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
