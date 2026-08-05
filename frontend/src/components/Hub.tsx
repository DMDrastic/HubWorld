/**
 * The signed-in home.
 *
 * The product is named for hub worlds — Station Square, Majula — a central space
 * that connects you to everywhere else. That idea had no representation in the
 * UI: signing in dropped you into a vertical stack of every panel at once.
 *
 * So this answers the three questions someone actually arrives with: what do I
 * hold, what is happening right now, and where do I go next. Anything requiring a
 * decision lives on its own page.
 */
import { useCallback, useEffect, useState } from 'react'
import { ArrowUpRight, CalendarDays, Store, Ticket as TicketIcon } from 'lucide-react'
import {
  dropsToXrp,
  fetchAuctions,
  fetchInventory,
  type AuctionSummary,
  type OwnedTicket,
  type User,
} from '@/lib/api'
import { useLinkHandler, type Route } from '@/lib/router'
import { Badge } from '@/components/ui/badge'

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-card ring-foreground/8 rounded-2xl p-5 ring-1">
      <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {label}
      </div>
      {/* Proportional figures read better at display size; tabular is for
          columns that must align vertically, which these do not. */}
      <div className="mt-2 text-3xl font-semibold tracking-tight">{value}</div>
      {hint && (
        <div className="text-muted-foreground mt-1 truncate text-xs" title={hint}>
          {hint}
        </div>
      )}
    </div>
  )
}

