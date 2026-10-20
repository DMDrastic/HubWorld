/**
 * Serving an event poster at a sensible size.
 *
 * Organizers upload whatever their camera or design tool produced — the first
 * real upload was 1.77MB — and a card 400px wide has no use for that. This
 * rewrites the stored URL to Supabase's image transformation endpoint, which
 * resizes on the fly and caches the result.
 *
 * ## Two problems, one fix
 *
 * **Size.** 1.77MB becomes ~160kB at 560px, ~223kB at 800px. That is the
 * difference between a page that paints and one that crawls on mobile.
 *
 * **Caching.** Measured against a live bucket: the plain object endpoint serves
 * `cache-control: no-cache` and IGNORES whatever the upload set — a
 * `Cache-Control` header on upload, and a `cacheControl` multipart field, were
 * both dropped. The transformation endpoint serves
 * `public, max-age=31536000, immutable`. So caching is not something we can ask
 * for at upload time; it comes from serving through `/render/image/`.
 *
 * `no-cache` is not as costly as it sounds — objects carry an ETag, so a browser
 * revalidates and gets a 304 rather than re-downloading. But it is still a round
 * trip per image per page load, and the first load is the full file either way.
 *
 * ## Why the DATABASE keeps the plain URL
 *
 * `Event.imageUrl` stays the canonical object URL, and the transform is applied
 * at render time. That way one stored value serves every context at its own
 * size, changing sizes needs no migration, and the record still points at the
 * actual object if we ever leave Supabase.
 */

/** What a Supabase public object URL contains, and what it becomes. */
const OBJECT_PATH = '/storage/v1/object/public/'
const RENDER_PATH = '/storage/v1/render/image/public/'

/**
 * Visually lossless enough for a poster at these sizes, and roughly an order of
 * magnitude smaller than the original. Not worth exposing as a knob.
 */
const QUALITY = 70

/**
 * A poster URL sized for where it is being shown.
 *
 * Returns the input unchanged when it is not a Supabase object URL, so an
 * externally hosted image still works — the transform is an optimisation, never
 * a requirement.
 */
export function posterUrl(url: string | null | undefined, width: number): string | undefined {
  if (!url) return undefined
  if (!url.includes(OBJECT_PATH)) return url
  return `${url.replace(OBJECT_PATH, RENDER_PATH)}?width=${width}&quality=${QUALITY}`
}

/**
 * The same image at 1x and 2x, for the retina displays most laptops have.
 *
 * Without this a card is either soft on a retina screen or wastefully large on a
 * standard one. `srcSet` lets the browser decide, which is the only party that
 * knows the answer.
 */
export function posterSrcSet(url: string | null | undefined, width: number): string | undefined {
  if (!url || !url.includes(OBJECT_PATH)) return undefined
  return `${posterUrl(url, width)} 1x, ${posterUrl(url, width * 2)} 2x`
}

/**
 * A stable hue from the slug, spread by the golden angle.
 *
 * djb2 alone was not enough. Taking the hash modulo 360 directly clustered the
 * real data badly: five of six seeded slugs landed inside a 44 degree band of
 * green, so a wall of fallbacks looked like one event repeated. Similar strings
 * — same length, lowercase, hyphenated — produce nearby hashes, and the modulo
 * preserves that nearness.
 *
 * Multiplying by the golden angle before wrapping is the standard fix: it maps
 * adjacent inputs to maximally distant hues, so slugs that differ by a character
 * end up on opposite sides of the wheel. Still deterministic, so an event keeps
 * its colour across reloads and devices.
 *
 * Shared by the poster wall and the ticket a holder keeps, so the same event is
 * the same colour wherever it appears.
 */
export function hueFrom(slug: string): number {
  let h = 5381
  for (let i = 0; i < slug.length; i++) h = ((h << 5) + h + slug.charCodeAt(i)) | 0
  return (Math.abs(h) * 137.508) % 360
}
