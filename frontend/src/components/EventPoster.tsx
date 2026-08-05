/**
 * One event, as a poster.
 *
 * PROTOTYPE — the poster-led direction. Sits alongside `EventCard` rather than
 * replacing it, so the two can be compared before anything is decided.
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
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

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

function FallbackPoster({ event }: { event: EventSummary }) {
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
        {dateFmt.format(when)}
      </div>

      {/* The title is the artwork, and it sits LOW — where the act's name sits
          on a real bill. The first pass spread these evenly down the poster with
          justify-between, which left a void through the middle. */}
      <div className="mt-auto space-y-3">
        <div className="font-heading text-[clamp(1.4rem,2.5vw,2rem)] leading-[0.95] font-semibold tracking-[-0.035em] text-balance text-white">
          {event.title}
        </div>
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
}) {
  const when = new Date(event.startsAt)
  const soldOut = event.status === 'SOLD_OUT'

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
          <FallbackPoster event={event} />
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

        {soldOut && !live && (
          <span className="absolute top-3 right-3 rounded-full bg-black/55 px-2.5 py-1 text-[0.68rem] font-medium text-white backdrop-blur-sm">
            sold out
          </span>
        )}
      </div>

      {/* Metadata sits BELOW the poster in the page's own voice, the way a
          listing sits under a bill on a wall — rather than overlaid, which
          would fight whatever the organizer uploaded. */}
      <div className="mt-3 space-y-1">
        {/* Only when a photograph is doing the work. A fallback poster already
            sets the title large, and printing it again underneath reads as a
            mistake rather than a caption. */}
        {event.imageUrl && (
          <h3 className="font-heading text-[0.95rem] leading-tight font-semibold tracking-[-0.02em] text-balance">
            {event.title}
          </h3>
        )}
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs">
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <CalendarDays className="size-3" aria-hidden />
            {dateFmt.format(when)} · {timeFmt.format(when)}
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
      className="group focus-visible:ring-ring block w-full cursor-pointer rounded-lg text-left focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      {body}
    </button>
  )
}
