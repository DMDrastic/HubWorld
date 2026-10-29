/**
 * The page background shared by the landing page and every other page: a canvas
 * that settles into the app background at the foot, teal tonal washes, and a faint
 * dot grid. It lives in one place so the two can never drift apart; the owner asked
 * for every page to carry exactly the landing page's.
 *
 * `--accent` is redefined HERE, on the wrapper, for the washes and for the landing
 * page's teal chrome. The app's own `--accent` (a neutral hover fill in the shadcn
 * primitives) is untouched outside this subtree, which is why the shell wraps its
 * pages in this component rather than setting the variable on the root.
 *
 * It also sets the muted-text and live-green values the washes were contrast-tuned
 * against (light mode's body text was measured on real pixels), so text inside it
 * clears AA on top of them.
 */
import type { ReactNode } from 'react'

export function PageBackdrop({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={`relative isolate min-h-[calc(100svh-4rem)] bg-[linear-gradient(to_bottom,var(--canvas)_calc(100%-12rem),var(--background))]
        [--canvas:#e3e8ef] [--panel:#d5dce7] [--lift:60%] [--muted-foreground:#4f5565] [--live:#116a30]
        [--accent:#007da2] [--wash-tint:3.5%] [--wash-1:12%] [--wash-2:9.5%] [--wash-3:8%] [--wash-4:9.5%] [--wash-5:9.5%] [--wash-6:11%] [--wash-glow:0%] [--wash-dot:20%]
        dark:[--canvas:#0e0e12] dark:[--panel:#0e151c] dark:[--lift:0%] dark:[--muted-foreground:#9b9aa7] dark:[--live:#3fb463]
        dark:[--accent:#00aed4] dark:[--wash-tint:6%] dark:[--wash-1:20%] dark:[--wash-2:17%] dark:[--wash-3:14%] dark:[--wash-4:17%] dark:[--wash-5:17%] dark:[--wash-6:19%] dark:[--wash-glow:15%] dark:[--wash-dot:30%] ${className}`}
    >
      {/* RESTORED at the owner's request: the teal accent, the tonal washes and
          the dot grid behind the page, which the first rework of this page had
          removed. They are the previous design's, unchanged except that the dark
          canvas is now the app's own near-black (#0e0e12, was #09090d) so the
          page meets the nav and footer without a seam.

          The accent is teal on purpose and is not the app's violet; it paints the
          marketing chrome around the phone, the demo's price line and the
          provenance dots. Peak wash percentages were tuned per theme against real
          pixel-sampled body-text contrast (light mode's worst case was 4.59:1),
          so change them with a measurement, not by eye. Lives in a -z-10 child
          of an `isolate`d root so it paints above the root background and below
          every section. The fade at both ends is two small overlays, not a mask
          on this page-tall layer, which iOS Safari handles badly while
          scrolling. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          backgroundImage: [
            'linear-gradient(color-mix(in oklch, var(--accent) var(--wash-tint), transparent), color-mix(in oklch, var(--accent) var(--wash-tint), transparent))',
            'radial-gradient(85vw 70vh at 50% 45%, color-mix(in oklch, var(--accent) var(--wash-glow), transparent), transparent 75%)',
            'radial-gradient(90vw 46vh at 50% 0%, color-mix(in oklch, var(--accent) var(--wash-1), transparent), transparent 72%)',
            'radial-gradient(70vw 60vh at 100% 24%, color-mix(in oklch, var(--accent) var(--wash-2), transparent), transparent 72%)',
            'radial-gradient(60vw 50vh at 0% 20%, color-mix(in oklch, oklch(0.8 0.1 65) var(--wash-3), transparent), transparent 72%)',
            'radial-gradient(80vw 60vh at 0% 54%, color-mix(in oklch, var(--accent) var(--wash-4), transparent), transparent 72%)',
            'radial-gradient(80vw 56vh at 100% 76%, color-mix(in oklch, var(--accent) var(--wash-5), transparent), transparent 72%)',
            'radial-gradient(90vw 50vh at 50% 100%, color-mix(in oklch, var(--accent) var(--wash-6), transparent), transparent 72%)',
            'linear-gradient(180deg, color-mix(in oklch, white var(--lift), transparent), transparent 48vh)',
          ].join(', '),
        }}
      >
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(circle, color-mix(in oklch, var(--accent) var(--wash-dot), transparent) 1px, transparent 1.4px)',
            backgroundSize: '28px 28px',
          }}
        />
        <div
          className="absolute inset-x-0 top-0 h-[5%]"
          style={{ background: 'linear-gradient(var(--background), transparent)' }}
        />
        <div
          className="absolute inset-x-0 bottom-0 h-[10%]"
          style={{ background: 'linear-gradient(transparent, var(--background))' }}
        />
      </div>
      {children}
    </div>
  )
}
