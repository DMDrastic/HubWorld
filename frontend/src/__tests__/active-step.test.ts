/**
 * Which phone screen is showing, as a pure rule.
 *
 * The bug was the phone's screen flipping back and forth on iPhones, where a
 * finger resting on a boundary and Safari's collapsing toolbar both move "the
 * middle of the screen" without the page moving. Each flip remounts the screen
 * with a fade, which reads as jitter. So what is pinned is mostly what must NOT
 * change the answer.
 */
import { describe, expect, it } from 'vitest'
import { SWITCH_MARGIN_PX, chooseActiveStep } from '@/lib/active-step'

// Five blocks 400px tall, stacked: centres at 200, 600, 1000, 1400, 1800.
const centers = [200, 600, 1000, 1400, 1800]

describe('chooseActiveStep', () => {
  it('picks the block nearest the middle of the screen', () => {
    expect(chooseActiveStep(centers, 190, -1)).toBe(0)
    expect(chooseActiveStep(centers, 1010, -1)).toBe(2)
    expect(chooseActiveStep(centers, 1790, -1)).toBe(4)
  })

  it('follows a real scroll all the way down and all the way back up, one step at a time', () => {
    let active = 0
    const seen: number[] = [active]
    // The middle of the screen sweeps down the page: equivalently, the blocks move up.
    for (let mid = 200; mid <= 1800; mid += 10) {
      active = chooseActiveStep(centers, mid, active)
      if (seen[seen.length - 1] !== active) seen.push(active)
    }
    for (let mid = 1800; mid >= 200; mid -= 10) {
      active = chooseActiveStep(centers, mid, active)
      if (seen[seen.length - 1] !== active) seen.push(active)
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 3, 2, 1, 0])
  })

  it('does NOT flip-flop when the middle jitters around a boundary', () => {
    // The exact midpoint between blocks 1 and 2 is 800. Wobble across it.
    let active = chooseActiveStep(centers, 790, -1)
    expect(active).toBe(1)
    let changes = 0
    for (let k = 0; k < 40; k++) {
      const next = chooseActiveStep(centers, 800 + (k % 2 ? 12 : -12), active)
      if (next !== active) changes++
      active = next
    }
    expect(changes).toBe(0)
  })

  it('does not flip when the toolbar collapses and the middle moves by tens of pixels', () => {
    let active = chooseActiveStep(centers, 790, -1)
    // Safari's toolbar changes the viewport by ~50-90px, so the middle moves by about
    // half that. Here it swings 25px past the boundary (the exact midpoint is 800).
    for (const mid of [790, 825, 790, 825, 790]) {
      active = chooseActiveStep(centers, mid, active)
    }
    expect(active).toBe(1)
  })

  it('still switches once a rival is CLEARLY nearer (positive control for the above)', () => {
    const active = chooseActiveStep(centers, 790, -1)
    expect(chooseActiveStep(centers, 800 + SWITCH_MARGIN_PX * 2, active)).toBe(2)
  })

  it('switches immediately when the current step is no longer on the page', () => {
    // A stale `current` (out of range, or the first call) must not be held onto.
    expect(chooseActiveStep(centers, 1000, 9)).toBe(2)
    expect(chooseActiveStep(centers, 1000, -1)).toBe(2)
  })

  it('keeps the current step when there is nothing to measure yet', () => {
    expect(chooseActiveStep([], 500, 3)).toBe(3)
    expect(chooseActiveStep([Infinity, Infinity], 500, 1)).toBe(1)
  })
})
