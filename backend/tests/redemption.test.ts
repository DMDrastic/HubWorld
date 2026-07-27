/**
 * Check-in rules.
 *
 * These encode the anti-fraud decisions, which are the whole point of redemption:
 * a ticket that can be used twice, or used by someone who sold it, is worse than
 * no ticketing system at all.
 */
import { describe, expect, it } from 'vitest'

type TicketStatus = 'MINTED' | 'LISTED' | 'IN_AUCTION' | 'REDEEMED' | 'BURNED'

/** Mirrors the guard now shared by gifting, listing and opening an auction. */
function canBeTransferred(status: TicketStatus): boolean {
  if (status === 'REDEEMED') return false
  return status === 'MINTED'
}

/** Mirrors the door's verdict for one signed check-in. */
function verdict(input: {
  ticketsForEvent: Array<{ status: TicketStatus; heldOnLedger: boolean }>
}): 'redeemed' | 'already_used' | 'no_ticket' {
  const { ticketsForEvent } = input
  const unredeemed = ticketsForEvent.filter((t) => t.status !== 'REDEEMED')
  if (ticketsForEvent.length > 0 && unredeemed.length === 0) return 'already_used'
  return unredeemed.some((t) => t.heldOnLedger) ? 'redeemed' : 'no_ticket'
}

describe('a redeemed ticket cannot be passed on', () => {
  it('blocks gifting, selling and auctioning', () => {
    // Admission has been used; selling it would be selling nothing.
    expect(canBeTransferred('REDEEMED')).toBe(false)
  })

  it('still allows an unused ticket to move', () => {
    expect(canBeTransferred('MINTED')).toBe(true)
  })

  it('blocks a ticket already committed elsewhere', () => {
    expect(canBeTransferred('LISTED')).toBe(false)
    expect(canBeTransferred('IN_AUCTION')).toBe(false)
  })
})

describe('door verdicts', () => {
  it('admits a holder whose ticket the ledger confirms', () => {
    expect(verdict({ ticketsForEvent: [{ status: 'MINTED', heldOnLedger: true }] })).toBe('redeemed')
  })

  it('refuses a holder who sold the ticket after we cached it', () => {
    // The cache still names them; the ledger does not. The ledger wins, or
    // someone gets in on a ticket they no longer own.
    expect(verdict({ ticketsForEvent: [{ status: 'MINTED', heldOnLedger: false }] })).toBe('no_ticket')
  })

  it('distinguishes "already scanned" from "no ticket"', () => {
    // Two different conversations at a door: one is a duplicate, the other is a
    // stranger. Collapsing them would make real double-entry unnoticeable.
    expect(verdict({ ticketsForEvent: [{ status: 'REDEEMED', heldOnLedger: true }] })).toBe('already_used')
    expect(verdict({ ticketsForEvent: [] })).toBe('no_ticket')
  })

  it('admits on a second ticket when the first is already used', () => {
    // Someone holding two tickets brings a friend; the used one must not block
    // the unused one.
    expect(
      verdict({
        ticketsForEvent: [
          { status: 'REDEEMED', heldOnLedger: true },
          { status: 'MINTED', heldOnLedger: true },
        ],
      }),
    ).toBe('redeemed')
  })

  it('refuses when every remaining ticket fails the ledger check', () => {
    expect(
      verdict({
        ticketsForEvent: [
          { status: 'REDEEMED', heldOnLedger: true },
          { status: 'MINTED', heldOnLedger: false },
        ],
      }),
    ).toBe('no_ticket')
  })
})
