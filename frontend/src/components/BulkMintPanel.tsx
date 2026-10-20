import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  cancelMintJob,
  dropsToXrp,
  fetchDelegation,
  fetchMintEstimate,
  fetchMintJob,
  fetchMintJobs,
  isOpenJob,
  resumeMintJob,
  startBulkMint,
  type DelegationMe,
  type EventSummary,
  type MintEstimate,
  type MintJob,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

const POLL_MS = 3000
const ESTIMATE_DEBOUNCE_MS = 350

/**
 * Mint a whole run of tickets with no further signatures.
 *
 * Starting one signs nothing: the organizer's earlier approval ("Minting for
 * you") is what authorises it, and the server checks that approval against the
 * ledger before a run is created. Everything here is about watching it and
 * being able to stop it — a run is minutes long and cannot be undone, so
 * Cancel is always within reach and a pause says in words what the organizer
 * has to do.
 */
export function BulkMintPanel({
  events,
  onChanged,
}: {
  events: EventSummary[]
  onChanged: () => void
}) {
  const [slug, setSlug] = useState(events[0]?.slug ?? '')
  const [count, setCount] = useState('')
  const [job, setJob] = useState<MintJob | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Whether the organizer has approved minting, so the form can say what to do
  // first instead of letting them start something the server will refuse.
  const [delegation, setDelegation] = useState<DelegationMe | null>(null)
  // What the typed count will ask of the organizer, keyed by the count it was
  // asked for so a stale answer is never shown beside a newer number.
  const [estimate, setEstimate] = useState<{ slug: string; count: number; value: MintEstimate } | null>(null)

  // Keep the selection valid if the caller's event list changes underneath us.
  useEffect(() => {
    if (events.length > 0 && !events.some((e) => e.slug === slug)) {
      setSlug(events[0]!.slug)
    }
  }, [events, slug])

  useEffect(() => {
    let stopped = false
    fetchDelegation().then(
      (d) => {
        if (!stopped) setDelegation(d)
      },
      () => undefined, // unknown: leave the form usable and let the server decide
    )
    return () => {
      stopped = true
    }
  }, [])

  // Asked once per settled count, not per keystroke and never on a timer: this
  // is a one-off lookup, and a poll keyed on its own result is the GiftPanel runaway.
  const countForEstimate = Number(count)
  const estimateWanted = Number.isInteger(countForEstimate) && countForEstimate >= 1 && countForEstimate <= 5000
  useEffect(() => {
    if (!slug || !estimateWanted) return
    let stopped = false
    const timer = window.setTimeout(() => {
      fetchMintEstimate(slug, countForEstimate).then(
        (value) => {
          if (!stopped) setEstimate({ slug, count: countForEstimate, value })
        },
        () => undefined, // no preview is not a refusal; the server still decides on start
      )
    }, ESTIMATE_DEBOUNCE_MS)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [slug, countForEstimate, estimateWanted])

  // Pick a run back up after a reload or a switch of event: it may well still be
  // going, and a page that forgot would invite starting a second.
  useEffect(() => {
    if (!slug) return
    let stopped = false
    setJob(null)
    setError(null)
    fetchMintJobs(slug).then(
      (jobs) => {
        if (stopped) return
        const open = jobs.find(isOpenJob) ?? jobs[0] ?? null
        setJob(open)
      },
      () => undefined, // a failed lookup says nothing about the run; just show the form
    )
    return () => {
      stopped = true
    }
  }, [slug])

  // Keyed on the id and whether it is open, both primitives. Keying on `job`
  // would re-run this on every poll result and fire the next request at once
  // instead of after POLL_MS (the GiftPanel runaway).
  const watchedId = job && isOpenJob(job) ? job.id : null
  useEffect(() => {
    if (!watchedId) return
    let stopped = false
    let timer: number

    const tick = async () => {
      if (stopped) return
      try {
        const next = await fetchMintJob(watchedId)
        if (stopped) return
        setJob(next)
        if (!isOpenJob(next)) {
          onChanged()
          return
        }
      } catch {
        // A blip in the poll is not a failed run; keep watching.
      }
      timer = window.setTimeout(tick, POLL_MS)
    }

    timer = window.setTimeout(tick, POLL_MS)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [watchedId, onChanged])

  const start = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setJob(await startBulkMint(slug, Number(count)))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the run')
    } finally {
      setBusy(false)
    }
  }, [slug, count])

  async function act(fn: (id: string) => Promise<MintJob>) {
    if (!job) return
    setBusy(true)
    setError(null)
    try {
      setJob(await fn(job.id))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work')
    } finally {
      setBusy(false)
    }
  }

  // Absent where the network cannot do it, rather than disabled.
  if (events.length === 0) return null
  if (delegation && !delegation.available) return null
  const notApproved = delegation?.available === true && delegation.state === 'not_granted'

  const open = job !== null && isOpenJob(job)
  const remaining = job && open ? secondsLeft(job) : null
  const pct = job && job.total > 0 ? Math.min(100, Math.round((job.minted / job.total) * 100)) : 0
  const countNum = Number(count)
  const countValid = Number.isInteger(countNum) && countNum >= 1
  const shownEstimate = estimate && estimate.slug === slug && estimate.count === countNum ? estimate.value : null
  // Only a definite "no" stops the button: unknown must not block a run the server may allow.
  const shortOfReserve = shownEstimate?.enough === false

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create tickets</CardTitle>
        <CardDescription>
          Choose how many, and HubWorld creates them for you. There's nothing to approve one by
          one, and you can stop at any time.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {!open && (
          <div className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="bulk-event" className="text-muted-foreground text-xs">
                Event
              </label>
              <select
                id="bulk-event"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
              >
                {events.map((e) => (
                  <option key={e.slug} value={e.slug}>
                    {e.title} ({e.ticketsMinted}/{e.ticketCount})
                  </option>
                ))}
              </select>
            </div>

            {notApproved && (
              <p className="text-muted-foreground text-sm" role="status">
                Allow HubWorld to create tickets above first. It's one approval and covers every ticket.
              </p>
            )}

            <div className="flex gap-2">
              <Input
                value={count}
                onChange={(e) => setCount(e.target.value.replace(/[^0-9]/g, ''))}
                inputMode="numeric"
                placeholder="How many tickets"
                aria-label="how many tickets"
              />
              <Button onClick={() => void start()} disabled={busy || !slug || !countValid || notApproved || shortOfReserve}>
                {busy ? 'Starting…' : 'Create tickets'}
              </Button>
            </div>

            {shownEstimate && <CostPreview estimate={shownEstimate} />}
          </div>
        )}

        {job && (
          <div className="space-y-3">
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium">
                {job.minted} of {job.total} created
              </span>
              <span className="text-muted-foreground text-xs">{statusLabel(job)}</span>
            </div>

            <div
              role="progressbar"
              aria-label="tickets created"
              aria-valuemin={0}
              aria-valuemax={job.total}
              aria-valuenow={job.minted}
              className="bg-muted h-2 overflow-hidden rounded-full"
            >
              <div className="bg-primary h-full transition-[width] duration-500" style={{ width: `${pct}%` }} />
            </div>

            {job.waiting ? (
              // A wait is the system working as designed, not a fault: say so, and
              // say it will carry on by itself.
              <p className="text-muted-foreground text-sm" role="status">
                {WAIT_COPY[job.waiting]}
              </p>
            ) : (
              job.statusReason &&
              job.status !== 'DONE' && (
                <p
                  className={job.status === 'FAILED' || job.status === 'PAUSED' ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}
                  role="status"
                >
                  {job.statusReason}
                </p>
              )
            )}

            {open && !job.waiting && remaining !== null && (
              <p className="text-muted-foreground text-xs">About {formatDuration(remaining)} left at this pace. You can close this page; it carries on.</p>
            )}

            {job.failedTxs > 0 && (
              <p className="text-muted-foreground text-xs">
                {job.failedTxs} attempt{job.failedTxs === 1 ? '' : 's'} didn't go through and made no
                ticket.
              </p>
            )}

            <div className="flex gap-2">
              {job.status === 'PAUSED' && (
                <Button onClick={() => void act(resumeMintJob)} disabled={busy}>
                  Resume
                </Button>
              )}
              {open && !job.cancelRequested && (
                <Button variant="secondary" onClick={() => void act(cancelMintJob)} disabled={busy}>
                  Stop
                </Button>
              )}
              {!open && (
                <Button variant="secondary" onClick={() => setJob(null)}>
                  {job.status === 'DONE' ? 'Create more' : 'Start over'}
                </Button>
              )}
            </div>
          </div>
        )}

        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

