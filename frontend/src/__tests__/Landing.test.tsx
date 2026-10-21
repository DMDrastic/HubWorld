/**
 * What the landing page claims about the ledger.
 *
 * The badge read "Live on XRPL testnet" as a hardcoded string. True the day it
 * was written, and a lie the moment `XRPL_NETWORK` changed — on the first page
 * every visitor sees, telling someone holding a real ticket that it is play
 * money. Exactly the failure the nav badge was built to avoid, sitting
 * unnoticed two components away.
 *
 * The rule: never name a network we have not been told about. "Live on the XRP
 * Ledger" is true everywhere, so it is the answer whenever we are not certain.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Landing } from '@/components/Landing'

function landing(network?: 'testnet' | 'devnet' | 'mainnet') {
  return render(<Landing onAuthenticated={vi.fn()} network={network} />)
}

describe('the landing page ledger badge', () => {
  it('never says testnet when running on mainnet', () => {
    // The one that would cost someone real money in confidence.
    landing('mainnet')
    expect(screen.queryByText(/testnet/i)).toBeNull()
    expect(screen.queryByText(/devnet/i)).toBeNull()
  })

  it('says something true on mainnet rather than nothing', () => {
    landing('mainnet')
    expect(screen.queryByText(/Live on the XRP Ledger/i)).not.toBeNull()
  })

  it.each(['testnet', 'devnet'] as const)('names %s, which a visitor needs to know', (net) => {
    landing(net)
    expect(screen.queryByText(new RegExp(`Live on XRPL ${net}`, 'i'))).not.toBeNull()
  })

  it('claims no network before health has loaded', () => {
    // Undefined is the state on first paint and on an API too old to say.
    // Defaulting to testnet here is how the original bug would come straight
    // back — it would flash "testnet" on a mainnet deploy on every load.
    landing(undefined)
    expect(screen.queryByText(/testnet/i)).toBeNull()
    expect(screen.queryByText(/Live on the XRP Ledger/i)).not.toBeNull()
  })
})

describe('the sticky phone on the landing page', () => {
  it('has no clipping ancestor, which WebKit tracks a frame behind the pinned header', () => {
    // WebKit follows a sticky element inside ANY overflow rule (clip included) against that
    // ancestor instead of the page, so on an iPhone the phone lagged the header and bumped it.
    // Headless engines cannot show it, so the structure is what is pinned: nothing above the
    // sticky element may carry an overflow class. Horizontal overflow is handled on `body`.
    const { container } = landing('testnet')
    const phone = container.querySelector('.sticky')
    expect(phone, 'the sticky phone is rendered').not.toBeNull()
    for (let el = phone!.parentElement; el && el !== container.parentElement; el = el.parentElement) {
      expect(el.className, `${el.tagName}.${el.className}`).not.toMatch(/overflow/)
    }
  })

  it('leaves the horizontal clipping to body, from sm up only', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
    expect(css).toMatch(/@media \(min-width: 640px\)\s*\{\s*body\s*\{\s*overflow-x: clip;/)
  })
})
