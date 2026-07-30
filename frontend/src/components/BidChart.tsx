/**
 * Auction price tracker.
 *
 * Design decisions worth keeping:
 *
 * - **Step, not line.** The leading bid holds flat until someone outbids it. A
 *   smooth line would imply interpolation between bids that never happened; the
 *   plateaus and jumps ARE the shape of an auction.
 *
 * - **Only committed bids set the price.** A bid is a buy offer, and it is not
 *   real until that offer exists on-ledger. Plotting unsigned bids would let
 *   anyone pump the visible price with money they never committed, turning the
 *   chart into a manipulation surface. Pending bids are drawn as a ghosted
 *   marker, never as price.
 *
 * - **A candlestick chart was considered and rejected.** OHLC compresses many
 *   trades per interval into a range; an auction has few, monotonically rising
 *   bids, so every candle would be a rangeless doji. It would look sophisticated
 *   and convey nothing.
 *
 * - **Velocity is the drama.** Bids-per-interval rising toward the close is the
 *   thing a price line cannot show, so it gets its own strip underneath.
 *
 * - **The x-axis is time-to-close**, not wall-clock, because "as the event
 *   approaches" is how a bidder actually thinks.
 */
import { useMemo } from 'react'
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { dropsToXrp, type Auction, type Bid } from '@/lib/api'

/** A bid only counts toward price once its buy offer exists on-ledger. */
const FUNDED: ReadonlySet<Bid['status']> = new Set(['COMMITTED', 'OUTBID', 'WON'])

