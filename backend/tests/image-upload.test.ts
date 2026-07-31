/**
 * Upload validation.
 *
 * The property under test: **a declared content type is not evidence.** Anyone
 * who can reach the endpoint chooses the `Content-Type` header, so accepting it
 * on trust would let an arbitrary file into the bucket under an image's name —
 * and anything served from our storage origin is a problem, not just a wrong
 * picture. The bytes decide, and the header only gets to be wrong.
 */
import { describe, expect, it } from 'vitest'
import { MAX_IMAGE_BYTES, checkImage, imageObjectPath } from '../src/image-upload.js'

const jpeg = (extra = 16) => new Uint8Array([0xff, 0xd8, 0xff, ...Array(extra).fill(0)])
const png = (extra = 16) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(extra).fill(0)])
const webp = () =>
  new Uint8Array([
    0x52, 0x49, 0x46, 0x46, // "RIFF"
    0x00, 0x00, 0x00, 0x00, // length — deliberately not part of the signature
    0x57, 0x45, 0x42, 0x50, // "WEBP"
    ...Array(8).fill(0),
  ])

describe('checkImage — accepts real images', () => {
  it.each([
    ['jpeg', jpeg(), 'image/jpeg', 'jpg'],
    ['png', png(), 'image/png', 'png'],
    ['webp', webp(), 'image/webp', 'webp'],
  ])('accepts %s and reports what it actually is', (_n, bytes, mime, ext) => {
    expect(checkImage(bytes)).toEqual({ ok: true, mime, ext })
  })

  it('reads the type from the BYTES, not the header', () => {
    // Header says png, bytes are jpeg. Refused rather than silently believed —
    // an honest client has no reason to disagree with itself.
    expect(checkImage(jpeg(), 'image/png')).toEqual({
      ok: false,
      reason: 'The file does not match its declared content type',
    })
  })

  it('tolerates charset parameters on the declared type', () => {
    expect(checkImage(jpeg(), 'image/jpeg; charset=binary')).toMatchObject({ ok: true })
  })
})

describe('checkImage — rejects what is not an image', () => {
  it('rejects a file merely CLAIMING to be an image — the attack this exists for', () => {
    const html = new Uint8Array([...Buffer.from('<html><script>alert(1)</script>')])
    expect(checkImage(html, 'image/png')).toEqual({ ok: false, reason: 'Not a JPEG, PNG or WEBP image' })
  })

  it('rejects an empty upload', () => {
    expect(checkImage(new Uint8Array())).toEqual({ ok: false, reason: 'The uploaded file is empty' })
  })

  it('rejects anything over the size cap', () => {
    const huge = new Uint8Array(MAX_IMAGE_BYTES + 1)
    huge.set([0xff, 0xd8, 0xff])
    expect(checkImage(huge)).toMatchObject({ ok: false })
    expect(checkImage(huge).ok).toBe(false)
  })

  it('accepts a file exactly at the cap, so the limit is not off by one', () => {
    const atLimit = new Uint8Array(MAX_IMAGE_BYTES)
    atLimit.set([0xff, 0xd8, 0xff])
    expect(checkImage(atLimit)).toMatchObject({ ok: true })
  })

  it('rejects a truncated signature rather than reading past the end', () => {
    expect(checkImage(new Uint8Array([0xff, 0xd8]))).toMatchObject({ ok: false })
  })

  it('rejects RIFF that is not WEBP', () => {
    // A .wav is also RIFF-framed, so matching only the first four bytes would
    // let audio into an image bucket.
    const wav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0, 0, 0, 0,
    ])
    expect(checkImage(wav)).toMatchObject({ ok: false })
  })
})

describe('imageObjectPath', () => {
  it('keys on event id and a random suffix, never a user filename', () => {
    expect(imageObjectPath('evt-1', 'jpg', 'abc123')).toBe('events/evt-1/abc123.jpg')
  })

  // A stable path would be served stale by a CDN after a re-upload, and a
  // user-supplied name would be a traversal and collision risk.
  it('gives a different path each upload, so replacing an image takes effect', () => {
    expect(imageObjectPath('evt-1', 'jpg', 'aaa')).not.toBe(imageObjectPath('evt-1', 'jpg', 'bbb'))
  })
})
