/**
 * Which colour a poster is "about".
 *
 * The properties that matter are the ones a plain average gets wrong, so each test
 * is built around a case where an average would give a different, worse answer.
 * `dominantTint` takes raw RGBA bytes, so none of this needs a canvas.
 */
import { describe, expect, it } from 'vitest'
import { dominantTint } from '@/lib/poster-tint'

/** `count` pixels of one colour, as RGBA bytes. */
function pixels(colour: [number, number, number, number?], count: number): number[] {
  const [r, g, b, a = 255] = colour
  return Array.from({ length: count }, () => [r, g, b, a]).flat()
}
const image = (...parts: number[][]) => new Uint8ClampedArray(parts.flat())

describe('dominantTint', () => {
  it('finds the colour in a poster that is mostly black with one orange figure', () => {
    // An average of these is a dark brown that is neither black nor orange.
    const tint = dominantTint(image(pixels([0, 0, 0], 900), pixels([255, 120, 0], 100)))
    expect(tint).not.toBeNull()
    const [r, g, b] = tint!
    expect(r).toBeGreaterThan(200)
    expect(g).toBeGreaterThan(80)
    expect(g).toBeLessThan(160)
    expect(b).toBeLessThan(40)
  })

  it('lets a vivid minority outweigh a dull majority', () => {
    const tint = dominantTint(image(pixels([120, 118, 116], 800), pixels([20, 60, 230], 200)))
    expect(tint).not.toBeNull()
    expect(tint![2]).toBeGreaterThan(tint![0])
  })

  it('returns nothing for a poster with no colour, rather than inventing one', () => {
    expect(dominantTint(image(pixels([128, 128, 128], 1000)))).toBeNull()
    expect(dominantTint(image(pixels([0, 0, 0], 500), pixels([255, 255, 255], 500)))).toBeNull()
  })

  it('does not let a white margin or a black border decide the colour', () => {
    const tint = dominantTint(
      image(pixels([255, 255, 255], 400), pixels([0, 0, 0], 400), pixels([30, 160, 90], 200)),
    )
    expect(tint).not.toBeNull()
    expect(tint![1]).toBeGreaterThan(tint![0])
    expect(tint![1]).toBeGreaterThan(tint![2])
  })

  it('ignores transparent pixels, whatever colour is stored in them', () => {
    // A cut-out PNG often stores pure red under alpha 0.
    expect(dominantTint(image(pixels([255, 0, 0, 0], 1000)))).toBeNull()
  })

  it('returns nothing for an empty image', () => {
    expect(dominantTint(new Uint8ClampedArray(0))).toBeNull()
  })
})
