/**
 * The bulk-mint rules, as pure functions. Each one guards a failure that is
 * silent in production — an event quietly short, fees burned for nothing, a
 * permission spent after it was withdrawn — so the boundaries are pinned exactly.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_FEE_DROPS,
  MAX_JOB_TICKETS,
  MAX_STALLED_WAVES,
  MEASURED_PAGES,
  NFTS_PER_PAGE,
  WAVE_SIZE,
  decideFee,
  judgeWave,
  nextWaveSize,
  planBulkMint,
  reserveNeededDrops,
  waveOutcome,
} from '../src/bulk-mint-policy.js'

describe('planBulkMint', () => {
  const base = { requested: 100, ticketCount: 1000, existing: 0, committed: 0 }

  it('accepts a request that fits', () => {
    expect(planBulkMint(base)).toEqual({ ok: true, count: 100 })
  })

  it('refuses nothing, fractions and negatives', () => {
    for (const requested of [0, -1, 1.5, Number.NaN]) {
      expect(planBulkMint({ ...base, requested }).ok).toBe(false)
    }
  })

  it('has a hard ceiling per run, inclusive', () => {
    expect(planBulkMint({ ...base, ticketCount: 0, requested: MAX_JOB_TICKETS }).ok).toBe(true)
    expect(planBulkMint({ ...base, ticketCount: 0, requested: MAX_JOB_TICKETS + 1 }).ok).toBe(false)
  })

  it('fits exactly to the advertised size, and not one past it', () => {
    expect(planBulkMint({ ...base, ticketCount: 100, requested: 100 }).ok).toBe(true)
    const over = planBulkMint({ ...base, ticketCount: 100, requested: 101 })
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.reason).toMatch(/Only 100 of this event's 100/)
  })

  it('counts what exists AND what is committed elsewhere against the size', () => {
    // 60 exist and 30 more are committed, so only 10 of 100 remain.
    const plan = planBulkMint({ ...base, ticketCount: 100, existing: 60, committed: 30, requested: 11 })
    expect(plan.ok).toBe(false)
    expect(planBulkMint({ ...base, ticketCount: 100, existing: 60, committed: 30, requested: 10 }).ok).toBe(true)
  })

  it('reports a full event plainly', () => {
    const plan = planBulkMint({ ...base, ticketCount: 100, existing: 100, requested: 1 })
    expect(plan).toEqual({ ok: false, reason: 'All 100 tickets for this event are minted or pending' })
  })

  it('treats ticketCount 0 as "no cap set"', () => {
    expect(planBulkMint({ ...base, ticketCount: 0, existing: 9_999, requested: 50 }).ok).toBe(true)
  })
})

describe('reserveNeededDrops', () => {
  const INC = 200_000n

  it('charges per effective page, plus one for misalignment', () => {
    expect(reserveNeededDrops(1, INC)).toBe(2n * INC)
    expect(reserveNeededDrops(NFTS_PER_PAGE, INC)).toBe(2n * INC)
    expect(reserveNeededDrops(NFTS_PER_PAGE + 1, INC)).toBe(3n * INC)
    expect(reserveNeededDrops(1000, INC)).toBe(47n * INC) // ceil(1000/22)=46, +1
  })

  it('NEVER understates a run that was actually measured', () => {
    // This is the test that would have caught the original figure: dividing by the
    // specification's 32 gave 33 pages for 1,000 tickets, and the real run needed 41.
    for (const { tickets, pages } of MEASURED_PAGES) {
      const estimated = reserveNeededDrops(tickets, INC) / INC
      expect(estimated, `${tickets} tickets measured ${pages} pages`).toBeGreaterThanOrEqual(BigInt(pages))
    }
  })

  it('would have failed the old figure (32 per page) on the 1,000-ticket measurement', () => {
    const old = BigInt(Math.ceil(1000 / 32) + 1)
    const measured = MEASURED_PAGES.find((m) => m.tickets === 1000)!
    expect(old).toBeLessThan(BigInt(measured.pages))
  })

  it('is not wildly over: within 30% of the largest measured run', () => {
    const m = MEASURED_PAGES.find((x) => x.tickets === 1000)!
    expect(Number(reserveNeededDrops(1000, INC) / INC)).toBeLessThanOrEqual(m.pages * 1.3)
  })

  it('scales with the network reserve rather than a constant', () => {
    expect(reserveNeededDrops(44, 2_000_000n)).toBe(3n * 2_000_000n)
  })
})

describe('decideFee', () => {
  it('pays a margin over the quote so a wave at the edge still clears', () => {
    expect(decideFee({ minimumFee: 10, openLedgerFee: 10 }, 1000)).toEqual({ ok: true, feeDrops: 12 })
  })

  it('uses the larger of the minimum and the open-ledger fee', () => {
    expect(decideFee({ minimumFee: 10, openLedgerFee: 100 }, 1000)).toEqual({ ok: true, feeDrops: 120 })
    expect(decideFee({ minimumFee: 50, openLedgerFee: 10 }, 1000)).toEqual({ ok: true, feeDrops: 60 })
  })

  it('waits instead of overpaying once the ceiling is passed', () => {
    const at = decideFee({ minimumFee: 10, openLedgerFee: 833 }, 1000) // 833*1.2 = 999.6 -> 1000
    expect(at.ok).toBe(true)
    const over = decideFee({ minimumFee: 10, openLedgerFee: 834 }, 1000) // 1000.8 -> 1001
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.reason).toMatch(/waiting for them to fall/)
  })

  it('has a default ceiling far above the fee measured on mainnet', () => {
    expect(DEFAULT_MAX_FEE_DROPS).toBeGreaterThanOrEqual(12 * 50)
  })
})

describe('judgeWave', () => {
  const ok = { codes: ['tesSUCCESS'], minted: 1, stalledWaves: 0 }

  it('carries on after a good wave', () => {
    expect(judgeWave(ok)).toEqual({ kind: 'continue' })
  })

  it('pauses, rather than retries, when the organizer withdrew the permission', () => {
    for (const code of ['terNO_DELEGATE_PERMISSION', 'tecNO_PERMISSION']) {
      const v = judgeWave({ ...ok, codes: ['tesSUCCESS', code], minted: 0 })
      expect(v.kind).toBe('pause')
      if (v.kind === 'pause') expect(v.reason).toMatch(/permission was withdrawn/)
    }
  })

  it('pauses when the organizer cannot fund the reserve', () => {
    for (const code of ['tecINSUFFICIENT_RESERVE', 'tecUNFUNDED', 'tecINSUFFICIENT_FUNDS']) {
      const v = judgeWave({ ...ok, codes: [code], minted: 0 })
      expect(v.kind).toBe('pause')
      if (v.kind === 'pause') expect(v.reason).toMatch(/reserve/)
    }
  })

  it('a permission problem outranks a funding one', () => {
    const v = judgeWave({ ...ok, codes: ['tecINSUFFICIENT_RESERVE', 'tecNO_PERMISSION'], minted: 0 })
    expect(v.kind === 'pause' && /permission/.test(v.reason)).toBe(true)
  })

  it('fails only after the stall limit, and only when nothing was minted', () => {
    expect(judgeWave({ codes: [], minted: 0, stalledWaves: MAX_STALLED_WAVES - 1 }).kind).toBe('continue')
    expect(judgeWave({ codes: [], minted: 0, stalledWaves: MAX_STALLED_WAVES }).kind).toBe('fail')
    // Progress resets the count, so a slow-but-moving run is never aborted.
    expect(judgeWave({ codes: [], minted: 3, stalledWaves: MAX_STALLED_WAVES }).kind).toBe('continue')
  })

  it('names the odd code in the failure', () => {
    const v = judgeWave({ codes: ['tecWEIRD'], minted: 0, stalledWaves: MAX_STALLED_WAVES })
    expect(v.kind === 'fail' && /tecWEIRD/.test(v.reason)).toBe(true)
  })
})

describe('nextWaveSize', () => {
  it('is the wave size, capped by what remains', () => {
    expect(nextWaveSize(1000)).toBe(WAVE_SIZE)
    expect(nextWaveSize(WAVE_SIZE)).toBe(WAVE_SIZE)
    expect(nextWaveSize(7)).toBe(7)
    expect(nextWaveSize(0)).toBe(0)
    expect(nextWaveSize(-3)).toBe(0)
  })
})

describe('waveOutcome', () => {
  const hashes = ['a', 'b', 'c']

  it('is settled once every hash validated', () => {
    expect(waveOutcome({ hashes, validated: new Set(hashes), currentLedger: 1, lastLedgerSequence: 100 })).toBe('settled')
  })

  it('waits while a hash can still land', () => {
    expect(waveOutcome({ hashes, validated: new Set(['a']), currentLedger: 100, lastLedgerSequence: 100 })).toBe('waiting')
  })

  it('treats the unvalidated as dead only PAST LastLedgerSequence, not at it', () => {
    expect(waveOutcome({ hashes, validated: new Set(['a']), currentLedger: 101, lastLedgerSequence: 100 })).toBe('settled')
  })
})
