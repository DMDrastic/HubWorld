/**
 * Watching the amendments this product is blocked on.
 *
 * The transitions that matter — an amendment gaining majority, then activating
 * — happen once, months apart, on a network we do not control. Waiting for a
 * real vote is not a test strategy, so the classification is pure and the
 * ledger's answer is supplied directly.
 *
 * The stakes are that `PermissionDelegationV1_1` activating is the moment
 * `src/delegation.ts` stops being dormant code. Missing that signal for weeks
 * costs nothing dramatic, but it is exactly the kind of thing nobody thinks to
 * check by hand.
 */
import { describe, expect, it } from 'vitest'
import {
  ACTIVATION_DELAY_DAYS,
  WATCHED,
  activationEta,
  classifyAmendment,
  describeAmendment,
  isNewsworthy,
  type LedgerAmendments,
} from '../src/amendments.js'

const DELEGATION = '0F48FF561C709540328F31F1C97FD512ACC8B4E42138A161CB0E21ECA292540B'

/** 2026-08-02T00:00:00Z expressed in XRPL's 2000-based epoch. */
const CLOSE_TIME = Math.floor(Date.UTC(2026, 7, 2) / 1000) - 946_684_800

const empty: LedgerAmendments = { enabled: new Set(), majorities: new Map() }

describe('classifyAmendment', () => {
  /** Mainnet's real state as measured on 2026-08-02: not enabled, no majority. */
  it('reports pending when there is no majority', () => {
    expect(classifyAmendment(DELEGATION, empty)).toEqual({ status: 'pending' })
  })

  it('reports enabled once activated', () => {
    const state: LedgerAmendments = { enabled: new Set([DELEGATION]), majorities: new Map() }
    expect(classifyAmendment(DELEGATION, state)).toEqual({ status: 'enabled' })
  })

  /**
   * The transition worth catching. A majority starts a two-week clock, which is
   * the only advance warning the network gives.
   */
  it('reports majority with the date activation is expected', () => {
    const state: LedgerAmendments = {
      enabled: new Set(),
      majorities: new Map([[DELEGATION, CLOSE_TIME]]),
    }
    const result = classifyAmendment(DELEGATION, state)
    expect(result.status).toBe('majority')
    if (result.status !== 'majority') throw new Error('unreachable')

    expect(result.since.toISOString().slice(0, 10)).toBe('2026-08-02')
    // Two weeks later, to the day.
    expect(result.activatesAbout.toISOString().slice(0, 10)).toBe('2026-08-16')
  })

  /** Enabled wins: an amendment can be listed in both while the vote settles. */
  it('prefers enabled over a lingering majority entry', () => {
    const state: LedgerAmendments = {
      enabled: new Set([DELEGATION]),
      majorities: new Map([[DELEGATION, CLOSE_TIME]]),
    }
    expect(classifyAmendment(DELEGATION, state).status).toBe('enabled')
  })

  /** Ids come from different sources; case must never decide the answer. */
  it('matches ids case-insensitively', () => {
    const state: LedgerAmendments = {
      enabled: new Set([DELEGATION.toUpperCase()]),
      majorities: new Map(),
    }
    expect(classifyAmendment(DELEGATION.toLowerCase(), state).status).toBe('enabled')
  })
})

describe('activationEta', () => {
  it('is exactly the delay after majority', () => {
    const eta = activationEta(CLOSE_TIME)
    const since = new Date((CLOSE_TIME + 946_684_800) * 1000)
    expect(eta.getTime() - since.getTime()).toBe(ACTIVATION_DELAY_DAYS * 86_400_000)
  })
})

describe('isNewsworthy', () => {
  /**
   * `pending` has been the answer for months and will be for months more.
   * Reporting it as a finding every run is noise, and noise is what makes
   * people stop reading the reconciler's output.
   */
  it('stays quiet while nothing has changed', () => {
    expect(isNewsworthy({ status: 'pending' })).toBe(false)
  })

  it('speaks up for majority and activation', () => {
    expect(isNewsworthy({ status: 'enabled' })).toBe(true)
    expect(
      isNewsworthy({
        status: 'majority',
        since: new Date(),
        activatesAbout: new Date(),
      }),
    ).toBe(true)
  })
})

describe('what is watched', () => {
  /**
   * `PermissionDelegationV1_1` is the load-bearing one — it is what makes
   * `src/delegation.ts` live code rather than a plan.
   */
  it('watches the amendment the minting ceiling depends on', () => {
    const found = WATCHED.find((a) => a.name === 'PermissionDelegationV1_1')
    expect(found).toBeDefined()
    expect(found!.id).toBe(DELEGATION)
  })

  /** MPT was investigated and rejected, so its progress is no longer news. */
  it('does not watch amendments for paths already ruled out', () => {
    expect(WATCHED.map((a) => a.name)).not.toContain('DynamicMPT')
  })

  it('says why each one matters', () => {
    for (const a of WATCHED) {
      expect(a.why.length, a.name).toBeGreaterThan(20)
      expect(a.id, a.name).toMatch(/^[0-9A-F]{64}$/)
    }
  })
})

describe('describeAmendment', () => {
  it('keeps the name and the dates', () => {
    expect(describeAmendment('X', { status: 'enabled' })).toContain('ACTIVE')
    expect(describeAmendment('X', { status: 'pending' })).toMatch(/no majority/i)
    const line = describeAmendment('X', {
      status: 'majority',
      since: new Date('2026-08-02T00:00:00Z'),
      activatesAbout: new Date('2026-08-16T00:00:00Z'),
    })
    expect(line).toContain('2026-08-02')
    expect(line).toContain('2026-08-16')
  })
})
