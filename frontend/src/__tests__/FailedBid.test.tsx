/** A buyer whose bid was let go is told why, on the row, in the server's words. */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MyListingRow } from '@/components/MarketCards'
import type { Listing } from '@/lib/api'

const base: Listing = {
  listingId: 'l1',
  state: 'failed',
  priceDrops: '10000000',
  platformFeeDrops: '500000',
  buyerPaysDrops: '10000000',
  feeModel: 'SELLER_PAYS_V2',
  seller: '@ayo',
  buyer: null,
  ticket: { nfTokenId: 'a'.repeat(64), seat: null, tier: null, event: { slug: 'neon', title: 'Neon Rooftop Session' } },
  role: 'buyer',
  reason: 'The bid could not be paid: the buyer did not have the funds when the sale was due. Nothing was charged.',
}

const row = (l: Listing) =>
  render(
    <ul>
      <MyListingRow listing={l} event={undefined} busy={false} onCheck={vi.fn()} onWithdraw={vi.fn()} />
    </ul>,
  )

describe('a purchase that was let go', () => {
  it('says so in words, with the reason and that nothing was charged', () => {
    row(base)
    expect(screen.getByText(/did not have the funds/i)).toBeTruthy()
    expect(screen.getByText(/nothing was charged/i)).toBeTruthy()
    expect(screen.getByText(/failed/i)).toBeTruthy()
  })

  it('offers no Withdraw (it is not theirs to withdraw)', () => {
    row(base)
    expect(screen.queryByRole('button', { name: /withdraw/i })).toBeNull()
  })

  it('shows no reason line on an ordinary pending purchase', () => {
    row({ ...base, state: 'settling', reason: undefined })
    expect(screen.queryByText(/nothing was charged/i)).toBeNull()
  })

  it('does not show a reason on a state that is not a failure, even if the server sent one (waiting for funds is not a failure)', () => {
    row({ ...base, state: 'settling', reason: "Waiting for the buyer's balance to cover the sale" })
    expect(screen.queryByText(/waiting for the buyer/i)).toBeNull()
  })
})
