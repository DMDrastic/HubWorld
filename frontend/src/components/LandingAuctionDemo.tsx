/**
 * A self-animating auction card for the landing page.
 *
 * Deliberately NOT `BidChart` — that component exists to plot REAL committed
 * bids, and `AuctionDialog` is its only importer so recharts (~410kB) stays
 * out of the main bundle (see CLAUDE.md). This is marketing content shown to
 * a visitor who has not signed in yet, so it is a small, dependency-free SVG
 * loop instead: a handful of plain elements, not a charting library.
 *
 * The bid timing reuses the SAME late-clustering curve the real seed script
 * uses for demo auctions — `t(u) = 1 - (1 - u) ** 2.6` — so what a visitor
 * watches here is shaped like a real auction's last-minute rush, not evenly
 * spaced placeholder data.
 */
import { useEffect, useRef, useState } from 'react'

type DemoBid = { t: number; price: number; who: string }

function curve(u: number): number {
  return 1 - (1 - u) ** 2.6
}

const US = [0, 0.2, 0.4, 0.6, 0.8, 1.0]
const PRICES = [8.0, 9.5, 11.25, 13.0, 15.25, 18.0]
const BIDDERS = ['reserve met', '@mina_v', '@dro', '@arin_k', '@coltlane', '@arin_k']
const BIDS: DemoBid[] = US.map((u, i) => ({ t: curve(u), price: PRICES[i]!, who: BIDDERS[i]! }))
const RESERVE = 8.0

const ACTIVE_MS = 9000
const HOLD_MS = 2400
const GAP_MS = 900
const CYCLE_MS = ACTIVE_MS + HOLD_MS + GAP_MS

const Y_MIN = 6
const Y_MAX = 19.5
const W = 520
const H = 190
const PAD_B = 18

function px(t: number): number {
  return t * W
}
function py(p: number): number {
  const frac = (p - Y_MIN) / (Y_MAX - Y_MIN)
  return H - PAD_B - frac * (H - PAD_B - 10)
}

const BUCKETS = 12
const velocityCounts = (() => {
  const counts = new Array(BUCKETS).fill(0) as number[]
  for (const b of BIDS) {
    const idx = Math.min(BUCKETS - 1, Math.floor(b.t * BUCKETS))
    counts[idx]! += 1
  }
  return counts
})()

type Frame = {
  phase: 'active' | 'closed' | 'gap'
  price: number
  who: string
  closed: boolean
  pathD: string
  areaD: string
  dotX: number
  dotY: number
  bidCount: number
  bidderCount: number
  closesIn: string
  log: { who: string; price: number }[]
}

