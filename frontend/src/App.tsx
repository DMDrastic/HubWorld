import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  fetchAuctions,
  fetchEvents,
  fetchHealth,
  fetchMe,
  lookupUser,
  purgeLegacyToken,
  signOut,
  type AuthUser,
  type AuctionSummary,
  type EventSummary,
  type Health,
  type User,
} from '@/lib/api'
import { SignIn } from '@/components/SignIn'
import { MintPanel } from '@/components/MintPanel'
import { GiftPanel } from '@/components/GiftPanel'
import { SellPanel } from '@/components/SellPanel'
import { DoorPanel } from '@/components/DoorPanel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

// Recharts is ~410kB and only the auction dialog needs it. Loading it eagerly
// more than doubled the main bundle (318kB -> 728kB), so it stays split out —
// and now it is not even fetched until someone opens an auction.
const AuctionDialog = lazy(() =>
  import('@/components/AuctionDialog').then((m) => ({ default: m.AuctionDialog })),
)

const dateFmt = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function HealthDot({ health }: { health: Health | null }) {
  const ok = health?.status === 'ok'
  return (
    <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
      <span
        className={`size-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-destructive'}`}
        aria-hidden
      />
      {health ? `api ${health.status} · db ${health.db}` : 'connecting…'}
    </span>
  )
}

