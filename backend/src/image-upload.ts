/**
 * Validating an uploaded event poster.
 *
 * The rule this module exists to enforce: **a declared content type is not
 * evidence.** `Content-Type` is chosen by whoever is uploading, so trusting it
 * means anyone who can reach the endpoint can put an arbitrary file into our
 * bucket under an image's name — an HTML file served from our storage origin, a
 * script, a zip. So the bytes are checked against known image signatures and the
 * declared type is only accepted when the file actually agrees with it.
 *
 * This does not make an image *safe* — a real JPEG can still carry a malicious
 * payload for a vulnerable decoder — but it does mean the bucket contains only
 * what it claims to contain, which is the property the rest of the app relies on
 * when it renders these URLs in an <img>.
 */

/** What we accept, and the leading bytes that prove it. */
const SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // WEBP is RIFF-framed: "RIFF" .... "WEBP", so bytes 8-11 carry the real
  // identity and 4-7 are a length we must skip rather than match.
  { mime: 'image/webp', ext: 'webp', magic: [0x52, 0x49, 0x46, 0x46], offset8: [0x57, 0x45, 0x42, 0x50] },
] as const

/** 2 MB. An event poster has no business being larger, and a request body that
 *  size is already generous on a small instance. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024

export type ImageCheck =
  | { ok: true; mime: string; ext: string }
  | { ok: false; reason: string }

function startsWith(bytes: Uint8Array, magic: readonly number[], at = 0): boolean {
  if (bytes.length < at + magic.length) return false
  return magic.every((b, i) => bytes[at + i] === b)
}

/**
 * Decide whether these bytes are an image we accept, and what they actually are.
 *
 * `declared` is taken from the request only to catch the case where a caller
 * says one thing and sends another — the returned `mime` always comes from the
 * BYTES, never from the header, so a lie cannot survive into storage metadata.
 */
export function checkImage(bytes: Uint8Array, declared?: string | null): ImageCheck {
  if (bytes.length === 0) return { ok: false, reason: 'The uploaded file is empty' }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      reason: `Image is larger than ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB`,
    }
  }

  const match = SIGNATURES.find(
    (s) => startsWith(bytes, s.magic) && (!('offset8' in s) || startsWith(bytes, s.offset8, 8)),
  )
  if (!match) {
    return { ok: false, reason: 'Not a JPEG, PNG or WEBP image' }
  }

  // A mismatch is not fatal — the bytes win — but it is worth refusing, because
  // an honest client has no reason to disagree with itself and a dishonest one
  // is telling us something.
  if (declared && declared.split(';')[0]!.trim().toLowerCase() !== match.mime) {
    return { ok: false, reason: 'The file does not match its declared content type' }
  }

  return { ok: true, mime: match.mime, ext: match.ext }
}

/**
 * Where an event's poster lives in the bucket.
 *
 * Keyed by event id and a random suffix rather than by filename. Two reasons:
 * a user-supplied filename is a path-traversal and collision risk, and a stable
 * path would be served stale by CDNs after a re-upload. The random suffix makes
 * every upload a new URL, so replacing an image takes effect immediately.
 */
export function imageObjectPath(eventId: string, ext: string, rand: string): string {
  return `events/${eventId}/${rand}.${ext}`
}
