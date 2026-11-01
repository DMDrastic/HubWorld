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
 * Not on the list, deliberately: the door and sign-in. They are not built for Privy, and a Privy user is told so rather than being
 * quietly sent to Xaman, a wallet that does not hold their key.
 */
import type { PayloadFlow } from '@prisma/client'
import { platformAddress } from './ledger.js'

export type FlowRule = {
  /** The only transaction types this action may be. */
  types: readonly string[]
  /** For an NFT offer: whether the action is selling (a listing, a gift) or buying (a purchase or a bid). */
  side?: 'sell' | 'buy'
  /**
   * For an NFT offer, who may take it and for what. A SALE is for a positive amount and only HubWorld's broker may complete it, so
   * neither party can skip the fee. A GIFT is for nothing and only the named person may take it, never the giver or the broker.
   */
  offer?: 'sale' | 'gift'
}

export const PRIVY_FLOW_RULES: ReadonlyMap<PayloadFlow, FlowRule> = new Map<PayloadFlow, FlowRule>([
  // An organizer's.
  ['DELEGATE_GRANT', { types: ['DelegateSet'] }],
  ['DELEGATE_REVOKE', { types: ['DelegateSet'] }],
  ['MINT', { types: ['NFTokenMint'] }],
  // A holder's. Buying at the box office is a purchase of a resale-shaped offer, so it is LISTING_BUY too.
  ['LISTING_CREATE', { types: ['NFTokenCreateOffer'], side: 'sell', offer: 'sale' }],
  ['AUCTION_OPEN', { types: ['NFTokenCreateOffer'], side: 'sell', offer: 'sale' }],
  ['LISTING_BUY', { types: ['NFTokenCreateOffer'], side: 'buy', offer: 'sale' }],
  ['AUCTION_BID', { types: ['NFTokenCreateOffer'], side: 'buy', offer: 'sale' }],
  ['LISTING_CANCEL', { types: ['NFTokenCancelOffer'] }],
  // Gifts: a free offer to one named person, that person accepting it, and the giver taking it back.
  ['GIFT_OFFER', { types: ['NFTokenCreateOffer'], side: 'sell', offer: 'gift' }],
  ['GIFT_ACCEPT', { types: ['NFTokenAcceptOffer'] }],
  ['GIFT_CANCEL', { types: ['NFTokenCancelOffer'] }],
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
  if (tx.TransactionType === 'NFTokenAcceptOffer') {
    // Accepting a gift takes exactly one sell offer, unbrokered. A buy offer here would SELL the person's ticket, and a broker fee
    // would make them the broker of someone else's sale.
    const ok =
      typeof tx.NFTokenSellOffer === 'string' &&
      /^[0-9A-Fa-f]{64}$/.test(tx.NFTokenSellOffer) &&
      !('NFTokenBuyOffer' in tx) &&
      !('NFTokenBrokerFee' in tx)
    if (!ok) return 'Accepting a gift takes exactly one offer made to you, and nothing else.'
  }
  if (rule.side) {
    const flags = typeof tx.Flags === 'number' ? tx.Flags : 0
    const isSell = (flags & TF_SELL_NFTOKEN) === TF_SELL_NFTOKEN
    if (rule.side === 'sell' && !isSell) return 'This must be a sell offer.'
    if (rule.side === 'buy' && isSell) return 'This must be a buy offer.'
  }
  const broker = brokerOrNull()
  if (rule.offer === 'sale') {
    // A zero or missing amount is how a ticket is given away; a sale is always for money.
    if (typeof tx.Amount !== 'string' || !/^[0-9]+$/.test(tx.Amount) || BigInt(tx.Amount) <= 0n) {
      return 'An offer must ask for a positive amount of XRP.'
    }
    // Only HubWorld's broker may complete the sale: an open offer could be taken directly, skipping the fee.
    if (typeof tx.Destination !== 'string' || (broker !== null && tx.Destination !== broker)) {
      return 'An offer must be restricted to HubWorld\u2019s broker.'
    }
  }
  if (rule.offer === 'gift') {
    // A gift is free. One for money would be a sale with no broker, so the fee could be skipped.
    if (tx.Amount !== '0') return 'A gift is free: its amount must be 0.'
    // To one named person: an open free offer is a ticket anyone can take.
    if (typeof tx.Destination !== 'string') return 'A gift must name the person it is for (a destination).'
    if (tx.Destination === tx.Account) return 'You cannot give a ticket to yourself.'
    // Not to the broker: HubWorld's broker must never come to hold anyone's ticket.
    if (broker !== null && tx.Destination === broker) return 'A gift must name a person, not HubWorld\u2019s broker.'
  }
  return null
}
