/**
 * The way in to becoming an organizer, from the signed-in home.
 *
 * A regular user's only route to the application used to be typing /organize, so the
 * feature existed and nobody could find it. The Hub invites them; it must not invite
 * someone who already is one, and it must go where the application is.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Hub } from '@/components/Hub'
import type { User } from '@/lib/api'

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

function user(role: User['role']): User {
  return {
    username: 'majula',
    displayName: null,
    xrplAddress: 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w',
    createdAt: new Date().toISOString(),
    role,
    ticketsOwned: 0,
  }
}

function renderHub(role: User['role']) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/auctions')) return json({ auctions: [] })
      return json({ tickets: [] })
    }),
  )
  return render(<Hub me={user(role)} onOpenAuction={vi.fn()} />)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the Hub invitation to organize', () => {
  it('invites a plain user, linking to the application page', async () => {
    renderHub('USER')
    const link = await screen.findByRole('link', { name: 'Apply to organize' })
    expect(link.getAttribute('href')).toBe('/organize')
  })

  it.each(['ORGANIZER', 'ADMIN'] as const)('does not invite an %s, who is one already', async (role) => {
    renderHub(role)
    await screen.findByText(/welcome back/i)
    expect(screen.queryByRole('link', { name: 'Apply to organize' })).toBeNull()
    expect(screen.queryByText('Run your own events')).toBeNull()
  })
})