function computeFrame(elapsed: number): Frame {
  let phase: Frame['phase']
  let f: number
  if (elapsed < ACTIVE_MS) {
    phase = 'active'
    f = elapsed / ACTIVE_MS
  } else if (elapsed < ACTIVE_MS + HOLD_MS) {
    phase = 'closed'
    f = 1
  } else {
    phase = 'gap'
    f = 0
  }

  let visible = BIDS.filter((b) => b.t <= f)
  if (visible.length === 0) visible = [{ t: 0, price: RESERVE, who: 'reserve met' }]

  const pts = visible.map((b) => ({ x: px(b.t), y: py(b.price) }))
  const holdX = phase === 'gap' ? pts[0]!.x : px(f)
  const last = pts[pts.length - 1]!

  let d = `M ${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)}`
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${pts[i]!.x.toFixed(1)} ${pts[i - 1]!.y.toFixed(1)}`
    d += ` L ${pts[i]!.x.toFixed(1)} ${pts[i]!.y.toFixed(1)}`
  }
  d += ` L ${holdX.toFixed(1)} ${last.y.toFixed(1)}`
  const areaD = `${d} L ${holdX.toFixed(1)} ${H - PAD_B} L ${pts[0]!.x.toFixed(1)} ${H - PAD_B} Z`

  const currentPrice = phase === 'gap' ? RESERVE : visible[visible.length - 1]!.price
  const leader = visible[visible.length - 1]!
  const fresh = visible.filter((b) => b.who !== 'reserve met')
  const distinct = new Set(fresh.map((b) => b.who))

  return {
    phase,
    price: currentPrice,
    who: phase === 'closed' ? `closed · won by ${leader.who}` : leader.who === 'reserve met' ? 'opens at reserve' : `${leader.who} · just now`,
    closed: phase === 'closed',
    pathD: phase === 'gap' ? '' : d,
    areaD: phase === 'gap' ? '' : areaD,
    dotX: holdX,
    dotY: last.y,
    bidCount: fresh.length,
    bidderCount: distinct.size,
    closesIn: phase === 'closed' ? 'closed' : `${Math.max(0, Math.ceil((ACTIVE_MS - elapsed) / 1000))}s`,
    log: fresh.slice(-2),
  }
}

export function LandingAuctionDemo() {
  const reduced =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const [frame, setFrame] = useState<Frame>(() => computeFrame(reduced ? ACTIVE_MS + 1 : 0))
  const rafRef = useRef<number>(0)
  const lastBucketRef = useRef(-1)

  useEffect(() => {
    if (reduced) return
    const start = performance.now()
    const tick = (now: number) => {
      const elapsed = (now - start) % CYCLE_MS
      const bucket = Math.floor(elapsed / 80)
      if (bucket !== lastBucketRef.current) {
        lastBucketRef.current = bucket
        setFrame(computeFrame(elapsed))
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [reduced])

  return (
    <div
      className="bg-card ring-foreground/8 relative overflow-hidden rounded-2xl p-6 ring-1 sm:p-7"
      aria-label="Live auction demo"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="bg-live/10 text-live border-live/25 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium">
          <span className="relative flex size-1.5">
            <span className="bg-live absolute inline-flex size-full animate-ping rounded-full opacity-70" />
            <span className="bg-live relative inline-flex size-1.5 rounded-full" />
          </span>
          live
        </span>
        <span className="text-muted-foreground text-xs">Skyline Sessions — The Observatory, Rooftop</span>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <div className="text-muted-foreground text-[0.7rem] font-medium tracking-[0.14em] uppercase">
            Leading bid
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-mono text-4xl font-semibold tracking-tight tabular-nums">
              {frame.price.toFixed(2)}
            </span>
            <span className="text-muted-foreground text-sm font-medium">XRP</span>
          </div>
          <div className={`mt-1 h-4 text-xs ${frame.closed ? 'text-live' : 'text-muted-foreground'}`}>
            {frame.who}
          </div>
        </div>

        <dl className="flex items-center gap-5 text-xs">
          <div>
            <dt className="text-muted-foreground">Reserve</dt>
            <dd className="text-live mt-0.5 font-mono tabular-nums">met</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Bids</dt>
            <dd className="text-foreground mt-0.5 font-mono tabular-nums">
              {frame.bidCount}
              <span className="text-muted-foreground"> / {frame.bidderCount} bidders</span>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Closes</dt>
            <dd className="text-foreground mt-0.5 font-mono tabular-nums">{frame.closesIn}</dd>
          </div>
        </dl>
      </div>

      <div className="mt-3.5 h-44 w-full">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full" aria-hidden>
          <line x1="0" y1={py(RESERVE)} x2={W} y2={py(RESERVE)} stroke="var(--color-muted-foreground)" strokeDasharray="4 4" strokeOpacity="0.6" />
          <defs>
            <linearGradient id="landing-price-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity="0.3" />
              <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {frame.areaD && <path d={frame.areaD} fill="url(#landing-price-fill)" stroke="none" />}
          {frame.pathD && (
            <path d={frame.pathD} fill="none" stroke="var(--color-chart-1)" strokeWidth="2" strokeLinejoin="round" />
          )}
          {frame.phase !== 'gap' && <circle cx={frame.dotX} cy={frame.dotY} r="4.5" fill="var(--color-chart-1)" stroke="var(--color-card)" strokeWidth="2" />}
        </svg>
      </div>

      <div className="h-10 w-full">
        <svg viewBox={`0 0 ${W} 44`} preserveAspectRatio="none" className="h-full w-full" aria-hidden>
          {velocityCounts.map((count, i) => {
            const bw = W / BUCKETS
            const bucketT = (i + 0.5) / BUCKETS
            const full = 6 + count * 14
            const elapsedFrac =
              frame.phase === 'gap' ? 0 : frame.phase === 'closed' ? 1 : frame.dotX / W
            const on = elapsedFrac >= bucketT
            return (
              <rect
                key={i}
                x={(i * bw + bw * 0.22).toFixed(1)}
                width={(bw * 0.56).toFixed(1)}
                y={on ? (44 - full).toFixed(1) : '44'}
                height={on ? full : 0}
                rx="2"
                fill="var(--color-chart-1)"
                fillOpacity={bucketT > 0.7 ? 0.75 : 0.4}
                style={{ transition: 'height 0.3s ease, y 0.3s ease' }}
              />
            )
          })}
        </svg>
      </div>
      <div className="text-muted-foreground text-center text-[0.65rem] tracking-[0.14em] uppercase">
        bid velocity
      </div>

      <div className="mt-3 h-9 border-t pt-2.5">
        {frame.log.map((entry, i) => (
          <div key={`${entry.who}-${i}`} className="text-muted-foreground text-xs">
            <b className="text-foreground font-medium">{entry.who}</b> bid{' '}
            <span className="text-chart-1 font-mono">{entry.price.toFixed(2)} XRP</span>
          </div>
        ))}
      </div>
    </div>
  )
}
