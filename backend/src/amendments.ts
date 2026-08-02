/**
 * Watching the amendments this product is waiting on.
 *
 * Two of HubWorld's hardest limits are not ours to fix — they are gated on XRPL
 * amendments activating. `PermissionDelegationV1_1` is the one that lifts the
 * minting ceiling from the low hundreds to thousands; until it activates on
 * mainnet, `src/delegation.ts` is dormant code and the ceiling documented in
 * `CLAUDE.md` stands.
 *
 * Amendments activate by validator vote: 80% support held continuously for two
 * weeks. Once an amendment crosses that line it appears in the ledger's
 * `Majorities` list with the time it got there, which is roughly a fortnight of
 * warning. Measured 2026-08-02: mainnet had **zero** amendments with majority
 * support, and runs an older rippled than testnet or devnet — validators cannot
 * vote for what their software does not implement, so a release has to land
 * first.
 *
 * That makes this worth watching rather than checking by hand: the interesting
 * event is a majority appearing, and it is easy to miss for weeks.
 */
import { ledger } from './ledger.js'

/** XRPL timestamps count from 2000-01-01, not the Unix epoch. */
const RIPPLE_EPOCH_OFFSET = 946_684_800

/** Support must hold for two weeks after majority before an amendment activates. */
export const ACTIVATION_DELAY_DAYS = 14

/** The well-known ledger index of the `Amendments` singleton. */
const AMENDMENTS_INDEX = '7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4'

export type WatchedAmendment = {
  name: string
  /** The amendment id, identical on every network. Read from `feature` on devnet. */
  id: string
  /** Why HubWorld cares — so a future reader knows whether it still matters. */
  why: string
}

/**
 * Only amendments that would change what this product can do.
 *
 * `DynamicMPT` is deliberately absent: the MPT tier was investigated and
 * rejected, so its progress is no longer news.
 */
export const WATCHED: WatchedAmendment[] = [
  {
    name: 'PermissionDelegationV1_1',
    id: '0F48FF561C709540328F31F1C97FD512ACC8B4E42138A161CB0E21ECA292540B',
    why: 'lifts the minting ceiling — src/delegation.ts is dormant until this activates',
  },
  {
    name: 'Sponsor',
    id: 'BE1F90581635DBCEBFC4678C4B54FEDDC1A17B50FD02CFE765A4132A342126AC',
    why: 'sponsored reserves would remove the fund-a-wallet barrier for new buyers',
  },
  {
    name: 'BatchV1_1',
    id: '9F287AED3CDB50A7BD1ACEC24296A30C9B5230CCD136219317AC790E3B884377',
    why: 'batches up to 8 inner transactions — an 8x minting improvement, not a fix',
  },
]

export type AmendmentState =
  | { status: 'enabled' }
  /** Has majority support; activation follows automatically after the delay. */
  | { status: 'majority'; since: Date; activatesAbout: Date }
  /** No majority. No activation possible for at least the delay period. */
  | { status: 'pending' }

export type LedgerAmendments = {
  enabled: Set<string>
  /** amendment id → the CloseTime at which it reached majority. */
  majorities: Map<string, number>
}

/** When an amendment that reached majority at `closeTime` should activate. */
export function activationEta(closeTime: number): Date {
  return new Date((closeTime + RIPPLE_EPOCH_OFFSET) * 1000 + ACTIVATION_DELAY_DAYS * 86_400_000)
}

/**
 * Classify one amendment against what the ledger reports.
 *
 * Pure so the interesting transitions can be tested without waiting months for
 * a real vote — which is the only other way to exercise this.
 */
export function classifyAmendment(id: string, ledgerState: LedgerAmendments): AmendmentState {
  const key = id.toUpperCase()
  if (ledgerState.enabled.has(key)) return { status: 'enabled' }

  const closeTime = ledgerState.majorities.get(key)
  if (closeTime !== undefined) {
    return {
      status: 'majority',
      since: new Date((closeTime + RIPPLE_EPOCH_OFFSET) * 1000),
      activatesAbout: activationEta(closeTime),
    }
  }
  return { status: 'pending' }
}

/**
 * Is this worth interrupting someone about?
 *
 * `pending` is the steady state and has been for months, so reporting it every
 * run is noise that trains people to skim. A majority appearing means a clock
 * has started; activation means the code can finally ship.
 */
export function isNewsworthy(state: AmendmentState): boolean {
  return state.status !== 'pending'
}

/** One line, with the date if there is one. */
export function describeAmendment(name: string, state: AmendmentState): string {
  switch (state.status) {
    case 'enabled':
      return `${name}: ACTIVE`
    case 'majority':
      return (
        `${name}: has majority since ${state.since.toISOString().slice(0, 10)} — ` +
        `activates about ${state.activatesAbout.toISOString().slice(0, 10)}`
      )
    case 'pending':
      return `${name}: no majority, so no activation for at least ${ACTIVATION_DELAY_DAYS} days`
  }
}

/**
 * Read the amendments object from whichever network we are connected to.
 *
 * The `feature` command would give names but is admin-only on public servers.
 * The `Amendments` ledger object is public, and ids are the same everywhere, so
 * this works against mainnet where `feature` does not.
 */
export async function readLedgerAmendments(): Promise<LedgerAmendments> {
  const client = await ledger()
  const res = (await client.request({
    command: 'ledger_entry',
    index: AMENDMENTS_INDEX,
    ledger_index: 'validated',
  } as never)) as {
    result: {
      node?: {
        Amendments?: string[]
        Majorities?: Array<{ Majority?: { Amendment?: string; CloseTime?: number } }>
      }
    }
  }

  const enabled = new Set((res.result.node?.Amendments ?? []).map((a) => a.toUpperCase()))
  const majorities = new Map<string, number>()
  for (const m of res.result.node?.Majorities ?? []) {
    if (m.Majority?.Amendment) {
      majorities.set(m.Majority.Amendment.toUpperCase(), m.Majority.CloseTime ?? 0)
    }
  }
  return { enabled, majorities }
}
