/**
 * Minimal history-based routing.
 *
 * A nav bar whose links do not change the URL is a lie: the back button breaks,
 * nothing is shareable, and a refresh dumps you somewhere else. But this app has
 * six destinations and no nested or dynamic routes, so `react-router` would be a
 * dependency and an architectural commitment bought for very little.
 *
 * `useSyncExternalStore` rather than `useState` + an effect, because the URL is
 * genuinely external state. The effect version renders once with a stale path
 * before correcting itself, which shows as a flash of the wrong view.
 *
 * NOTE: deep links only work in dev because Vite serves index.html for unknown
 * paths. A production deploy needs the same SPA fallback, or /tickets 404s on
 * refresh.
 */
import { useCallback, useSyncExternalStore } from 'react'

export const ROUTES = ['/', '/events', '/tickets', '/market', '/organize', '/door'] as const
export type Route = (typeof ROUTES)[number]

function isRoute(path: string): path is Route {
  return (ROUTES as readonly string[]).includes(path)
}

/** Unknown paths fall back to the hub rather than rendering nothing. */
function current(): Route {
  const path = window.location.pathname
  return isRoute(path) ? path : '/'
}

const listeners = new Set<() => void>()

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  window.addEventListener('popstate', fn)
  return () => {
    listeners.delete(fn)
    window.removeEventListener('popstate', fn)
  }
}

export function navigate(to: Route): void {
  if (window.location.pathname === to) return
  window.history.pushState(null, '', to)
  // pushState does not fire popstate, so subscribers are notified by hand.
  for (const fn of listeners) fn()
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, current, () => '/' as Route)
}

/**
 * Click handler for an anchor that should route rather than reload.
 *
 * Kept as a real `<a href>` at the call site so middle-click, copy-link and
 * open-in-new-tab keep working — a div with an onClick loses all of that.
 */
export function useLinkHandler(): (to: Route) => (e: React.MouseEvent) => void {
  return useCallback(
    (to: Route) => (e: React.MouseEvent) => {
      // Let the browser handle modified clicks: new tab, new window, download.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
      e.preventDefault()
      navigate(to)
    },
    [],
  )
}
