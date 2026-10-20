import { CheckCircle2, Clock, XCircle } from 'lucide-react'
import type { CheckInState } from '@/lib/api'

/** Verdict presentation. Admission is the only green outcome. */
export const VERDICT: Record<
  CheckInState['state'],
  { label: string; detail: string; tone: 'good' | 'bad' | 'wait' }
> = {
  pending: { label: 'Waiting', detail: 'Ask them to scan and sign.', tone: 'wait' },
  redeemed: { label: 'Admitted', detail: 'Valid ticket, checked in.', tone: 'good' },
  already_used: {
    label: 'Already checked in',
    detail: 'This ticket has been used. Do not admit.',
    tone: 'bad',
  },
  no_ticket: {
    label: 'No valid ticket',
    detail: 'They hold no ticket for this event.',
    tone: 'bad',
  },
  rejected: { label: 'Declined', detail: 'They cancelled in Xaman.', tone: 'bad' },
  expired: { label: 'Expired', detail: 'Took too long — start another.', tone: 'bad' },
}

/**
 * The verdict, loud enough to read standing up in the dark with a queue waiting.
 *
 * Shared by both door modes so "already checked in" looks the same however the
 * person arrived. Admit / do-not-admit is a red-green decision, the single most
 * common form of colour blindness, made in a doorway at a glance: the label
 * carries the meaning and the icon is a second non-colour channel, so the verdict
 * never rests on hue alone.
 */
export function VerdictCard({ result }: { result: CheckInState }) {
  const verdict = VERDICT[result.state]
  const toneClass =
    verdict.tone === 'good'
      ? 'border-live/50 bg-live/10 text-live'
      : verdict.tone === 'bad'
        ? 'border-destructive/60 bg-destructive/10 text-destructive'
        : 'border-border'
  const Icon = verdict.tone === 'good' ? CheckCircle2 : verdict.tone === 'bad' ? XCircle : Clock

  return (
    <div className={`w-full rounded-xl border-2 p-5 text-center ${toneClass}`} role="status">
      <Icon className="mx-auto size-7" aria-hidden />
      <div className="mt-2 text-xl font-semibold tracking-tight">{verdict.label}</div>
      <div className="mt-1 text-sm">{result.reason ?? verdict.detail}</div>
      {result.holder && <div className="mt-2 text-sm font-medium">{result.holder}</div>}
      {result.ticket && (result.ticket.tier || result.ticket.seat) && (
        <div className="text-xs opacity-80">
          {[result.ticket.tier, result.ticket.seat].filter(Boolean).join(' · ')}
        </div>
      )}
    </div>
  )
}