const WAIT_COPY = {
  fees: 'Network fees are unusually high right now, so HubWorld is waiting for them to drop. It carries on by itself, usually within a few minutes. Nothing is lost.',
  network: 'The network is busy. HubWorld will try again in a moment.',
  account: 'Waiting for a ticket sale on your account to finish, then it carries on.',
} as const

const WAIT_LABEL = { fees: 'Waiting for fees to fall', network: 'Network busy', account: 'Waiting for a sale' } as const

/** Whole seconds left at the pace so far, or null before there is enough to go on. */
function secondsLeft(job: MintJob): number | null {
  const elapsed = (Date.now() - new Date(job.createdAt).getTime()) / 1000
  if (job.minted < MIN_MINTED_FOR_PACE || elapsed <= 0) return null
  const rate = job.minted / elapsed
  return Math.ceil((job.total - job.minted) / rate)
}

const MIN_MINTED_FOR_PACE = 40

/** "under a minute", "about 12 minutes", "about 2 hours": a person's words, not a stopwatch. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return 'under a minute'
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round((seconds / 3600) * 2) / 2
  return `${hours} hours`
}

function CostPreview({ estimate }: { estimate: MintEstimate }) {
  const reserve = dropsToXrp(estimate.reserveDrops)
  const have = estimate.spendableDrops === null ? null : dropsToXrp(estimate.spendableDrops)
  const shortBy =
    estimate.enough === false && estimate.spendableDrops !== null
      ? dropsToXrp((BigInt(estimate.reserveDrops) - BigInt(estimate.spendableDrops)).toString())
      : null
  return (
    <div className="space-y-1 text-sm" role="status">
      <p>
        Creating these tickets sets aside <span className="font-medium">about {reserve} XRP</span> of
        your balance. It isn't spent, and it comes back as the tickets sell.
      </p>
      {have !== null && estimate.enough !== false && (
        <p className="text-muted-foreground">You have {have} XRP available, which covers it.</p>
      )}
      {shortBy !== null && (
        <p className="text-destructive">
          You have {have} XRP available. Add about {shortBy} XRP to your wallet before starting.
        </p>
      )}
      {have === null && (
        <p className="text-muted-foreground">
          We couldn't read your balance just now. You can still start; we check again before
          anything is created.
        </p>
      )}
      <p className="text-muted-foreground">
        Takes about {formatDuration(estimate.seconds)}. It runs by itself, so you don't need to stay on
        this page.
      </p>
    </div>
  )
}

function statusLabel(job: MintJob): string {
  if (job.cancelRequested && isOpenJob(job)) return 'Stopping…'
  if (job.waiting) return WAIT_LABEL[job.waiting]
  switch (job.status) {
    case 'QUEUED':
      return 'Waiting to start'
    case 'RUNNING':
      return 'Creating'
    case 'PAUSED':
      return 'Paused'
    case 'DONE':
      return 'Finished'
    case 'FAILED':
      return 'Stopped'
    case 'CANCELLED':
      return 'Cancelled'
  }
}
