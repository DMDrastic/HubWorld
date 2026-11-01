/**
 * US$ as the price people read, XRP as the price they pay. DISPLAY ONLY. Written before the code.
 *
 * The server sends the XRP amount and its estimate side by side; the page converts nothing, it only formats. Three
 * rules are pinned here:
 *   - no fresh price, no dollar figure: XRP alone, never a remembered number;
 *   - where someone commits, the XRP figure is what they pay and the dollars are labelled as an estimate;
 *   - the estimate never reaches signing: the approval screen's review is handed the XRP drops, and the review code
 *     does not know an estimate exists.
 */
import { StrictMode } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CheckoutDialog } from '@/components/CheckoutDialog'
import { EventRow } from '@/components/EventRow'
import { Price } from '@/components/Price'
import { formatFiat } from '@/lib/fiat'
import { PolicyContext } from '@/lib/policy-context'
import { reviewer } from '@/lib/sign-review-loader'
import type { EventSummary, Policy } from '@/lib/api'
import { WALLET, WithRuntime, fakeRuntime, json } from './fakeRuntime'

const USD = (minor: string) => ({ currency: 'USD' as const, minor })

const EVENT: EventSummary = {
  slug: 'neon',
  title: 'Neon Rooftop Session',
  venue: 'Hub World',
  startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  status: 'PUBLISHED',
  ticketCount: 100,
  ticketsMinted: 100,
  primaryPriceDrops: '27000000',
  primaryFeeDrops: '1000000',
  primaryAllInDrops: '28000000',
  ticketsForSale: 12,
  organizer: { username: 'org', displayName: null },
  fiat: { primaryAllInDrops: USD('3500'), primaryPriceDrops: USD('3375'), primaryFeeDrops: USD('125') },
}
const STALE: EventSummary = { ...EVENT, fiat: {} }

describe('formatting, not converting', () => {
  it('formats minor units as US$ or EC$, with grouping', () => {
    expect(formatFiat(USD('3500'))).toBe('US$35.00')
    expect(formatFiat(USD('5'))).toBe('US$0.05')
    expect(formatFiat(USD('123456789'))).toBe('US$1,234,567.89')
    expect(formatFiat({ currency: 'XCD', minor: '9450' })).toBe('EC$94.50')
  })
})

describe('a price, read', () => {
  it('shows the dollars large and the XRP small underneath', () => {
    render(<Price drops="28000000" fiat={USD('3500')} />)
    expect(screen.getByText('US$35.00')).toBeTruthy()
    expect(screen.getByText('≈ 28 XRP')).toBeTruthy()
  })

  it('with no fresh price shows XRP alone, and no dollar sign anywhere', () => {
    const { container } = render(<Price drops="28000000" fiat={undefined} />)
    expect(screen.getByText('28 XRP')).toBeTruthy()
    expect(container.textContent).not.toMatch(/\$/)
  })
})

describe('the event row', () => {
  const row = (e: EventSummary) =>
    render(
      <ol>
        <EventRow event={e} live={false} onOpenAuction={vi.fn()} onBuy={vi.fn()} />
      </ol>,
    )

  it('leads with the dollar estimate and keeps the XRP beside it', () => {
    row(EVENT)
    const buy = screen.getByRole('button', { name: /buy a ticket to neon rooftop session/i })
    expect(buy.textContent).toContain('US$35.00')
    expect(buy.textContent).toContain('≈ 28 XRP')
    // The accessible name says what is actually charged.
    expect(buy.getAttribute('aria-label')).toMatch(/28 XRP \(about US\$35\.00\)/)
  })

  it('a stale feed: XRP only', () => {
    row(STALE)
    const buy = screen.getByRole('button', { name: /buy a ticket/i })
    expect(buy.textContent).toContain('28 XRP')
    expect(buy.textContent).not.toMatch(/\$/)
  })
})