type PricePoint = {
  minutesToClose: number
  priceXrp: number
  bidder: string
  amountDrops: string
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'closed'
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function fmtAgo(iso: string, now: number): string {
  const d = now - new Date(iso).getTime()
  const m = Math.floor(d / 60_000)
  if (m < 1) return 'just now'
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`
}

export function BidChart({ auction, now = Date.now() }: { auction: Auction; now?: number }) {
  const view = useMemo(() => {
    const endsAt = new Date(auction.endsAt).getTime()
    const startsAt = new Date(auction.startsAt).getTime()

    const funded = auction.bids
      .filter((b) => FUNDED.has(b.status))
      .sort((a, b) => +new Date(a.placedAt) - +new Date(b.placedAt))

    // Running maximum: the price is the highest funded bid so far, which is not
    // necessarily the latest one if a later bid were lower.
    let top = 0n
    const series: PricePoint[] = []
    for (const b of funded) {
      const amt = BigInt(b.amountDrops)
      if (amt <= top) continue
      top = amt
      series.push({
        minutesToClose: (endsAt - new Date(b.placedAt).getTime()) / 60_000,
        priceXrp: Number(dropsToXrp(b.amountDrops)),
        bidder: b.bidder,
        amountDrops: b.amountDrops,
      })
    }

    // Hold the last price flat to the close, so the step reaches the axis edge
    // instead of stopping mid-chart and implying the auction already ended.
    const nowMinutes = (endsAt - now) / 60_000
    if (series.length > 0 && nowMinutes < series[series.length - 1]!.minutesToClose) {
      const last = series[series.length - 1]!
      series.push({ ...last, minutesToClose: nowMinutes })
    }

    // Velocity: bids per bucket across the auction, so the late rush is visible.
    const BUCKETS = 12
    const span = Math.max(endsAt - startsAt, 1)
    const velocity = Array.from({ length: BUCKETS }, (_, i) => ({
      minutesToClose: ((BUCKETS - i - 0.5) * span) / BUCKETS / 60_000,
      bids: 0,
    }))
    for (const b of funded) {
      const frac = (new Date(b.placedAt).getTime() - startsAt) / span
      const idx = Math.min(BUCKETS - 1, Math.max(0, Math.floor(frac * BUCKETS)))
      velocity[idx]!.bids += 1
    }

    const pending = auction.bids.filter((b) => b.status === 'PENDING')
    const leader = funded.length > 0 ? funded[funded.length - 1]! : null
    const reserveXrp = Number(dropsToXrp(auction.reserveDrops))
    const currentXrp = series.length > 0 ? series[series.length - 1]!.priceXrp : 0

    return {
      series,
      velocity,
      pending: pending.map((b) => ({
        minutesToClose: (endsAt - new Date(b.placedAt).getTime()) / 60_000,
        priceXrp: Number(dropsToXrp(b.amountDrops)),
        bidder: b.bidder,
      })),
      leader,
      reserveXrp,
      currentXrp,
      aboveReserve: currentXrp >= reserveXrp,
      distinctBidders: new Set(funded.map((b) => b.bidder)).size,
      bidCount: funded.length,
      msToClose: endsAt - now,
    }
  }, [auction, now])

  const axisStyle = { fontSize: 11, fill: 'var(--color-muted-foreground)' }

  return (
    <div className="space-y-3">
      {/* Ticker strip — the glanceable, stock-ticker part. Cheaper than a chart
          and the only thing that works on a narrow screen. */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <div className="text-muted-foreground text-[0.7rem] font-medium tracking-[0.14em] uppercase">
            Leading bid
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-mono text-4xl font-semibold tracking-tight tabular-nums">
              {view.currentXrp.toFixed(2)}
            </span>
            <span className="text-muted-foreground text-sm font-medium">XRP</span>
          </div>
          {view.leader && (
            <div className="text-muted-foreground mt-1 text-xs">
              {view.leader.bidder} · {fmtAgo(view.leader.placedAt, now)}
            </div>
          )}
        </div>

        <dl className="flex items-center gap-5 text-xs">
          <div>
            <dt className="text-muted-foreground">Reserve</dt>
            {/* Above-reserve is a STATE, so it wears the live token rather
                than the series colour — the price line is already violet. */}
            <dd
              className={`mt-0.5 font-mono tabular-nums ${
                view.aboveReserve ? 'text-live' : 'text-foreground'
              }`}
            >
              {view.aboveReserve ? 'met' : view.reserveXrp.toFixed(2)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Bids</dt>
            <dd className="text-foreground mt-0.5 font-mono tabular-nums">
              {view.bidCount}
              <span className="text-muted-foreground"> / {view.distinctBidders} bidders</span>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Closes</dt>
            <dd className="text-foreground mt-0.5 font-mono tabular-nums">
              {fmtCountdown(view.msToClose)}
            </dd>
          </div>
        </dl>
      </div>

      {/* Price. Reversed axis so the close is on the right and time runs left to
          right the way a reader expects. */}
      <div className="h-48 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={view.series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
            <XAxis
              dataKey="minutesToClose"
              type="number"
              reversed
              domain={['dataMax', 0]}
              tickFormatter={(v: number) => (v <= 0.5 ? 'close' : `${Math.round(v)}m`)}
              tick={axisStyle}
              stroke="var(--color-border)"
            />
            <YAxis
              tickFormatter={(v: number) => `${v}`}
              tick={axisStyle}
              stroke="var(--color-border)"
              width={38}
              domain={([min, max]: readonly [number, number]) =>
                [
                  Math.floor(Math.min(min, view.reserveXrp) * 0.95),
                  Math.ceil(max * 1.05),
                ] as [number, number]
              }
            />
            <Tooltip
              contentStyle={{
                background: 'var(--color-popover)',
                border: '1px solid var(--color-border)',
                borderRadius: 12,
                fontSize: 12,
                padding: '8px 12px',
                boxShadow: '0 8px 24px -8px rgb(0 0 0 / 0.45)',
                color: 'var(--color-popover-foreground)',
              }}
              cursor={{ stroke: 'var(--color-border)', strokeWidth: 1 }}
              labelFormatter={(v: React.ReactNode) => `${Math.round(Number(v))}m to close`}
              formatter={(value: unknown, _n: unknown, item: unknown) => {
                const p = (item as { payload?: PricePoint }).payload
                return [`${Number(value).toFixed(2)} XRP`, p?.bidder ?? 'bid']
              }}
            />

            <ReferenceLine
              y={view.reserveXrp}
              stroke="var(--color-muted-foreground)"
              strokeDasharray="4 4"
              strokeOpacity={0.7}
              label={{
                value: 'reserve',
                position: 'insideTopLeft',
                fontSize: 10,
                fill: 'var(--color-muted-foreground)',
              }}
            />

            {/* stepAfter: the price holds until the next bid lands. The series
                wears chart-1, not `primary` — it is a data mark that happens to
                share the brand hue, and calling it `primary` would invite the
                next series to reach for `secondary`. */}
            <defs>
              <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <Area
              type="stepAfter"
              dataKey="priceXrp"
              stroke="var(--color-chart-1)"
              strokeWidth={2}
              fill="url(#priceFill)"
              dot={{ r: 2.5, fill: 'var(--color-chart-1)', strokeWidth: 0 }}
              // A 2px surface ring keeps the hovered point legible where the
              // mark overlaps the fill beneath it.
              activeDot={{
                r: 4.5,
                fill: 'var(--color-chart-1)',
                stroke: 'var(--color-card)',
                strokeWidth: 2,
              }}
              isAnimationActive={false}
            />

            {/* Unfunded bids: visible but deliberately not part of the price. */}
            {view.pending.length > 0 && (
              <Scatter
                data={view.pending}
                dataKey="priceXrp"
                fill="var(--color-muted-foreground)"
                fillOpacity={0.45}
                shape="circle"
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Velocity. Same reversed axis so the columns line up with the price
          above them. */}
      <div className="h-16 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={view.velocity} margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
            <XAxis
              dataKey="minutesToClose"
              type="number"
              reversed
              domain={['dataMax', 0]}
              hide
            />
            <YAxis hide />
            <Tooltip
              contentStyle={{
                background: 'var(--color-popover)',
                border: '1px solid var(--color-border)',
                borderRadius: 12,
                fontSize: 12,
                padding: '8px 12px',
                boxShadow: '0 8px 24px -8px rgb(0 0 0 / 0.45)',
                color: 'var(--color-popover-foreground)',
              }}
              cursor={{ stroke: 'var(--color-border)', strokeWidth: 1 }}
              labelFormatter={(v: React.ReactNode) => `${Math.round(Number(v))}m to close`}
              formatter={(v: unknown) => [`${v}`, 'bids']}
            />
            {/* Rounded data-ends, anchored to the baseline. */}
            <Bar
              dataKey="bids"
              fill="var(--color-chart-1)"
              fillOpacity={0.4}
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="text-muted-foreground text-center text-[0.65rem] tracking-[0.14em] uppercase">
        bid velocity
      </div>

      {view.pending.length > 0 && (
        <p className="text-muted-foreground text-xs">
          {view.pending.length} bid{view.pending.length === 1 ? '' : 's'} awaiting escrow — shown
          faded, and not counted as price until locked on-ledger.
        </p>
      )}
    </div>
  )
}