function Countdown({ endsAt }: { endsAt: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const ms = new Date(endsAt).getTime() - now
  if (ms <= 0) return <span className="text-muted-foreground">closed</span>
  const m = Math.floor(ms / 60_000)
  if (m >= 60) return <span>{Math.floor(m / 60)}h {m % 60}m left</span>
  const s = Math.floor((ms % 60_000) / 1000)
  return (
    <span className="tabular-nums">
      {m}m {String(s).padStart(2, '0')}s left
    </span>
  )
}

function SectionHeader({
  title,
  href,
  label,
  onNavigate,
}: {
  title: string
  href: Route
  label: string
  onNavigate: (e: React.MouseEvent) => void
}) {
  return (
    <div className="flex items-baseline justify-between">
      <h2 className="font-medium tracking-tight">{title}</h2>
      <a
        href={href}
        onClick={onNavigate}
        className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
      >
        {label}
      </a>
    </div>
  )
}

const SHORTCUTS = [
  ['/events', 'Browse events', 'See what is on and which nights are up for bidding.', CalendarDays],
  ['/tickets', 'Your tickets', 'Everything you hold, and gifting to an @handle.', TicketIcon],
  ['/market', 'Marketplace', 'Buy a resale, or list and auction your own.', Store],
] as const satisfies readonly (readonly [Route, string, string, typeof Store])[]

export function Hub({ me, onOpenAuction }: { me: User; onOpenAuction: (slug: string) => void }) {
  const [tickets, setTickets] = useState<OwnedTicket[]>([])
  const [auctions, setAuctions] = useState<AuctionSummary[]>([])
  const link = useLinkHandler()

  const load = useCallback(async () => {
    const [inv, auc] = await Promise.allSettled([fetchInventory(), fetchAuctions()])
    if (inv.status === 'fulfilled') setTickets(inv.value.tickets)
    if (auc.status === 'fulfilled') setAuctions(auc.value)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const usable = tickets.filter((t) => t.status !== 'REDEEMED')
  const upcoming = [...usable].sort(
    (a, b) => +new Date(a.event.startsAt) - +new Date(b.event.startsAt),
  )

  return (
    <div className="space-y-10 py-10">
      <div className="relative">
        <div
          className="pointer-events-none absolute inset-x-0 -top-20 h-64 opacity-0"
          aria-hidden
        />
        <div className="relative">
          <h1 className="text-3xl font-semibold tracking-[-0.02em]">
            Welcome back, <span className="text-primary">@{me.username}</span>
          </h1>
          <p className="text-muted-foreground mt-1.5 font-mono text-xs break-all">
            {me.xrplAddress}
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Tickets held"
          value={String(usable.length)}
          hint={
            tickets.length > usable.length
              ? `${tickets.length - usable.length} already used`
              : undefined
          }
        />
        <Stat label="Live auctions" value={String(auctions.length)} hint="across all events" />
        <Stat
          label="Next event"
          value={upcoming[0] ? dateFmt.format(new Date(upcoming[0].event.startsAt)) : '—'}
          hint={upcoming[0]?.event.title}
        />
      </div>

      {auctions.length > 0 && (
        <section className="space-y-3">
          <SectionHeader
            title="Bidding now"
            href="/events"
            label="all events"
            onNavigate={link('/events')}
          />
          <ul className="space-y-2">
            {auctions.slice(0, 3).map((a) => (
              <li key={a.id}>
                {/* The only glow in the signed-in shell. A live auction is the
                    one thing on this page with a deadline attached. */}
                <button
                  type="button"
                  onClick={() => onOpenAuction(a.eventSlug)}
                  className="bg-card ring-foreground/8 hover:ring-live/40 hover:glow-live group flex w-full items-center justify-between gap-4 rounded-2xl p-5 text-left ring-1 transition-all"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="relative flex size-1.5 shrink-0">
                        <span className="bg-live absolute inline-flex size-full animate-ping rounded-full opacity-70" />
                        <span className="bg-live relative inline-flex size-1.5 rounded-full" />
                      </span>
                      <span className="truncate font-medium tracking-tight">{a.eventTitle}</span>
                    </div>
                    <div className="text-muted-foreground mt-1 text-xs">
                      {a.bidCount} bid{a.bidCount === 1 ? '' : 's'} · <Countdown endsAt={a.endsAt} />
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <div className="text-right">
                      <div className="font-mono text-lg font-semibold tabular-nums">
                        {dropsToXrp(a.topBidDrops)}
                      </div>
                      <div className="text-muted-foreground text-[0.7rem] tracking-wide uppercase">
                        XRP
                      </div>
                    </div>
                    <ArrowUpRight className="text-muted-foreground group-hover:text-live size-4 transition-colors" />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {upcoming.length > 0 && (
        <section className="space-y-3">
          <SectionHeader
            title="Your next tickets"
            href="/tickets"
            label="all tickets"
            onNavigate={link('/tickets')}
          />
          <ul className="space-y-2">
            {upcoming.slice(0, 3).map((t) => (
              <li
                key={t.nfTokenId}
                className="bg-card ring-foreground/8 flex items-center justify-between gap-3 rounded-2xl p-5 ring-1"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium tracking-tight">{t.event.title}</div>
                  <div className="text-muted-foreground mt-1 text-xs">
                    {dateFmt.format(new Date(t.event.startsAt))}
                    {t.tier ? ` · ${t.tier}` : ''}
                    {t.seat ? ` · ${t.seat}` : ''}
                  </div>
                </div>
                {t.status === 'LISTED' && <Badge variant="secondary">listed</Badge>}
                {t.status === 'IN_AUCTION' && <Badge variant="secondary">in auction</Badge>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {usable.length === 0 && auctions.length === 0 && (
        <div className="rounded-2xl border border-dashed p-12 text-center">
          <p className="font-medium tracking-tight">Your hub is empty</p>
          <p className="text-muted-foreground mx-auto mt-1.5 max-w-sm text-sm leading-relaxed">
            Tickets you buy, receive or win will appear here.
          </p>
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-3">
        {SHORTCUTS.map(([to, label, body, Icon]) => (
          <a
            key={to}
            href={to}
            onClick={link(to)}
            className="group bg-card ring-foreground/8 hover:ring-primary/30 rounded-2xl p-5 ring-1 transition-all hover:-translate-y-0.5"
          >
            <div className="flex items-center justify-between">
              <div className="bg-primary/10 text-primary ring-primary/15 flex size-8 items-center justify-center rounded-lg ring-1">
                <Icon className="size-4" aria-hidden />
              </div>
              <ArrowUpRight className="text-muted-foreground group-hover:text-primary size-4 transition-colors" />
            </div>
            <div className="mt-4 font-medium tracking-tight">{label}</div>
            <div className="text-muted-foreground mt-1 text-sm leading-relaxed text-pretty">
              {body}
            </div>
          </a>
        ))}
      </section>
    </div>
  )
}
