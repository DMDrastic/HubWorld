/**
 * Which events the landing page floats around its headline.
 *
 * Only what the public may see (published or sold out, never a draft, a cancelled
 * or a finished event), with artwork first because a poster is the point, then
 * upcoming before past, then the soonest. It never pads: asked for eight of three
 * events it returns three.
 */
import type { EventSummary } from '@/lib/api'

/** Which events to show: shown-to-the-public statuses, artwork first, then soonest. */
export function pickCloudEvents(events: EventSummary[], limit = 8): EventSummary[] {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const from = today.getTime()
  return events
    .filter((e) => e.status === 'PUBLISHED' || e.status === 'SOLD_OUT')
    .sort((a, b) => {
      const art = Number(Boolean(b.imageUrl)) - Number(Boolean(a.imageUrl))
      if (art !== 0) return art
      const aUpcoming = new Date(a.startsAt).getTime() >= from
      const bUpcoming = new Date(b.startsAt).getTime() >= from
      if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1
      return +new Date(a.startsAt) - +new Date(b.startsAt)
    })
    .slice(0, limit)
}
