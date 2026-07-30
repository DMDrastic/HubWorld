/**
 * Theme selection.
 *
 * Dark is the default and the design's primary target; light is fully supported
 * rather than a fallback. The choice persists in localStorage, so it survives a
 * reload — this is a display preference, not a credential, and nothing here is
 * sensitive (see `purgeLegacyToken` for why the session deliberately is not).
 *
 * `useSyncExternalStore` for the same reason the router uses it: the current
 * theme lives on `documentElement`, which is genuinely external state. Reading
 * it into `useState` and correcting in an effect renders once with the wrong
 * value, which shows as a flash.
 *
 * The class is applied BEFORE React mounts, by the inline script in index.html.
 * Doing it here instead would paint the light theme first and then repaint —
 * exactly the flash the script exists to prevent.
 */
import { useSyncExternalStore } from 'react'

export type Theme = 'dark' | 'light'

export const THEME_KEY = 'hubworld_theme'

function current(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

const listeners = new Set<() => void>()

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function setTheme(theme: Theme): void {
  const root = document.documentElement

  // Cards and buttons carry `transition-all` for their hover states, which also
  // catches the background and border colours. Without this guard, flipping the
  // theme ANIMATES every surface from one palette to the other — a visible
  // ~150ms sweep where each card passes through mid-grey and its text through
  // its own contrast floor. Confirmed by screenshotting mid-switch. Suppress
  // transitions for the swap, then restore them.
  root.classList.add('theme-switching')
  root.classList.toggle('dark', theme === 'dark')

  try {
    window.localStorage.setItem(THEME_KEY, theme)
  } catch {
    // Private browsing and blocked storage: the toggle still works for this
    // page view, it just will not be remembered. Not worth failing over.
  }

  // Two frames: the first lets the new colours paint with transitions off, the
  // second removes the guard. Removing it in a single frame can land in the
  // same style recalculation and re-enable the animation we just suppressed.
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => root.classList.remove('theme-switching'))
  })

  for (const fn of listeners) fn()
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, current, () => 'dark' as Theme)
  return [theme, setTheme]
}
