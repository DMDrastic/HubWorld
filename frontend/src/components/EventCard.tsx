/**
 * One event, as a card.
 *
 * The list used to be rows of text, which reads as a table of records rather
 * than a page of things you might go to. An event is sold on its poster, so the
 * image leads and the metadata sits under it.
 *
 * ## The fallback matters more than the image
 *
 * Most events will not have artwork, especially early. A grey box with a broken
 * icon makes the whole page look unfinished, so a poster-less event gets a
 * generated gradient derived from its slug — deterministic, so the same event is
 * always the same colour, and drawn from the palette's own hues so it reads as
 * design rather than as a placeholder. It carries the event's initial, which
 * gives the eye something to distinguish cards by.
 *
 * ## Only live auctions are interactive
 *
 * Same rule the list had: a card with no auction is not a button, because a
 * control that opens an empty window is worse than no control.
 */
import { ArrowUpRight, CalendarDays, MapPin } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { EventSummary } from '@/lib/api'
import { posterSrcSet, posterUrl } from '@/lib/poster'

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * A stable hue from the slug.
 *
 * djb2, because it only has to be deterministic and well-spread — not
 * cryptographic. The point is that an event keeps its colour across reloads and
 * across devices, so the page has a consistent identity rather than reshuffling.
 */
function hueFrom(slug: string): number {
  let h = 5381
  for (let i = 0; i < slug.length; i++) h = ((h << 5) + h + slug.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}

function Poster({ event, width }: { event: EventSummary; width: number }) {
  if (event.imageUrl) {
    return (
      <img
        // Sized for this card rather than served raw: uploads are whatever the
        // organizer had, and the first real one was 1.77MB for a 400px slot.
        src={posterUrl(event.imageUrl, width)}
        srcSet={posterSrcSet(event.imageUrl, width)}
        // The title is already adjacent in the DOM, so describing the poster
        // again would make a screen reader say the event name twice. It is
        // decorative here, and empty alt is how you say so.
        alt=""
        loading="lazy"
        decoding="async"
        className="absolute inset-0 size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
      />
    )
  }

  const hue = hueFrom(event.slug)
  return (
    <div
      className="absolute inset-0 grid place-items-center"
      style={{
        background: `linear-gradient(140deg,
          oklch(0.62 0.17 ${hue}) 0%,
          oklch(0.48 0.15 ${(hue + 40) % 360}) 55%,
          oklch(0.34 0.10 ${(hue + 80) % 360}) 100%)`,
      }}
      aria-hidden
    >
      <span className="font-heading text-6xl font-semibold text-white/25 select-none">
        {event.title.trim().charAt(0).toUpperCase()}
      </span>
    </div>
  )
}

export function EventCard({
  event,
  live,
  onOpenAuction,
  featured = false,
}: {
  event: EventSummary
  /** Has a live auction — the only thing that makes a card activatable. */
  live: boolean
  onOpenAuction: (event: EventSummary) => void
  /** Larger treatment for the featured rail. */
  featured?: boolean
}) {
  const body = (
    <>
      <div className={`relative overflow-hidden ${featured ? 'aspect-16/10' : 'aspect-4/3'}`}>
        <Poster event={event} width={featured ? 560 : 440} />

        {/* Scrim, so white text stays legible over an arbitrary photograph.
            Without it, contrast depends on whatever the organizer uploaded. */}
        <div className="absolute inset-0 bg-linear-to-t from-black/85 via-black/25 to-transparent" />

        <div className="absolute inset-x-0 bottom-0 p-4">
          <h3
            className={`font-heading font-semibold tracking-[-0.02em] text-balance text-white ${
              featured ? 'text-2xl' : 'text-lg'
            }`}
          >
            {event.title}
          </h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/80">
            {event.venue && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3.5" aria-hidden />
                {event.venue}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="size-3.5" aria-hidden />
              {dateFmt.format(new Date(event.startsAt))}
            </span>
          </div>
        </div>

        {live && (
          <span className="text-live-foreground bg-live/90 absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium backdrop-blur-sm">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-70" />
              <span className="relative inline-flex size-1.5 rounded-full bg-current" />
            </span>
            auction live
          </span>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="text-muted-foreground min-w-0 text-xs">
          <span className="truncate">@{event.organizer.username}</span>
          <span aria-hidden> · </span>
          <span className="tabular-nums">
            {event.ticketsMinted}/{event.ticketCount} minted
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={event.status === 'SOLD_OUT' ? 'destructive' : 'secondary'}>
            {event.status.replace('_', ' ').toLowerCase()}
          </Badge>
          {live && (
            <span className="text-live inline-flex items-center gap-0.5 text-xs font-medium">
              Bid
              <ArrowUpRight className="size-3.5" aria-hidden />
            </span>
          )}
        </div>
      </div>
    </>
  )

  const shell =
    'bg-card ring-foreground/8 group block w-full overflow-hidden rounded-2xl text-left ring-1 transition-all'

  if (!live) return <div className={shell}>{body}</div>

  return (
    // A real button: keyboard reachable and announced as activatable. A
    // clickable div is neither.
    <button
      type="button"
      onClick={() => onOpenAuction(event)}
      aria-label={`View live bidding for ${event.title}`}
      className={`${shell} hover:ring-live/40 hover:glow-live focus-visible:ring-ring cursor-pointer hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:outline-none`}
    >
      {body}
    </button>
  )
}
