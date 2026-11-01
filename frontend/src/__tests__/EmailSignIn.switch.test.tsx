/**
 * Someone who is still signed in to the email wallet from earlier (a stale browser session) can switch to a different email without
 * first signing in as the old one. Written before the change.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { EmailSignIn } from '@/components/EmailSignIn'
import { WithRuntime, fakeRuntime } from './fakeRuntime'

afterEach(() => vi.unstubAllGlobals())

describe('EmailSignIn when the browser still remembers an email wallet', () => {
  it('offers "Use a different email", and it signs that wallet out so the next sign-in can be someone else', () => {
    const runtime = fakeRuntime({ authenticated: true })
    render(
      <WithRuntime runtime={runtime}>
        <EmailSignIn onAuthenticated={vi.fn()} />
      </WithRuntime>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Use a different email' }))
    expect(runtime.logout).toHaveBeenCalledTimes(1)
  })

  it('says whose wallet it remembers, so the person knows why', () => {
    render(
      <WithRuntime runtime={fakeRuntime({ authenticated: true })}>
        <EmailSignIn onAuthenticated={vi.fn()} />
      </WithRuntime>,
    )
    expect(screen.getByText(/remembers an email wallet/i)).toBeTruthy()
  })

  it('shows nothing of the kind when nobody is remembered', () => {
    render(
      <WithRuntime runtime={fakeRuntime({ authenticated: false, walletAddress: null })}>
        <EmailSignIn onAuthenticated={vi.fn()} />
      </WithRuntime>,
    )
    expect(screen.queryByRole('button', { name: 'Use a different email' })).toBeNull()
    expect(screen.queryByText(/remembers an email wallet/i)).toBeNull()
  })
})
