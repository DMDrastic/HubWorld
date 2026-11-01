/**
 * What a Privy wallet may be asked to sign: one list, in one place.
 *
 * The wallet belongs to the person, so the server never signs for it; what it can do is decide what to ASK. Each action
 * is therefore pinned to the kind of transaction it is allowed to be, and for offers to the side of the offer. The
 * server builds these transactions itself, so this is a second lock: if a route ever built the wrong thing (a sell
 * offer where a bid belongs, which would give a ticket away for the amount), the request is refused before anyone's
 * wallet is asked.
 *
 * Both `signing.ts` (which signer to use) and `privy-signing.ts` (what to build) read this and nothing else, so the
 * list a person is routed by and the list a request is checked against cannot drift apart.
 *
 * Not on the list, deliberately: gifts, the door and sign-in. They are not built for Privy, and a Privy user is told so
 * rather than being quietly sent to Xaman, a wallet that does not hold their key.
 */
import type { PayloadFlow } from '@prisma/client'
import { platformAddress } from './ledger.js'

export type FlowRule = {
  /** The only transaction types this action may be. */
  types: readonly string[]
  /** For an NFT offer: whether the action is selling (a listing) or buying (a purchase or a bid). */
  side?: 'sell' | 'buy'
}

export const PRIVY_FLOW_RULES: ReadonlyMap<PayloadFlow, FlowRule> = new Map<PayloadFlow, FlowRule>([
  // An organizer's.
  ['DELEGATE_GRANT', { types: ['DelegateSet'] }],
  ['DELEGATE_REVOKE', { types: ['DelegateSet'] }],
  ['MINT', { types: ['NFTokenMint'] }],
  // A holder's. Buying at the box office is a purchase of a resale-shaped offer, so it is LISTING_BUY too.
  ['LISTING_CREATE', { types: ['NFTokenCreateOffer'], side: 'sell' }],
  ['AUCTION_OPEN', { types: ['NFTokenCreateOffer'], side: 'sell' }],
  ['LISTING_BUY', { types: ['NFTokenCreateOffer'], side: 'buy' }],
  ['AUCTION_BID', { types: ['NFTokenCreateOffer'], side: 'buy' }],
  ['LISTING_CANCEL', { types: ['NFTokenCancelOffer'] }],
])

const TF_SELL_NFTOKEN = 1

/** The broker, or null on a deployment that has none configured (stub mode, scripts, tests). */
function brokerOrNull(): string | null {
  try {
    return platformAddress()
  } catch {
    return null
  }
}

/** Why this transaction is not what this action may ask for, or null if it is. In words a person can read. */
export function checkFlowTx(flow: PayloadFlow, tx: Record<string, unknown>): string | null {
  const rule = PRIVY_FLOW_RULES.get(flow)
  if (!rule) return 'That is not an action this kind of wallet can approve yet.'
  if (typeof tx.TransactionType !== 'string' || !rule.types.includes(tx.TransactionType)) {
    return 'That is not the kind of transaction this action is for.'
  }
  if (tx.TransactionType === 'NFTokenCancelOffer') {
    const offers = tx.NFTokenOffers
    if (!Array.isArray(offers) || offers.length !== 1) return 'A withdrawal cancels exactly one listing.'
  }
  if (rule.side) {
    const flags = typeof tx.Flags === 'number' ? tx.Flags : 0
    const isSell = (flags & TF_SELL_NFTOKEN) === TF_SELL_NFTOKEN
    if (rule.side === 'sell' && !isSell) return 'This must be a sell offer.'
    if (rule.side === 'buy' && isSell) return 'This must be a buy offer.'
    // A zero or missing amount is how a ticket is given away; an offer here is always for money.
    if (typeof tx.Amount !== 'string' || !/^[0-9]+$/.test(tx.Amount) || BigInt(tx.Amount) <= 0n) {
      return 'An offer must ask for a positive amount of XRP.'
    }
    // Only HubWorld's broker may complete the sale: an open offer could be taken directly, skipping the fee.
    const broker = brokerOrNull()
    if (typeof tx.Destination !== 'string' || (broker !== null && tx.Destination !== broker)) {
      return 'An offer must be restricted to HubWorld’s broker.'
    }
  }
  return null
}
