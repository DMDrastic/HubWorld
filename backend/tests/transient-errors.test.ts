/**
 * Transient-network detection.
 *
 * A timeout reaching Xaman or the XRP Ledger used to surface as
 * "Internal server error". That is actively misleading: the user's transaction
 * may already have succeeded on-ledger — as happened with a gift that reported an
 * error while the acceptance had validated fine — and a 500 reads like data loss
 * rather than "try again".
 *
 * The awkward part is that `fetch` reports these as a bare
 * `TypeError: fetch failed` with the real code buried under `cause`, sometimes
 * inside an AggregateError. So the detection has to walk the chain.
 */
import { describe, expect, it } from 'vitest'
import { isTransientNetworkError } from '../src/app.js'

describe('isTransientNetworkError', () => {
  it('detects a plain connection error', () => {
    for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
      expect(isTransientNetworkError(Object.assign(new Error('x'), { code })), code).toBe(true)
    }
  })

  it('unwraps the shape fetch actually throws', () => {
    // This is verbatim the structure seen in the log: TypeError: fetch failed,
    // with an AggregateError cause carrying the code.
    const inner = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
    const aggregate = Object.assign(new Error('AggregateError'), {
      code: 'ETIMEDOUT',
      errors: [inner, inner],
    })
    const thrown = Object.assign(new TypeError('fetch failed'), { cause: aggregate })

    expect(isTransientNetworkError(thrown)).toBe(true)
  })

  it('finds a code nested only inside an AggregateError list', () => {
    const thrown = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('all attempts failed'), {
        errors: [Object.assign(new Error('nope'), { code: 'ECONNREFUSED' })],
      }),
    })
    expect(isTransientNetworkError(thrown)).toBe(true)
  })

  it('recognises an xrpl.js disconnect, which carries no code', () => {
    expect(isTransientNetworkError(new Error('NotConnectedError'))).toBe(true)
    expect(isTransientNetworkError(new Error('websocket was closed'))).toBe(true)
  })

  it('does NOT swallow ordinary bugs', () => {
    // A programming error must still be a 500. Reporting it as transient would
    // tell the user to retry something that will never work.
    expect(isTransientNetworkError(new TypeError('x is not a function'))).toBe(false)
    expect(isTransientNetworkError(new Error('Unique constraint failed'))).toBe(false)
    expect(isTransientNetworkError(Object.assign(new Error('bad'), { code: 'P2002' }))).toBe(false)
  })

  it('tolerates junk without throwing', () => {
    for (const junk of [null, undefined, 'string', 42, {}, []]) {
      expect(isTransientNetworkError(junk)).toBe(false)
    }
  })

  it('does not recurse forever on a self-referential cause', () => {
    const e: { cause?: unknown; message: string } = { message: 'loop' }
    e.cause = e
    expect(isTransientNetworkError(e)).toBe(false)
  })
})
