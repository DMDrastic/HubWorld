/**
 * Top navigation.
 *
 * Destinations are filtered by what the account can actually do, matching the
 * rule the rest of the app follows: organizer surfaces are absent for regular
 * users rather than disabled. A nav link that 403s is worse than no link.
 *
 * Real `<a href>` elements, not buttons — middle-click, copy-link and
 * open-in-new-tab all keep working, and the router only intercepts plain left
 * clicks.
 */
import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { isOrganizer, type Health, type User } from '@/lib/api'
import { useLinkHandler, type Route } from '@/lib/router'
import { useTheme } from '@/lib/theme'

type Destination = { to: Route; label: string }

function destinations(me: User | null, hasDoor: boolean): Destination[] {
  // Signed out, Events is still worth reaching: it is about the world rather
  // than about you, and the API serves it publicly. Asking someone to connect a
  // crypto wallet before they may even look at what is on is the same mistake
  // the landing page was written to fix. Everything else stays absent, because
  // the remaining destinations describe things only an account can have.
  if (!me) return [{ to: '/events', label: 'Events' }]

  const base: Destination[] = [
    { to: '/', label: 'Hub' },
    { to: '/events', label: 'Events' },
    { to: '/tickets', label: 'Tickets' },
    { to: '/market', label: 'Market' },
  ]
  // A volunteer is a plain USER with a door, so this cannot be decided by role.
  if (hasDoor) base.push({ to: '/door', label: 'Door' })
  if (isOrganizer(me.role)) base.push({ to: '/organize', label: 'Organize' })
  return base
}

/**
 * Which ledger this is, shown only when it is NOT mainnet.
 *
 * On testnet or devnet the label is a caveat on everything else on screen: the
 * tickets are not real and the money is not real. That is worth saying plainly
 * and permanently, not hiding in a tooltip.
 *
 * On mainnet it renders nothing, deliberately. Mainnet is simply the product,
 * and a chip reading "MAINNET" is developer chrome leaking into a consumer UI —
 * it tells an attendee buying a ticket nothing they need. The operator's check
 * lives in the health tooltip instead, which names the network in every case
 * including mainnet, so an absent chip is never ambiguous between "we are on
 * mainnet" and "this build is too old to say".
 *
 * Styled `muted` rather than `destructive`. Nothing is broken on testnet — it
 * is a fact about the environment, not a fault — and CLAUDE.md is explicit that
 * borrowing `destructive` for warnings must not spread further.
 */
function NetworkBadge({ health }: { health: Health | null }) {
  // Absent on an older API that predates the field; nothing to claim, so
  // nothing is shown rather than guessing a default.
  if (!health?.network || health.network === 'mainnet') return null

  return (
    <span
      className="bg-muted text-muted-foreground rounded-lg px-2 py-1 font-mono text-xs"
      title={`Connected to the XRPL ${health.network}. Tickets and payments here are not real.`}
    >
      {health.network}
    </span>
  )
}

function HealthDot({ health }: { health: Health | null }) {
  const ok = health?.status === 'ok'
  // The network is named here in EVERY case, mainnet included, so the operator
  // always has one place to confirm it — see NetworkBadge.
  const detail = health
    ? `api ${health.status} · db ${health.db}${health.network ? ` · ${health.network}` : ''}`
    : 'connecting'
  return (
    <span className="flex items-center gap-1.5" title={detail}>
      <span className="relative flex size-1.5">
        {ok && (
          <span className="bg-live absolute inline-flex size-full animate-ping rounded-full opacity-60" />
        )}
        <span
          className={`relative inline-flex size-1.5 rounded-full ${
            ok ? 'bg-live' : 'bg-destructive animate-pulse'
          }`}
          aria-hidden
        />
      </span>
      <span className="sr-only">{health ? `API ${health.status}` : 'connecting'}</span>
    </span>
  )
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      // The label names the DESTINATION, not the current state — "dark mode" on
      // a button that is already dark reads as a status, not a control.
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring flex size-8 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      {theme === 'dark' ? <Moon className="size-4" /> : <Sun className="size-4" />}
    </button>
  )
}

