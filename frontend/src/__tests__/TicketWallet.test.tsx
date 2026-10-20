/**
 * The tickets a holder keeps, drawn as tickets.
 *
 * The page this lives on used to be a gift form and a handle lookup, so a holder
 * with a ticket saw two utility cards and nothing that said "you have one". What
 * is pinned here is the thing that was missing: a ticket is on the page, says
 * what it is and whether it is good, and is the way into gifting it.
 *
 * Rendered in <StrictMode> like every data-loading component here.
 */
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { TicketWallet } from '@/components/TicketWallet'

const ticket = (over: Record<string, unknown> = {}, event: Record<string, unknown> = {}) => ({
  nfTokenId: '00081388E82223A2A5150D5AADF7D8E5F5E3AC44D31AB0D402ACCC570127D521',
  seat: null,
  tier: null,
  status: 'MINTED',
  syncedAt: null,
  onLedger: null,
  event: {
    slug: 'neon-rooftop-session',
    title: 'Neon Rooftop Session',
    startsAt: '2026-10-21T14:25:00.000Z',
    venue: null,
    imageUrl: null,
    ...event,
  },
  canAuction: false,
  auctionBlockedReason: null,
  faceValueDrops: null,
  resaleAllowed: true,
  maxListingPriceDrops: null,
  maxAuctionReserveDrops: null,
  resaleBlockedReason: null,
  ...over,
})

function mockInventory(tickets: unknown[] | 'fail') {
  const calls = { inventory: 0 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/tickets/mine')) {
        calls.inventory += 1
        if (tickets === 'fail') return new Response('{}', { status: 500 })
        return new Response(JSON.stringify({ address: 'rHolder', verified: false, tickets }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
  return calls
}

const renderWallet = (onGift = vi.fn(), version = 0) =>
  render(
    <StrictMode>
      <TicketWallet version={version} onGift={onGift} />
    </StrictMode>,
  )

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('TicketWallet', () => {
  it('shows a held ticket as a ticket, and says there is one', async () => {
    mockInventory([ticket()])
    renderWallet()

    expect(await screen.findByRole('heading', { name: /you have 1 ticket$/i })).toBeTruthy()
    const card = screen.getByRole('article', { name: /ticket for neon rooftop session/i })
    expect(card.textContent).toMatch(/admit one/i)
    expect(card.textContent).toMatch(/valid/i)
    expect(card.textContent).toMatch(/general admission/i)
    expect(card.textContent).toMatch(/oct/i)
  })

  it('counts several tickets and draws each one', async () => {
    mockInventory([
      ticket({ nfTokenId: 'A'.repeat(64) }),
      ticket({ nfTokenId: 'B'.repeat(64) }, { slug: 'other-night', title: 'Other Night' }),
    ])
    renderWallet()

    expect(await screen.findByRole('heading', { name: /you have 2 tickets/i })).toBeTruthy()
    expect(screen.getAllByRole('article')).toHaveLength(2)
  })

  it('shows the place and the seat when there are any, and not their absence', async () => {
    mockInventory([ticket({ tier: 'VIP', seat: 'A12' }, { venue: 'Openfield Stadium' })])
    renderWallet()

    const card = await screen.findByRole('article')
    expect(card.textContent).toMatch(/openfield stadium/i)
    expect(card.textContent).toMatch(/vip · a12/i)
    expect(card.textContent).not.toMatch(/general admission/i)
  })

  it('carries the event artwork as a thumbnail when there is some, and nothing when there is not', async () => {
    mockInventory([
      ticket({ nfTokenId: 'A'.repeat(64) }, { slug: 'has-art', title: 'Has Art', imageUrl: 'https://img.example/poster.png' }),
      ticket({ nfTokenId: 'B'.repeat(64) }, { slug: 'no-art', title: 'No Art', imageUrl: null }),
    ])
    renderWallet()

    const withArt = await screen.findByRole('article', { name: /ticket for has art/i })
    const withoutArt = screen.getByRole('article', { name: /ticket for no art/i })
    expect(withArt.querySelector('img')?.getAttribute('src')).toBe('https://img.example/poster.png')
    expect(withoutArt.querySelector('img')).toBeNull()
  })

  it('offers the Gift button on a valid ticket and hands back WHICH ticket', async () => {
    const onGift = vi.fn()
    mockInventory([ticket({ nfTokenId: 'C'.repeat(64) })])
    renderWallet(onGift)

    const button = (await screen.findByRole('button', { name: /gift the neon rooftop session ticket/i })) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    button.click()

    expect(onGift).toHaveBeenCalledExactlyOnceWith('C'.repeat(64))
  })

  it('says a used ticket is used and does not offer to gift it (positive control above)', async () => {
    mockInventory([ticket({ status: 'REDEEMED' })])
    renderWallet()

    const card = await screen.findByRole('article')
    expect(card.textContent).toMatch(/used/i)
    expect(card.textContent).not.toMatch(/\bvalid\b/i)
    expect((screen.getByRole('button', { name: /gift the/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says a ticket on sale is on sale, and will not gift it', async () => {
    mockInventory([ticket({ status: 'LISTED' })])
    renderWallet()

    expect((await screen.findByRole('article')).textContent).toMatch(/listed for sale/i)
    expect((screen.getByRole('button', { name: /gift the/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('warns when the ledger disagrees that the ticket is in the wallet', async () => {
    mockInventory([ticket({ onLedger: false })])
    renderWallet()

    expect((await screen.findByRole('article')).textContent).toMatch(/can't find this ticket in your wallet/i)
  })

  it('does not show a burned ticket', async () => {
    mockInventory([ticket({ status: 'BURNED' })])
    renderWallet()

    expect(await screen.findByText(/no tickets yet/i)).toBeTruthy()
    expect(screen.queryByRole('article')).toBeNull()
  })

  it('invites a holder with none to browse events, rather than showing an empty page', async () => {
    mockInventory([])
    renderWallet()

    expect(await screen.findByText(/no tickets yet/i)).toBeTruthy()
    expect((screen.getByRole('link', { name: /browse events/i }) as HTMLAnchorElement).getAttribute('href')).toBe('/events')
  })

  it('does not call a failed load "no tickets" (unknown is not "none")', async () => {
    mockInventory('fail')
    renderWallet()

    expect(await screen.findByText(/couldn't load your tickets/i)).toBeTruthy()
    expect(screen.queryByText(/no tickets yet/i)).toBeNull()
  })

  it('loads once, and again only when the page says something may have moved', async () => {
    const calls = mockInventory([ticket()])
    const { rerender } = renderWallet(vi.fn(), 0)
    await screen.findByRole('article')
    // StrictMode mounts effects twice in development; what matters is that it is bounded.
    const first = calls.inventory
    expect(first).toBeLessThanOrEqual(2)

    rerender(
      <StrictMode>
        <TicketWallet version={0} onGift={vi.fn()} />
      </StrictMode>,
    )
    expect(calls.inventory).toBe(first)

    rerender(
      <StrictMode>
        <TicketWallet version={1} onGift={vi.fn()} />
      </StrictMode>,
    )
    await waitFor(() => expect(calls.inventory).toBeGreaterThan(first))
  })
})
