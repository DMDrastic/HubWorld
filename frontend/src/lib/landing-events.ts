/**
 * Which events the landing page floats around its headline.
 *
 * Only what the public may see (published or sold out, never a draft, a cancelled
 * or a finished event) AND only events that have a poster. The cloud is made of
 * posters, so an event with no artwork has nothing to put in its place: showing it as
 * a flat colour tile with a date on it read as a broken image beside the real
 * artwork, and the page already has decorative art for the places left over. Upcoming
 * comes before past, then the soonest. It never pads: asked for eight of three events
 * it returns three.
 */
import type { EventSummary } from '@/lib/api'

/** Which events to show: shown-to-the-public statuses, artwork first, then soonest. */
export function pickCloudEvents(events: EventSummary[], limit = 8): EventSummary[] {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const from = today.getTime()
  return events
    .filter((e) => (e.status === 'PUBLISHED' || e.status === 'SOLD_OUT') && Boolean(e.imageUrl))
    .sort((a, b) => {
      const aUpcoming = new Date(a.startsAt).getTime() >= from
      const bUpcoming = new Date(b.startsAt).getTime() >= from
      if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1
      return +new Date(a.startsAt) - +new Date(b.startsAt)
    })
    .slice(0, limit)
}
