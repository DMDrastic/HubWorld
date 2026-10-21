/**
 * What the footer is allowed to claim.
 *
 * It carries no network notice. A "Running on the XRPL testnet" box used to lead
 * it and was removed on request; the nav badge and the landing page's ledger line
 * still say which network this is, derived from /api/health. This pins the
 * absence so the notice cannot drift back in, on any network or none.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Footer } from '@/components/Footer'
import type { Health } from '@/lib/api'

const BASE: Health = { status: 'ok', db: 'connected', uptime: 1, timestamp: '' }
const on = (network: Health['network']): Health => ({ ...BASE, network })

describe('the footer makes no network claim', () => {
  it.each(['testnet', 'devnet', 'mainnet', undefined] as const)('on %s', (network) => {
    render(<Footer health={on(network)} />)

    expect(screen.queryByText(/Running on the XRPL/i)).toBeNull()
    expect(screen.queryByText(/no real money is involved/i)).toBeNull()
    expect(screen.queryByText(/testnet|devnet|mainnet/i)).toBeNull()
  })

  it('on a health that has not loaded', () => {
    render(<Footer health={null} />)
    expect(screen.queryByText(/Running on the XRPL/i)).toBeNull()
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

    const ledger = screen.getByRole('link', { name: /xrp ledger/i })
    expect(ledger.getAttribute('rel')).toContain('noopener')
    expect(ledger.getAttribute('target')).toBe('_blank')

    // The repository is deliberately not advertised from the product.
    expect(screen.queryByRole('link', { name: /github/i })).toBeNull()

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
