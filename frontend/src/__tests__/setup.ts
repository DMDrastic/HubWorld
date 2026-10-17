import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// jsdom does not implement matchMedia at all, so any component reading
// prefers-reduced-motion (or any other media query) throws on mount rather
// than just reporting false. Default to "no preference" — tests that care
// about the reduced-motion branch specifically can still override this.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

// jsdom does not implement IntersectionObserver either — any component using
// one (scroll-driven reveals, the phone showcase's active-step tracking)
// throws on mount instead of just never firing a callback, which is the
// accurate jsdom behaviour: there is no layout, so nothing would ever
// intersect anyway.
if (!window.IntersectionObserver) {
  class NoopIntersectionObserver implements IntersectionObserver {
    readonly root = null
    readonly rootMargin = ''
    readonly scrollMargin = ''
    readonly thresholds: ReadonlyArray<number> = []
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }
  window.IntersectionObserver = NoopIntersectionObserver
}

// Unmount between tests so a leaked polling timer from one test cannot fire
// into the next and make failures look random.
afterEach(() => {
  cleanup()
})
