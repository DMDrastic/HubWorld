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

export type ReviewContext = {
  /** The account the signed-in person's own wallet is. */
  account: string
  /** HubWorld's delegate address from a separate read; null when it could not be read. */
  hubworldDelegate: string | null
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
  else review = reviewMint(tx, ctx)
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
