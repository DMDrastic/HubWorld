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
import { isOrganizer, type Health, type User } from '@/lib/api'
import { useLinkHandler, type Route } from '@/lib/router'

type Destination = { to: Route; label: string }

function destinations(me: User | null, hasDoor: boolean): Destination[] {
  if (!me) return []

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

function HealthDot({ health }: { health: Health | null }) {
  const ok = health?.status === 'ok'
  return (
    <span
      className="flex items-center gap-1.5"
      title={health ? `api ${health.status} · db ${health.db}` : 'connecting'}
    >
      <span
        className={`size-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-destructive animate-pulse'}`}
        aria-hidden
      />
      <span className="sr-only">{health ? `API ${health.status}` : 'connecting'}</span>
    </span>
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
    <header className="bg-background/80 sticky top-0 z-40 border-b backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4">
        <a
          href="/"
          onClick={link('/')}
          className="flex shrink-0 items-center gap-2 font-semibold tracking-tight"
        >
          {/* The mark: a ring of destinations around a centre, which is the
              hub-world idea the product is named for. */}
          <span className="bg-primary/10 text-primary flex size-7 items-center justify-center rounded-md">
            <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden>
              <circle cx="12" cy="12" r="3" fill="currentColor" />
              <circle cx="12" cy="4" r="1.8" fill="currentColor" opacity=".55" />
              <circle cx="20" cy="12" r="1.8" fill="currentColor" opacity=".55" />
              <circle cx="12" cy="20" r="1.8" fill="currentColor" opacity=".55" />
              <circle cx="4" cy="12" r="1.8" fill="currentColor" opacity=".55" />
            </svg>
          </span>
          HubWorld
        </a>

        <nav className="hidden flex-1 items-center gap-1 sm:flex">
          {items.map((d) => {
            const active = route === d.to
            return (
              <a
                key={d.to}
                href={d.to}
                onClick={link(d.to)}
                aria-current={active ? 'page' : undefined}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                }`}
              >
                {d.label}
              </a>
            )
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3 text-sm">
          <HealthDot health={health} />
          {me ? (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground hidden md:inline">@{me.username}</span>
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
              className={`shrink-0 rounded-md px-3 py-1 text-sm ${
                route === d.to
                  ? 'bg-accent text-accent-foreground font-medium'
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
