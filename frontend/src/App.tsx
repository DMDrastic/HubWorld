import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  fetchAuctions,
  fetchDoorEvents,
  fetchEvents,
  fetchHealth,
  fetchMe,
  lookupUser,
  isOrganizer,
  onAuthLost,
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
import { SignInRequired } from '@/components/SignInRequired'
import { Hub } from '@/components/Hub'
import { EventList } from '@/components/EventList'
import { EventImagePanel } from '@/components/EventImagePanel'
import { useRoute } from '@/lib/router'
import { OrganizerPanel } from '@/components/OrganizerPanel'
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

  // Ask the server who this browser is. The cookie is unreadable from here, so
  // asking is the only way to know; a 401 simply means not signed in.
  //
  // Only a 401 clears the identity. A transport failure carries no status and
  // says nothing about who is signed in — clearing `me` there would sign
  // someone out because the backend blinked.
  const restore = useCallback(async () => {
    try {
      setMe(await fetchMe())
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setMe(null)
    }
  }, [])

  useEffect(() => {
    // Drop any token the previous localStorage scheme left behind.
    purgeLegacyToken()
    void load()
    void restore()
  }, [load, restore])

  // Any 401, from any call, means the session this page has been assuming is
  // gone. Without this the header kept naming an account whose requests were
  // all being refused — or worse, attributed to whoever the cookie now named.
  useEffect(() => onAuthLost(() => setMe(null)), [])

  // The cookie can also change while this tab is not looking: signing in as a
  // different account in another tab is the ordinary way it happens, and this
  // tab is never told. So re-ask on the way back rather than trusting a snapshot
  // taken at mount.
  //
  // Deliberately event-driven, not polled. `restore` is stable, so this
  // subscribes once and cannot become a request loop the way a poll keyed on
  // fetched state would — see the GiftPanel note in CLAUDE.md.
  useEffect(() => {
    const revalidate = () => {
      if (document.visibilityState !== 'visible') return
      void restore()
    }
    window.addEventListener('focus', revalidate)
    document.addEventListener('visibilitychange', revalidate)
    return () => {
      window.removeEventListener('focus', revalidate)
      document.removeEventListener('visibilitychange', revalidate)
    }
  }, [restore])

  // Stable identity: SignIn's polling effect depends on this, and a new
  // function each render would restart the poll loop continuously.
  const handleAuthenticated = useCallback(
    (_user: AuthUser) => {
      // The cookie is already set by the response that told us this. Re-fetch
      // through /auth/me so the view uses one canonical shape — and through
      // `restore`, so a network blip on this one call cannot undo a sign-in
      // that genuinely succeeded.
      void restore()
    },
    [restore],
  )

  // The local view is cleared whatever happens — continuing to render a session
  // we just tried to end is the failure being fixed here. But a sign-out that
  // ended nothing is reported rather than shown as success, because that is the
  // symptom of a cookie belonging to someone other than the account on screen.
  const handleSignOut = useCallback(async () => {
    try {
      const { revoked } = await signOut()
      setError(
        revoked ? null : 'Signed out here, but no active session was found to end on the server.',
      )
    } catch (err) {
      setError(
        err instanceof ApiError ? `Sign-out failed: ${err.message}` : 'Sign-out could not reach the backend.',
      )
    } finally {
      setMe(null)
    }
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

        {/* `/` and `/events` render for everybody. The rest describe an account
            — what you hold, what you are selling, whose door you work — so
            signed out they say why they are empty instead of silently rendering
            the landing page under someone else's URL. */}
        {route === '/' &&
          (me ? (
            <Hub me={me} onOpenAuction={openAuctionBySlug} />
          ) : (
            <Landing onAuthenticated={handleAuthenticated} network={health?.network} />
          ))}

        {route === '/events' && (
          <section className="space-y-4 py-8">
            <div>
              <h1 className="text-3xl font-semibold tracking-[-0.02em]">Events</h1>
              <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
                Sold-out nights open for bidding are marked live.
                {!me && ' Anyone can watch an auction; bidding needs a wallet.'}
              </p>
            </div>
            <EventList
              events={events}
              auctionSlugs={auctionSlugs}
              onOpenAuction={setAuctionEvent}
            />
          </section>
        )}

        {route === '/tickets' &&
          (me ? (
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
          ) : (
            <SignInRequired
              title="Your tickets"
              blurb="Tickets live in your own wallet, so this page is whatever that wallet holds. Sign in to see yours."
              onAuthenticated={handleAuthenticated}
            />
          ))}

        {route === '/market' &&
          (me ? (
            <section className="space-y-4 py-8">
              <div>
                <h1 className="text-3xl font-semibold tracking-[-0.02em]">Marketplace</h1>
                <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
                  Resales settle on-ledger. The organizer earns a royalty on every one.
                </p>
              </div>
              <SellPanel onChanged={handleMinted} />
            </section>
          ) : (
            <SignInRequired
              title="Marketplace"
              blurb="Buying and selling both need a wallet to sign with — a resale moves the ticket and the money in one on-ledger transaction."
              onAuthenticated={handleAuthenticated}
            />
          ))}

        {route === '/door' &&
          (me ? (
            <section className="space-y-4 py-8">
              <div>
                <h1 className="text-3xl font-semibold tracking-[-0.02em]">Door</h1>
                <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
                  Attendees sign to prove the ticket is theirs. The verdict shows here.
                </p>
              </div>
              <DoorPanel />
            </section>
          ) : (
            <SignInRequired
              title="Door"
              blurb="Working a door is granted per event, so this page depends on who you are. Sign in to see the doors you may work."
              onAuthenticated={handleAuthenticated}
            />
          ))}

        {route === '/organize' && !me && (
          <SignInRequired
            title="Organize"
            blurb="Issuing tickets means minting from your own wallet, so it starts with signing in. Organizer access is reviewed by a person."
            onAuthenticated={handleAuthenticated}
          />
        )}

        {route === '/organize' && me && isOrganizer(me.role) && (
          <section className="space-y-4 py-8">
            <div>
              <h1 className="text-3xl font-semibold tracking-[-0.02em]">Organize</h1>
              <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
                Create events and issue tickets. Your royalty follows every resale.
              </p>
            </div>
            <OrganizerPanel role={me.role} onChanged={handleMinted} />
            <EventImagePanel events={organizing} onChanged={handleMinted} />
            <MintPanel events={organizing} onMinted={handleMinted} />
          </section>
        )}

        {/* A regular user who types /organize gets the application form
            rather than a blank page or a 403. */}
        {route === '/organize' && me && !isOrganizer(me.role) && (
          <section className="space-y-4 py-8">
            <h1 className="text-2xl font-semibold tracking-tight">Run your own events</h1>
            <OrganizerPanel role={me.role} onChanged={handleMinted} />
          </section>
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