describe('the checkout', () => {
  const review = vi.fn()
  const CREATED = {
    listingId: 'l-1', uuid: '11111111-2222-4333-8444-555555555555', next: '', qrPng: '', mode: 'live' as const,
    paysDrops: '28000000', expiresAt: new Date(Date.now() + 300_000).toISOString(),
    sign: { tx: { TransactionType: 'NFTokenCreateOffer', Account: WALLET.address }, hash: 'AB'.repeat(32), account: WALLET.address },
  }
  const mount = (event: EventSummary, created: object) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/checkout') && init?.method === 'POST') return json(created, 201)
      if (/\/listings\/[^/]+$/.test(url)) return json({ listingId: 'l-1', state: 'buyer_pending', priceDrops: '27000000', platformFeeDrops: '1000000', buyerPaysDrops: '28000000', seller: '@org', buyer: '@me', ticket: { nfTokenId: 'AB', seat: null, tier: null, event: { slug: 'neon', title: 'Neon' } } })
      throw new Error(`unexpected fetch: ${url}`)
    }))
    render(
      <StrictMode>
        <PolicyContext.Provider value={{ platformBps: 250, maxRoyaltyBps: 2000, brokerAddress: 'rBroker' } as Policy}>
          <WithRuntime runtime={fakeRuntime()}>
            <CheckoutDialog event={event} open signedIn onOpenChange={vi.fn()} onSold={vi.fn()} />
          </WithRuntime>
        </PolicyContext.Provider>
      </StrictMode>,
    )
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(reviewer, 'load').mockResolvedValue({ reviewSignRequest: (...a: unknown[]) => review(...a) } as never)
    review.mockResolvedValue({ ok: true, title: 'Buy', lines: [] })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    review.mockReset()
  })

  it('before committing: the XRP is what you pay, the dollars are "about"', async () => {
    mount(EVENT, CREATED)
    expect(await screen.findByText('You’ll pay 28 XRP (about US$35.00)')).toBeTruthy()
  })

  it('at the approval: the same sentence from the HELD amount, and the review is handed the XRP drops', async () => {
    // The held amount's own estimate (the price moved since the list loaded), not the list's.
    mount(EVENT, { ...CREATED, fiat: { paysDrops: USD('3600') } })
    fireEvent.click(await screen.findByRole('button', { name: /buy a ticket/i }))
    expect(await screen.findByText('You’ll pay 28 XRP (about US$36.00)', { selector: '[data-commit]' })).toBeTruthy()
    await vi.waitFor(() => expect(review).toHaveBeenCalled())
    expect(review.mock.calls[0]![1]).toMatchObject({ action: { kind: 'buy', amountDrops: '28000000' } })
    expect(JSON.stringify(review.mock.calls[0])).not.toMatch(/3600|USD|fiat/)
  })

  it('a stale feed: "You’ll pay 28 XRP", with no estimate', async () => {
    mount(STALE, { ...CREATED, fiat: {} })
    expect(await screen.findByText('You’ll pay 28 XRP')).toBeTruthy()
    expect(screen.queryByText(/US\$/)).toBeNull()
  })
})

describe('the review code does not know an estimate exists', () => {
  it.each(['lib/sign-review.ts', 'components/SignStep.tsx', 'components/SigningPrompt.tsx'])('%s mentions no fiat, USD or EC$', (file) => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8')
    expect(src).not.toMatch(/fiat|usd|xcd|EC\$|US\$/i)
  })
})

describe('asking for an estimate of a typed amount', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('asks once after a pause, never shows the old amount\'s estimate for a new amount, and shows nothing when stale', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { renderHook } = await import('@testing-library/react')
    const { useQuote } = await import('@/lib/use-quote')
    const asked: string[] = []
    let fresh = true
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://x')
      const drops = url.searchParams.get('drops')!
      asked.push(drops)
      return json({ fiat: fresh ? Object.fromEntries(drops.split(',').map((d) => [d, USD(String(Number(d) / 800_000))])) : {} })
    }))

    const { result, rerender } = renderHook(({ d }) => useQuote([d]), { initialProps: { d: '28000000' } })
    rerender({ d: '28000000' })
    await vi.waitFor(() => expect(result.current['28000000']).toEqual(USD('35')))
    expect(asked).toEqual(['28000000'])

    rerender({ d: '40000000' })
    // The 28 XRP estimate is not offered for 40 XRP while the new answer is on its way.
    expect(result.current).toEqual({})
    await vi.waitFor(() => expect(result.current['40000000']).toEqual(USD('50')))

    fresh = false
    rerender({ d: '1000000' })
    await vi.waitFor(() => expect(asked).toContain('1000000'))
    expect(result.current).toEqual({})
  })
})
