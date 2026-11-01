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
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  CalendarDays,
  CircleCheck,
  DoorOpen,
  Globe,
  ImagePlus,
  MapPin,
  Percent,
  Repeat,
  Ticket,
  Users,
} from 'lucide-react'
import {
  ApiError,
  IMAGE_ACCEPT,
  applyToOrganize,
  resendEmailVerification,
  createEvent,
  fetchApplications,
  fetchOrganizerStatus,
  fetchPolicy,
  imageProblem,
  reviewApplication,
  uploadEventImage,
  xrpToDrops,
  type DoorMode,
  type OrganizerStatus,
  type PendingApplication,
  type Policy,
  type ResalePolicyMode,
  type Role,
} from '@/lib/api'
import { prepareImage } from '@/lib/image-prep'
import { tintFromFile, type Rgb } from '@/lib/poster-tint'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, fieldClass } from '@/components/ui/input'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`
const bps = (n: number) => `${(n / 100).toFixed(2).replace(/\.00$/, '')}%`

/** A regular user's route in: apply, then wait for review. */
function ApplyForm({ policy, status, onApplied }: {
  policy: Policy | null
  status: OrganizerStatus | null
  onApplied: () => void
}) {
  const [orgName, setOrgName] = useState('')
  const [email, setEmail] = useState('')
  const [contact, setContact] = useState('')
  const [pitch, setPitch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resendNote, setResendNote] = useState<string | null>(null)

  const application = status?.application ?? null

  async function resend() {
    setBusy(true)
    try {
      const { emailSent } = await resendEmailVerification()
      setResendNote(emailSent ? 'Sent. Check your inbox.' : 'We could not send it just now. Try again in a minute.')
    } catch (err) {
      setResendNote(err instanceof ApiError ? err.message : 'Could not send it')
    } finally {
      setBusy(false)
    }
  }

  if (application?.state === 'pending') {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">under review</Badge>
          {/* A confirmation is a fact worth seeing at a glance, not the tail of a
              sentence. The check carries the colour and the words carry the meaning,
              and the label stays foreground: green text on its own tint is under 4.5:1
              in light mode, which is why the live chip does the same. */}
          {application.email && application.emailVerified && (
            <Badge variant="outline">
              <CircleCheck className="text-live" aria-hidden />
              Email confirmed
            </Badge>
          )}
        </div>
        <p className="text-sm">
          Your application for <strong>{application.orgName}</strong> is with the Hubworld team.
        </p>
        {application.email &&
          (application.emailVerified ? (
            <p className="text-sm">
              We&rsquo;ll email <strong>{application.email}</strong> with the decision.
            </p>
          ) : (
            <div className="space-y-1.5">
              <p className="text-sm">
                Confirm your email: we sent a link to <strong>{application.email}</strong>. We only
                send the decision to a confirmed address.
              </p>
              <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void resend()}>
                Send the link again
              </Button>
              {resendNote && (
                <p className="text-muted-foreground text-xs" role="status">
                  {resendNote}
                </p>
              )}
            </div>
          ))}
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
      await applyToOrganize({ orgName, email, contact: contact.trim() || undefined, pitch })
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
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Your email, for the decision and updates"
        aria-label="email"
      />
      <Input
        value={contact}
        onChange={(e) => setContact(e.target.value)}
        placeholder="Anything else: a phone or handle (optional)"
        aria-label="other contact"
      />
      <textarea
        value={pitch}
        onChange={(e) => setPitch(e.target.value)}
        placeholder="What kind of events do you run?"
        aria-label="what you run"
        rows={3}
        className={`${fieldClass} py-2.5 leading-relaxed`}
      />

      {policy && (
        <p className="text-muted-foreground text-xs">
          Hubworld takes {bps(policy.platformBps)} of each resale. You set your own royalty on
          resales, up to {bps(policy.maxRoyaltyBps)}.
        </p>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}

      <Button type="submit" disabled={busy || !orgName.trim() || !email.trim() || !pitch.trim()}>
        {busy ? 'Sending…' : 'Apply to organize'}
      </Button>
    </form>
  )
}

/**
 * Where an event starts, as the organizer's own clock will read it.
 *
 * `startsAt` is typed in local time and converted with `new Date(...)`, so the
 * zone is whatever this browser is in. Saying so on the form (offset and place)
 * turns "7 pm" into "7 pm Toronto" before anyone commits to it. The offset is
 * measured on the chosen date, not on today, so a date after a clock change reads
 * the offset it will really have.
 */
function zoneFor(startsAt: string): { offset: string; place: string } {
  const when = startsAt && !Number.isNaN(new Date(startsAt).getTime()) ? new Date(startsAt) : new Date()
  const minutes = -when.getTimezoneOffset()
  const abs = Math.abs(minutes)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  return {
    offset: `GMT${minutes >= 0 ? '+' : '-'}${hh}:${mm}`,
    place: tz.split('/').pop()?.replace(/_/g, ' ') ?? '',
  }
}

/**
 * The poster, chosen before the event exists.
 *
 * The upload endpoint is keyed on the event's slug, which only exists once the
 * event has been created, so the file is held here and sent right after the
 * create succeeds (see `CreateEventForm`). Picking it now still matters: an
 * organizer sees how the event will look while they are describing it.
 *
 * The preview is a 3:4 tile because that is the crop the Events timeline uses,
 * so what is shown here is what a visitor will see.
 */
function PosterPicker({
  file,
  onFile,
}: {
  file: File | null
  onFile: (f: File | null) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  // A state-and-effect pair, not `useMemo`: StrictMode runs the cleanup between
  // its two mounts, which would revoke a URL a memo had already handed out.
  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== 'function') {
      setPreview(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  async function pick(chosen: File | undefined) {
    if (!chosen) return
    setNote(null)
    const problem = imageProblem(chosen)
    setError(problem)
    // Clear the input, or picking the SAME file again fires no change event.
    if (input.current) input.current.value = ''
    if (problem) return
    try {
      // Anything over the server's limit is shrunk here, on this device, so a
      // phone photo never has to be exported smaller by hand first.
      const { file: ready, shrunk } = await prepareImage(chosen)
      onFile(ready)
      if (shrunk) {
        setNote(`Resized from ${mb(chosen.size)} to ${mb(ready.size)} to fit.`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That image could not be used')
    }
  }

  return (
    <div>
      <div className="surface relative aspect-3/4 overflow-hidden">
        {preview ? (
          <img src={preview} alt="Poster preview" className="absolute inset-0 size-full object-cover" />
        ) : (
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <ImagePlus className="size-8" aria-hidden />
            <span>Add a poster</span>
          </button>
        )}

        {preview && (
          <button
            type="button"
            onClick={() => input.current?.click()}
            aria-label="Replace poster"
            className="bg-background text-foreground focus-visible:ring-ring absolute right-3 bottom-3 flex size-11 items-center justify-center rounded-full shadow-md ring-1 ring-black/10 focus-visible:ring-2 focus-visible:outline-none"
          >
            <ImagePlus className="size-5" aria-hidden />
          </button>
        )}
      </div>

      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT}
        className="sr-only"
        aria-label="poster image"
        tabIndex={-1}
        onChange={(e) => void pick(e.target.files?.[0])}
      />

      <div className="mt-3 flex items-start justify-between gap-3 text-xs">
        <p className={error ? 'text-destructive' : 'text-muted-foreground'}>
          {error ?? note ?? 'JPEG, PNG or WEBP, up to 25MB. Larger files are shrunk to fit. It is what people see when browsing.'}
        </p>
        {file && (
          <button
            type="button"
            onClick={() => {
              setError(null)
              setNote(null)
              onFile(null)
            }}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring shrink-0 rounded underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
          >
            Remove
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * One line of the form: an icon, what it is, and its value at the right edge.
 * The whole line lights up while its control has focus, so the target is the row
 * and not a thin input inside it. A hint, when there is one, sits underneath
 * inside the same plate.
 */
function Option({
  icon: Icon,
  label,
  hint,
  children,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="focus-within:bg-foreground/[0.03] px-4 py-3 transition-colors first:rounded-t-2xl last:rounded-b-2xl">
      <div className="flex min-h-8 items-center gap-3">
        <Icon className="text-muted-foreground size-[1.125rem] shrink-0" aria-hidden />
        <span className="shrink-0">{label}</span>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">{children}</div>
      </div>
      {hint && (
        <div className="text-muted-foreground mt-1.5 pl-[1.875rem] text-xs leading-relaxed">{hint}</div>
      )}
    </div>
  )
}

/** A bare input for the right edge of an `Option`. */
const VALUE_INPUT =
  'bg-transparent text-right outline-none placeholder:text-muted-foreground/60 min-w-0 w-28'
const VALUE_SELECT =
  'bg-transparent text-right outline-none cursor-pointer max-w-full min-w-0 [&>option]:bg-popover [&>option]:text-popover-foreground'

/**
 * Organizers create events. platformBps is absent on purpose — it is policy.
 *
 * Laid out like a composer rather than a form: the poster on one side, and on the
 * other the name as the largest thing on the page, when and where, then the
 * options that decide what the event is. Only fields the server actually takes
 * are here, and none is a placeholder for something later (there is no
 * description, end time, calendar or visibility choice, because there is
 * nothing behind any of them).
 */
function CreateEventForm({ policy, onCreated }: { policy: Policy | null; onCreated: () => void }) {
  const [title, setTitle] = useState('')
  const [venue, setVenue] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [ticketCount, setTicketCount] = useState('100')
  const [royaltyPct, setRoyaltyPct] = useState('5')
  const [priceUsd, setPriceUsd] = useState('')
  const [chosenPolicy, setResalePolicy] = useState<ResalePolicyMode>('UNRESTRICTED')
  // Under the new fee model a ticket is never resold for more than its buyer paid, so a policy that allows
  // more is not offered. An older server that says nothing keeps offering everything.
  const loose = policy?.looseResalePolicies !== false
  // Derived, not stored: the server's answer arrives after the form is up, and a stored default would stay stale.
  // A fixed cap is still a number of XRP, which cannot go with a US$ price until resale moves to US$: with a price, the
  // option is not offered, and a cap already chosen falls back to face value only.
  const priced = priceUsd.trim() !== ''
  const resalePolicy: ResalePolicyMode =
    !loose && chosenPolicy === 'UNRESTRICTED'
      ? 'FACE_VALUE_ONLY'
      : priced && chosenPolicy === 'FIXED_CAP'
        ? 'FACE_VALUE_ONLY'
        : chosenPolicy
  const [resaleCapPct, setResaleCapPct] = useState('120')
  const [resaleCapXrp, setResaleCapXrp] = useState('')
  // Offered only where this server can run the code door; otherwise the server's own default (the signature door) applies.
  // Code first: email attendees cannot sign at the door.
  const [doorMode, setDoorMode] = useState<DoorMode>('QR')
  const offerDoorMode = policy?.doorCodes === true
  const [poster, setPoster] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<string | null>(null)
  const [posterNote, setPosterNote] = useState<string | null>(null)
  // The wash behind the page follows the chosen poster's colour. `tint` keeps the
  // LAST colour found and `washOn` says whether to show it, so removing the
  // poster fades the wash out instead of snapping it away mid-fade.
  const [tint, setTint] = useState<Rgb | null>(null)
  const [washOn, setWashOn] = useState(false)
  const id = useId()

  useEffect(() => {
    if (!poster) {
      setWashOn(false)
      return
    }
    let live = true
    void tintFromFile(poster).then((found) => {
      if (!live) return
      if (found) setTint(found)
      setWashOn(found !== null)
    })
    return () => {
      live = false
    }
  }, [poster])

  const zone = zoneFor(startsAt)

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
      if (!loose && resalePolicy === 'PERCENTAGE_CAP' && resaleCapBps > 10_000) {
        throw new ApiError('A resale cap can be at most 100%: a ticket is never resold for more than its buyer paid')
      }
      const resaleCapDrops = xrpToDrops(resaleCapXrp)
      if (resalePolicy === 'FIXED_CAP' && !(BigInt(resaleCapDrops) > 0n)) {
        throw new ApiError('Enter a resale cap price above zero')
      }
      // Optional: an event without a price has no box office, and tickets are minted to hold or listed by hand. In US$,
      // whole cents only: XRP is worked out when someone pays.
      const primaryPriceUsdCents = priced ? usdToCents(priceUsd) : undefined
      if (primaryPriceUsdCents === null) {
        throw new ApiError('Enter the ticket price in US dollars, like 35 or 35.50, or leave it blank')
      }
      if (primaryPriceUsdCents !== undefined && !(BigInt(primaryPriceUsdCents) > 0n)) {
        throw new ApiError('Enter a ticket price above zero, or leave it blank')
      }
      const event = await createEvent({
        title,
        venue: venue.trim() || undefined,
        startsAt: new Date(startsAt).toISOString(),
        ticketCount: Number(ticketCount),
        royaltyBps: Math.round(Number(royaltyPct) * 100),
        ...(primaryPriceUsdCents ? { primaryPriceUsdCents } : {}),
        resalePolicy,
        ...(offerDoorMode ? { doorMode } : {}),
        ...(resalePolicy === 'PERCENTAGE_CAP' ? { resaleCapBps } : {}),
        ...(resalePolicy === 'FIXED_CAP' ? { resaleCapDrops } : {}),
      })

      // The event exists from here on. A poster that fails to upload must not
      // read as a failed event (that would invite a second, duplicate create),
      // so it is reported on its own and the poster panel below can retry it.
      setPosterNote(null)
      if (poster) {
        try {
          await uploadEventImage(event.slug, poster)
        } catch (err) {
          setPosterNote(
            `The poster could not be uploaded (${err instanceof ApiError ? err.message : 'upload failed'}). Add it under Event posters below.`,
          )
        }
      }

      setCreated(event.title)
      setTitle('')
      setVenue('')
      setPriceUsd('')
      setStartsAt('')
      setPoster(null)
      setError(null)
      onCreated()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the event')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      // The base column is `minmax(0,1fr)`, not the implicit `auto`: an auto column grows
      // to its widest child's minimum, and a native select sizes itself to its longest
      // option, which pushed this whole page past the edge of a phone.
      className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[19rem_minmax(0,1fr)] lg:gap-12"
    >
      {/* Fixed and behind everything, so it paints under the nav and the footer as
          well as the form. It only exists while this form is on screen. */}
      <div
        aria-hidden
        data-poster-wash={washOn ? 'on' : 'off'}
        className="poster-wash pointer-events-none fixed inset-0 -z-10 transition-opacity duration-700"
        style={
          {
            opacity: washOn ? 1 : 0,
            ...(tint ? { '--poster-tint': `rgb(${tint.join(' ')})` } : {}),
          } as React.CSSProperties
        }
      />
      <div className="w-full max-w-[12rem] lg:max-w-[19rem]">
        <PosterPicker file={poster} onFile={setPoster} />
      </div>

      <div className="space-y-4">
        {created && (
          <p className="text-sm" role="status">
            <span className="text-live font-medium">Created</span> “{created}”.
          </p>
        )}
        {posterNote && <p className="text-destructive text-sm">{posterNote}</p>}

        <div className="focus-within:ring-ring/60 rounded-xl focus-within:ring-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Event name"
            aria-label="event title"
            className="placeholder:text-muted-foreground/40 w-full bg-transparent px-1 py-1 text-4xl font-semibold tracking-[-0.03em] outline-none sm:text-5xl"
          />
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-[minmax(0,1fr)_11rem]">
          <label className="surface flex items-center gap-3 px-4 py-3" htmlFor={`${id}-start`}>
            <CalendarDays className="text-muted-foreground size-[1.125rem] shrink-0" aria-hidden />
            <span className="shrink-0">Starts</span>
            <input
              id={`${id}-start`}
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              aria-label="starts at"
              className="min-w-0 flex-1 bg-transparent text-right outline-none"
            />
          </label>
          <div className="surface px-4 py-3" title="Times are read in this browser's time zone.">
            <Globe className="text-muted-foreground size-[1.125rem]" aria-hidden />
            <div className="mt-1 text-sm font-medium tabular-nums">{zone.offset}</div>
            <div className="text-muted-foreground text-sm">{zone.place}</div>
          </div>
        </div>

        <label className="surface focus-within:bg-foreground/[0.03] flex items-start gap-3 px-4 py-3 transition-colors">
          <MapPin className="text-muted-foreground mt-0.5 size-[1.125rem] shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            <input
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
              placeholder="Add event location"
              aria-label="venue"
              className="placeholder:text-foreground w-full bg-transparent outline-none"
            />
            <span className="text-muted-foreground text-sm">Venue or address. Optional.</span>
          </span>
        </label>

        <h2 className="text-muted-foreground pt-3 text-sm font-medium">Event options</h2>
        <div className="surface divide-y">
          <Option
            icon={Ticket}
            label="Ticket price"
            hint="Per ticket at the box office, in US dollars. Leave it blank to sell by hand instead."
          >
            <span className="text-muted-foreground">US$</span>
            <input
              value={priceUsd}
              onChange={(e) => setPriceUsd(e.target.value)}
              placeholder="Not for sale"
              inputMode="decimal"
              aria-label="ticket price in US$"
              className={VALUE_INPUT}
            />
          </Option>

          <Option icon={Users} label="Tickets">
            <input
              value={ticketCount}
              onChange={(e) => setTicketCount(e.target.value)}
              placeholder="100"
              inputMode="numeric"
              aria-label="ticket count"
              className={VALUE_INPUT}
            />
          </Option>

          <Option
            icon={Percent}
            label="Royalty"
            hint={`Your cut of every resale${policy ? `, up to ${bps(policy.maxRoyaltyBps)}` : ''}.`}
          >
            <input
              value={royaltyPct}
              onChange={(e) => setRoyaltyPct(e.target.value)}
              placeholder="5"
              inputMode="decimal"
              aria-label="royalty percent"
              className={`${VALUE_INPUT} w-16`}
            />
            <span className="text-muted-foreground">%</span>
          </Option>

          <Option
            icon={Repeat}
            label="Resale"
            hint={
              <>
                Sets how high buyers can resell a ticket. Gifts aren't affected. You choose this now
                and can't change it later.
                {!loose &&
                  ' Resale is capped at what the buyer paid, so there is no option that allows more.'}
                {loose &&
                  resalePolicy === 'PERCENTAGE_CAP' &&
                  ' 120 means a resale may not exceed 120% of what the ticket originally sold for.'}
              </>
            }
          >
            {resalePolicy === 'PERCENTAGE_CAP' && (
              <>
                <input
                  value={resaleCapPct}
                  onChange={(e) => setResaleCapPct(e.target.value)}
                  placeholder="120"
                  inputMode="decimal"
                  aria-label="resale cap percent of face value"
                  className={`${VALUE_INPUT} w-14 border-b`}
                />
                <span className="text-muted-foreground">%</span>
              </>
            )}
            {resalePolicy === 'FIXED_CAP' && (
              <>
                <input
                  value={resaleCapXrp}
                  onChange={(e) => setResaleCapXrp(e.target.value)}
                  placeholder="Max price"
                  inputMode="decimal"
                  aria-label="resale cap in XRP"
                  className={`${VALUE_INPUT} w-24 border-b`}
                />
                <span className="text-muted-foreground">XRP</span>
              </>
            )}
            <select
              value={resalePolicy}
              onChange={(e) => setResalePolicy(e.target.value as ResalePolicyMode)}
              aria-label="resale policy"
              className={VALUE_SELECT}
            >
              {loose && <option value="UNRESTRICTED">Unrestricted</option>}
              <option value="PERCENTAGE_CAP">Capped at % of face value</option>
              {!priced && <option value="FIXED_CAP">Capped at a fixed price</option>}
              <option value="FACE_VALUE_ONLY">Face value only, no markup</option>
              <option value="DISABLED">Disabled</option>
            </select>
          </Option>

          {offerDoorMode && (
            <Option
              icon={DoorOpen}
              label="Door"
              hint="Guests show a code that changes every 20 seconds, and it works for every guest. Approving in Xaman proves the guest's own wallet is at the door, but guests who signed in with email cannot do it. You can change this later."
            >
              <select
                value={doorMode}
                onChange={(e) => setDoorMode(e.target.value as DoorMode)}
                aria-label="how guests get in"
                className={VALUE_SELECT}
              >
                <option value="QR">Code (recommended)</option>
                <option value="SIGNATURE">Xaman approval (crypto wallets only)</option>
              </select>
            </Option>
          )}
        </div>

        {policy && (
          <p className="text-muted-foreground text-sm">
            HubWorld takes {bps(policy.platformBps)} of each sale. It's the same for every event.
          </p>
        )}
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}

        <Button
          type="submit"
          disabled={busy || !title.trim() || !startsAt}
          size="lg"
          className="mt-2 w-full"
        >
          {busy ? 'Creating…' : 'Create event'}
        </Button>
      </div>
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
            {a.applicant}
            {a.email ? ` · ${a.email} (${a.emailVerified ? 'confirmed' : 'not confirmed'})` : ''}
            {a.contact ? ` · ${a.contact}` : ''}
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

export function OrganizerPanel({
  role,
  onChanged,
  refreshKey = 0,
}: {
  role: Role
  onChanged: () => void
  /** Bumped when something outside this panel changes the application (an email confirmed). */
  refreshKey?: number
}) {
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [status, setStatus] = useState<OrganizerStatus | null>(null)

  const load = useCallback(async () => {
    const [p, s] = await Promise.allSettled([fetchPolicy(), fetchOrganizerStatus()])
    if (p.status === 'fulfilled') setPolicy(p.value)
    if (s.status === 'fulfilled') setStatus(s.value)
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const organizer = role === 'ORGANIZER' || role === 'ADMIN'

  // An organizer gets the composer on the page itself, not inside a card: it is
  // the page's main job, and a form boxed in a panel reads as one tool among
  // many. Everyone else still gets the small, boxed invitation to apply.
  if (organizer) {
    return (
      <div className="space-y-8">
        <CreateEventForm
          policy={policy}
          onCreated={() => {
            void load()
            onChanged()
          }}
        />
        {role === 'ADMIN' && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Review <Badge variant="secondary">admin</Badge>
              </CardTitle>
              <CardDescription>Organizer applications waiting on a decision.</CardDescription>
            </CardHeader>
            <CardContent>
              <ReviewQueue />
            </CardContent>
          </Card>
        )}
      </div>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Run your own events</CardTitle>
        <CardDescription>
          Hosting on Hubworld is a separate account type — apply and someone will review it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ApplyForm policy={policy} status={status} onApplied={load} />
      </CardContent>
    </Card>
  )
}

/** "35", "35.5" or "35.50" to US cents as a string; null for anything else (more than two decimals, signs, letters). */
function usdToCents(typed: string): string | null {
  const m = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(typed.trim())
  if (!m) return null
  return (BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0')).toString()
}
