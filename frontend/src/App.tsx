import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import {
  ApiError,
  fetchAuctions,
  fetchDoorEvents,
  fetchEvents,
  fetchHealth,
  fetchMe,
  lookupUser,
  isOrganizer,
  purgeLegacyToken,
  signOut,
  type AuthUser,
  type AuctionSummary,
  type DoorEvent,
  type EventSummary,
  type Health,
  type User,
} from '@/lib/api'
import { MintPanel } from '@/components/MintPanel'
import { GiftPanel } from '@/components/GiftPanel'
import { SellPanel } from '@/components/SellPanel'
import { DoorPanel } from '@/components/DoorPanel'
import { NavBar } from '@/components/NavBar'
import { Landing } from '@/components/Landing'
import { Hub } from '@/components/Hub'
import { useRoute } from '@/lib/router'
import { OrganizerPanel } from '@/components/OrganizerPanel'
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
            <div className="min-w-0">
              <div className="font-medium tracking-tight">{e.title}</div>
              <div className="text-muted-foreground mt-0.5 text-sm">
                {e.venue} · {dateFmt.format(new Date(e.startsAt))}
              </div>
              <div className="text-muted-foreground mt-1 text-xs">
                by @{e.organizer.username} · {e.ticketsMinted}/{e.ticketCount} minted
              </div>
              {live && (
                <div className="text-live mt-2.5 flex items-center gap-1 text-xs font-medium">
                  View live bidding
                  <ArrowUpRight className="size-3.5" aria-hidden />
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <Badge variant={e.status === 'SOLD_OUT' ? 'destructive' : 'secondary'}>
                {e.status.replace('_', ' ').toLowerCase()}
              </Badge>
              {live && (
                <span className="text-live flex items-center gap-1.5 text-xs font-medium">
                  <span className="relative flex size-1.5">
                    <span className="bg-live absolute inline-flex size-full animate-ping rounded-full opacity-70" />
                    <span className="bg-live relative inline-flex size-1.5 rounded-full" />
                  </span>
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
                className="bg-card ring-foreground/8 hover:ring-live/40 hover:glow-live focus-visible:ring-ring w-full rounded-2xl p-5 text-left ring-1 transition-all focus-visible:ring-2 focus-visible:outline-none"
              >
                {body}
              </button>
            ) : (
              <div className="bg-card ring-foreground/8 rounded-2xl p-5 ring-1">{body}</div>
            )}
          </li>
        )
      })}
    </ul>
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

  const [doorEvents, setDoorEvents] = useState<DoorEvent[]>([])
  const route = useRoute()

  // Door access is per event, so whether to show that destination cannot be
  // decided from the role — a volunteer is a plain USER.
  useEffect(() => {
    if (!me) {
      setDoorEvents([])
      return
    }
    void fetchDoorEvents()
      .then(setDoorEvents)
      .catch(() => setDoorEvents([]))
  }, [me])

  const openAuctionBySlug = useCallback(
    (slug: string) => {
      const found = events.find((e) => e.slug === slug)
      if (found) setAuctionEvent(found)
    },
    [events],
  )

  const auctionSlugs = new Set(auctions.map((a) => a.eventSlug))
  const organizing = me ? events.filter((e) => e.organizer.username === me.username) : []

  return (
    <div className="min-h-svh">
      <NavBar
        me={me}
        health={health}
        route={route}
        hasDoor={doorEvents.length > 0}
        onSignOut={() => void handleSignOut()}
      />

      <main className="mx-auto max-w-6xl px-4 pb-24">
        {error && (
          <p className="text-destructive bg-destructive/8 mt-4 rounded-xl border border-current/20 p-3.5 text-sm">
            {error}
          </p>
        )}

        {!me ? (
          <Landing onAuthenticated={handleAuthenticated} />
        ) : (
          <>
            {route === '/' && <Hub me={me} onOpenAuction={openAuctionBySlug} />}

            {route === '/events' && (
              <section className="space-y-4 py-8">
                <div>
                  <h1 className="text-3xl font-semibold tracking-[-0.02em]">Events</h1>
                  <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
                    Sold-out nights open for bidding are marked live.
                  </p>
                </div>
                <EventList
                  events={events}
                  auctionSlugs={auctionSlugs}
                  onOpenAuction={setAuctionEvent}
                />
              </section>
            )}

            {route === '/tickets' && (
              <section className="space-y-4 py-8">
                <div>
                  <h1 className="text-3xl font-semibold tracking-[-0.02em]">Your tickets</h1>
                  <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
                    Held in your wallet. Gift one to any @handle — it moves on-ledger.
                  </p>
                </div>
                <GiftPanel onChanged={handleMinted} />
                <HandleLookup />
              </section>
            )}

            {route === '/market' && (
              <section className="space-y-4 py-8">
                <div>
                  <h1 className="text-3xl font-semibold tracking-[-0.02em]">Marketplace</h1>
                  <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
                    Resales settle on-ledger. The organizer earns a royalty on every one.
                  </p>
                </div>
                <SellPanel onChanged={handleMinted} />
              </section>
            )}

            {route === '/door' && (
              <section className="space-y-4 py-8">
                <div>
                  <h1 className="text-3xl font-semibold tracking-[-0.02em]">Door</h1>
                  <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
                    Attendees sign to prove the ticket is theirs. The verdict shows here.
                  </p>
                </div>
                <DoorPanel />
              </section>
            )}

            {route === '/organize' && isOrganizer(me.role) && (
              <section className="space-y-4 py-8">
                <div>
                  <h1 className="text-3xl font-semibold tracking-[-0.02em]">Organize</h1>
                  <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
                    Create events and issue tickets. Your royalty follows every resale.
                  </p>
                </div>
                <OrganizerPanel role={me.role} onChanged={handleMinted} />
                <MintPanel events={organizing} onMinted={handleMinted} />
              </section>
            )}

            {/* A regular user who types /organize gets the application form
                rather than a blank page or a 403. */}
            {route === '/organize' && !isOrganizer(me.role) && (
              <section className="space-y-4 py-8">
                <h1 className="text-2xl font-semibold tracking-tight">Run your own events</h1>
                <OrganizerPanel role={me.role} onChanged={handleMinted} />
              </section>
            )}
          </>
        )}
      </main>

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
    </div>
  )
}
