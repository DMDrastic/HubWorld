/**
 * Object storage for event posters, on Supabase.
 *
 * Plain `fetch` against the Storage REST API rather than `@supabase/supabase-js`,
 * for the same reason `xaman.ts` does: two endpoints do not justify a dependency,
 * and the request shape is then visible here instead of behind an SDK.
 *
 * ## Why the bytes come through us
 *
 * The alternative is a signed upload URL handed to the browser, which avoids
 * proxying the file. It is the better shape at volume — but it moves validation
 * to a place we do not control, and the whole point of `checkImage` is that the
 * bytes are inspected before anything reaches the bucket. A signed URL would let
 * a client upload whatever it liked to a path we had already blessed.
 *
 * At a 2MB cap and one poster per event, proxying costs nothing worth having.
 *
 * ## The service key
 *
 * `SUPABASE_SERVICE_KEY` bypasses row-level security, so it is strictly
 * backend-only — the same rule as the Xaman API secret. It is never returned in
 * a response and never reaches the bundle.
 */
import { env, storageMode } from './env.js'

/** Thrown when storage is reachable but refuses the write. */
export class StorageError extends Error {}

/**
 * Upload bytes and return the public URL.
 *
 * `upsert` is off: paths carry a random suffix so a collision would mean we
 * generated the same one twice, which should fail loudly rather than silently
 * overwrite somebody else's poster.
 */
export async function uploadPublicObject(
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  if (storageMode === 'disabled') {
    throw new StorageError('Object storage is not configured')
  }

  const base = env.SUPABASE_URL!.replace(/\/+$/, '')
  const bucket = env.SUPABASE_BUCKET
  const res = await fetch(`${base}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      // BOTH headers, deliberately. Supabase has two key formats in circulation
      // and they authenticate differently:
      //
      //   - legacy `service_role` keys are JWTs and go in `Authorization: Bearer`
      //   - current `sb_secret_…` keys are NOT JWTs, and Bearer alone is rejected
      //     with "Invalid Compact JWS" — Storage tries to parse them as a token
      //     and fails. They authenticate via `apikey`.
      //
      // Sending both means either format works, so rotating a key or inheriting
      // an older project does not silently break uploads. Verified against a
      // real bucket: Bearer alone fails, `apikey` succeeds.
      apikey: env.SUPABASE_SERVICE_KEY!,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY!}`,
      'Content-Type': contentType,
      // Supabase IGNORES this on the object endpoint — measured against a live
      // bucket, which serves `cache-control: no-cache` regardless of what the
      // upload asks for, whether sent as a header or as a `cacheControl`
      // multipart field. It is sent anyway in case that changes, but caching is
      // not obtained here: it comes from linking through the transformation
      // endpoint, which serves `public, max-age=31536000, immutable`. See
      // frontend/src/lib/poster.ts, which is where the caching actually happens.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
    // A Buffer is what undici's fetch wants for a binary body, and unlike a
    // bare Uint8Array it needs no cast to a DOM type this project does not load.
    body: Buffer.from(bytes),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')

    // Storage does NOT put its real status in the HTTP status. A missing bucket
    // comes back as HTTP 400 carrying {"statusCode":"404","code":"NoSuchBucket"},
    // so branching on res.status alone would miss every case worth naming.
    // Observed against a live project; parsing the body is the only way to tell
    // these apart.
    const body = (() => {
      try {
        return JSON.parse(text) as { code?: string; message?: string }
      } catch {
        return null
      }
    })()

    if (body?.code === 'NoSuchBucket') {
      throw new StorageError(
        `Bucket "${bucket}" does not exist in this Supabase project — create it and make it public`,
      )
    }
    // "Invalid Compact JWS" means the key is not a JWT and was sent somewhere
    // that expects one. With both headers set that should not happen, so say
    // what it actually implies rather than echoing a cryptography error.
    if (/Invalid Compact JWS/i.test(text)) {
      throw new StorageError('Supabase rejected the storage key — check SUPABASE_SERVICE_KEY')
    }

    throw new StorageError(
      `Upload failed: ${body?.message ?? text.slice(0, 200) ?? res.status}`,
    )
  }

  // Public buckets serve from a stable, unauthenticated path. Anything stored
  // through here is deliberately world-readable: it is a poster on a public
  // event page, and signing every render would be cost for no privacy.
  return `${base}/storage/v1/object/public/${bucket}/${path}`
}