function HandleLookup() {
  const [handle, setHandle] = useState('')
  const [user, setUser] = useState<User | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!handle.trim()) return
    setBusy(true)
    try {
      setUser(await lookupUser(handle))
      setError(null)
    } catch (err) {
      setUser(null)
      setError(err instanceof ApiError ? err.message : 'Lookup failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Resolve a handle</CardTitle>
        <CardDescription>
          @username → XRPL address, so raw r-addresses never reach the UI
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={submit} className="flex gap-2">
          <Input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="@stationsquare"
            aria-label="username"
          />
          <Button type="submit" disabled={busy || !handle.trim()}>
            {busy ? '…' : 'Look up'}
          </Button>
        </form>

        {error && <p className="text-destructive text-sm">{error}</p>}

        {user && (
          <div className="space-y-1 rounded-md border p-3 text-sm">
            <div className="font-medium">
              {user.displayName ?? user.username}{' '}
              <span className="text-muted-foreground font-normal">@{user.username}</span>
            </div>
            <div className="text-muted-foreground font-mono text-xs break-all">
              {user.xrplAddress}
            </div>
            <div className="text-muted-foreground text-xs">
              {user.ticketsOwned} ticket{user.ticketsOwned === 1 ? '' : 's'} in inventory
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function EventList({
  events,
  auctionSlugs,
  onOpenAuction,
}: {
  events: EventSummary[]
  /** Slugs with a live auction, from GET /api/auctions. */
  auctionSlugs: ReadonlySet<string>
  onOpenAuction: (event: EventSummary) => void
}) {
  if (events.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No events yet — run <code className="font-mono">npm run db:seed</code> in backend/.
      </p>
    )
  }

  return (
    <ul className="space-y-3">
      {events.map((e) => {
        // Only an event with a live auction is interactive. Everything else is
        // a plain row, so clicking never opens an empty window.
        const live = auctionSlugs.has(e.slug)

        const body = (
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-medium">{e.title}</div>
              <div className="text-muted-foreground text-sm">
                {e.venue} · {dateFmt.format(new Date(e.startsAt))}
              </div>
              <div className="text-muted-foreground mt-1 text-xs">
                by @{e.organizer.username} · {e.ticketsMinted}/{e.ticketCount} minted
              </div>
              {live && (
                <div className="text-primary mt-2 text-xs font-medium">
                  View live bidding →
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Badge variant={e.status === 'SOLD_OUT' ? 'destructive' : 'secondary'}>
                {e.status.replace('_', ' ').toLowerCase()}
              </Badge>
              {live && (
                <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                  <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden />
                  auction live
                </span>
              )}
            </div>
          </div>
        )

        return (
          <li key={e.slug}>
            {live ? (
              // A real button, not a clickable div — it must be keyboard
              // reachable and announced as activatable.
              <button
                type="button"
                onClick={() => onOpenAuction(e)}
                aria-label={`View live bidding for ${e.title}`}
                className="hover:border-primary/60 hover:bg-accent/40 focus-visible:ring-ring w-full rounded-lg border p-4 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                {body}
              </button>
            ) : (
              <div className="rounded-lg border p-4">{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Inventory({ me, onSignOut }: { me: User; onSignOut: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {me.displayName ?? me.username}{' '}
          <span className="text-muted-foreground font-normal">@{me.username}</span>
        </CardTitle>
        <CardDescription className="font-mono text-xs break-all">
          {me.xrplAddress}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">
          {me.ticketsOwned === 0
            ? 'No tickets in your inventory yet.'
            : `${me.ticketsOwned} ticket${me.ticketsOwned === 1 ? '' : 's'} in your inventory.`}
        </p>
        <Button variant="secondary" size="sm" onClick={onSignOut}>
          Sign out
        </Button>
      </CardContent>
    </Card>
  )
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [events, setEvents] = useState<EventSummary[]>([])
  const [me, setMe] = useState<User | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Which event's auction window is open, or null for none.
  const [auctionEvent, setAuctionEvent] = useState<EventSummary | null>(null)
  const [auctions, setAuctions] = useState<AuctionSummary[]>([])

  const load = useCallback(async () => {
    try {
      const [h, e, a] = await Promise.all([fetchHealth(), fetchEvents(), fetchAuctions()])
      setHealth(h)
      setEvents(e)
      setAuctions(a)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unknown error')
    }
  }, [])

  // Restore an existing session. The cookie is unreadable from here, so the
  // only way to know is to ask; a 401 simply means not signed in.
  const restore = useCallback(async () => {
    try {
      setMe(await fetchMe())
    } catch {
      setMe(null)
    }
  }, [])

  useEffect(() => {
    // Drop any token the previous localStorage scheme left behind.
    purgeLegacyToken()
    void load()
    void restore()
  }, [load, restore])

  // Stable identity: SignIn's polling effect depends on this, and a new
  // function each render would restart the poll loop continuously.
  const handleAuthenticated = useCallback((_user: AuthUser) => {
    // The cookie is already set by the response that told us this. Re-fetch
    // through /auth/me so the view uses one canonical shape.
    void fetchMe()
      .then(setMe)
      .catch(() => setMe(null))
  }, [])

  const handleSignOut = useCallback(async () => {
    await signOut()
    setMe(null)
  }, [])

  // A fresh mint changes both the event's minted count and the issuer's
  // inventory. Stable identity — MintPanel's poll effect depends on it.
  const handleMinted = useCallback(() => {
    void load()
    void restore()
  }, [load, restore])

  return (
    <main className="mx-auto min-h-svh max-w-2xl space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">HubWorld</h1>
          <p className="text-muted-foreground text-sm">Your events, in one place</p>
        </div>
        <HealthDot health={health} />
      </header>

      {error && <p className="text-destructive text-sm">{error}</p>}

      {me ? (
        <Inventory me={me} onSignOut={() => void handleSignOut()} />
      ) : (
        <SignIn onAuthenticated={handleAuthenticated} />
      )}

      {me && (
        <>
          <MintPanel
            events={events.filter((e) => e.organizer.username === me.username)}
            onMinted={handleMinted}
          />
          <DoorPanel events={events.filter((e) => e.organizer.username === me.username)} />
          <GiftPanel onChanged={handleMinted} />
          <SellPanel onChanged={handleMinted} />
        </>
      )}

      <HandleLookup />

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Events</h2>
        <EventList
          events={events}
          auctionSlugs={new Set(auctions.map((a) => a.eventSlug))}
          onOpenAuction={setAuctionEvent}
        />
      </section>

      {auctionEvent && (
        <Suspense fallback={null}>
          <AuctionDialog
            slug={auctionEvent.slug}
            title={auctionEvent.title}
            open={true}
            signedIn={me !== null}
            onOpenChange={(open) => {
              if (!open) setAuctionEvent(null)
            }}
          />
        </Suspense>
      )}
    </main>
  )
}
