/**
 * Posters, floated around the landing page's headline.
 *
 * A page that says "events" with no poster on it asks a stranger to take that on
 * trust, so the hero carries eight of them. The REAL events on HubWorld come first,
 * with the artwork their organizers uploaded, and each links to the Events page.
 * Where there are fewer than eight, the remaining places hold decorative artwork.
 *
 * That filler is the one place this page shows something that is not an event, so it
 * is kept from ever reading as one: it is pure graphic art with no title, no date and
 * no place; it is not a link; and it is hidden from assistive technology, which hears
 * only the real events. A page whose pitch is that the ledger tells the truth can
 * decorate, but it must not pretend.
 *
 * Each poster keeps its position and tilt, and drifts a few pixels up and down on its
 * own slow cycle (see `.float-y` in index.css). The drift lives on a wrapper inside the
 * tilted element, so it can never disturb the tilt, and it stops under reduced motion.
 *
 * Wide screens (`xl`, 1280px) get the posters scattered at the edges. Measured against
 * the actual letters, the scatter touches the text below about 1240px, so anything
 * narrower gets the first three in a row above the headline instead.
 */
import type { CSSProperties } from 'react'
import confetti from '@/assets/sample-poster-confetti.jpg'
import hoops from '@/assets/sample-poster-hoops.jpg'
import stage from '@/assets/sample-poster-stage.jpg'
import arches from '@/assets/filler-poster-arches.jpg'
import dusk from '@/assets/filler-poster-dusk.jpg'
import halftone from '@/assets/filler-poster-halftone.jpg'
import rings from '@/assets/filler-poster-rings.jpg'
import sunrise from '@/assets/filler-poster-sunrise.jpg'
import { FallbackThumb } from '@/components/EventRow'
import type { EventSummary } from '@/lib/api'
import { pickCloudEvents } from '@/lib/landing-events'
import { posterSrcSet, posterUrl } from '@/lib/poster'
import { useLinkHandler } from '@/lib/router'

/**
 * Decorative artwork, in the order it fills empty places. Two are photographs and one
 * is line art (Marcel Strauss and Aditya Chinchure, Unsplash licence; the line art and
 * the five graphic posters were drawn for this page), all supplied by the project owner.
 */
const FILLER_POSTERS = [confetti, rings, hoops, sunrise, stage, dusk, arches, halftone] as const

/**
 * Where each poster sits, how far and how slowly it drifts. Position, width and tilt
 * are the design; `float` is the drift: a distance in px, a cycle length in seconds,
 * and a negative delay so the cloud is already mid-motion on first paint.
 */
const SLOTS: ReadonlyArray<{
  side: 'left' | 'right'
  x: string
  y: string
  w: string
  r: number
  float: readonly [distance: number, seconds: number, delay: number]
}> = [
  { side: 'left', x: '3%', y: '4.5rem', w: '9.5rem', r: -6, float: [10, 7.2, -1.5] },
  { side: 'right', x: '3%', y: '3.5rem', w: '9rem', r: 6, float: [8, 6.4, -4.1] },
  { side: 'left', x: '15%', y: '15.5rem', w: '8.25rem', r: 5, float: [12, 8.6, -6.3] },
  { side: 'right', x: '14%', y: '14.5rem', w: '9.5rem', r: -5, float: [9, 7.8, -2.7] },
  { side: 'left', x: '0.5%', y: '24rem', w: '7.5rem', r: -3, float: [7, 6.9, -5.2] },
  { side: 'right', x: '1%', y: '25rem', w: '7rem', r: 4, float: [11, 9.1, -0.8] },
  // The two outermost-top places sit further out than the rest: they only appear once
  // all eight are filled, and at 24% they crowded the headline.
  { side: 'left', x: '18%', y: '1rem', w: '6.75rem', r: 3, float: [6, 6.1, -3.4] },
  { side: 'right', x: '18%', y: '0.5rem', w: '6.5rem', r: -4, float: [8, 7.5, -7.6] },
]

