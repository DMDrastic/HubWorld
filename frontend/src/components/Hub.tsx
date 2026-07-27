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
    <div className="rounded-lg border p-4">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-muted-foreground mt-0.5 text-xs">{hint}</div>}
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

  const shortcut = (to: Route, label: string, body: string) => (
    <a
      key={to}
      href={to}
      onClick={link(to)}
      className="hover:border-primary/50 hover:bg-accent/30 rounded-lg border p-4 transition-colors"
    >
      <div className="font-medium">{label}</div>
      <div className="text-muted-foreground mt-0.5 text-sm text-pretty">{body}</div>
    </a>
  )

  return (
    <div className="space-y-8 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome back, <span className="text-primary">@{me.username}</span>
        </h1>
        <p className="text-muted-foreground font-mono text-xs break-all">{me.xrplAddress}</p>
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
          <div className="flex items-baseline justify-between">
            <h2 className="font-medium">Bidding now</h2>
            <a
              href="/events"
              onClick={link('/events')}
              className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
            >
              all events
            </a>
          </div>
          <ul className="space-y-2">
            {auctions.slice(0, 3).map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => onOpenAuction(a.eventSlug)}
                  className="hover:border-primary/50 hover:bg-accent/30 flex w-full items-center justify-between gap-3 rounded-lg border p-4 text-left transition-colors"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{a.eventTitle}</div>
                    <div className="text-muted-foreground text-xs">
                      {a.bidCount} bid{a.bidCount === 1 ? '' : 's'} · <Countdown endsAt={a.endsAt} />
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-mono font-semibold tabular-nums">
                      {dropsToXrp(a.topBidDrops)}
                    </div>
                    <div className="text-muted-foreground text-xs">XRP</div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {upcoming.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="font-medium">Your next tickets</h2>
            <a
              href="/tickets"
              onClick={link('/tickets')}
              className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
            >
              all tickets
            </a>
          </div>
          <ul className="space-y-2">
            {upcoming.slice(0, 3).map((t) => (
              <li
                key={t.nfTokenId}
                className="flex items-center justify-between gap-3 rounded-lg border p-4"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{t.event.title}</div>
                  <div className="text-muted-foreground text-xs">
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
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="font-medium">Your hub is empty</p>
          <p className="text-muted-foreground mt-1 text-sm">
            Tickets you buy, receive or win will appear here.
          </p>
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-3">
        {shortcut('/events', 'Browse events', 'See what is on and which nights are up for bidding.')}
        {shortcut('/tickets', 'Your tickets', 'Everything you hold, and gifting to an @handle.')}
        {shortcut('/market', 'Marketplace', 'Buy a resale, or list and auction your own.')}
      </section>
    </div>
  )
}
