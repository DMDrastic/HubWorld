/**
 * One event, as a poster.
 *
 * This is what `/events` renders.
 *
 * References to `EventCard` below are to the 4:3 card this replaced, deleted
 * once nothing imported it. They are kept because they record WHY several
 * decisions here are what they are — three of them are regressions against that
 * component, found in review after the suite stayed green through all of them.
 * `git log` has the file if you need to see it.
 *
 * ## Why this looks different
 *
 * The card version is a web card: 4:3, a bordered shell, the image sitting
 * inside a container. It reads as a record in a list. But the native object of
 * this industry is the gig poster, and a gig poster is PORTRAIT — 2:3, no frame,
 * type set large and confident. Changing the aspect ratio alone does most of the
 * work of making a page look like a wall of things you might go to rather than a
 * table of rows.
 *
 * So: no card shell, no border, no background panel. The poster IS the object.
 * The page around it goes neutral, and the events supply every bit of colour —
 * which inverts today's arrangement, where a violet aurora supplies the mood and
 * the events are interchangeable gradient blobs.
 *
 * ## The fallback is a designed poster, not a placeholder
 *
 * Most events have no artwork, especially early, so the fallback is seen more
 * often than real images and deserves more care than a gradient. This one is
 * typographic: the title set large over a deep two-tone ground, with the date as
 * a rule beneath it — a printed bill rather than a coloured rectangle with an
 * initial floating in it. The hue is still derived from the slug so an event
 * keeps its identity across reloads, but the saturation is pulled right down so
 * a wall of fallbacks reads as a set rather than a paint chart.
 */
import { CalendarDays, MapPin } from 'lucide-react'
import type { EventSummary } from '@/lib/api'
import { posterSrcSet, posterUrl } from '@/lib/poster'

const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const dateYearFmt = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/**
 * The year appears only when it is not this one.
 *
 * `EventCard` used `dateStyle: 'medium'`, which always carried a year; dropping
 * it for the poster's terse look made two events a year apart both read "16
 * Aug", with nothing on the page to tell them apart — and `/events` is not
 * filtered by date, so far-future events sit in the same grid. Printing the year
 * on everything is the other extreme: it is noise on the 90% of events happening
 * within a few months. So it earns its place by being surprising.
 */
function formatDate(when: Date): string {
  return when.getFullYear() === new Date().getFullYear()
    ? dateFmt.format(when)
    : dateYearFmt.format(when)
}

/**
 * A stable hue from the slug, spread by the golden angle.
 *
 * djb2 alone was not enough. Taking the hash modulo 360 directly clustered the
 * real data badly: five of six seeded slugs landed inside a 44 degree band of
 * green, so a wall of fallbacks looked like one event repeated. Similar strings
 * — same length, lowercase, hyphenated — produce nearby hashes, and the modulo
 * preserves that nearness.
 *
 * Multiplying by the golden angle before wrapping is the standard fix: it maps
 * adjacent inputs to maximally distant hues, so slugs that differ by a character
 * end up on opposite sides of the wheel. Still deterministic, so an event keeps
 * its colour across reloads and devices.
 */
function hueFrom(slug: string): number {
  let h = 5381
  for (let i = 0; i < slug.length; i++) h = ((h << 5) + h + slug.charCodeAt(i)) | 0
  return (Math.abs(h) * 137.508) % 360
}