const FRAME =
  'relative block aspect-3/4 overflow-hidden rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] shadow-[0_10px_28px_-10px_rgb(0_0_0/0.55)]'

type Tile =
  | { kind: 'event'; event: EventSummary }
  | { kind: 'filler'; src: string; key: string }

/** Real events first, then decorative artwork, never more than there are places. */
function tilesFor(events: EventSummary[]): Tile[] {
  const real = pickCloudEvents(events, SLOTS.length)
  const tiles: Tile[] = real.map((event) => ({ kind: 'event', event }))
  for (let i = 0; tiles.length < SLOTS.length; i++) {
    tiles.push({ kind: 'filler', src: FILLER_POSTERS[i % FILLER_POSTERS.length]!, key: `filler-${i}` })
  }
  return tiles
}

function EventPoster({ event }: { event: EventSummary }) {
  const link = useLinkHandler()
  return (
    <a
      href="/events"
      onClick={link('/events')}
      aria-label={event.title}
      className={`${FRAME} focus-visible:ring-ring transition-transform duration-300 hover:-translate-y-1 hover:scale-[1.05] focus-visible:ring-2 focus-visible:outline-none`}
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

function FillerPoster({ src }: { src: string }) {
  return (
    <span className={FRAME}>
      <img src={src} alt="" decoding="async" className="absolute inset-0 size-full object-cover" />
    </span>
  )
}

function Tile({ tile }: { tile: Tile }) {
  return tile.kind === 'event' ? <EventPoster event={tile.event} /> : <FillerPoster src={tile.src} />
}

const keyOf = (t: Tile) => (t.kind === 'event' ? t.event.slug : t.key)

export function LandingPosterCloud({ events }: { events: EventSummary[] }) {
  const tiles = tilesFor(events)
  const hasReal = tiles.some((t) => t.kind === 'event')
  // Only a cloud that contains real events is announced as a list of them.
  const listProps = hasReal ? { 'aria-label': 'Events on HubWorld' } : { 'aria-hidden': true as const }

  return (
    <>
      {/* Wide: scattered at the edges, behind the headline's column. */}
      <ul {...listProps} className="pointer-events-none absolute inset-0 hidden xl:block">
        {tiles.map((tile, i) => {
          const slot = SLOTS[i]!
          const [distance, seconds, delay] = slot.float
          const place: CSSProperties = {
            [slot.side]: slot.x,
            top: slot.y,
            width: slot.w,
            transform: `rotate(${slot.r}deg)`,
          }
          const drift = {
            '--float-distance': `${distance}px`,
            '--float-duration': `${seconds}s`,
            animationDelay: `${delay}s`,
          } as CSSProperties
          return (
            <li
              key={keyOf(tile)}
              aria-hidden={tile.kind === 'filler' ? true : undefined}
              className={`absolute ${tile.kind === 'event' ? 'pointer-events-auto' : ''}`}
              style={place}
            >
              <div className="float-y" style={drift}>
                <Tile tile={tile} />
              </div>
            </li>
          )
        })}
      </ul>

      {/* Narrow: no room to scatter, so a short row above the headline. */}
      <ul {...listProps} className="mb-8 flex justify-center gap-3 xl:hidden">
        {tiles.slice(0, 3).map((tile, i) => {
          const [distance, seconds, delay] = SLOTS[i]!.float
          const drift = {
            '--float-distance': `${Math.min(distance, 7)}px`,
            '--float-duration': `${seconds}s`,
            animationDelay: `${delay}s`,
          } as CSSProperties
          return (
            <li
              key={keyOf(tile)}
              aria-hidden={tile.kind === 'filler' ? true : undefined}
              className="w-24 sm:w-28"
              style={{ transform: `rotate(${[-4, 2, 5][i]}deg)` }}
            >
              <div className="float-y" style={drift}>
                <Tile tile={tile} />
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}
