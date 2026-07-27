/**
 * When a ticket may go to auction.
 *
 * Auctions are the SECONDARY market for scarcity. They exist because a sold-out
 * event has demand the organizer can no longer meet, so holders bid against each
 * other. Two rules follow from that, and neither was enforced before:
 *
 * **1. The event must be sold out.** Auctioning while the organizer still has
 * inventory is just competing with face value — a fan bids 30 XRP for a ticket
 * anyone can buy for 10. That is not scarcity, it is confusion.
 *
 * **2. The organizer cannot auction.** Their allocation is the primary sale, at
 * the price they set. An organizer auctioning their own stock is an organizer
 * bidding up their own event, which is exactly the behaviour ticketing platforms
 * are supposed to prevent.
 *
 * ## Why "sold out" is derived, not read from Event.status
 *
 * `Event.status` is settable and therefore unreliable — the seeded
 * `peachs-castle-afterparty` is marked SOLD_OUT with zero tickets minted. Gating
 * a market on a field someone can just set would let an organizer open auctions
 * on an event that never sold anything. The facts are counted instead, and the
 * status field is corrected to match.
 */
import { prisma } from './prisma.js'

export type SoldOutState = {
  ticketCount: number
  minted: number
  /** Tickets the organizer still holds — unsold inventory. */
  organizerHolds: number
  soldOut: boolean
}

/**
 * Count what has actually happened for an event, and sync `Event.status`.
 *
 * Sold out means both halves: everything promised has been issued, AND none of
 * it is still with the organizer. Either alone is not enough — 10 minted with 4
 * unsold is not sold out, and 3 minted and distributed out of 10 is not either.
 */
export async function evaluateSoldOut(eventId: string): Promise<SoldOutState> {
  const event = await prisma.event.findUniqueOrThrow({
    where: { id: eventId },
    select: { id: true, organizerId: true, ticketCount: true, status: true },
  })

  const [minted, organizerHolds] = await Promise.all([
    prisma.ticket.count({ where: { eventId } }),
    prisma.ticket.count({ where: { eventId, ownerId: event.organizerId } }),
  ])

  // A ticketCount of 0 means "no declared cap", which can never be sold out —
  // otherwise an event with no tickets would qualify the moment it was created.
  const soldOut = event.ticketCount > 0 && minted >= event.ticketCount && organizerHolds === 0

  // Keep the status field honest rather than leaving two sources of truth.
  // Never touch a CANCELLED or COMPLETED event: those are decisions, not counts.
  if (event.status === 'PUBLISHED' && soldOut) {
    await prisma.event.update({ where: { id: eventId }, data: { status: 'SOLD_OUT' } })
  } else if (event.status === 'SOLD_OUT' && !soldOut) {
    // Tickets came back to the organizer, or the cap was raised.
    await prisma.event.update({ where: { id: eventId }, data: { status: 'PUBLISHED' } })
  }

  return { ticketCount: event.ticketCount, minted, organizerHolds, soldOut }
}

export type AuctionEligibility =
  | { allowed: true }
  | { allowed: false; reason: string; detail?: Record<string, unknown> }

/**
 * Whether this holder may auction this ticket.
 *
 * Reasons are specific because "you can't do that" is useless to someone holding
 * a ticket they believe is valuable — they need to know whether to wait for the
 * event to sell out or that it will never be allowed.
 */
export async function canAuction(params: {
  eventId: string
  organizerId: string
  holderId: string
}): Promise<AuctionEligibility> {
  if (params.holderId === params.organizerId) {
    return {
      allowed: false,
      reason:
        'Organizers sell their own tickets at face value. Auctions are for holders reselling a sold-out event.',
    }
  }

  const state = await evaluateSoldOut(params.eventId)
  if (!state.soldOut) {
    return {
      allowed: false,
      reason:
        state.minted < state.ticketCount
          ? `This event is not sold out yet — ${state.minted} of ${state.ticketCount} tickets issued.`
          : `The organizer still has ${state.organizerHolds} ticket${state.organizerHolds === 1 ? '' : 's'} available at face value.`,
      detail: {
        minted: state.minted,
        ticketCount: state.ticketCount,
        organizerHolds: state.organizerHolds,
      },
    }
  }

  return { allowed: true }
}
