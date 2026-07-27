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
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl font-semibold tabular-nums">
            {view.currentXrp.toFixed(2)}
          </span>
          <span className="text-muted-foreground text-xs">XRP</span>
          {view.leader && (
            <span className="text-muted-foreground text-xs">
              {view.leader.bidder} · {fmtAgo(view.leader.placedAt, now)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span
            className={
              view.aboveReserve
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-muted-foreground'
            }
          >
            {view.aboveReserve ? 'above reserve' : `reserve ${view.reserveXrp.toFixed(2)}`}
          </span>
          <span className="text-muted-foreground">
            {view.bidCount} bids · {view.distinctBidders} bidders
          </span>
          <span className="font-mono tabular-nums">{fmtCountdown(view.msToClose)}</span>
        </div>
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
                borderRadius: 8,
                fontSize: 12,
                color: 'var(--color-popover-foreground)',
              }}
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
              label={{ value: 'reserve', position: 'insideTopLeft', fontSize: 10, fill: 'var(--color-muted-foreground)' }}
            />

            {/* stepAfter: the price holds until the next bid lands. */}
            <Area
              type="stepAfter"
              dataKey="priceXrp"
              stroke="var(--color-primary)"
              strokeWidth={2}
              fill="var(--color-primary)"
              fillOpacity={0.12}
              dot={{ r: 2.5, fill: 'var(--color-primary)' }}
              activeDot={{ r: 4 }}
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
                borderRadius: 8,
                fontSize: 12,
                color: 'var(--color-popover-foreground)',
              }}
              labelFormatter={(v: React.ReactNode) => `${Math.round(Number(v))}m to close`}
              formatter={(v: unknown) => [`${v}`, 'bids']}
            />
            <Bar
              dataKey="bids"
              fill="var(--color-primary)"
              fillOpacity={0.35}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="text-muted-foreground text-center text-[10px]">bid velocity</div>

      {view.pending.length > 0 && (
        <p className="text-muted-foreground text-xs">
          {view.pending.length} bid{view.pending.length === 1 ? '' : 's'} awaiting escrow — shown
          faded, and not counted as price until locked on-ledger.
        </p>
      )}
    </div>
  )
}
