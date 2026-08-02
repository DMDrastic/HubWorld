/**
 * How a signature is requested — a QR to scan, a deep link to tap, or both.
 *
 * The plate under the QR is white in BOTH themes, deliberately. A scanner needs
 * dark-on-light contrast and a clear margin (the "quiet zone"), and a code flush
 * against a dark card can simply fail to read — a failure that looks like Xaman
 * being broken rather than like a styling bug. It is one of the few places in the
 * app that ignores the palette, because the constraint belongs to the scanner
 * rather than to the design.
 *
 * ---------------------------------------------------------------------------
 * THE MOBILE PROBLEM, WHICH THIS EXISTS TO SOLVE
 *
 * A QR is an instruction to a SECOND device. On a desktop that is exactly right:
 * the phone holding the keys scans the screen. On a phone it is a dead end — you
 * cannot scan the screen you are reading, and until this component was given
 * `next`, every signing flow in the app did precisely that. Sign-in, minting,
 * gifting, listing, buying, bidding and door check-in were all unusable on a
 * phone, which is the device most attendees actually hold.
 *
 * Xaman returns both forms for every payload, and the backend has always passed
 * the deep link through as `next` (`body.next.always`). The frontend simply
 * dropped it. So:
 *
 *   - narrow screens get the LINK, and no QR. An unscannable QR is not a
 *     fallback, it is noise that makes the screen look broken.
 *   - wider screens get the QR, with the link offered quietly underneath —
 *     useful when someone happens to be browsing on the phone that will sign.
 *
 * Chosen with CSS rather than by sniffing the user agent: the question is "is
 * there room for a QR", which is what a media query actually answers, and it
 * stays correct in a resized window or a split view.
 * ---------------------------------------------------------------------------
 */
import { cn } from '@/lib/utils'

export function QrCode({
  src,
  alt,
  className,
  next,
  mode,
}: {
  src: string
  alt: string
  /** Sizing for the image itself, e.g. `size-44`. The plate follows it. */
  className?: string
  /**
   * Xaman's universal deep link for this payload. Omit it and the component
   * behaves exactly as before — QR only, at every width.
   */
  next?: string
  /**
   * Stub mode returns `hubworld-stub://sign/<uuid>`, which opens nothing. A
   * button that visibly does nothing is worse than no button, so the link is
   * withheld unless we are talking to real Xaman.
   */
  mode?: 'live' | 'stub'
}) {
  const deepLink = mode === 'stub' ? undefined : next

  return (
    <div className="flex flex-col items-center gap-3">
      {/* Hidden below `sm` when there is a link to tap instead — see above. */}
      <div className={cn('rounded-xl bg-white p-3', deepLink && 'hidden sm:block')}>
        <img src={src} alt={alt} className={cn('size-44 rounded-md', className)} />
      </div>

      {deepLink && (
        <a
          href={deepLink}
          // Xaman leaves the browser to sign. Same tab, because the polling loop
          // lives on this page and must be the thing still running to notice the
          // signature when the user comes back.
          className={cn(
            'bg-primary text-primary-foreground inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-sm font-medium transition-opacity hover:opacity-90',
            // The primary action on a phone; a quiet secondary offer on desktop,
            // where the QR is the better route.
            'w-full sm:w-auto sm:bg-transparent sm:px-0 sm:py-0 sm:text-xs sm:font-normal sm:text-muted-foreground sm:underline sm:underline-offset-4 sm:hover:text-foreground',
          )}
        >
          Open in Xaman
        </a>
      )}
    </div>
  )
}
