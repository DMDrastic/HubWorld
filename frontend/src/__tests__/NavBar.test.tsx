/**
 * Which destinations a signed-out visitor is offered.
 *
 * The rule: Events is public because it describes the world, and the API serves
 * it without a session. Everything else describes an *account* — what you hold,
 * what you are selling, whose door you may work — so those links stay absent
 * rather than disabled, matching the rule the rest of the app follows.
 *
 * The absence is the thing being asserted. A nav that offers Tickets to someone
 * with no wallet promises a page that cannot exist for them, and a link that
 * 403s is worse than no link.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NavBar } from '@/components/NavBar'
import type { Health, User } from '@/lib/api'

const HEALTH: Health = { status: 'ok', db: 'connected', uptime: 1, timestamp: '' }

function user(role: User['role'] = 'USER'): User {
  return {
    username: 'majula',
    displayName: null,
    xrplAddress: 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w',
    createdAt: new Date().toISOString(),
    role,
    ticketsOwned: 0,
  }
}

function nav(me: User | null, hasDoor = false) {
  return render(
    <NavBar me={me} health={HEALTH} route="/" hasDoor={hasDoor} onSignOut={vi.fn()} />,
  )
}

describe('NavBar destinations when signed out', () => {
  it('offers Events, so the app can be looked at without a wallet', () => {
    nav(null)
    // Both the wide and narrow navs render, so the link appears more than once.
    expect(screen.getAllByRole('link', { name: 'Events' }).length).toBeGreaterThan(0)
  })

  it.each(['Tickets', 'Market', 'Door', 'Organize'])(
    'does not offer %s, which needs an account to mean anything',
    (label) => {
      nav(null)
      expect(screen.queryByRole('link', { name: label })).toBeNull()
    },
  )

  it('still says nobody is signed in', () => {
    nav(null)
    expect(screen.getByText('not signed in')).toBeTruthy()
  })
})

describe('NavBar destinations when signed in', () => {
  it('adds the account destinations', () => {
    nav(user())
    for (const label of ['Hub', 'Events', 'Tickets', 'Market']) {
      expect(screen.getAllByRole('link', { name: label }).length).toBeGreaterThan(0)
    }
  })

  it('keeps Organize hidden from a plain USER', () => {
    nav(user('USER'))
    expect(screen.queryByRole('link', { name: 'Organize' })).toBeNull()
  })

  it('shows Organize to an ORGANIZER', () => {
    nav(user('ORGANIZER'))
    expect(screen.getAllByRole('link', { name: 'Organize' }).length).toBeGreaterThan(0)
  })

  // Door access is per event, so a volunteer is a plain USER — the role alone
  // cannot decide this, which is why `hasDoor` exists as a separate input.
  it('shows Door to a plain USER who has one', () => {
    nav(user('USER'), true)
    expect(screen.getAllByRole('link', { name: 'Door' }).length).toBeGreaterThan(0)
  })
})
