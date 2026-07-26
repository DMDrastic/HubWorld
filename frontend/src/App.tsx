import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  fetchEvents,
  fetchHealth,
  fetchMe,
  lookupUser,
  purgeLegacyToken,
  signOut,
  type AuthUser,
  type EventSummary,
  type Health,
  type User,
} from '@/lib/api'
import { SignIn } from '@/components/SignIn'
import { MintPanel } from '@/components/MintPanel'
import { GiftPanel } from '@/components/GiftPanel'
import { SellPanel } from '@/components/SellPanel'
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

function EventList({ events }: { events: EventSummary[] }) {
  if (events.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No events yet — run <code className="font-mono">npm run db:seed</code> in backend/.
      </p>
    )
  }

  return (
    <ul className="space-y-3">
      {events.map((e) => (
        <li key={e.slug} className="rounded-lg border p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-medium">{e.title}</div>
              <div className="text-muted-foreground text-sm">
                {e.venue} · {dateFmt.format(new Date(e.startsAt))}
              </div>
              <div className="text-muted-foreground mt-1 text-xs">
                by @{e.organizer.username} · {e.ticketsMinted}/{e.ticketCount} minted
              </div>
            </div>
            <Badge variant={e.status === 'SOLD_OUT' ? 'destructive' : 'secondary'}>
              {e.status.replace('_', ' ').toLowerCase()}
            </Badge>
          </div>
        </li>
      ))}
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

  const load = useCallback(async () => {
    try {
      const [h, e] = await Promise.all([fetchHealth(), fetchEvents()])
      setHealth(h)
      setEvents(e)
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
          <GiftPanel onChanged={handleMinted} />
          <SellPanel onChanged={handleMinted} />
        </>
      )}

      <HandleLookup />

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Events</h2>
        <EventList events={events} />
      </section>
    </main>
  )
}
