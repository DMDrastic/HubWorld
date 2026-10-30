/**
 * Which of someone's tickets float on the Hub, which wait on the timeline, and which are behind them.
 *
 * Three groups, decided here in one place so the page and its tests cannot disagree:
 *
 * - FEATURED: the soonest upcoming tickets, never more than `FEATURED_MAX`. These are the ones
 *   worth a poster each, because they are the ones you are about to use. Four is the owner's
 *   cap on what may float; more would stop being a few things to look at and become a crowd.
 * - UPCOMING: every other ticket for something still ahead of you, soonest first.
 * - PAST: tickets already used at the door, and tickets for nights that have gone. A ticket is
 *   not the event's property: one you held for a gig last month is history even if nobody
 *   scanned it.
 *
 * "Upcoming" is measured from the start of today, as on the Events page: a ticket for tonight
 * at 7 pm is still the thing to show at 9 pm.
 */
import type { OwnedTicket } from '@/lib/api'

export const FEATURED_MAX = 4

export type TicketGroups = {
  featured: OwnedTicket[]
  upcoming: OwnedTicket[]
  past: OwnedTicket[]
}

export function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const startsAt = (t: OwnedTicket) => new Date(t.event.startsAt).getTime()

export function groupTickets(tickets: readonly OwnedTicket[], now: number = Date.now()): TicketGroups {
  const from = startOfDay(now)
  const isPast = (t: OwnedTicket) => t.status === 'REDEEMED' || startsAt(t) < from

  const ahead = tickets.filter((t) => !isPast(t)).sort((a, b) => startsAt(a) - startsAt(b))
  // Most recent first: the night you just went to is the one you most want to see.
  const behind = tickets.filter(isPast).sort((a, b) => startsAt(b) - startsAt(a))

  return {
    featured: ahead.slice(0, FEATURED_MAX),
    upcoming: ahead.slice(FEATURED_MAX),
    past: behind,
  }
}

/** How far ahead a ticket still reads as "soon" in words. Beyond this the date says it better. */
export const RELATIVE_DAYS_MAX = 13

/**
 * When a ticket's night is, in the words a person would use ("Today", "Tomorrow", "In 3 days").
 *
 * Counted in calendar days from the local midnight, not in 24-hour blocks: a ticket for 9 am
 * tomorrow is "Tomorrow" at 11 pm tonight, not "In 10 hours". Null for a night that has gone and
 * for one too far off to be worth saying, where the printed date is the better answer.
 */
export function relativeDay(startsAtIso: string, now: number = Date.now()): string | null {
  const days = Math.round((startOfDay(new Date(startsAtIso).getTime()) - startOfDay(now)) / 864e5)
  if (days < 0 || days > RELATIVE_DAYS_MAX) return null
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  return `In ${days} days`
}
