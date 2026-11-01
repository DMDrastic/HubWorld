import { describe, expect, it } from 'vitest'
import { RippledError } from 'xrpl'
import { isEntryNotFound, isTxNotFound } from '../src/xrpl-errors.js'

describe('isTxNotFound', () => {
  it('recognises the error the way mainnet actually delivers it', () => {
    // The message does NOT contain the code; it lives on data.error.
    const err = new RippledError('Transaction not found.', { error: 'txnNotFound', error_code: 29 })
    expect(err.message).not.toMatch(/txnNotFound/)
    expect(isTxNotFound(err)).toBe(true)
  })

  it('recognises it from the code alone', () => {
    const err = Object.assign(new Error('something else'), { data: { error: 'txnNotFound' } })
    expect(isTxNotFound(err)).toBe(true)
  })

  it('does not swallow other failures (positive control)', () => {
    expect(isTxNotFound(new RippledError('Too busy', { error: 'tooBusy' }))).toBe(false)
    expect(isTxNotFound(new Error('socket closed'))).toBe(false)
    expect(isTxNotFound('txnNotFound')).toBe(false)
  })
})

import { isRateLimited, retryAfterMs, withBackoff } from '../src/xrpl-errors.js'

describe('rate limits', () => {
  const busy = () =>
    new RippledError('rate limit: units quota (10000 per 60s) exhausted, retry in ~12460ms', { error: 'tooBusy', error_code: 9 })

  it('recognises mainnet\'s rate limit and its retry hint', () => {
    expect(isRateLimited(busy())).toBe(true)
    expect(retryAfterMs(busy())).toBe(12460)
    expect(isRateLimited(new RippledError('Transaction not found.', { error: 'txnNotFound' }))).toBe(false)
  })

  it('waits out a rate limit for the hinted time, then succeeds', async () => {
    const waits: number[] = []
    let calls = 0
    const out = await withBackoff(
      async () => {
        calls += 1
        if (calls < 3) throw busy()
        return 'ok'
      },
      async (ms) => void waits.push(ms),
    )
    expect(out).toBe('ok')
    expect(waits).toEqual([12710, 12710])
  })

  it('rethrows anything that is not a rate limit immediately (positive control)', async () => {
    let calls = 0
    await expect(
      withBackoff(async () => {
        calls += 1
        throw new Error('boom')
      }, async () => {}),
    ).rejects.toThrow('boom')
    expect(calls).toBe(1)
  })

  it('gives up after a bounded number of attempts rather than waiting forever', async () => {
    let calls = 0
    await expect(
      withBackoff(async () => {
        calls += 1
        throw busy()
      }, async () => {}),
    ).rejects.toThrow(/rate limit/)
    expect(calls).toBe(6)
  })
})

describe('isEntryNotFound', () => {
  it('recognises a missing ledger object the way the node delivers it (the code is on data.error)', () => {
    const err = new RippledError('Entry not found.', { error: 'entryNotFound', error_code: 33 })
    expect(isEntryNotFound(err)).toBe(true)
  })

  it('recognises it from the code alone', () => {
    expect(isEntryNotFound(Object.assign(new Error('x'), { data: { error: 'entryNotFound' } }))).toBe(true)
  })

  it('is NOT fooled by a node that is busy, down or refusing: those say nothing about the offer', () => {
    expect(isEntryNotFound(new RippledError('Too busy', { error: 'tooBusy' }))).toBe(false)
    expect(isEntryNotFound(new Error('WebSocket is not open'))).toBe(false)
    expect(isEntryNotFound(Object.assign(new Error('timeout'), { data: { error: 'slowDown' } }))).toBe(false)
  })

  it('is false for things that are not errors', () => {
    expect(isEntryNotFound('entryNotFound')).toBe(false)
    expect(isEntryNotFound(null)).toBe(false)
  })
})
