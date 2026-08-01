/**
 * Uploading a poster for an event you organize.
 *
 * Separate from MintPanel because they answer different questions — "what does
 * this event look like" and "how many tickets exist" are not the same job, and
 * one panel doing both would bury the artwork behind the issuance controls.
 *
 * The file is validated here AND on the server, deliberately. The client check
 * exists only so an obvious mistake fails instantly instead of after uploading
 * two megabytes; it is not the boundary. The server reads the magic bytes and
 * refuses anything that disagrees with its own declared type, because a check
 * running on the uploader's machine protects nobody.
 */
import { useRef, useState } from 'react'
import { ImagePlus, Loader2 } from 'lucide-react'
import { ApiError, IMAGE_ACCEPT, MAX_IMAGE_BYTES, uploadEventImage } from '@/lib/api'
import type { EventSummary } from '@/lib/api'
import { posterUrl } from '@/lib/poster'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

const ACCEPTED = new Set(IMAGE_ACCEPT.split(','))

/** Fails fast on the two mistakes worth catching before a round trip. */
function localProblem(file: File): string | null {
  if (!ACCEPTED.has(file.type)) return 'Choose a JPEG, PNG or WEBP image'
  if (file.size > MAX_IMAGE_BYTES) {
    return `That image is ${(file.size / 1024 / 1024).toFixed(1)}MB — the limit is 2MB`
  }
  return null
}

function Row({
  event,
  onChanged,
}: {
  event: EventSummary
  onChanged: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function pick(file: File | undefined) {
    if (!file) return
    const problem = localProblem(file)
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    setBusy(true)
    try {
      await uploadEventImage(event.slug, file)
      onChanged()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed')
    } finally {
      setBusy(false)
      // Clear the input, or picking the SAME file again fires no change event
      // and the retry silently does nothing.
      if (input.current) input.current.value = ''
    }
  }

  return (
    <li className="bg-muted/40 flex items-center gap-3 rounded-xl p-3">
      <div className="bg-muted size-14 shrink-0 overflow-hidden rounded-lg ring-1 ring-current/10">
        {event.imageUrl ? (
          // A 56px thumbnail has even less use for the full file than a card does.
          <img
            src={posterUrl(event.imageUrl, 120)}
            alt=""
            className="size-full object-cover"
          />
        ) : (
          <div className="text-muted-foreground grid size-full place-items-center">
            <ImagePlus className="size-4" aria-hidden />
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{event.title}</div>
        <div className="text-muted-foreground text-xs">
          {event.imageUrl ? 'Poster set' : 'No poster yet'}
        </div>
        {error && <p className="text-destructive mt-1 text-xs">{error}</p>}
      </div>

      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT}
        className="sr-only"
        aria-label={`Poster for ${event.title}`}
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {busy ? (
          <>
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Uploading
          </>
        ) : event.imageUrl ? (
          'Replace'
        ) : (
          'Add poster'
        )}
      </Button>
    </li>
  )
}

export function EventImagePanel({
  events,
  onChanged,
}: {
  /** Only events this user organizes — the API enforces the same rule. */
  events: EventSummary[]
  onChanged: () => void
}) {
  if (events.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Event posters</CardTitle>
        <CardDescription>
          The image people see when browsing. JPEG, PNG or WEBP, up to 2MB.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {events.map((e) => (
            <Row key={e.slug} event={e} onChanged={onChanged} />
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
