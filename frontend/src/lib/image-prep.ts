/**
 * Fitting a poster to what the server accepts, on the organizer's own device.
 *
 * The server refuses anything over 2MB, which a real phone photo or a design
 * export routinely is. Raising that limit would make every upload slower on a bad
 * connection and fill storage with pixels nobody sees: posters are shown at 560 to
 * 840px wide. So the file is shrunk HERE, before it is sent, and the server's
 * limit stays what it was, as the last line of defence rather than the thing an
 * organizer runs into.
 *
 * A file already under the limit is never touched. Re-encoding something that
 * fits can only make it worse.
 *
 * Output keeps what the input needs. A JPEG stays a JPEG. A PNG or WEBP becomes
 * WEBP, which keeps transparency, and falls back to a JPEG on a white ground only
 * where the browser cannot encode WEBP. Smaller edges and lower qualities are
 * tried in order and the first result under the target wins, so the best-looking
 * file that fits is the one sent.
 *
 * `encode` is injectable because the real one needs a canvas, which the unit tests
 * do not have. Failing to shrink is an error with words, never a silent upload of
 * something the server will refuse.
 */
import { MAX_IMAGE_BYTES } from '@/lib/api'

/** Longest edges tried, in order. 2400px is nearly three times what is ever shown. */
const EDGES = [2400, 1800, 1400] as const
const QUALITIES = [0.88, 0.78, 0.68, 0.58] as const
/** A little under the real limit, so a file is not accepted on the knife-edge. */
const TARGET_BYTES = Math.floor(MAX_IMAGE_BYTES * 0.9)

export type Encoder = (
  file: File,
  longestEdge: number,
  type: 'image/jpeg' | 'image/webp',
  quality: number,
) => Promise<Blob | null>

export type Prepared = {
  file: File
  /** Whether the file was re-encoded, so the page can say so. */
  shrunk: boolean
}

export class CannotShrinkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CannotShrinkError'
  }
}

/** The real encoder: decode, scale onto a canvas, re-encode. */
export const canvasEncoder: Encoder = async (file, longestEdge, type, quality) => {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return null
  }
  const scale = Math.min(1, longestEdge / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close?.()
    return null
  }
  // JPEG has no alpha, so a transparent PNG would turn black; give it a white ground.
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close?.()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
  // A browser that cannot encode WEBP hands back a PNG, which is larger and not
  // what was asked for. Treat that as "no result" so the caller can fall back.
  return blob && blob.type === type ? blob : null
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`

/** Same name with the extension the new type needs. */
function renamed(name: string, type: string): string {
  const stem = name.replace(/\.[^./\\]+$/, '') || 'poster'
  return `${stem}.${type === 'image/jpeg' ? 'jpg' : 'webp'}`
}

export async function prepareImage(file: File, encode: Encoder = canvasEncoder): Promise<Prepared> {
  if (file.size <= MAX_IMAGE_BYTES) return { file, shrunk: false }

  // Where the output goes: JPEG in, JPEG out; anything else to WEBP, then JPEG as
  // the fallback when WEBP cannot be encoded.
  const preferred: Array<'image/jpeg' | 'image/webp'> =
    file.type === 'image/jpeg' ? ['image/jpeg'] : ['image/webp', 'image/jpeg']

  for (const type of preferred) {
    typeAttempt: for (const edge of EDGES) {
      for (const quality of QUALITIES) {
        const blob = await encode(file, edge, type, quality)
        // `null` means this type cannot be produced at all here, so neither a
        // lower quality nor a smaller edge will change that: leave BOTH loops and
        // move on to the next type.
        if (!blob) break typeAttempt
        if (blob.size <= TARGET_BYTES) {
          return {
            file: new File([blob], renamed(file.name, type), { type, lastModified: Date.now() }),
            shrunk: true,
          }
        }
      }
    }
  }

  throw new CannotShrinkError(
    `That image is ${mb(file.size)} and this browser could not shrink it under ${mb(MAX_IMAGE_BYTES)}. Try a smaller export.`,
  )
}
