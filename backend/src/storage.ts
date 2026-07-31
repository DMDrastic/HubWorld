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
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY!}`,
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
    // A Buffer is what undici's fetch wants for a binary body, and unlike a
    // bare Uint8Array it needs no cast to a DOM type this project does not load.
    body: Buffer.from(bytes),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    // The bucket not existing is the overwhelmingly likely first failure, and
    // Supabase's message for it is not obvious, so name it.
    if (res.status === 404) {
      throw new StorageError(
        `Bucket "${bucket}" not found — create it in Supabase and make it public`,
      )
    }
    throw new StorageError(`Upload failed: ${res.status} ${text.slice(0, 200)}`)
  }

  // Public buckets serve from a stable, unauthenticated path. Anything stored
  // through here is deliberately world-readable: it is a poster on a public
  // event page, and signing every render would be cost for no privacy.
  return `${base}/storage/v1/object/public/${bucket}/${path}`
}