function FallbackPoster({ event, titled }: { event: EventSummary; titled: boolean }) {
  const hue = hueFrom(event.slug)
  const when = new Date(event.startsAt)

  return (
    <div
      className="absolute inset-0 flex flex-col p-5"
      style={{
        // Restrained, but not so flat that neighbours become indistinguishable —
        // the first pass pulled chroma so far down that every fallback read as
        // the same dark green. Enough colour to tell events apart, not enough to
        // fight a real poster hanging beside it.
        background: `linear-gradient(160deg,
          oklch(0.40 0.105 ${hue}) 0%,
          oklch(0.24 0.075 ${(hue + 25) % 360}) 58%,
          oklch(0.16 0.045 ${(hue + 45) % 360}) 100%)`,
      }}
      aria-hidden
    >
      {/* Date only, and never wrapping. The status badge owns the opposite
          corner, and once room was reserved for it the date-plus-time line
          broke across two lines with a lone "PM" underneath. The time moves to
          the caption below, where there is width for it. */}
      <div className="pr-24 font-mono text-[0.65rem] tracking-[0.2em] whitespace-nowrap text-white/45 uppercase">
        {formatDate(when)}
      </div>

      {/* The title is the artwork, and it sits LOW — where the act's name sits
          on a real bill. The first pass spread these evenly down the poster with
          justify-between, which left a void through the middle. */}
      <div className="mt-auto space-y-3">
        {/* `line-clamp-5` because this block is `mt-auto` inside a fixed-height
            `overflow-hidden` poster: once the title, rule and venue exceed the
            space, `mt-auto` collapses to zero and the text overflows the TOP and
            is cut mid-letter. At the 2-column mobile density a poster is about
            123px of content width, which ordinary event names reach. Clamping
            ends in an ellipsis instead, and the caption below still carries the
            full name to a screen reader. */}
        {titled && (
          <div className="font-heading line-clamp-5 text-[clamp(1.4rem,2.5vw,2rem)] leading-[0.95] font-semibold tracking-[-0.035em] text-balance text-white">
            {event.title}
          </div>
        )}
        <div className="h-px w-full bg-white/25" />
        <div className="font-mono text-[0.65rem] leading-relaxed tracking-[0.18em] text-white/50 uppercase">
          {event.venue ?? 'HubWorld'}
        </div>
      </div>
    </div>
  )
}

