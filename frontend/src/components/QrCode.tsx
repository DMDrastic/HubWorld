/**
 * A Xaman QR code, on a plate that keeps it scannable.
 *
 * Every signing flow in the app renders one of these, and each one used to sit
 * directly on the card with a hairline border. That is fine on a light surface
 * and a problem on a dark one: a scanner needs dark-on-light contrast and a
 * clear margin — the "quiet zone" — around the symbol. A code flush against a
 * dark card can simply fail to read, and the failure looks like Xaman being
 * broken rather than like a styling bug.
 *
 * So the plate is white in BOTH themes, deliberately. It is one of the few
 * places in the app that ignores the palette, because the constraint here is
 * an optical one belonging to the scanner, not a design choice.
 */
import { cn } from '@/lib/utils'

export function QrCode({
  src,
  alt,
  className,
}: {
  src: string
  alt: string
  /** Sizing for the image itself, e.g. `size-44`. The plate follows it. */
  className?: string
}) {
  return (
    <div className="rounded-xl bg-white p-3">
      <img src={src} alt={alt} className={cn('size-44 rounded-md', className)} />
    </div>
  )
}
