import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  cancelMintJob,
  fetchDelegation,
  fetchMintJob,
  fetchMintJobs,
  isOpenJob,
  resumeMintJob,
  startBulkMint,
  type DelegationMe,
  type EventSummary,
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
  const pct = job && job.total > 0 ? Math.min(100, Math.round((job.minted / job.total) * 100)) : 0
  const countNum = Number(count)
  const countValid = Number.isInteger(countNum) && countNum >= 1

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mint a run of tickets</CardTitle>
        <CardDescription>
          Once you've approved minting above, HubWorld mints the whole run for you. There's nothing
          to sign per ticket, and you can stop it at any time.
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
                Approve minting above first. It's one signature, and it covers every ticket.
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
              <Button onClick={() => void start()} disabled={busy || !slug || !countValid || notApproved}>
                {busy ? 'Starting…' : 'Start minting'}
              </Button>
            </div>
          </div>
        )}

        {job && (
          <div className="space-y-3">
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium">
                {job.minted} of {job.total} minted
              </span>
              <span className="text-muted-foreground text-xs">{statusLabel(job)}</span>
            </div>

            <div
              role="progressbar"
              aria-label="tickets minted"
              aria-valuemin={0}
              aria-valuemax={job.total}
              aria-valuenow={job.minted}
              className="bg-muted h-2 overflow-hidden rounded-full"
            >
              <div className="bg-primary h-full transition-[width] duration-500" style={{ width: `${pct}%` }} />
            </div>

            {job.statusReason && job.status !== 'DONE' && (
              <p
                className={job.status === 'FAILED' || job.status === 'PAUSED' ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}
                role="status"
              >
                {job.statusReason}
              </p>
            )}

            {job.failedTxs > 0 && (
              <p className="text-muted-foreground text-xs">
                {job.failedTxs} transaction{job.failedTxs === 1 ? '' : 's'} were refused by the
                network and produced no ticket.
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
                  Cancel the run
                </Button>
              )}
              {!open && (
                <Button variant="secondary" onClick={() => setJob(null)}>
                  {job.status === 'DONE' ? 'Mint more' : 'Start over'}
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

function statusLabel(job: MintJob): string {
  if (job.cancelRequested && isOpenJob(job)) return 'Stopping after the current batch…'
  switch (job.status) {
    case 'QUEUED':
      return 'Waiting to start'
    case 'RUNNING':
      return 'Minting'
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
