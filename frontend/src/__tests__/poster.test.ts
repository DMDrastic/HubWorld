/**
 * Poster sizing.
 *
 * Measured against a live bucket, which is why this exists at all: the plain
 * object endpoint serves `cache-control: no-cache` and ignores whatever the
 * upload asked for, while the transformation endpoint serves
 * `public, max-age=31536000, immutable`. Caching is therefore a property of HOW
 * WE LINK to an image, not of how we stored it — so the rewrite is load-bearing
 * rather than an optimisation.
 *
 * It also took the first real upload from 1.77MB to about 160kB.
 */
import { describe, expect, it } from 'vitest'
import { posterSrcSet, posterUrl } from '@/lib/poster'

const OBJECT =
  'https://abc.supabase.co/storage/v1/object/public/event-images/events/e1/deadbeef.jpg'

describe('posterUrl', () => {
  it('rewrites a Supabase object URL to the transformation endpoint', () => {
    const out = posterUrl(OBJECT, 440)!
    expect(out).toContain('/storage/v1/render/image/public/')
    expect(out).not.toContain('/storage/v1/object/public/')
    expect(out).toContain('width=440')
  })

  it('keeps the object path intact so it still points at the same file', () => {
    expect(posterUrl(OBJECT, 440)).toContain('event-images/events/e1/deadbeef.jpg')
  })

  // The transform is an optimisation, never a requirement. An externally hosted
  // poster must still render rather than being mangled into a broken URL.
  it('passes a non-Supabase URL through untouched', () => {
    const external = 'https://images.example.com/poster.jpg'
    expect(posterUrl(external, 440)).toBe(external)
  })

  it('returns undefined for no image, so no <img> is emitted', () => {
    expect(posterUrl(null, 440)).toBeUndefined()
    expect(posterUrl(undefined, 440)).toBeUndefined()
    expect(posterUrl('', 440)).toBeUndefined()
  })

  it('asks for different sizes in different places', () => {
    expect(posterUrl(OBJECT, 120)).toContain('width=120')
    expect(posterUrl(OBJECT, 560)).toContain('width=560')
  })
})

describe('posterSrcSet', () => {
  it('offers 1x and 2x, so retina is sharp and standard is not wasteful', () => {
    const set = posterSrcSet(OBJECT, 440)!
    expect(set).toContain('width=440')
    expect(set).toContain('width=880')
    expect(set).toMatch(/1x/)
    expect(set).toMatch(/2x/)
  })

  // A srcSet pointing at an untransformable URL would be two identical entries,
  // which is worse than none: it implies a choice the browser does not have.
  it('is absent for a non-Supabase URL', () => {
    expect(posterSrcSet('https://images.example.com/poster.jpg', 440)).toBeUndefined()
  })

  it('is absent when there is no image', () => {
    expect(posterSrcSet(null, 440)).toBeUndefined()
  })
})
