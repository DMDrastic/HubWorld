import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { FRAME, HOLE_PCT, SCREEN } from '@/lib/phone-frame'

/**
 * The phone's screen is drawn behind a PNG with a transparent hole. If the content
 * does not reach every edge of that hole, the page shows through as a strip, which
 * shipped once because the insets were guessed rather than measured. These read the
 * real image, so a different frame or a wrong number fails here.
 *
 * Decoded by hand (8-bit RGBA, non-interlaced, which is asserted) to avoid adding
 * an image library for one test.
 */
function decodeAlpha(file: string) {
  const buf = readFileSync(file)
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  expect([buf[24], buf[25], buf[28]], 'bit depth, colour type, interlace').toEqual([8, 6, 0])
  const chunks: Buffer[] = []
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at)
    if (buf.toString('ascii', at + 4, at + 8) === 'IDAT') chunks.push(buf.subarray(at + 8, at + 8 + len))
    at += 12 + len
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * 4
  const px = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0
      const b = y > 0 ? px[(y - 1) * stride + x] : 0
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0
      const p = a + b - c
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      const add = [0, a, b, (a + b) >> 1, paeth][filter]
      px[y * stride + x] = (src[x] + add) & 255
    }
  }
  return { width, height, alpha: (x: number, y: number) => px[y * stride + x * 4 + 3] }
}

const frame = decodeAlpha(resolve(process.cwd(), 'src/assets/iphone-17-pro-cosmic-orange-portrait.png'))

describe('phone frame geometry', () => {
  it('is the image the numbers were measured from', () => {
    expect([frame.width, frame.height]).toEqual([FRAME.width, FRAME.height])
  })

  it('the hole starts where HOLE_PCT says, on every side', () => {
    const { width: W, height: H, alpha } = frame
    const mid = [Math.round(W / 4), Math.round(H / 2)] // clear of the Dynamic Island and the side buttons
    const top = Array.from({ length: H }, (_, y) => y).find((y) => alpha(mid[0], y) < 16)!
    const bottom = Array.from({ length: H }, (_, i) => H - 1 - i).find((y) => alpha(mid[0], y) < 16)!
    const left = Array.from({ length: W }, (_, x) => x).filter((x) => x > 8).find((x) => alpha(x, mid[1]) < 16)!
    const right = Array.from({ length: W }, (_, i) => W - 9 - i).find((x) => alpha(x, mid[1]) < 16)!
    const near = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThan(0.1)
    near((top / H) * 100, HOLE_PCT.top)
    near(((H - 1 - bottom) / H) * 100, HOLE_PCT.bottom)
    near((left / W) * 100, HOLE_PCT.left)
    near(((W - 1 - right) / W) * 100, HOLE_PCT.right)
  })

  it('the content reaches past the hole on every side, so no strip of page can show', () => {
    expect(SCREEN.left).toBeLessThan(HOLE_PCT.left)
    expect(SCREEN.right).toBeLessThan(HOLE_PCT.right)
    expect(SCREEN.top).toBeLessThan(HOLE_PCT.top)
    expect(SCREEN.bottom).toBeLessThan(HOLE_PCT.bottom)
  })

  it('but only a hair: it must stay under the opaque rail, not poke out of the phone', () => {
    // The rail is ~15px (1.7% of the width) thick; an overlap of a few pixels is hidden by it.
    for (const side of ['left', 'right'] as const) expect(HOLE_PCT[side] - SCREEN[side]).toBeLessThan(0.7)
    for (const side of ['top', 'bottom'] as const) expect(HOLE_PCT[side] - SCREEN[side]).toBeLessThan(0.3)
  })

  it('every transparent pixel of the screen is covered by the content box', () => {
    const { width: W, height: H, alpha } = frame
    const L = (SCREEN.left / 100) * W, R = W - (SCREEN.right / 100) * W
    const T = (SCREEN.top / 100) * H, B = H - (SCREEN.bottom / 100) * H
    // The hole's flat middle, away from the rounded corners (the box's own radius covers those).
    let uncovered = 0
    for (let y = 150; y < H - 150; y += 7)
      for (let x = 30; x < W - 30; x += 7)
        if (alpha(x, y) < 16 && (x < L || x > R || y < T || y > B)) uncovered++
    expect(uncovered).toBe(0)
  })
})
