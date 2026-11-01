/**
 * The rules for a sale that has a buyer's offer on the ledger but is not yet matched, as pure functions.
 *
 * A buy offer does not lock funds, so a buyer can spend the money after bidding and the match then fails. That is a
 * reason to wait a little (they may be paid by something else, which has happened) and not a reason to wait for ever:
 * every wait backs off, a hard cap bounds how many there are, and past it the sale is let go so the ticket can be sold
 * to someone who can pay.
 */
import { classifyResult } from './tx-result.js'

/** Strikes (spaced-out failed attempts to match) a sale gets before it is let go. */
export const MAX_SETTLE_STRIKES = 6

/** How long to wait after strike 1, 2, ... A buyer gets roughly 18 minutes in total to fund the bid. */
export const SETTLE_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 900_000] as const

/** The sweep leaves a sale to its own client for this long before stepping in beside it. */
export const SWEEP_GRACE_MS = 45_000

/** One driver owns a match attempt for this long; a driver that dies lets it lapse. Longer than a broker submit. */
export const CLAIM_LEASE_MS = 90_000

/** A sale this long in SETTLING is reported: it is not finishing by itself. */
export const STUCK_AFTER_MS = 15 * 60_000

export const stuckCutoff = (now: Date) => new Date(now.getTime() - STUCK_AFTER_MS)

export type Strike = { strikes: number; dead: boolean; nextAt: Date | null }

/** Record one more failed attempt (the buyer could not pay): when to look again, or that the sale is let go. */
export function settleStrike(strikesBefore: number, now: Date): Strike {
  const strikes = strikesBefore + 1
  if (strikes >= MAX_SETTLE_STRIKES) return { strikes, dead: true, nextAt: null }
  const wait = SETTLE_BACKOFF_MS[Math.min(strikes - 1, SETTLE_BACKOFF_MS.length - 1)]!
  return { strikes, dead: false, nextAt: new Date(now.getTime() + wait) }
}

/**
 * Does this ledger result mean the buyer could not pay? Only that is waited for. Our own faults are never blamed on a
 * buyer, and a vanished offer is not a wait at all.
 */
export function isFundsShortfall(result: string): boolean {
  return classifyResult(result) === 'counterparty'
}
