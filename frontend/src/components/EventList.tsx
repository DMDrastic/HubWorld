/**
 * The events page.
 *
 * Two shapes, because two jobs. A GRID for browsing everything — someone here is
 * scanning for what they could go to, and a grid shows the most options per
 * glance. A RAIL for live auctions — few items, time-limited, worth prominence.
 *
 * A carousel was considered for the whole list and rejected. It shows two or
 * three items and hides the rest behind interaction, which suppresses exactly
 * the discovery this page exists for. It is the right shape only when the set is
 * small and each item deserves space, which describes the live auctions and
 * nothing else here.
 *
 * The rail is native CSS scroll-snap rather than a carousel library. It gives
 * the same feel, adds no dependency to a bundle already carrying Recharts, and
 * arrives accessible: it scrolls with a trackpad, a touch swipe, arrow keys and
 * a screen reader's own navigation, none of which a JS carousel gets for free.
 */
import { EventCard } from '@/components/EventCard'
import type { EventSummary } from '@/lib/api'

export function EventList({
  events,
  auctionSlugs,
  onOpenAuction,
}: {
  events: EventSummary[]
  /** Slugs with a live auction, from GET /api/auctions. */
  auctionSlugs: ReadonlySet<string>
  onOpenAuction: (event: EventSummary) => void
}) {
  if (events.length === 0) {
    return (
      <div className="ring-foreground/8 rounded-2xl px-6 py-16 text-center ring-1">
        <p className="text-muted-foreground text-sm">
          No events yet — run <code className="font-mono">npm run db:seed</code> in backend/.
        </p>
      </div>
    )
  }

  const live = events.filter((e) => auctionSlugs.has(e.slug))
  const rest = events.filter((e) => !auctionSlugs.has(e.slug))

  return (
    <div className="space-y-10">
      {live.length > 0 && (
        <section aria-labelledby="live-now">
          <div className="mb-3 flex items-baseline justify-between gap-4">
            <h2
              id="live-now"
              className="text-muted-foreground text-xs font-medium tracking-[0.18em] uppercase"
            >
              Bidding now
            </h2>
            {live.length > 1 && (
              <span className="text-muted-foreground text-xs">scroll for more →</span>
            )}
          </div>

          {/* -mx-4 px-4 lets cards bleed to the viewport edge on a phone, so the
              rail reads as continuing off-screen instead of stopping short. */}
          <ul className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2">
            {live.map((e) => (
              <li
                key={e.slug}
                className="w-[85%] shrink-0 snap-start sm:w-[26rem]"
              >
                <EventCard event={e} live onOpenAuction={onOpenAuction} featured />
              </li>
            ))}
          </ul>
        </section>
      )}

      {rest.length > 0 && (
        <section aria-labelledby="all-events">
          <h2
            id="all-events"
            className="text-muted-foreground mb-3 text-xs font-medium tracking-[0.18em] uppercase"
          >
            {live.length > 0 ? 'Everything else' : 'All events'}
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rest.map((e) => (
              <li key={e.slug}>
                <EventCard event={e} live={false} onOpenAuction={onOpenAuction} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
