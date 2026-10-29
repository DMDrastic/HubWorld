/**
 * The one colour a poster is "about", for the wash behind the create page.
 *
 * An average of all pixels is the wrong answer: a poster that is mostly black
 * with one orange figure averages to a muddy brown that is neither. So each pixel
 * votes in proportion to how saturated it is (squared, so a vivid minority
 * outweighs a dull majority) and a little by how bright it is, and near-black or
 * near-white pixels, which have no hue to speak of, barely count.
 *
 * A poster with no colour in it (black and white, or flat grey) has nothing to
 * follow, so the answer is `null` and the page stays on its neutral ground. A
 * wash invented from nothing would be decoration, which this system does not do.
 *
 * `dominantTint` is pure so it can be tested; `tintFromFile` is the thin part that
 * needs a browser, and it fails closed: any problem reading the image means no
 * wash, never an error on a form someone is filling in.
 */
export type Rgb = readonly [number, number, number]

/** Below this much total colour the image counts as colourless. */
const MIN_COLOUR_WEIGHT = 4

export function dominantTint(data: Uint8ClampedArray): Rgb | null {
  let r = 0
  let g = 0
  let b = 0
  let total = 0

  for (let i = 0; i + 3 < data.length; i += 4) {
    const alpha = data[i + 3]!
    if (alpha < 128) continue
    const pr = data[i]!
    const pg = data[i + 1]!
    const pb = data[i + 2]!
    const max = Math.max(pr, pg, pb)
    const min = Math.min(pr, pg, pb)
    if (max === 0) continue
    const saturation = (max - min) / max
    const value = max / 255
    // Squared saturation, softened by brightness, with the extremes damped so a
    // black border or a white margin never decides the colour.
    const weight = saturation * saturation * (0.25 + value) * (value > 0.96 ? 0.2 : 1) * (value < 0.1 ? 0.2 : 1)
    r += pr * weight
    g += pg * weight
    b += pb * weight
    total += weight
  }

  if (total < MIN_COLOUR_WEIGHT) return null
  return [Math.round(r / total), Math.round(g / total), Math.round(b / total)]
}

/** The tint of an image file, or null when it cannot be read or has no colour. */
export async function tintFromFile(file: File): Promise<Rgb | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null
  try {
    const bitmap = await createImageBitmap(file)
    // 32 by 32 is plenty to find a colour and costs nothing; the canvas is never
    // attached to the page.
    const size = 32
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, size, size)
    bitmap.close?.()
    return dominantTint(ctx.getImageData(0, 0, size, size).data)
  } catch {
    return null
  }
}
