/**
 * The events page: a timeline you can switch between what is coming and what has
 * been.
 *
 * It used to be a wall of portrait posters with a rail of live auctions on top.
 * That showed the most events per glance, which suited browsing, but a person
 * here is usually asking "what is on, when, and can I get in?", and a poster
 * answers only the first part. See `EventRow`, which has the reasoning for what
 * a row holds and what the rail says.
 *
 * Live auctions are not pulled into a separate rail any more. They are ordinary
 * events with an extra fact, and splitting them out put the same night in two
 * places depending on one flag; on the timeline they sit where their date puts
 * them, marked on the rail and in a chip, with the action inline.
 *
 * The page opens on whichever side has something in it. An empty "Upcoming" as
 * the first thing a new visitor sees reads as a dead product, so when nothing is
 * scheduled the past events show instead, and the switch is right there.
 */
import { useId, useState } from 'react'
import { CalendarX2 } from 'lucide-react'
import { EventRow } from '@/components/EventRow'
import { PageHeader } from '@/components/PageHeader'
import { Segmented } from '@/components/Segmented'
import type { EventSummary } from '@/lib/api'

type View = 'upcoming' | 'past'

const VIEWS = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'past', label: 'Past' },
] as const

/**
 * Upcoming means it has not happened and has not been called off. Measured from
 * the start of today rather than from this instant: an event that began at
 * 7 pm is still the thing to show at 9 pm, not something already gone.
 */
function isUpcoming(e: EventSummary, from: number): boolean {
  return e.status !== 'COMPLETED' && e.status !== 'CANCELLED' && new Date(e.startsAt).getTime() >= from
}

function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-20 text-center">
      <div className="surface flex size-16 items-center justify-center rounded-2xl">
        <CalendarX2 className="text-muted-foreground size-7" aria-hidden />
      </div>
      <h2 className="mt-6 text-xl font-semibold tracking-[-0.02em]">{title}</h2>
      <div className="text-muted-foreground mt-2 max-w-sm text-sm leading-relaxed">{children}</div>
    </div>
  )
}

export function EventList({
  events,
  auctionSlugs,
  onOpenAuction,
  onBuy,
  note,
}: {
  events: EventSummary[]
  /** Slugs with a live auction, from GET /api/auctions. */
  auctionSlugs: ReadonlySet<string>
  onOpenAuction: (event: EventSummary) => void
  /** Opens the box office for an event that has tickets on sale. */
  onBuy?: (event: EventSummary) => void
  /** A line under the title, for what only this visitor needs to hear. */
  note?: string
}) {
  const from = startOfToday()
  const upcoming = events
    .filter((e) => isUpcoming(e, from))
    .sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt))
  const past = events
    .filter((e) => !isUpcoming(e, from))
    .sort((a, b) => +new Date(b.startsAt) - +new Date(a.startsAt))

  const [view, setView] = useState<View>(() => (upcoming.length > 0 || past.length === 0 ? 'upcoming' : 'past'))
  const idBase = useId()
  const panelId = `${idBase}-panel`

  if (events.length === 0) {
    return (
      <>
        <PageHeader title="Events" description={note} />
        <Empty title="No events yet">
          Run <code className="font-mono">npm run db:seed</code> in backend/ to add some.
        </Empty>
      </>
    )
  }

  const shown = view === 'upcoming' ? upcoming : past

  return (
    <>
      <PageHeader
        title="Events"
        description={note}
        aside={
          <Segmented
            label="Show events"
            options={VIEWS}
            value={view}
            onChange={setView}
            idBase={idBase}
            panelId={panelId}
          />
        }
      />

      <div role="tabpanel" id={panelId} aria-labelledby={`${idBase}-${view}`}>
        {shown.length === 0 ? (
          view === 'upcoming' ? (
            <Empty title="Nothing scheduled">
              No events are coming up. Past events are one tap away.
            </Empty>
          ) : (
            <Empty title="No past events" />
          )
        ) : (
          <ol className="pb-8">
            {shown.map((e, i) => (
              <EventRow
                key={e.slug}
                event={e}
                live={auctionSlugs.has(e.slug)}
                onOpenAuction={onOpenAuction}
                onBuy={onBuy}
                first={i === 0}
                last={i === shown.length - 1}
                showDate={i === 0 || new Date(shown[i - 1]!.startsAt).toDateString() !== new Date(e.startsAt).toDateString()}
              />
            ))}
          </ol>
        )}
      </div>
    </>
  )
}
