/**
 * One event, as a row on the timeline.
 *
 * This replaces `EventPoster`, the portrait gig-poster wall. That design argued
 * the native object of this industry is the poster, and for browsing it was
 * right; for DECIDING it was not. A poster says what the night looks like but
 * makes you open something to learn who runs it, whether it is on sale and what
 * it costs. A row puts all of that, and the one action that is available, in the
 * same place for every event — and keeps the poster, as the thumbnail, because
 * the artwork is still the thing people recognise an event by.
 *
 * ## What the rail says
 *
 * Each row owns a node on a vertical rail, and the node is not decoration: a
 * filled pulsing green node is a live auction, a violet ring is a night you can
 * buy into, a dim dot is everything else. State is also written out in a chip,
 * because a colour alone is not a statement (a colour-blind reader, or anyone
 * glancing at a phone in a dark room, must not have to decode it).
 *
 * ## Rules carried over from the poster, because each cost a bug
 *
 * - The title is a real heading in the document, once. The fallback thumbnail
 *   paints no title, so there is never a second copy to read aloud or to count.
 * - Every status other than the ordinary one is visible. `GET /api/events`
 *   applies no default filter, so DRAFT, COMPLETED and CANCELLED all arrive.
 * - A live auction is the more urgent fact and takes the chip from a status.
 * - Only a live auction makes the row act: a control that opens an empty window
 *   is worse than no control. Buying is a SEPARATE control, never nested in the
 *   auction's, and appears only when buying can work.
 * - The year is printed only when it is not this one.
 */
import { MapPin } from 'lucide-react'
import { dropsToXrp, type EventSummary } from '@/lib/api'
import { formatFiat, spokenPrice } from '@/lib/fiat'
import { hueFrom, posterSrcSet, posterUrl } from '@/lib/poster'

const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const dayYearFmt = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short' })

/** "Oct 5", or "Oct 5, 2027" when the year is not this one. */
function formatDay(when: Date): string {
  return when.getFullYear() === new Date().getFullYear()
    ? dayFmt.format(when)
    : dayYearFmt.format(when)
}

/**
 * Green means one thing here: an auction is live. A thumbnail that happened to
 * hash into the greens would sit beside a live node and a live chip and look
 * like part of that signal, so the band is skipped and its hues move on to the
 * blues. Distinctness between neighbours is untouched; only the greens go.
 */
function offGreen(hue: number): number {
  return hue >= 95 && hue < 175 ? (hue + 85) % 360 : hue
}

/**
 * The thumbnail when an organizer has uploaded no artwork, which is the common
 * case early on.
 *
 * It states the one fact that is always true and always useful, the date, in
 * a colour derived from the slug so an event keeps its look across reloads and
 * neighbours differ. No title: the heading beside it carries that, and painting
 * it twice is the bug the poster spent three reviews fixing.
 */
export function FallbackThumb({ event }: { event: Pick<EventSummary, 'slug' | 'startsAt'> }) {
  const hue = offGreen(hueFrom(event.slug))
  const when = new Date(event.startsAt)
  return (
    <div
      data-fallback
      className="absolute inset-0 flex flex-col items-start justify-end p-3"
      style={{ background: `oklch(0.3 0.085 ${hue})` }}
      aria-hidden
    >
      <div className="text-4xl leading-none font-semibold tracking-[-0.04em] text-white/90 tabular-nums">
        {when.getDate()}
      </div>
      <div className="mt-1 font-mono text-xs tracking-wider text-white/60 uppercase">
        {monthFmt.format(when)}
      </div>
    </div>
  )
}

/** A small round mark standing in for the organizer, coloured from the name. */
function Monogram({ name }: { name: string }) {
  return (
    <span
      className="flex size-5 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-semibold text-white/90"
      style={{ background: `oklch(0.4 0.1 ${hueFrom(name)})` }}
      aria-hidden
    >
      {name.replace(/^@/, '').charAt(0).toUpperCase()}
    </span>
  )
}

