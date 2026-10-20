/**
 * The rules of unattended bulk minting, as pure functions.
 *
 * Every one of these guards a failure that is silent in production. A bulk mint
 * that goes wrong does not crash: it produces an event that is quietly short of
 * tickets, or one that burned fees on transactions that did nothing, or one that
 * kept submitting against a permission the organizer had withdrawn. Keeping the
 * decisions here — free of the ledger and the database — means they can be
 * pinned precisely and mutation-tested, instead of being buried in a loop that
 * only runs against a network.
 */

/**
 * Transactions per wave.
 *
 * rippled holds only a small number of future-sequence transactions PER ACCOUNT
 * and drops the rest rather than queueing them. Measured on devnet: firing 1,000
 * at once, 962 came back `terPRE_SEQ`, throughput collapsed from 7.5/s to 0.5/s,
 * and 402 of the tickets existed. 20 sits inside the queue with room to spare.
 */
export const WAVE_SIZE = 20

/**
 * Hard ceiling on one job. Not a technical limit — a sanity bound, so a typo
 * cannot ask for a million NFTs and lock the organizer's reserve for the lot.
 */
export const MAX_JOB_TICKETS = 5_000

/**
 * Tickets per NFTokenPage, as MEASURED rather than as specified.
 *
 * A page holds at most 32, and the documentation reads as if that were the
 * figure to divide by. It is not: pages SPLIT as they fill, so they run fuller
 * than half and emptier than full. Measured on devnet by minting 1,000 tickets
 * through the shipped worker: 41 pages, 24.4 tickets per page (earlier runs: 100
 * -> 4 pages, 250 -> 9, 500 -> 23). Dividing by 32 gave 33 pages and understated
 * the reserve by about a fifth — the product would have let an organizer start a
 * run it could not finish, and found out at ticket 900.
 *
 * 22 sits ~10% below the measured average, so the estimate stays above what any
 * of those runs actually needed. Where the NFTokenID falls decides which page a
 * token lands in, so a different run splits differently. Re-measure before
 * raising it; `bulk-mint-policy.test.ts` pins the measurements.
 */
export const NFTS_PER_PAGE = 22

/** Page counts actually observed, for the test that keeps the estimate honest. */
export const MEASURED_PAGES: ReadonlyArray<{ tickets: number; pages: number }> = [
  { tickets: 100, pages: 4 },
  { tickets: 250, pages: 9 },
  { tickets: 500, pages: 23 },
  { tickets: 1000, pages: 41 },
]

export type PlanInput = {
  requested: number
  /** The advertised cap. 0 means the organizer set none. */
  ticketCount: number
  /** Tickets already recorded for the event. */
  existing: number
  /** Mints committed elsewhere and not yet recorded: pending MintRequests, and the unfinished remainder of other jobs. */
  committed: number
}

export type Plan = { ok: true; count: number } | { ok: false; reason: string }

/**
 * How many tickets a job may mint.
 *
 * The cap counts what is already committed, not just what exists: a job asking
 * for 500 while another run still has 300 to go would overshoot the advertised
 * event size, and a ticket minted past `ticketCount` cannot be taken back.
 */
export function planBulkMint(input: PlanInput): Plan {
  const { requested, ticketCount, existing, committed } = input

  if (!Number.isInteger(requested) || requested < 1) {
    return { ok: false, reason: 'Ask for at least one ticket' }
  }
  if (requested > MAX_JOB_TICKETS) {
    return { ok: false, reason: `One run is limited to ${MAX_JOB_TICKETS} tickets` }
  }

  if (ticketCount > 0) {
    const room = ticketCount - existing - committed
    if (room <= 0) {
      return { ok: false, reason: `All ${ticketCount} tickets for this event are minted or pending` }
    }
    if (requested > room) {
      return {
        ok: false,
        reason: `Only ${room} of this event's ${ticketCount} tickets are left to mint`,
      }
    }
  }

  return { ok: true, count: requested }
}

/**
 * Reserve the organizer must be able to lock for `count` more tickets.
 *
 * Reserve is per NFTokenPage, not per ticket, and the pages fill unevenly (see
 * `NFTS_PER_PAGE`); one extra page is added because a run need not start on a
 * page boundary. Too high a figure refuses an organizer who could have afforded
 * it; too low lets the job start and die half-way with
 * `tecINSUFFICIENT_RESERVE`, which is worse.
 */
export function reserveNeededDrops(count: number, reserveIncDrops: bigint): bigint {
  const pages = Math.ceil(count / NFTS_PER_PAGE) + 1
  return BigInt(pages) * reserveIncDrops
}

