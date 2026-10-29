/**
 * "Start with the poster", as something a visitor can do.
 *
 * Choosing a poster on the create page washes the page in that poster's colour; it
 * is the most memorable thing the product does, and it is hard to describe and
 * instant to show. So this is the real behaviour, small: pick one of three sample
 * posters and the plate takes on its colour, read from the image by the same
 * `dominantTint` the real create page uses, not a colour hard-coded per poster.
 *
 * It is an EXAMPLE and says so. The event, its date, price and royalty are made up
 * for the demo, and the plate is labelled as such, because a landing page must never
 * show something that looks like a real event or a real result and is not.
 *
 * The three posters are real images served with the page, so the tint is genuinely
 * measured. Where the browser cannot read an image the plate simply stays neutral:
 * the demo loses its colour, never its function.
 */
import { useEffect, useId, useState } from 'react'
import { CalendarDays, Percent, Repeat, Ticket } from 'lucide-react'
import confetti from '@/assets/sample-poster-confetti.jpg'
import hoops from '@/assets/sample-poster-hoops.jpg'
import stage from '@/assets/sample-poster-stage.jpg'
import { tintFromUrl, type Rgb } from '@/lib/poster-tint'

/**
 * Sample artwork. `stage` and `confetti` are photographs by Marcel Strauss and
 * Aditya Chinchure (Unsplash licence), cropped and shrunk; `hoops` was drawn for this
 * page. All three were supplied by the project owner.
 */
const SAMPLES = [
  { id: 'stage', label: 'Blue night', src: stage },
  { id: 'confetti', label: 'Confetti', src: confetti },
  { id: 'hoops', label: 'Orange court', src: hoops },
] as const

function Row({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  label: string
  value: string
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 px-4 py-2.5">
      <Icon className="text-muted-foreground size-[1.125rem] shrink-0" aria-hidden />
      <span>{label}</span>
      <span className="ml-auto text-right font-medium tabular-nums">{value}</span>
    </div>
  )
}

export function LandingCreateDemo({
  readTint = tintFromUrl,
}: {
  /** How a poster's colour is read. Injectable because tests have no canvas. */
  readTint?: (url: string) => Promise<Rgb | null>
}) {
  const [index, setIndex] = useState(0)
  const [tint, setTint] = useState<Rgb | null>(null)
  const [washOn, setWashOn] = useState(false)
  const name = useId()
  const chosen = SAMPLES[index]!

  // Keyed on the chosen poster's URL, a primitive, so a re-render never re-reads it.
  const src = chosen.src
  useEffect(() => {
    let live = true
    void readTint(src).then((found) => {
      if (!live) return
      if (found) setTint(found)
      setWashOn(found !== null)
    })
    return () => {
      live = false
    }
  }, [src, readTint])

  return (
    <div className="surface relative overflow-hidden p-6 sm:p-10">
      {/* The wash, clipped to this plate. Same layer the real create page paints, a
          little stronger here because the plate is small. */}
      <div
        aria-hidden
        data-demo-wash={washOn ? 'on' : 'off'}
        className="poster-wash pointer-events-none absolute inset-0 [--poster-bottom:24%] [--poster-top:36%] transition-opacity duration-700 dark:[--poster-bottom:30%] dark:[--poster-top:52%]"
        style={
          {
            opacity: washOn ? 1 : 0,
            ...(tint ? { '--poster-tint': `rgb(${tint.join(' ')})` } : {}),
          } as React.CSSProperties
        }
      />

      <div className="relative grid gap-8 lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-12">
        <div className="mx-auto w-full max-w-[13rem] lg:mx-0 lg:max-w-none">
          <div className="relative aspect-3/4 overflow-hidden rounded-2xl border border-[var(--surface-border)]">
            <img
              src={chosen.src}
              alt={`${chosen.label} sample poster`}
              className="absolute inset-0 size-full object-cover"
            />
          </div>

          <fieldset className="mt-4">
            <legend className="sr-only">Choose a sample poster</legend>
            <div className="flex gap-3">
              {SAMPLES.map((s, i) => (
                <label key={s.id} className="relative block flex-1 cursor-pointer">
                  <input
                    type="radio"
                    name={name}
                    checked={i === index}
                    onChange={() => setIndex(i)}
                    className="peer sr-only"
                  />
                  <span className="peer-checked:ring-foreground peer-focus-visible:ring-ring relative block aspect-3/4 overflow-hidden rounded-lg border border-[var(--surface-border)] opacity-70 ring-2 ring-transparent transition peer-checked:opacity-100 hover:opacity-100">
                    <img src={s.src} alt="" className="absolute inset-0 size-full object-cover" />
                  </span>
                  <span className="sr-only">{s.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">Example event. Pick a poster.</p>
          <p className="text-4xl leading-[1.05] font-semibold tracking-[-0.03em] sm:text-5xl">
            Tuesday Night Hoops
          </p>

          <div className="surface divide-y">
            <Row icon={CalendarDays} label="Starts" value="Tue, Nov 3, 8:00 PM" />
            <Row icon={Ticket} label="Ticket price" value="15 XRP" />
            <Row icon={Percent} label="Royalty" value="5%" />
            <Row icon={Repeat} label="Resale" value="Capped at 120% of face value" />
          </div>

          <a
            href="#hero-signin"
            className="bg-primary text-primary-foreground focus-visible:ring-ring inline-flex h-11 w-full items-center justify-center rounded-full px-6 text-base font-medium transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none"
          >
            Create yours
          </a>
        </div>
      </div>
    </div>
  )
}
