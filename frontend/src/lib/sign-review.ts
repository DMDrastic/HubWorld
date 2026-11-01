/**
 * Reading what you are about to sign, before you sign it.
 *
 * With a wallet the person owns, the server builds the transaction and the page only asks the
 * wallet to sign its hash. A hash is opaque: a page that just forwards it would let a compromised
 * server get an organizer to approve a delegation to the wrong account without anyone seeing it.
 * So the page does three things the server cannot do for it:
 *
 *   1. DECODES the transaction it was given and writes a plain summary FROM THE TRANSACTION, never
 *      from text the server supplied.
 *   2. Works out the hash ITSELF and refuses if it differs from the one it was handed.
 *   3. Refuses anything it does not fully understand: an unknown transaction type, a permission it
 *      does not know, a field it cannot describe. Signing something blind is the failure this
 *      exists to prevent, so "I can't show you this" means "I won't ask you to sign it".
 *
 * One honest limit: if the server is hostile it can also lie about which delegate account is the
 * real HubWorld one. The summary always prints the full account being authorised so it can be
 * checked against an independent source; this module checks it against what `/delegation/me`
 * advertises, which catches a server that is merely inconsistent, not one that is consistently lying.
 *
 * Imports `xrpl` for the one thing it needs (encoding for signing), so it lives in the code-split
 * Privy chunk's dependency graph and is never in the main bundle.
 */
import { encodeForSigning } from 'xrpl'
import { dropsToXrp, type SignBlock } from '@/lib/api'

export type Held = { mint: boolean; offers: boolean }
export type Scope = 'mint' | 'offers'

/**
 * What the person asked for, as the PAGE knows it (the price they saw, the bid they typed), so the review can check the
 * transaction against it. `label` is the event's name as the page already shows it: it only words the summary, it is not
 * part of what is checked.
 */
export type ReviewAction =
  /** A purchase, at the box office or from the marketplace: the buy offer must be for exactly what was shown. */
  | { kind: 'buy'; amountDrops: string; label?: string }
  /** A bid in an auction: exactly what was typed. */
  | { kind: 'bid'; amountDrops: string; label?: string }
  /** Listing a ticket: the sell offer must be the asking price less at most a 10% fee, never more. */
  | { kind: 'list'; askDrops: string; label?: string }
  /** Opening an auction: the same, against the reserve. */
  | { kind: 'auction'; reserveDrops: string; label?: string }
  /** Taking a listing off sale. */
  | { kind: 'withdraw'; label?: string }
  /** Giving a ticket: a free offer to the person the giver chose (their handle as typed, their wallet as looked up). */
  | { kind: 'gift'; recipientAddress: string; recipientHandle: string; label?: string }
  /** Accepting a ticket someone gave you: the one offer the page was shown. */
  | { kind: 'acceptGift'; offerIndex: string; fromHandle: string; label?: string }
  /** Taking back a gift you offered and nobody has accepted yet. */
  | { kind: 'cancelGift'; label?: string }

export type ReviewContext = {
  /** The account the signed-in person's own wallet is. */
  account: string
  /** HubWorld's delegate address from a separate read; null when it could not be read. */
  hubworldDelegate: string | null
  /** HubWorld's broker from a separate read (`/api/policy`); null when it could not be read. Offers must name it. */
  broker?: string | null
  /** For a purchase, bid, listing, auction or withdrawal: what the person asked for. */
  action?: ReviewAction
  /** For a delegation: what is held today, and what the person just asked to do. */
  delegation?: { held: Held; action: 'grant' | 'revoke'; scope: Scope }
  /** For a mint: the event as the person saw it. */
  eventTitle?: string
}

export type Review =
  | { ok: true; title: string; lines: string[]; authorises?: string }
  | { ok: false; reason: string }

const PERMISSION_FOR: Record<string, Scope> = { NFTokenMint: 'mint', NFTokenCreateOffer: 'offers' }

/** Fees on the ledger are about 12 drops; thousands during a spike. A request for more than this is wrong. */
const MAX_FEE_DROPS = 100_000n

const COMMON = ['TransactionType', 'Account', 'Fee', 'Sequence', 'LastLedgerSequence', 'SigningPubKey', 'NetworkID', 'Flags']
const FIELDS: Record<string, string[]> = {
  DelegateSet: [...COMMON, 'Authorize', 'Permissions'],
  NFTokenMint: [...COMMON, 'NFTokenTaxon', 'TransferFee', 'URI', 'Amount', 'Destination'],
  NFTokenCreateOffer: [...COMMON, 'NFTokenID', 'Amount', 'Destination', 'Owner'],
  NFTokenCancelOffer: [...COMMON, 'NFTokenOffers'],
  NFTokenAcceptOffer: [...COMMON, 'NFTokenSellOffer'],
}

