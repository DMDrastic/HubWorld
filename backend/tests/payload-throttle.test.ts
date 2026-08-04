/**
 * How long a signature can go unnoticed.
 *
 * `resolvePayload` serves a cached payload state and only re-asks Xaman once the
 * cache is older than `REFRESH_THROTTLE_MS`. That window is the entire distance
 * between someone signing on their phone and the page reacting — whenever the
 * webhook callback does not arrive, which includes every deployment where the
 * URL was never registered in the Xaman console.
 *
 * It was 10 seconds. Observed on production: sign-in took about five seconds to
 * be noticed, the average of that window, having been roughly two before the
 * webhook was switched on.
 *
 * The reason 10s was wrong is a shape mismatch. The saving is per PAYLOAD, not
 * per viewer — N people watching one auction collapse to one request per window
 * whatever the window is. Sign-in is one person watching their own payload, so a
 * long window saves nothing and costs its full length.
 *
 * These tests pin the property rather than the number: the window must stay
 * short enough that a client polling every 2s is not made to wait, and must stay
 * non-zero so a crowded auction cannot hammer Xaman.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/** The frontend's poll interval — SignIn, GiftPanel and the rest all use 2s. */
const CLIENT_POLL_MS = 2_000

function throttleMs(): number {
  const src = readFileSync(
    path.resolve(import.meta.dirname, '../src/payload-store.ts'),
    'utf8',
  )
  const m = src.match(/const REFRESH_THROTTLE_MS = ([\d_]+)/)
  if (!m) throw new Error('REFRESH_THROTTLE_MS not found — has it been renamed?')
  return Number(m[1]!.replace(/_/g, ''))
}

describe('the payload refresh window', () => {
  it('is shorter than the client poll, so a lone poller is never made to wait', () => {
    // The property that actually matters. At or above the poll interval, some
    // polls are served a stale "pending" and the person watching waits for no
    // reason — which is exactly what 10s did.
    expect(throttleMs()).toBeLessThan(CLIENT_POLL_MS)
  })

  it('is not zero, or a crowded auction hammers Xaman', () => {
    // The 429 during the first live gift is what this whole mechanism exists to
    // prevent. Removing the window entirely would bring it back.
    expect(throttleMs()).toBeGreaterThan(0)
  })

  it('keeps the worst-case wait under a second and a half', () => {
    // Stated as a human-facing budget rather than an implementation detail:
    // this is the longest a signature can sit unnoticed when no callback comes.
    expect(throttleMs()).toBeLessThanOrEqual(1_500)
  })
})
