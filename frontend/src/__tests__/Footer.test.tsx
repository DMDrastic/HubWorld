/**
 * What the footer is allowed to claim.
 *
 * The test-network notice is the part that matters. It tells someone arriving
 * from a link that nothing here is real — so getting it wrong in the mainnet
 * direction would tell a person holding a real ticket that their money is play
 * money, and getting it wrong the other way would be a sandbox pretending to be
 * a product.
 *
 * The landing page shipped exactly that bug: "Live on XRPL testnet" as a
 * hardcoded string, true on the day it was written and a lie the moment
 * XRPL_NETWORK changed. So this asserts the notice tracks the server, never a
 * literal, and claims NOTHING when the server has not said.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Footer } from '@/components/Footer'
import type { Health } from '@/lib/api'

const BASE: Health = { status: 'ok', db: 'connected', uptime: 1, timestamp: '' }
const on = (network: Health['network']): Health => ({ ...BASE, network })

describe('the test-network notice', () => {
  it.each(['testnet', 'devnet'] as const)('warns plainly on %s', (network) => {
    render(<Footer health={on(network)} />)

    expect(screen.getByText(new RegExp(`Running on the XRPL ${network}`, 'i'))).not.toBeNull()
    expect(screen.getByText(/no real money is involved/i)).not.toBeNull()
  })

  it('says nothing of the sort on mainnet', () => {
    // Mainnet is simply the product. A "this is not real" notice in front of a
    // paying customer would be developer chrome, and false.
    render(<Footer health={on('mainnet')} />)

    expect(screen.queryByText(/Running on the XRPL/i)).toBeNull()
    expect(screen.queryByText(/no real money is involved/i)).toBeNull()
  })

  it('claims nothing before the server has said', () => {
    // Undefined on first paint and on an API too old to carry the field.
    // Defaulting either way is how the landing-page bug happened.
    render(<Footer health={null} />)

    expect(screen.queryByText(/Running on the XRPL/i)).toBeNull()
    expect(screen.queryByText(/testnet/i)).toBeNull()
    expect(screen.queryByText(/mainnet/i)).toBeNull()
  })
})

describe('the rest of the footer', () => {
  it('carries copyright for the CURRENT year, not a frozen one', () => {
    // A hardcoded year silently rots every January.
    render(<Footer health={on('testnet')} />)

    expect(screen.getByText(new RegExp(`© ${new Date().getFullYear()} HubWorld`))).not.toBeNull()
  })

  it('states the custody position, which is the product’s central claim', () => {
    render(<Footer health={on('testnet')} />)
    expect(screen.getByText(/never holds your keys/i)).not.toBeNull()
  })

  it('links out safely, and only to pages that exist', () => {
    render(<Footer health={on('testnet')} />)

    const source = screen.getByRole('link', { name: /source on github/i })
    expect(source.getAttribute('rel')).toContain('noopener')
    expect(source.getAttribute('target')).toBe('_blank')

    // `router.ts` falls unknown paths back to the Hub rather than 404ing, so a
    // Terms or Privacy link would render the Hub and look like it worked. They
    // belong here when they are real routes, not before.
    for (const dead of [/terms/i, /privacy/i, /cookie/i]) {
      expect(screen.queryByRole('link', { name: dead })).toBeNull()
    }
  })

  it('shows the build only when the server knows it', () => {
    render(<Footer health={{ ...on('testnet'), commit: 'unknown' }} />)
    expect(screen.queryByText(/^build /i)).toBeNull()

    render(<Footer health={{ ...on('testnet'), commit: 'abcdef1234567890' }} />)
    expect(screen.getByText('build abcdef1')).not.toBeNull()
  })
})
