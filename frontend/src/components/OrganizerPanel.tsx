/**
 * The organizer boundary.
 *
 * Regular users see one thing here: an invitation to apply. Everything an
 * organizer can do — minting, the door, event creation — is not merely disabled
 * for them, it is absent. A greyed-out button still advertises a capability and
 * invites people to go looking for the endpoint.
 *
 * The server enforces all of this independently; hiding is presentation, not
 * security.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  applyToOrganize,
  createEvent,
  fetchApplications,
  fetchOrganizerStatus,
  fetchPolicy,
  reviewApplication,
  xrpToDrops,
  type OrganizerStatus,
  type PendingApplication,
  type Policy,
  type ResalePolicyMode,
  type Role,
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

const bps = (n: number) => `${(n / 100).toFixed(2).replace(/\.00$/, '')}%`

/** A regular user's route in: apply, then wait for review. */
function ApplyForm({ policy, status, onApplied }: {
  policy: Policy | null
  status: OrganizerStatus | null
  onApplied: () => void
}) {
  const [orgName, setOrgName] = useState('')
  const [contact, setContact] = useState('')
  const [pitch, setPitch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const application = status?.application ?? null

  if (application?.state === 'pending') {
    return (
      <div className="space-y-2">
        <Badge variant="secondary">under review</Badge>
        <p className="text-sm">
          Your application for <strong>{application.orgName}</strong> is with the Hubworld team.
        </p>
        <p className="text-muted-foreground text-xs">
          Organizers issue real admission and take real money, so every application is read by
          a person.
        </p>
      </div>
    )
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await applyToOrganize({ orgName, contact, pitch })
      setError(null)
      onApplied()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {application?.state === 'rejected' && (
        <div className="border-destructive/50 bg-destructive/10 rounded-xl border p-3.5 text-sm">
          <div className="font-medium">Not approved</div>
          {application.reviewNote && (
            <div className="text-muted-foreground mt-1 text-xs">{application.reviewNote}</div>
          )}
          <div className="text-muted-foreground mt-1 text-xs">You can revise and resubmit.</div>
        </div>
      )}

      <Input
        value={orgName}
        onChange={(e) => setOrgName(e.target.value)}
        placeholder="Who you are — venue, promoter, collective"
        aria-label="organisation name"
      />
      <Input
        value={contact}
        onChange={(e) => setContact(e.target.value)}
        placeholder="Email or handle we can reach you on"
        aria-label="contact"
      />
      <textarea
        value={pitch}
        onChange={(e) => setPitch(e.target.value)}
        placeholder="What kind of events do you run?"
        aria-label="what you run"
        rows={3}
        className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
      />

      {policy && (
        <p className="text-muted-foreground text-xs">
          Hubworld takes {bps(policy.platformBps)} of each resale. You set your own royalty on
          resales, up to {bps(policy.maxRoyaltyBps)}.
        </p>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}

      <Button type="submit" disabled={busy || !orgName.trim() || !contact.trim() || !pitch.trim()}>
        {busy ? 'Sending…' : 'Apply to organize'}
      </Button>
    </form>
  )
}

/** Organizers create events. platformBps is absent on purpose — it is policy. */
function CreateEventForm({ policy, onCreated }: { policy: Policy | null; onCreated: () => void }) {
  const [title, setTitle] = useState('')
  const [venue, setVenue] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [ticketCount, setTicketCount] = useState('100')
  const [royaltyPct, setRoyaltyPct] = useState('5')
  const [priceXrp, setPriceXrp] = useState('')
  const [resalePolicy, setResalePolicy] = useState<ResalePolicyMode>('UNRESTRICTED')
  const [resaleCapPct, setResaleCapPct] = useState('120')
  const [resaleCapXrp, setResaleCapXrp] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      // Validate the CONVERTED value, not the raw input — a tiny percentage
      // or drops amount can parse as a positive number and still round or
      // floor to zero, which the server's `.positive()`/regex then rejects
      // with a confusing error after the form already accepted it.
      const resaleCapBps = Math.round(Number(resaleCapPct) * 100)
      if (resalePolicy === 'PERCENTAGE_CAP' && !(resaleCapBps > 0)) {
        throw new ApiError('Enter a resale cap percentage above zero')
      }
      const resaleCapDrops = xrpToDrops(resaleCapXrp)
      if (resalePolicy === 'FIXED_CAP' && !(BigInt(resaleCapDrops) > 0n)) {
        throw new ApiError('Enter a resale cap price above zero')
      }
      // Optional: an event without a price has no box office, and tickets are
      // minted to hold or listed by hand. Validated as the CONVERTED drops, like
      // the cap above, so a price that rounds to zero is refused here.
      const primaryPriceDrops = priceXrp.trim() ? xrpToDrops(priceXrp) : undefined
      if (primaryPriceDrops !== undefined && !(BigInt(primaryPriceDrops) > 0n)) {
        throw new ApiError('Enter a ticket price above zero, or leave it blank')
      }
      const event = await createEvent({
        title,
        venue: venue.trim() || undefined,
        startsAt: new Date(startsAt).toISOString(),
        ticketCount: Number(ticketCount),
        royaltyBps: Math.round(Number(royaltyPct) * 100),
        ...(primaryPriceDrops ? { primaryPriceDrops } : {}),
        resalePolicy,
        ...(resalePolicy === 'PERCENTAGE_CAP' ? { resaleCapBps } : {}),
        ...(resalePolicy === 'FIXED_CAP' ? { resaleCapDrops } : {}),
      })
      setCreated(event.title)
      setTitle('')
      setVenue('')
      setPriceXrp('')
      setStartsAt('')
      setError(null)
      onCreated()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the event')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="text-sm font-medium">Create an event</div>
      {created && <p className="text-live text-sm">Created “{created}”.</p>}

      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Event title" aria-label="event title" />
      <Input value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="Venue" aria-label="venue" />
      <div className="flex gap-2">
        <Input
          type="datetime-local"
          value={startsAt}
          onChange={(e) => setStartsAt(e.target.value)}
          aria-label="starts at"
        />
        <Input
          value={ticketCount}
          onChange={(e) => setTicketCount(e.target.value)}
          placeholder="Tickets"
          inputMode="numeric"
          aria-label="ticket count"
          className="w-28"
        />
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={royaltyPct}
          onChange={(e) => setRoyaltyPct(e.target.value)}
          placeholder="Royalty %"
          inputMode="decimal"
          aria-label="royalty percent"
          className="w-28"
        />
        <span className="text-muted-foreground text-xs">
          your cut of every resale{policy ? `, max ${bps(policy.maxRoyaltyBps)}` : ''}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={priceXrp}
          onChange={(e) => setPriceXrp(e.target.value)}
          placeholder="Price, XRP"
          inputMode="decimal"
          aria-label="ticket price in XRP"
          className="w-28"
        />
        <span className="text-muted-foreground text-xs">
          per ticket at the box office. Leave blank to sell by hand instead.
        </span>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <select
            value={resalePolicy}
            onChange={(e) => setResalePolicy(e.target.value as ResalePolicyMode)}
            aria-label="resale policy"
            className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
          >
            <option value="UNRESTRICTED">Resale: unrestricted</option>
            <option value="PERCENTAGE_CAP">Resale: capped at % of face value</option>
            <option value="FIXED_CAP">Resale: capped at a fixed price</option>
            <option value="FACE_VALUE_ONLY">Resale: face value only, no markup</option>
            <option value="DISABLED">Resale: disabled</option>
          </select>
          {resalePolicy === 'PERCENTAGE_CAP' && (
            <>
              <Input
                value={resaleCapPct}
                onChange={(e) => setResaleCapPct(e.target.value)}
                placeholder="% of face value"
                inputMode="decimal"
                aria-label="resale cap percent of face value"
                className="w-28"
              />
              <span className="text-muted-foreground text-xs">
                e.g. 120 means a resale may not exceed 120% of what the ticket originally sold for
              </span>
            </>
          )}
          {resalePolicy === 'FIXED_CAP' && (
            <>
              <Input
                value={resaleCapXrp}
                onChange={(e) => setResaleCapXrp(e.target.value)}
                placeholder="Max resale price in XRP"
                inputMode="decimal"
                aria-label="resale cap in XRP"
                className="w-36"
              />
              <span className="text-muted-foreground text-xs">an absolute ceiling, in XRP</span>
            </>
          )}
        </div>
        <p className="text-muted-foreground text-xs">
          Governs what holders may resell for — gifting is unaffected regardless of this
          setting. Set at creation; there is no edit later.
        </p>
      </div>

      {policy && (
        <p className="text-muted-foreground text-xs">
          Hubworld's {bps(policy.platformBps)} platform fee is set by policy and applies to all
          events.
        </p>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}

      <Button type="submit" disabled={busy || !title.trim() || !startsAt}>
        {busy ? 'Creating…' : 'Create event'}
      </Button>
    </form>
  )
}

/** Admin-only review queue. */
function ReviewQueue() {
  const [applications, setApplications] = useState<PendingApplication[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setApplications(await fetchApplications())
    } catch {
      setApplications([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function review(id: string, decision: 'approve' | 'reject') {
    setBusy(true)
    try {
      await reviewApplication(id, decision)
      await load()
    } finally {
      setBusy(false)
    }
  }

  if (applications.length === 0) return null

  return (
    <div className="space-y-2 border-t pt-4">
      <div className="text-sm font-medium">Applications to review ({applications.length})</div>
      {applications.map((a) => (
        <div key={a.id} className="bg-muted/40 space-y-2 rounded-xl p-3.5">
          <div className="text-sm font-medium">{a.orgName}</div>
          <div className="text-muted-foreground text-xs">
            {a.applicant} · {a.contact}
          </div>
          <p className="text-sm">{a.pitch}</p>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void review(a.id, 'approve')}>
              Approve
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void review(a.id, 'reject')}
            >
              Reject
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}

export function OrganizerPanel({ role, onChanged }: { role: Role; onChanged: () => void }) {
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [status, setStatus] = useState<OrganizerStatus | null>(null)

  const load = useCallback(async () => {
    const [p, s] = await Promise.allSettled([fetchPolicy(), fetchOrganizerStatus()])
    if (p.status === 'fulfilled') setPolicy(p.value)
    if (s.status === 'fulfilled') setStatus(s.value)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const organizer = role === 'ORGANIZER' || role === 'ADMIN'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {organizer ? 'Organizer' : 'Run your own events'}
          {role === 'ADMIN' && <Badge variant="secondary">admin</Badge>}
        </CardTitle>
        <CardDescription>
          {organizer
            ? 'Create events and issue tickets. Your royalty travels with every ticket you mint.'
            : 'Hosting on Hubworld is a separate account type — apply and someone will review it.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {organizer ? (
          <CreateEventForm
            policy={policy}
            onCreated={() => {
              void load()
              onChanged()
            }}
          />
        ) : (
          <ApplyForm policy={policy} status={status} onApplied={load} />
        )}
        {role === 'ADMIN' && <ReviewQueue />}
      </CardContent>
    </Card>
  )
}