const refuse = (reason: string): Review => ({ ok: false, reason })

/** SHA-512Half of the signing-prefixed bytes, as the ledger hashes a transaction to sign it. */
export async function hashOf(tx: Record<string, unknown>): Promise<string> {
  const hex = encodeForSigning(tx as never)
  const bytes = Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', bytes))
  return [...digest.slice(0, 32)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}

function describePermissions(set: Set<Scope>): string[] {
  const lines: string[] = []
  if (set.has('mint')) lines.push('Create tickets in your wallet when you ask it to.')
  if (set.has('offers')) lines.push('Put your tickets up for sale, only to HubWorld’s own checkout.')
  return lines
}

export async function reviewSignRequest(sign: SignBlock, ctx: ReviewContext): Promise<Review> {
  const tx = sign.tx
  const type = tx.TransactionType

  if (typeof type !== 'string' || !(type in FIELDS)) {
    return refuse('This request is something we can’t show you in plain words, so we won’t ask you to approve it.')
  }
  if (sign.account !== ctx.account || tx.Account !== ctx.account) {
    return refuse('This request is not for your account.')
  }
  for (const key of Object.keys(tx)) {
    if (!FIELDS[type]!.includes(key)) {
      return refuse(`This request contains something we can’t describe (${key}), so we won’t ask you to approve it.`)
    }
  }
  // A request with no deadline could be approved now and used much later.
  if (typeof tx.LastLedgerSequence !== 'number') return refuse('This request has no expiry, so we won’t ask you to approve it.')
  if (typeof tx.Fee !== 'string' || !/^\d+$/.test(tx.Fee) || BigInt(tx.Fee) > MAX_FEE_DROPS) {
    return refuse('This request asks for an unusual network fee, so we won’t ask you to approve it.')
  }

  let review: Review
  if (type === 'DelegateSet') review = reviewDelegation(tx, ctx)
  else if (type === 'NFTokenMint') review = reviewMint(tx, ctx)
  else review = reviewAction(tx, ctx)
  if (!review.ok) return review

  // Last, and independent of the server: our own hash must be the one we were told to sign.
  let mine: string
  try {
    mine = await hashOf(tx)
  } catch {
    return refuse('We couldn’t check this request, so we won’t ask you to approve it.')
  }
  if (mine !== sign.hash.toUpperCase()) {
    return refuse('What we were asked to sign does not match what is shown here, so we won’t ask you to approve it.')
  }
  return review
}

function reviewDelegation(tx: Record<string, unknown>, ctx: ReviewContext): Review {
  const d = ctx.delegation
  if (!d) return refuse('This request was not expected here.')
  if (typeof tx.Authorize !== 'string') return refuse('This request does not say who it authorises.')
  if (tx.Authorize === ctx.account) return refuse('This request authorises your own account, which makes no sense.')
  if (!ctx.hubworldDelegate) {
    return refuse('We couldn’t confirm which account this authorises, so we won’t ask you to approve it.')
  }
  if (tx.Authorize !== ctx.hubworldDelegate) {
    return refuse('This would authorise an account that is not HubWorld’s. Do not approve it.')
  }

  const raw = tx.Permissions
  if (!Array.isArray(raw)) return refuse('This request does not list what it allows.')
  const result = new Set<Scope>()
  for (const entry of raw) {
    const value = (entry as { Permission?: { PermissionValue?: unknown } })?.Permission?.PermissionValue
    const scope = typeof value === 'string' ? PERMISSION_FOR[value] : undefined
    if (!scope) return refuse('This request allows something we don’t recognise, so we won’t ask you to approve it.')
    result.add(scope)
  }

  // A DelegateSet REPLACES the whole set, so the safe test is: is the result exactly what the
  // person asked for? A grant must add that one thing and keep the rest; a revoke must take away
  // that one thing and keep the rest. Anything else (granting more, or quietly dropping something) is refused.
  const expected = new Set<Scope>()
  if (d.held.mint) expected.add('mint')
  if (d.held.offers) expected.add('offers')
  if (d.action === 'grant') expected.add(d.scope)
  else expected.delete(d.scope)
  const same = result.size === expected.size && [...result].every((s) => expected.has(s))
  if (!same) return refuse('This would change more than you asked for, so we won’t ask you to approve it.')

  const grant = d.action === 'grant'
  const what = d.scope === 'mint' ? 'create tickets for you' : 'sell your tickets'
  const lines = result.size
    ? ['After this, HubWorld will be able to:', ...describePermissions(result), 'It cannot send your money or touch anything else.']
    : ['After this, HubWorld will not be able to act on your account at all.']
  lines.push(`Authorising this account: ${tx.Authorize}`, 'You can take this back at any time.')
  return {
    ok: true,
    title: grant ? `Allow HubWorld to ${what}` : `Stop HubWorld from being able to ${what}`,
    lines,
    authorises: tx.Authorize,
  }
}

function reviewMint(tx: Record<string, unknown>, ctx: ReviewContext): Review {
  const lines: string[] = ['A new ticket is created in your wallet, with you as its issuer.']
  if (typeof tx.TransferFee === 'number') {
    lines.push(`You earn ${tx.TransferFee / 1000}% every time it is resold.`)
  }
  if (tx.Amount !== undefined) {
    if (typeof tx.Amount !== 'string' || !/^\d+$/.test(tx.Amount) || typeof tx.Destination !== 'string') {
      return refuse('This listing is in a form we can’t describe, so we won’t ask you to approve it.')
    }
    lines.push(`It is offered for sale at ${dropsToXrp(tx.Amount)} XRP, and only the account ${tx.Destination} can complete that sale.`)
  }
  return { ok: true, title: ctx.eventTitle ? `Create a ticket for ${ctx.eventTitle}` : 'Create a ticket', lines }
}

const short = (id: unknown) => (typeof id === 'string' && id.length >= 12 ? `${id.slice(0, 6)}…${id.slice(-6)}` : 'unknown')
const toBig = (v: unknown): bigint | null => (typeof v === 'string' && /^[1-9][0-9]*$/.test(v) ? BigInt(v) : null)
const TF_SELL = 1

/**
 * A purchase, a bid, a listing, an auction or a withdrawal.
 *
 * The page knows what the person asked for, and the transaction is checked against THAT: the amount of a purchase must be
 * what was shown, the destination must be HubWorld's broker as read from a separate place, and a listing may keep back a fee
 * but never ask for more than the price. A server that changed any of them is refused before the wallet is asked.
 */
function reviewAction(tx: Record<string, unknown>, ctx: ReviewContext): Review {
  const act = ctx.action
  if (!act) return refuse('This request was not expected here.')
  const type = tx.TransactionType
  const at = act.label ? ` to ${act.label}` : ''

  if (act.kind === 'cancelGift') {
    if (type !== 'NFTokenCancelOffer') return refuse('This is not taking back a gift, so we won’t ask you to approve it.')
    const offers = tx.NFTokenOffers
    if (!Array.isArray(offers) || offers.length !== 1 || typeof offers[0] !== 'string' || !/^[0-9A-Fa-f]{64}$/.test(offers[0])) {
      return refuse('This would cancel something other than your one gift, so we won’t ask you to approve it.')
    }
    return {
      ok: true,
      title: `Take back your gift of a ticket${at}`,
      lines: ['This withdraws the offer before anyone accepts it. The ticket stays in your wallet, and nothing is charged.'],
    }
  }

  if (act.kind === 'acceptGift') {
    if (type !== 'NFTokenAcceptOffer') return refuse('This is not accepting a gift, so we won’t ask you to approve it.')
    if (tx.NFTokenSellOffer !== act.offerIndex) {
      return refuse('This would accept something that is not the gift shown to you. Do not approve it.')
    }
    return {
      ok: true,
      title: `Accept the ticket${at} from ${act.fromHandle}`,
      lines: [
        'This takes the ticket into your wallet. Nothing is paid, apart from a tiny network fee.',
        // Said as what it is: an accept does not carry the offer's amount, so this page cannot see it. The server reads the offer
        // on the ledger and refuses to ask unless it is free and addressed to you.
        'An accept does not show what the offer costs, so HubWorld checked on the ledger that this one is free and addressed to you before asking.',
      ],
    }
  }

  if (act.kind === 'gift') {
    if (type !== 'NFTokenCreateOffer') return refuse('This is not a gift, so we won’t ask you to approve it.')
    const giftFlags = typeof tx.Flags === 'number' ? tx.Flags : 0
    if ((giftFlags & TF_SELL) !== TF_SELL || 'Owner' in tx) return refuse('This is not a gift, so we won’t ask you to approve it.')
    if (tx.Amount !== '0') return refuse('A gift is free, and this asks for money. Do not approve it.')
    if (tx.Destination === ctx.account) return refuse('This gives the ticket to yourself, which makes no sense.')
    if (ctx.broker && tx.Destination === ctx.broker) return refuse('This would give your ticket to HubWorld’s own account. Do not approve it.')
    if (tx.Destination !== act.recipientAddress) {
      return refuse('This sends the ticket to someone who is not the person you chose. Do not approve it.')
    }
    const handle = act.recipientHandle.replace(/^@/, '')
    return {
      ok: true,
      title: `Give your ticket${at} to @${handle}`,
      lines: [
        `It is free: @${handle} receives the ticket and nothing is paid either way.`,
        'It stays yours until they accept it, and you can take it back until then.',
        `Their wallet: ${String(tx.Destination)}`,
        `Ticket ${short(tx.NFTokenID)}`,
      ],
    }
  }

  if (act.kind === 'withdraw') {
    if (type !== 'NFTokenCancelOffer') return refuse('This is not a withdrawal, so we won’t ask you to approve it.')
    const offers = tx.NFTokenOffers
    if (!Array.isArray(offers) || offers.length !== 1 || typeof offers[0] !== 'string' || !/^[0-9A-Fa-f]{64}$/.test(offers[0])) {
      return refuse('This would cancel something other than a single listing, so we won’t ask you to approve it.')
    }
    return {
      ok: true,
      title: `Take your ticket${at} off sale`,
      lines: ['This withdraws your listing. Nothing is charged, and the ticket stays in your wallet.'],
    }
  }

  if (type !== 'NFTokenCreateOffer') return refuse('This is not the kind of request we were expecting, so we won’t ask you to approve it.')

  // Only HubWorld's broker may complete a sale. An offer anyone could take would skip the fee, or hand the ticket away.
  if (!ctx.broker) return refuse('We couldn’t confirm HubWorld’s account, so we won’t ask you to approve this.')
  if (tx.Destination !== ctx.broker) return refuse('This offer goes to an account that is not HubWorld’s. Do not approve it.')

  const amount = toBig(tx.Amount)
  if (amount === null) return refuse('This offer is not for a plain amount of XRP, so we won’t ask you to approve it.')
  const flags = typeof tx.Flags === 'number' ? tx.Flags : 0
  const isSell = (flags & TF_SELL) === TF_SELL
  const xrp = dropsToXrp(amount.toString())
  const ticket = `Ticket ${short(tx.NFTokenID)}`

  if (act.kind === 'buy' || act.kind === 'bid') {
    if (isSell) return refuse('This is a sale of your ticket, not a purchase, so we won’t ask you to approve it.')
    if (typeof tx.Owner !== 'string' || tx.Owner === ctx.account) {
      return refuse('This offer does not name another owner for the ticket, so we won’t ask you to approve it.')
    }
    if (tx.Amount !== act.amountDrops) {
      return refuse('The amount is not what was shown to you, so we won’t ask you to approve it.')
    }
    return act.kind === 'buy'
      ? {
          ok: true,
          title: `Buy 1 ticket${at}`,
          lines: [
            `You pay ${xrp} XRP. Nothing else leaves your wallet apart from a tiny network fee.`,
            ticket,
            'Only HubWorld’s account can complete this, and only if the ticket is still available.',
          ],
        }
      : {
          ok: true,
          title: `Bid on a ticket${at}`,
          lines: [
            `You offer ${xrp} XRP. If you do not win, nothing is charged.`,
            ticket,
            'Only HubWorld’s account can complete this, and only if you win.',
          ],
        }
  }

  // list / auction: a sell offer for the ticket in the person's own wallet.
  if (!isSell) return refuse('This is a purchase, not a listing, so we won’t ask you to approve it.')
  if ('Owner' in tx) return refuse('This offer names an owner, which a listing never does, so we won’t ask you to approve it.')
  const ask = toBig(act.kind === 'list' ? act.askDrops : act.reserveDrops)
  if (ask === null) return refuse('We couldn’t check this against what you asked for, so we won’t ask you to approve it.')
  // A fee may come out of the sale, but never more than a tenth, and the offer can never be MORE than the price shown.
  if (amount > ask || amount * 10n < ask * 9n) {
    return refuse('The amount is not what you asked for, so we won’t ask you to approve it.')
  }
  const fee = ask - amount
  if (act.kind === 'list') {
    return {
      ok: true,
      title: `Put your ticket${at} up for sale`,
      lines: [
        `If it sells you receive ${xrp} XRP, before the organizer’s royalty.`,
        `Your asking price of ${dropsToXrp(ask.toString())} XRP${fee > 0n ? `; HubWorld’s fee of ${dropsToXrp(fee.toString())} XRP comes out of it` : ''}.`,
        ticket,
        'Only HubWorld’s account can complete the sale. You can take it off sale until it sells.',
      ],
    }
  }
  return {
    ok: true,
    title: `Start an auction for your ticket${at}`,
    lines: [
      `Your reserve of ${dropsToXrp(ask.toString())} XRP is the least it will sell for. If it sells you receive at least ${xrp} XRP, before the organizer’s royalty.`,
      ticket,
      'Only HubWorld’s account can complete the sale.',
    ],
  }
}