export type FeeQuote = { minimumFee: number; openLedgerFee: number }

export type FeeDecision = { ok: true; feeDrops: number } | { ok: false; reason: string }

/** Margin over the quoted open-ledger fee, so a wave priced at the edge still clears. */
const FEE_MARGIN = 1.2

/**
 * What to pay per mint, or whether to wait.
 *
 * A busy mainnet raises the open-ledger fee; devnet is empty and never did, so
 * the 12 drops measured there is not a promise. Paying whatever is asked would
 * let a fee spike spend the delegate's balance on a job that could have waited,
 * so above `maxFeeDrops` the answer is to try again later, not to overpay.
 */
export function decideFee(quote: FeeQuote, maxFeeDrops: number): FeeDecision {
  const wanted = Math.ceil(Math.max(quote.minimumFee, quote.openLedgerFee) * FEE_MARGIN)
  if (wanted > maxFeeDrops) {
    return {
      ok: false,
      reason: `Network fees are high right now (${wanted} drops per ticket); waiting for them to fall`,
    }
  }
  return { ok: true, feeDrops: wanted }
}

/** Default ceiling: 0.001 XRP, about 80x the fee measured on mainnet. */
export const DEFAULT_MAX_FEE_DROPS = 1_000

export type WaveVerdict =
  /** Carry on. */
  | { kind: 'continue' }
  /** Needs the organizer, so waiting changes nothing. */
  | { kind: 'pause'; reason: string }
  /** Give up: something is wrong that retrying will not fix. */
  | { kind: 'fail'; reason: string }

const PERMISSION_CODES = new Set(['terNO_DELEGATE_PERMISSION', 'tecNO_PERMISSION', 'tecNO_DELEGATE_PERMISSION'])
const FUNDING_CODES = new Set(['tecINSUFFICIENT_RESERVE', 'tecUNFUNDED', 'tecINSUFFICIENT_FUNDS'])

/**
 * Consecutive waves with no new ticket before giving up.
 *
 * Consecutive, not cumulative: counting every stall across a long run aborted a
 * devnet attempt that was still making progress.
 */
export const MAX_STALLED_WAVES = 5

/**
 * What a finished wave means for the job.
 *
 * The result codes carry the diagnosis, and they differ in who can fix them. A
 * revoked grant or an organizer who cannot cover the reserve needs a human, so
 * retrying burns fees for nothing — pause and say why. A `tec` of any other kind
 * is a real failure to record; and a wave that landed nothing, repeatedly, is a
 * stall to stop rather than loop.
 */
export function judgeWave(input: {
  /** Result code of each transaction that was applied (validated), by code. */
  codes: string[]
  /** Tickets this wave produced. */
  minted: number
  /** Waves in a row that produced nothing, including this one. */
  stalledWaves: number
}): WaveVerdict {
  for (const code of input.codes) {
    if (PERMISSION_CODES.has(code)) {
      return {
        kind: 'pause',
        reason: 'Your minting permission was withdrawn. Approve it again to continue.',
      }
    }
  }
  for (const code of input.codes) {
    if (FUNDING_CODES.has(code)) {
      return {
        kind: 'pause',
        reason: 'Your account cannot cover the reserve for more tickets. Add XRP and resume.',
      }
    }
  }

  if (input.minted === 0 && input.stalledWaves >= MAX_STALLED_WAVES) {
    const odd = input.codes.find((c) => c !== 'tesSUCCESS')
    return {
      kind: 'fail',
      reason: `No tickets were minted across ${input.stalledWaves} attempts${odd ? ` (${odd})` : ''}`,
    }
  }

  return { kind: 'continue' }
}

/** Size of the next wave: never past what is left. */
export function nextWaveSize(remaining: number, waveSize: number = WAVE_SIZE): number {
  return Math.max(0, Math.min(remaining, waveSize))
}

/**
 * Where did a wave's transactions end up, given what the ledger now says?
 *
 * `landed` hashes are validated; the rest are either still able to land
 * (`lastLedgerSequence` not yet passed) or dead. A dead hash that never
 * validated is dropped, and its sequence will have been taken by nothing — the
 * next wave simply re-reads the organizer's sequence and starts from there.
 */
export function waveOutcome(input: {
  hashes: string[]
  validated: ReadonlySet<string>
  currentLedger: number
  lastLedgerSequence: number
}): 'settled' | 'waiting' {
  const unresolved = input.hashes.filter((h) => !input.validated.has(h))
  if (unresolved.length === 0) return 'settled'
  // Past LastLedgerSequence an unvalidated transaction can never apply.
  return input.currentLedger > input.lastLedgerSequence ? 'settled' : 'waiting'
}