export function EventPoster({
  event,
  live,
  onOpenAuction,
  interactive = true,
  titled = true,
}: {
  event: EventSummary
  live: boolean
  onOpenAuction: (event: EventSummary) => void
  /**
   * Set false when something ELSE on the page already opens this auction.
   * The single-auction feature layout has its own button, and shipping both
   * would give a keyboard or screen-reader user two tab stops to one
   * destination — which reads as two different things until you try them.
   */
  interactive?: boolean
  /**
   * Set false when the SURROUNDING layout already names this event.
   *
   * The single-auction feature layout sets its own `text-3xl` heading beside the
   * poster, and the poster was naming the event too — as a small caption under a
   * photograph, or as the large painted title on a fallback. Either way the name
   * appeared twice, adjacent, and since one live auction is the ordinary case
   * rather than the edge, that was the DEFAULT rendering of the section.
   *
   * The caller taking this on also takes on the accessible name: with `titled`
   * false there is no heading in here at all, so the layout must supply a real
   * one. The feature layout does.
   */
  titled?: boolean
}) {
  const when = new Date(event.startsAt)

  /**
   * Any status that is not the ordinary one has to be visible.
   *
   * `EventCard` badged EVERY status; this component badged only SOLD_OUT, and
   * `GET /api/events` applies no default filter — so DRAFT, COMPLETED and
   * CANCELLED events are all in the response and a CANCELLED one rendered
   * identically to a published one. On a wall of posters, where the whole point
   * is reading at a glance, that is the worst possible place to lose it.
   */
  const abnormal = event.status !== 'PUBLISHED' ? event.status : null

  /**
   * Cancelled and completed events get a badge AND a visual treatment.
   *
   * A badge alone is a detail you read; desaturating is a state you SEE. These
   * two are the statuses where mistaking the event for a live one wastes
   * somebody's evening, so they are worth more than a label.
   */
  const inert = event.status === 'CANCELLED' || event.status === 'COMPLETED'

  const body = (
    <>
      {/* 2:3 — the proportion of an actual gig poster. This single change does
          more than any colour decision to stop the page reading as a data table. */}
      <div className="relative aspect-2/3 overflow-hidden rounded-lg">
        {event.imageUrl ? (
          <img
            src={posterUrl(event.imageUrl, 420)}
            srcSet={posterSrcSet(event.imageUrl, 420)}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute inset-0 size-full object-cover transition-transform duration-[600ms] ease-out group-hover:scale-[1.03]"
          />
        ) : (
          <FallbackPoster event={event} titled={titled} />
        )}

        {/* Only over real photography, and only at the foot, so an uploaded
            poster is seen rather than veiled. The fallback needs no scrim — it
            was designed with its own contrast. */}
        {event.imageUrl && (
          <div className="absolute inset-x-0 bottom-0 h-1/3 bg-linear-to-t from-black/70 to-transparent" />
        )}

        {live && (
          <span className="bg-live text-live-foreground absolute top-3 right-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.68rem] font-medium">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-70" />
              <span className="relative inline-flex size-1.5 rounded-full bg-current" />
            </span>
            auction live
          </span>
        )}

        {/* One badge, not two stacked in the same corner. A live auction is the
            more urgent fact and already implies the event is not on sale. */}
        {abnormal && !live && (
          <span
            className={`absolute top-3 right-3 rounded-full px-2.5 py-1 text-[0.68rem] font-medium text-white backdrop-blur-sm ${
              event.status === 'CANCELLED' ? 'bg-destructive/85' : 'bg-black/55'
            }`}
          >
            {abnormal.replace('_', ' ').toLowerCase()}
          </span>
        )}

        {/* Over the artwork rather than on the container, so the caption below
            stays legible — the point is that the POSTER reads as past, not that
            the whole entry becomes hard to make out. */}
        {inert && (
          <div className="absolute inset-0 bg-background/45 backdrop-saturate-50" aria-hidden />
        )}
      </div>

      {/* Metadata sits BELOW the poster in the page's own voice, the way a
          listing sits under a bill on a wall — rather than overlaid, which
          would fight whatever the organizer uploaded. */}
      <div className="mt-3 space-y-1">
        {/* ALWAYS rendered, and only sometimes visible.

            A fallback poster already sets the title large, so printing it again
            underneath reads as a mistake rather than a caption — which is why
            this used to be behind `event.imageUrl`. That was wrong, and it took
            the title out of the ACCESSIBILITY TREE entirely: `FallbackPoster` is
            `aria-hidden`, so for an image-less event the only copy of the name
            was inside a region screen readers are told to skip. A user got
            "16 Aug · 7:00 PM · Hub World" with no event name, and heading
            navigation found nothing at all. `EventCard` never had this problem
            because its heading sat outside the decorative part.

            So it stays a real `<h3>` in the document either way; `sr-only`
            handles the visual duplication instead of a conditional. */}
        {titled && (
          <h3
            className={
              event.imageUrl
                ? 'font-heading text-[0.95rem] leading-tight font-semibold tracking-[-0.02em] text-balance'
                : 'sr-only'
            }
          >
            {event.title}
          </h3>
        )}
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs">
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <CalendarDays className="size-3" aria-hidden />
            {formatDate(when)} · {timeFmt.format(when)}
          </span>
          {event.venue && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <MapPin className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{event.venue}</span>
            </span>
          )}
        </div>
      </div>
    </>
  )

  // Same rule as before: only a live auction makes this activatable, because a
  // control that opens an empty window is worse than no control.
  if (!live || !interactive) return <div className="group block">{body}</div>

  return (
    <button
      type="button"
      onClick={() => onOpenAuction(event)}
      // Named explicitly. Without this the accessible name is inferred from
      // whatever happens to be inside — and the poster image is decorative with
      // an empty alt, so a screen reader would announce a button called
      // something like "Aug 16 The Observatory". The label says what the control
      // does and which event it does it to.
      aria-label={`View live bidding for ${event.title}`}
      className="group focus-visible:ring-ring block w-full cursor-pointer rounded-lg text-left focus-visible:ring-2 focus-visible:outline-none"
    >
      {body}
    </button>
  )
}
