/**
 * The boundary is the difference between a broken page and a blank one.
 *
 * React unmounts the entire tree when a render throws with nothing to catch it,
 * so the failure mode being tested here is not "an ugly error" — it is a white
 * screen with no message and no way back. That is invisible to every other test
 * in this suite, because they all render components that work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ErrorBoundary } from '@/components/ErrorBoundary'

function Boom(): React.ReactNode {
  throw new Error('ledger went sideways')
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React logs caught render errors to console.error by design. Silence it so
    // a passing run is not full of red, but assert on it below rather than
    // dropping the signal entirely.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders children untouched when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>the hub</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('the hub')).toBeTruthy()
  })

  it('catches a render error instead of unmounting the tree', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Something broke')).toBeTruthy()
  })

  it("shows the error's message, which is often the only usable clue", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText('ledger went sideways')).toBeTruthy()
  })

  it('offers a way out rather than stranding the user', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Back to the hub' })).toBeTruthy()
  })

  it('reassures that nothing was lost, because the ledger holds the tickets', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText(/nothing has been lost/i)).toBeTruthy()
  })

  it('still reports the error to the console for debugging', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(logged.some((args) => String(args[0]).includes('Unhandled render error'))).toBe(true)
  })

  it('leaves the hub navigable from the fallback', () => {
    // A router push would keep the broken tree mounted and re-render straight
    // back into the error, so this must be a full navigation.
    const { location } = window
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...location, href: '/somewhere', reload: vi.fn() },
    })

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back to the hub' }))
    expect(window.location.href).toBe('/')

    Object.defineProperty(window, 'location', { configurable: true, value: location })
  })
})
