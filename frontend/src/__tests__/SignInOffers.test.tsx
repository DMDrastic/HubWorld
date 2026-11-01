/**
 * Email sign-in is a way in for EVERYONE, not only organizers: a ticket holder's wallet is now the one that signs their
 * purchases and listings. Written before the change.
 *
 * It appears wherever a visitor can sign in (the pages that need an account, and the landing page), and only when the Privy
 * host has reported a runtime: a deployment with email sign-in switched off, or a visit where the chunk has not arrived, shows
 * exactly what it showed before.
 */
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SignInRequired } from '@/components/SignInRequired'
import { Landing } from '@/components/Landing'
import { WithRuntime, fakeRuntime } from './fakeRuntime'

vi.mock('@/lib/router', async () => {
  const actual = await vi.importActual<typeof import('@/lib/router')>('@/lib/router')
  return { ...actual }
})

describe('the pages that need an account', () => {
  it('offer "Continue with email" beside Xaman when the email wallet is available, on ANY of them', () => {
    render(
      <StrictMode>
        <WithRuntime runtime={fakeRuntime({ authenticated: false, walletAddress: null })}>
          <SignInRequired title="Tickets" blurb="b" onAuthenticated={vi.fn()} />
        </WithRuntime>
      </StrictMode>,
    )
    expect(screen.getByRole('button', { name: 'Continue with email' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy()
  })

  it('offer only Xaman when there is no email wallet, exactly as before', () => {
    render(
      <WithRuntime runtime={null}>
        <SignInRequired title="Tickets" blurb="b" onAuthenticated={vi.fn()} />
      </WithRuntime>,
    )
    expect(screen.queryByRole('button', { name: 'Continue with email' })).toBeNull()
    expect(screen.queryByText(/sign in with email/i)).toBeNull()
  })
})

describe('the landing page', () => {
  const landing = (runtime: ReturnType<typeof fakeRuntime> | null) =>
    render(
      <WithRuntime runtime={runtime}>
        <Landing onAuthenticated={vi.fn()} />
      </WithRuntime>,
    )

  it('offers "Continue with email" next to the main button when the email wallet is available', () => {
    landing(fakeRuntime({ authenticated: false, walletAddress: null }))
    expect(screen.getByRole('button', { name: 'Continue with email' })).toBeTruthy()
  })

  it('shows nothing extra when it is not', () => {
    landing(null)
    expect(screen.queryByRole('button', { name: 'Continue with email' })).toBeNull()
  })
})
