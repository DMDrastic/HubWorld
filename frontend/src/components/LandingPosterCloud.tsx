/**
 * Real events, floated around the landing page's headline.
 *
 * A page that says "events" with no event on it asks a stranger to take that on
 * trust. These are the events actually on HubWorld, with the posters their organizers
 * uploaded, so the page is alive to exactly the degree the product is. Nothing here
 * is invented: with no events there is no cloud, and with three there are three.
 * Padding the space with made-up posters would be the one dishonest thing on a page
 * whose pitch is that what you see on the ledger is true.
 *
 * Events with artwork come first, then the soonest. A poster-less event shows the
 * same date tile as the Events page rather than an empty frame.
 *
 * Wide screens get the posters scattered at the edges, each a little askew; below
 * `lg` there is no room to scatter, so the first three sit in a row above the
 * headline. Every poster links to the Events page, and the whole cloud is a list, so
 * a screen reader hears "list, N items" and not an unlabelled scatter of images.
 */
import type { CSSProperties } from 'react'
import { FallbackThumb } from '@/components/EventRow'
import type { EventSummary } from '@/lib/api'
import { pickCloudEvents } from '@/lib/landing-events'
import { posterSrcSet, posterUrl } from '@/lib/poster'
import { useLinkHandler } from '@/lib/router'

/** Where each poster sits, measured from its own edge of the hero. */
const SLOTS: ReadonlyArray<{ side: 'left' | 'right'; x: string; y: string; w: string; r: number }> = [
  { side: 'left', x: '3%', y: '4.5rem', w: '9.5rem', r: -6 },
  { side: 'right', x: '3%', y: '3.5rem', w: '9rem', r: 6 },
  { side: 'left', x: '15%', y: '15.5rem', w: '8.25rem', r: 5 },
  { side: 'right', x: '14%', y: '14.5rem', w: '9.5rem', r: -5 },
  { side: 'left', x: '0.5%', y: '24rem', w: '7.5rem', r: -3 },
  { side: 'right', x: '1%', y: '25rem', w: '7rem', r: 4 },
  { side: 'left', x: '24%', y: '1rem', w: '6.75rem', r: 3 },
  { side: 'right', x: '24%', y: '0.5rem', w: '6.5rem', r: -4 },
]

function Poster({ event }: { event: EventSummary }) {
  const link = useLinkHandler()
  return (
    <a
      href="/events"
      onClick={link('/events')}
      aria-label={event.title}
      className="focus-visible:ring-ring relative block aspect-3/4 overflow-hidden rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] shadow-[0_10px_28px_-10px_rgb(0_0_0/0.55)] transition-transform duration-300 hover:scale-[1.04] focus-visible:ring-2 focus-visible:outline-none"
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
    </a>
  )
}

export function LandingPosterCloud({ events }: { events: EventSummary[] }) {
  const shown = pickCloudEvents(events, SLOTS.length)
  if (shown.length === 0) return null

  return (
    <>
      {/* Wide: scattered at the edges, behind the headline's column. */}
      <ul aria-label="Events on HubWorld" className="pointer-events-none absolute inset-0 hidden lg:block">
        {shown.map((e, i) => {
          const slot = SLOTS[i]!
          const style: CSSProperties = {
            [slot.side]: slot.x,
            top: slot.y,
            width: slot.w,
            transform: `rotate(${slot.r}deg)`,
          }
          return (
            <li key={e.slug} className="pointer-events-auto absolute" style={style}>
              <Poster event={e} />
            </li>
          )
        })}
      </ul>

      {/* Narrow: no room to scatter, so a short row above the headline. */}
      <ul
        aria-label="Events on HubWorld"
        className="mb-8 flex justify-center gap-3 lg:hidden"
      >
        {shown.slice(0, 3).map((e, i) => (
          <li key={e.slug} className="w-24 sm:w-28" style={{ transform: `rotate(${[-4, 2, 5][i]}deg)` }}>
            <Poster event={e} />
          </li>
        ))}
      </ul>
    </>
  )
}