/** The mark: a ring of destinations around a centre — the hub-world idea. */
/**
 * The HubWorld mark: two nodes orbiting a hub.
 *
 * The layer order is the whole trick — back half of the orbit, then the
 * diamond, then the front half — so the ring passes behind and in front of the
 * hub. Flatten it and the mark loses its dimensionality.
 *
 * It carries its own gradient rather than inheriting `currentColor`, so the
 * tinted container the old placeholder sat in is gone: a gradient inside a
 * gradient-ringed plate was two competing treatments of the same idea.
 *
 * The gradient id is namespaced. `favicon.svg` defines its own `hw`, and an
 * inline SVG sharing a document with another `id="hw"` would silently take
 * whichever the browser resolved first.
 *
 * The orbit replays when the tab is returned to. A CSS animation fires once per
 * element, so the nodes are re-keyed to remount them — the cheapest honest way
 * to restart it, and it costs nothing while the tab is hidden because the event
 * only fires on the way back. Guarded on `visible` because visibilitychange
 * fires in BOTH directions, and replaying on the way out would animate a mark
 * nobody is looking at.
 */
function Mark() {
  const [run, setRun] = useState(0)

  useEffect(() => {
    const replay = () => {
      if (document.visibilityState === 'visible') setRun((n) => n + 1)
    }
    document.addEventListener('visibilitychange', replay)
    return () => document.removeEventListener('visibilitychange', replay)
  }, [])

  return (
    <svg viewBox="0 0 100 100" className="size-9 shrink-0" aria-hidden>
      <defs>
        <linearGradient id="hw-nav" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f8cff" />
          <stop offset="1" stopColor="#7a5cff" />
        </linearGradient>
      </defs>
      <g transform="rotate(-18 50 50)">
        <ellipse cx="50" cy="50" rx="46" ry="23" fill="none" stroke="url(#hw-nav)" strokeWidth="5.5" />
        <g key={`back-${run}`} className="hw-node hw-node-back">
          <circle r="7" fill="#ffffff" stroke="#1e40af" strokeWidth="2" />
        </g>
      </g>
      <rect x="32" y="32" width="36" height="36" rx="9" transform="rotate(45 50 50)" fill="url(#hw-nav)" />
      <g transform="rotate(-18 50 50)">
        <path d="M4,50 A46,23 0 0 0 96,50" fill="none" stroke="url(#hw-nav)" strokeWidth="5.5" />
        <g key={`front-${run}`} className="hw-node hw-node-front">
          <circle r="8" fill="#ffffff" stroke="#1e40af" strokeWidth="2" />
        </g>
      </g>
    </svg>
  )
}

export function NavBar({
  me,
  health,
  route,
  hasDoor,
  onSignOut,
}: {
  me: User | null
  health: Health | null
  route: Route
  hasDoor: boolean
  onSignOut: () => void
}) {
  const link = useLinkHandler()
  const items = destinations(me, hasDoor)

  return (
    <header className="bg-background/70 sticky top-0 z-40 border-b backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4">
        <a
          href="/"
          onClick={link('/')}
          className="flex shrink-0 items-center gap-2.5 text-[0.95rem] font-semibold tracking-tight"
        >
          <Mark />
          HubWorld
        </a>

        <nav className="hidden flex-1 items-center gap-0.5 sm:flex">
          {items.map((d) => {
            const active = route === d.to
            return (
              <a
                key={d.to}
                href={d.to}
                onClick={link(d.to)}
                aria-current={active ? 'page' : undefined}
                className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? 'bg-primary/12 text-primary font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/60'
                }`}
              >
                {d.label}
              </a>
            )
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2 text-sm">
          <NetworkBadge health={health} />
          <HealthDot health={health} />
          <ThemeToggle />
          {me ? (
            <div className="flex items-center gap-2">
              <span className="bg-muted text-muted-foreground hidden rounded-lg px-2 py-1 font-mono text-xs md:inline">
                @{me.username}
              </span>
              <button
                type="button"
                onClick={onSignOut}
                className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
              >
                Sign out
              </button>
            </div>
          ) : (
            <span className="text-muted-foreground text-xs">not signed in</span>
          )}
        </div>
      </div>

      {/* Narrow screens: the same destinations, scrollable, below the brand. */}
      {items.length > 0 && (
        <nav className="flex gap-1 overflow-x-auto border-t px-4 py-2 sm:hidden">
          {items.map((d) => (
            <a
              key={d.to}
              href={d.to}
              onClick={link(d.to)}
              aria-current={route === d.to ? 'page' : undefined}
              className={`shrink-0 rounded-lg px-3 py-1 text-sm ${
                route === d.to
                  ? 'bg-primary/12 text-primary font-medium'
                  : 'text-muted-foreground'
              }`}
            >
              {d.label}
            </a>
          ))}
        </nav>
      )}
    </header>
  )
}
