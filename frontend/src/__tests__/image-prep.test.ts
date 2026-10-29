/**
 * Fitting a poster under the server's limit on the organizer's device.
 *
 * The encoder is injected, because the real one needs a canvas. What is under test
 * is the policy: leave a file that fits alone, try the best quality first and only
 * give up quality when it is needed, keep transparency where the input had it,
 * fall back when WEBP cannot be produced, and say so in words when nothing fits.
 */
import { describe, expect, it, vi } from 'vitest'
import { MAX_IMAGE_BYTES } from '@/lib/api'
import { CannotShrinkError, prepareImage, type Encoder } from '@/lib/image-prep'

const big = (type: string, name: string, bytes = MAX_IMAGE_BYTES * 3) =>
  new File([new Uint8Array(bytes)], name, { type })
const blobOf = (bytes: number, type: string) => new Blob([new Uint8Array(bytes)], { type })

describe('prepareImage', () => {
  it('leaves a file that already fits exactly as it was', async () => {
    const encode = vi.fn<Encoder>()
    const small = new File([new Uint8Array(1000)], 'a.png', { type: 'image/png' })

    const out = await prepareImage(small, encode)

    expect(out.shrunk).toBe(false)
    expect(out.file).toBe(small)
    // Re-encoding something that fits can only make it worse, so it is never tried.
    expect(encode).not.toHaveBeenCalled()
  })

  it('tries the best quality first and stops at the first result that fits', async () => {
    const seen: Array<[number, number]> = []
    const encode: Encoder = async (_f, edge, type, quality) => {
      seen.push([edge, quality])
      // Fits only from the third quality step down.
      return blobOf(quality <= 0.68 ? 900_000 : MAX_IMAGE_BYTES * 2, type)
    }

    const out = await prepareImage(big('image/jpeg', 'photo.jpg'), encode)

    expect(out.shrunk).toBe(true)
    expect(out.file.size).toBe(900_000)
    expect(seen.map(([, q]) => q)).toEqual([0.88, 0.78, 0.68])
    // The edge stayed at the largest while quality alone was enough.
    expect(new Set(seen.map(([e]) => e))).toEqual(new Set([2400]))
  })

  it('shrinks the picture itself only when quality alone is not enough', async () => {
    const encode: Encoder = async (_f, edge, type) =>
      blobOf(edge <= 1800 ? 800_000 : MAX_IMAGE_BYTES * 2, type)

    const out = await prepareImage(big('image/jpeg', 'photo.jpg'), encode)

    expect(out.file.size).toBe(800_000)
  })

  it('keeps a JPEG a JPEG, with the matching name', async () => {
    const encode: Encoder = async (_f, _e, type) => blobOf(500_000, type)

    const out = await prepareImage(big('image/jpeg', 'summer.party.jpeg'), encode)

    expect(out.file.type).toBe('image/jpeg')
    expect(out.file.name).toBe('summer.party.jpg')
  })

  it('turns a PNG into WEBP, which keeps transparency', async () => {
    const encode: Encoder = async (_f, _e, type) => blobOf(500_000, type)

    const out = await prepareImage(big('image/png', 'cutout.png'), encode)

    expect(out.file.type).toBe('image/webp')
    expect(out.file.name).toBe('cutout.webp')
  })

  it('falls back to JPEG where the browser cannot encode WEBP', async () => {
    const types: string[] = []
    const encode: Encoder = async (_f, _e, type) => {
      types.push(type)
      return type === 'image/webp' ? null : blobOf(500_000, type)
    }

    const out = await prepareImage(big('image/png', 'cutout.png'), encode)

    expect(out.file.type).toBe('image/jpeg')
    // It did not waste every edge and quality on a type that cannot be made.
    expect(types.filter((t) => t === 'image/webp')).toHaveLength(1)
  })

  it('says so, in words, when nothing fits, rather than sending what will be refused', async () => {
    const encode: Encoder = async (_f, _e, type) => blobOf(MAX_IMAGE_BYTES * 2, type)

    await expect(prepareImage(big('image/jpeg', 'huge.jpg'), encode)).rejects.toThrow(CannotShrinkError)
    await expect(prepareImage(big('image/jpeg', 'huge.jpg'), encode)).rejects.toThrow(/could not shrink/i)
  })

  it('also fails clearly where the image cannot be decoded at all', async () => {
    const encode: Encoder = async () => null
    await expect(prepareImage(big('image/png', 'x.png'), encode)).rejects.toThrow(CannotShrinkError)
  })

  it('accepts a result a little under the limit and no closer, so it is never on the edge', async () => {
    const justUnder: Encoder = async (_f, _e, type) => blobOf(MAX_IMAGE_BYTES - 10, type)
    await expect(prepareImage(big('image/jpeg', 'edge.jpg'), justUnder)).rejects.toThrow(CannotShrinkError)
  })
})
