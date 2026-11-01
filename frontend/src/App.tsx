import { Fragment, Suspense, lazy, useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  fetchAuctions,
  fetchDoorEvents,
  fetchEvents,
  fetchHealth,
  fetchMe,
  fetchPolicy,
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
  type Policy,
  type User,
} from '@/lib/api'
import { MintPanel } from '@/components/MintPanel'
import { DelegationPanel } from '@/components/DelegationPanel'
import { BulkMintPanel } from '@/components/BulkMintPanel'
import { CheckoutDialog } from '@/components/CheckoutDialog'
import { GiftPanel } from '@/components/GiftPanel'
import { TicketWallet } from '@/components/TicketWallet'
import { SellPanel } from '@/components/SellPanel'
import { DoorPanel } from '@/components/DoorPanel'
import { NavBar } from '@/components/NavBar'
import { EmailVerifyNotice } from '@/components/EmailVerifyNotice'
import { Landing } from '@/components/Landing'
import { PageBackdrop } from '@/components/PageBackdrop'
import { SignInRequired } from '@/components/SignInRequired'
import { WithSigner } from '@/components/WithSigner'
import { PolicyContext } from '@/lib/policy-context'
import { Hub } from '@/components/Hub'
import { Footer } from '@/components/Footer'
import { EventList } from '@/components/EventList'
import { EventImagePanel } from '@/components/EventImagePanel'
import { useRoute } from '@/lib/router'
import { OrganizerPanel } from '@/components/OrganizerPanel'
import { PageHeader } from '@/components/PageHeader'
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
        <CardTitle>Look up a handle</CardTitle>
        <CardDescription>Check whose wallet an @handle points to before you gift to it.</CardDescription>
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
  // What this deployment offers. Failing to read it is not an error: it just means Xaman only.
  const [policy, setPolicy] = useState<Policy | null>(null)
  useEffect(() => {
    let stale = false
    fetchPolicy()
      .then((p) => {
        if (!stale) setPolicy(p)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [])
  const privyOn = Boolean(policy?.signers?.includes('privy') && policy.privyAppId)
  const [error, setError] = useState<string | null>(null)
  // Which event's auction window is open, or null for none.
  const [auctionEvent, setAuctionEvent] = useState<EventSummary | null>(null)
  const [buyEvent, setBuyEvent] = useState<EventSummary | null>(null)
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
    // Cleared BEFORE the request, not after it.
    //
    // This used to sit in a `finally`, so the view stayed signed in for the
    // whole round trip. The nav kept offering Organize, Tickets, Market and
    // Door, and a quick click in that window rendered a privileged screen to
    // someone who had just signed out. The server refused every call it made,
    // but refusal is not the standard this app holds itself to: those surfaces
    // are ABSENT for people who cannot use them, because a visible control
    // advertises a capability and invites someone to probe the endpoint behind
    // it. A signed-out organizer briefly seeing the organizer screen is the
    // same defect as showing it to a regular user.
    //
    // Clearing first also fails in the safe direction. The worst case is
    // showing signed-out UI while a session is momentarily still live on the
    // server — which is precisely what `revoked` reports below — rather than
    // showing signed-in UI for a session that is already gone.
    setMe(null)

    try {
      const { revoked } = await signOut()
      setError(
        revoked ? null : 'Signed out here, but no active session was found to end on the server.',
      )
    } catch (err) {
      setError(
        err instanceof ApiError ? `Sign-out failed: ${err.message}` : 'Sign-out could not reach the backend.',
      )
    }
  }, [])

  // A fresh mint changes both the event's minted count and the issuer's
  // inventory. Stable identity — MintPanel's poll effect depends on it.
  const handleMinted = useCallback(() => {
    void load()
    void restore()
  }, [load, restore])

  // The Tickets page: which ticket's Gift button was pressed, and a counter the
  // wallet reloads on once a gift settles.
  const [giftTarget, setGiftTarget] = useState<string | null>(null)
  const [walletVersion, setWalletVersion] = useState(0)
  const handleGiftChanged = useCallback(() => {
    setWalletVersion((v) => v + 1)
    handleMinted()
  }, [handleMinted])
  const chooseGift = useCallback((nfTokenId: string) => {
    setGiftTarget(nfTokenId)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById('gift-panel')?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
  }, [])

  const [doorEvents, setDoorEvents] = useState<DoorEvent[]>([])
  const route = useRoute()
  // Bumped when an emailed confirmation link is spent, so the application panel re-reads it.
  const [emailVerifiedTick, setEmailVerifiedTick] = useState(0)

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

  // Every page carries the landing page's background. The signed-out landing page
  // mounts it itself (it is full-bleed and sequences its own sections), so the shell
  // must not add a second layer under it.
  const Backdrop = route === '/' && !me ? Fragment : PageBackdrop

  const auctionSlugs = new Set(auctions.map((a) => a.eventSlug))
  const organizing = me ? events.filter((e) => e.organizer.username === me.username) : []

  return (
    <PolicyContext.Provider value={policy}>
    {/* The email wallet's code is a separate chunk, fetched after the page is up and only when the server offers it. It sits
        BESIDE the page and reports upward, so loading it never remounts anything. */}
    <WithSigner enabled={privyOn} appId={policy?.privyAppId}>
    <div className="min-h-svh">
      <NavBar
        me={me}
        health={health}
        route={route}
        hasDoor={doorEvents.length > 0}
        onSignOut={() => void handleSignOut()}
      />

      <Backdrop>
      <main className="mx-auto max-w-6xl px-4 pb-24">
        {error && (
          <p className="text-destructive bg-destructive/8 mt-4 rounded-xl border border-current/20 p-3.5 text-sm">
            {error}
          </p>
        )}

        {/* The link in an applicant's confirmation email. It needs no session. */}
        {route === '/organize' && (
          <EmailVerifyNotice onVerified={() => setEmailVerifiedTick((n) => n + 1)} />
        )}

        {/* `/` and `/events` render for everybody. The rest describe an account
            — what you hold, what you are selling, whose door you work — so
            signed out they say why they are empty instead of silently rendering
            the landing page under someone else's URL. */}
        {route === '/' &&
          (me ? (
            <Hub me={me} onOpenAuction={openAuctionBySlug} />
          ) : (
            <Landing onAuthenticated={handleAuthenticated} network={health?.network} events={events} />
          ))}

        {route === '/events' && (
          <section>
            <EventList
              events={events}
              auctionSlugs={auctionSlugs}
              onOpenAuction={setAuctionEvent}
              onBuy={setBuyEvent}
              note={me ? undefined : 'Anyone can watch an auction; bidding needs a wallet.'}
            />
          </section>
        )}

        {route === '/tickets' &&
          (me ? (
            <section className="space-y-4 pb-8">
              <PageHeader
                title="Your tickets"
                description="These live in your own wallet, so they're yours even if HubWorld disappears."
              />
              <TicketWallet version={walletVersion} onGift={chooseGift} />
              <GiftPanel onChanged={handleGiftChanged} selectedId={giftTarget} />
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
            <section className="space-y-4 pb-8">
              <PageHeader
                title="Marketplace"
                description="Resales settle on-ledger. The organizer earns a royalty on every one."
              />
              <SellPanel
                onChanged={handleMinted}
                events={events}
                auctions={auctions}
                onOpenAuction={openAuctionBySlug}
              />
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
            <section className="space-y-4 pb-8">
              <PageHeader
                title="Door"
                description="Check guests in. The verdict shows here, on your device, never on theirs."
              />
              <DoorPanel />
            </section>
          ) : (
            <SignInRequired
              title="Door"
              blurb="Working a door is granted per event, so this page depends on who you are. Sign in to see the doors you may work."
              onAuthenticated={handleAuthenticated}
            />
          ))}

        {route === '/organize' && (
          <>
          {route === '/organize' && !me && (
            <SignInRequired
              title="Organize"
              blurb="Issuing tickets means minting from your own wallet, so it starts with signing in. Organizer access is reviewed by a person."
              onAuthenticated={handleAuthenticated}
            />
          )}

          {route === '/organize' && me && isOrganizer(me.role) && (
            <section className="space-y-4 pb-8">
              <PageHeader
                title="Organize"
                description="Create events and tickets. You earn a cut of every resale."
              />
              <OrganizerPanel role={me.role} onChanged={handleMinted} refreshKey={emailVerifiedTick} />
              <EventImagePanel events={organizing} onChanged={handleMinted} />
              <DelegationPanel />
              <BulkMintPanel events={organizing} onChanged={handleMinted} />
              <MintPanel events={organizing} onMinted={handleMinted} />
            </section>
          )}

          {/* A regular user who types /organize gets the application form
              rather than a blank page or a 403. */}
          {route === '/organize' && me && !isOrganizer(me.role) && (
            <section className="space-y-4 pb-8">
              <PageHeader title="Run your own events" />
              <OrganizerPanel role={me.role} onChanged={handleMinted} refreshKey={emailVerifiedTick} />
            </section>
          )}
          </>
        )}
      </main>
      </Backdrop>

      <Footer health={health} />

      {buyEvent && (
        <CheckoutDialog
          event={buyEvent}
          open={true}
          signedIn={me !== null}
          onOpenChange={(open) => {
            if (!open) setBuyEvent(null)
          }}
          onSold={handleMinted}
        />
      )}

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
    </WithSigner>
    </PolicyContext.Provider>
  )
}