export function EventRow({
  event,
  live,
  onOpenAuction,
  onBuy,
  first = true,
  last = true,
  showDate = true,
}: {
  event: EventSummary
  live: boolean
  onOpenAuction: (event: EventSummary) => void
  /** Offered only for an event with a price, tickets left and a normal status. */
  onBuy?: (event: EventSummary) => void
  /** Position on the rail, so its line starts and ends at a node, not off the page. */
  first?: boolean
  last?: boolean
  /** Only the first row of a day prints the date; the rest share it. */
  showDate?: boolean
}) {
  const when = new Date(event.startsAt)
  const abnormal = event.status !== 'PUBLISHED' ? event.status : null
  const cancelled = event.status === 'CANCELLED'
  const organizer = event.organizer.displayName ?? `@${event.organizer.username}`

  // What the buyer actually pays, as the server worked it out (the same figure the checkout charges). A server that
  // sends no all-in price shows the ticket price, as it always did.
  const buyPrice = event.primaryAllInDrops ?? event.primaryPriceDrops
  // The dollar estimate for that same figure, when the server had a fresh price. Display only.
  const buyFiat = event.fiat?.[event.primaryAllInDrops ? 'primaryAllInDrops' : 'primaryPriceDrops']

  const buyable =
    onBuy !== undefined &&
    !live &&
    event.status === 'PUBLISHED' &&
    event.primaryPriceDrops != null &&
    (event.ticketsForSale ?? 0) > 0

  // Where the node sits, measured once so the rail's line can start and stop on it.
  const NODE_Y = '1.75rem'

  return (
    <li className="grid sm:grid-cols-[7rem_1.5rem_minmax(0,1fr)] sm:gap-x-4">
      {/* Wide screens: the date sits to the left of the rail. */}
      <div className="hidden pt-[1.15rem] sm:block">
        {showDate && (
          <>
            <div className="font-medium tracking-tight">{formatDay(when)}</div>
            <div className="text-muted-foreground text-sm">{weekdayFmt.format(when)}</div>
          </>
        )}
      </div>

      <div className="relative hidden sm:block" aria-hidden>
        <div
          className="bg-border absolute left-1/2 w-px -translate-x-1/2"
          style={{ top: first ? NODE_Y : 0, bottom: last ? `calc(100% - ${NODE_Y})` : 0 }}
        />
        <div
          className={`absolute left-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ${
            live
              ? 'bg-live ring-live/30 ring-4'
              : buyable
                ? 'bg-background border-brand border-2'
                : 'bg-foreground/25'
          }`}
          style={{ top: NODE_Y }}
        >
          {live && (
            <span className="bg-live absolute inset-0 animate-ping rounded-full opacity-60" />
          )}
        </div>
      </div>

      <div className={last ? '' : 'pb-5'}>
        {/* Narrow screens: no rail, so the date heads each day's rows instead. */}
        {showDate && (
          <div className="mt-6 mb-2 first:mt-0 sm:hidden">
            <span className="font-medium tracking-tight">{formatDay(when)}</span>
            <span className="text-muted-foreground"> · {weekdayFmt.format(when)}</span>
          </div>
        )}

        <div
          className={`surface surface-hover flex gap-4 p-4 sm:p-5 ${live ? 'surface-live' : ''}`}
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="text-muted-foreground text-sm tabular-nums">{timeFmt.format(when)}</p>

            <h3 className="font-heading mt-1 text-xl leading-snug font-semibold tracking-[-0.02em] text-balance">
              {event.title}
            </h3>

            {/* `min-w-0` on the span, not just the paragraph: a flex item will not
                shrink below its content unless told it may, so a long venue
                pushed the whole card past the edge of a phone. */}
            <p className="text-muted-foreground mt-2.5 flex items-center gap-2 text-sm">
              <Monogram name={organizer} />
              <span className="min-w-0 truncate">By {organizer}</span>
            </p>

            {event.venue && (
              <p className="text-muted-foreground mt-1.5 flex items-center gap-2 text-sm">
                <MapPin className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{event.venue}</span>
              </p>
            )}

            <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
              {live && (
                // The label is foreground, the dot is green: green text on its
                // own tint is 4.2:1 in light mode, under the 4.5 a 12px label
                // needs, and the dot is what carries the colour anyway.
                <span className="bg-live/15 text-foreground inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium">
                  <span className="text-live relative flex size-1.5" aria-hidden>
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-70" />
                    <span className="relative inline-flex size-1.5 rounded-full bg-current" />
                  </span>
                  auction live
                </span>
              )}

              {abnormal && !live && (
                <span
                  className={`inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium ${
                    cancelled
                      ? 'bg-destructive/15 text-destructive'
                      : 'bg-foreground/8 text-foreground/80'
                  }`}
                >
                  {abnormal.replace('_', ' ').toLowerCase()}
                </span>
              )}

              {live && (
                <button
                  type="button"
                  onClick={() => onOpenAuction(event)}
                  // Names the control and the event; the heading above is the
                  // event's name, and this label vanishes when the auction ends.
                  aria-label={`View live bidding for ${event.title}`}
                  className="bg-primary text-primary-foreground focus-visible:ring-ring inline-flex h-11 items-center rounded-full px-4 text-sm font-medium transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none sm:h-10"
                >
                  Watch the bidding
                </button>
              )}

              {buyable && (
                <button
                  type="button"
                  onClick={() => onBuy(event)}
                  aria-label={`Buy a ticket to ${event.title} for ${spokenPrice(buyPrice!, buyFiat)}`}
                  className={`bg-primary text-primary-foreground focus-visible:ring-ring inline-flex items-center gap-3 rounded-full px-4 text-sm font-medium transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none ${buyFiat ? 'min-h-11 py-1.5' : 'h-11 sm:h-10'}`}
                >
                  {buyFiat ? (
                    <span className="flex flex-col items-start leading-tight">
                      <span className="tabular-nums">Buy · {formatFiat(buyFiat)}</span>
                      <span className="text-xs tabular-nums opacity-75">≈ {dropsToXrp(buyPrice!)} XRP</span>
                    </span>
                  ) : (
                    <span>Buy · {dropsToXrp(buyPrice!)} XRP</span>
                  )}
                  <span className="opacity-75">{event.ticketsForSale} left</span>
                </button>
              )}
            </div>
          </div>

          <div
            className={`relative aspect-3/4 w-24 shrink-0 self-start overflow-hidden rounded-xl sm:w-32 ${
              cancelled ? 'opacity-60 grayscale' : ''
            }`}
          >
            {event.imageUrl ? (
              <img
                src={posterUrl(event.imageUrl, 320)}
                srcSet={posterSrcSet(event.imageUrl, 320)}
                alt=""
                loading="lazy"
                decoding="async"
                className="absolute inset-0 size-full object-cover"
              />
            ) : (
              <FallbackThumb event={event} />
            )}
          </div>
        </div>
      </div>
    </li>
  )
}
