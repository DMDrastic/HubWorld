/**
 * Scoped minting delegation.
 *
 * The minting ceiling is a triangle — the organizer must be the issuer (that is
 * what makes `TransferFee` pay them), Hubworld signs as nobody, and bulk minting
 * must be unattended. Any two. We chose the first two, so an organizer taps once
 * per ticket and the product caps out in the low hundreds.
 *
 * `PermissionDelegationV1_1` gives us the third corner without giving up the
 * first. An organizer grants Hubworld permission to submit `NFTokenMint` **and
 * nothing else**; Hubworld signs with its own key while `Account` stays the
 * organizer, so the minted NFT's issuer — and therefore the royalty recipient —
 * is still the organizer.
 *
 * Verified on devnet (`scripts/delegation-spike.ts`, 2026-08-02):
 *   - `Issuer` on the resulting NFT is the ORGANIZER, `TransferFee` intact.
 *   - The NFT never lands in Hubworld's account.
 *   - Hubworld attempting a `Payment` from the organizer's account is refused
 *     with `terNO_DELEGATE_PERMISSION` — the scope is enforced by the LEDGER,
 *     not by our good behaviour. This is the difference from `RegularKey`,
 *     which is unscoped and would also hand over the ability to send funds.
 *   - Revocation is one transaction and takes effect immediately.
 *   - The DELEGATE pays the transaction fee, not the organizer.
 *
 * The amendment is enabled on mainnet (checked 2026-10-19, and exercised with a
 * real ticket by `scripts/delegation-mainnet-check.ts`). Every entry point is
 * still gated on `delegationAvailable()`, read from the ledger, rather than
 * assuming support from the network name. See `ROADMAP.md` §5b.
 *
 * "Delegate" here is the account that SIGNS delegated transactions — a key
 * separate from the broker's, so that a leaked broker key does not mean "can
 * mint as every organizer who ever granted".
 */
import type { DelegateSet, NFTokenMint } from 'xrpl'
import { ledgerMode } from './env.js'
import { ledger } from './ledger.js'
import * as stubLedger from './stub-ledger.js'

/**
 * The one permission Hubworld ever asks for.
 *
 * Named as a constant because the whole trust argument rests on it being
 * exactly this and nothing more — a reviewer should be able to grep one symbol
 * and see the entire scope of what an organizer grants us.
 */
export const MINT_PERMISSION = 'NFTokenMint' as const

/**
 * The second permission, used only for the lazy primary sale.
 *
 * Far more dangerous than minting: minting only creates value for the organizer,
 * whereas offer creation lets the delegate put the organizer's EXISTING tickets
 * up for sale — measured, a zero-price offer to itself returns `tesSUCCESS`.
 * Funds stay safe (`Payment` is still refused). It is therefore its own consent,
 * never bundled into the mint grant, and revoked independently.
 */
export const OFFER_PERMISSION = 'NFTokenCreateOffer' as const

/** Every permission Hubworld ever asks for. Anything else on a grant is not ours. */
export const KNOWN_PERMISSIONS = [MINT_PERMISSION, OFFER_PERMISSION] as const
export type KnownPermission = (typeof KNOWN_PERMISSIONS)[number]

/**
 * The permission set to send to GRANT `permission` while keeping what is held.
 *
 * `DelegateSet` replaces the whole set. Sending only the new permission silently
 * revokes the old one, so a grant is always `current ∪ new`. Sorted and
 * de-duplicated so equal sets compare equal.
 */
export function permissionsAfterGrant(current: readonly string[], add: string): string[] {
  return [...new Set([...current, add])].sort()
}

/**
 * The set to send to REVOKE `remove` (or everything, when omitted).
 *
 * An empty result is the revocation of the delegate entirely.
 */
export function permissionsAfterRevoke(current: readonly string[], remove?: string): string[] {
  if (remove === undefined) return []
  return [...new Set(current)].filter((p) => p !== remove).sort()
}

/** Same members, regardless of order or repeats. */
export function samePermissions(a: readonly string[], b: readonly string[]): boolean {
  const x = [...new Set(a)].sort()
  const y = [...new Set(b)].sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/** The amendment that must be active before any of this can be submitted. */
export const DELEGATION_AMENDMENT = 'PermissionDelegationV1_1' as const

/**
 * Grant Hubworld permission to mint on the organizer's behalf.
 *
 * Signed by the ORGANIZER in Xaman — this is the one signature that replaces
 * one-per-ticket. It is deliberately a separate, explicit act rather than
 * something folded into event creation, because it is the moment an organizer
 * agrees that Hubworld may act as them at all.
 */
export function buildDelegateMintTx(params: {
  organizerAddress: string
  delegateAddress: string
}): DelegateSet {
  return buildDelegateSetTx(params, [MINT_PERMISSION])
}

/**
 * A `DelegateSet` carrying exactly the permissions given.
 *
 * `DelegateSet` REPLACES the whole permission set for a delegate; it does not
 * add to it. Granting a second permission by sending only the new one would
 * silently revoke the first, so every grant must name the full set it intends
 * the delegate to end up with. Callers add permissions here deliberately —
 * nothing appends to the mint grant by accident.
 */
export function buildDelegateSetTx(
  params: { organizerAddress: string; delegateAddress: string },
  permissions: readonly string[],
): DelegateSet {
  if (params.organizerAddress === params.delegateAddress) {
    // Delegating to yourself is meaningless, and it usually means a caller has
    // confused the two addresses — which would be a silent no-op otherwise.
    throw new Error('cannot delegate to the same account')
  }
  return {
    TransactionType: 'DelegateSet',
    Account: params.organizerAddress,
    Authorize: params.delegateAddress,
    Permissions: permissions.map((PermissionValue) => ({ Permission: { PermissionValue } })),
  }
}

/**
 * Withdraw the grant.
 *
 * An empty `Permissions` array is the revocation, confirmed on devnet: the very
 * next delegated mint is refused with `terNO_DELEGATE_PERMISSION`. Revocation
 * must stay as easy as granting, or "revocable" is a claim rather than a
 * property.
 */
export function buildRevokeMintTx(params: {
  organizerAddress: string
  delegateAddress: string
}): DelegateSet {
  return {
    TransactionType: 'DelegateSet',
    Account: params.organizerAddress,
    Authorize: params.delegateAddress,
    Permissions: [],
  }
}

/**
 * A mint that Hubworld submits but the ORGANIZER issues.
 *
 * `Account` is the organizer and `Delegate` is Hubworld. That split is the
 * entire point: the ledger treats the organizer as the issuer — so `TransferFee`
 * still pays them and the NFT lands in their account — while the signature comes
 * from our key, so no human taps anything.
 *
 * Takes an already-built `NFTokenMint` rather than rebuilding one, so there is
 * exactly ONE place in the codebase that decides what a ticket mint looks like
 * (`buildMintTx`). A second builder would be a second chance to get the royalty
 * or the transferable flag wrong.
 */
export function asDelegatedMint(mint: NFTokenMint, delegateAddress: string): NFTokenMint {
  if (mint.Account === delegateAddress) {
    // Would mint an NFT ISSUED BY HUBWORLD — the royalty would accrue to us and
    // the organizer would never receive it. Worth refusing loudly: it is not a
    // crash, it is a silently wrong issuer discovered later on mainnet.
    throw new Error('a delegated mint must be issued by the organizer, not the platform')
  }
  return { ...mint, Delegate: delegateAddress }
}

/**
 * Is scoped delegation usable on the network we are actually connected to?
 *
 * Read from the ledger rather than assumed from `XRPL_NETWORK`, because the
 * answer changes over time as the amendment activates — hardcoding a network
 * list would go stale silently and in the direction that breaks minting.
 *
 * Cached for the process lifetime: an amendment that has activated cannot
 * deactivate, and the negative case is re-checked on the next boot, which is
 * soon enough for something that changes once ever.
 */
let availability: boolean | null = null

export async function delegationAvailable(): Promise<boolean> {
  // The fake ledger supports everything HubWorld builds, and stub mode refuses
  // to boot in production, so this can never claim support on a real network.
  if (ledgerMode === 'stub') return true
  return delegationAvailableOnLedger()
}

/**
 * The same question, always asked of the REAL ledger.
 *
 * The app's ledger setting can be the pretend one, and a script talking to devnet or
 * mainnet with throwaway wallets must never be answered by it: a mainnet check that
 * quietly read the stub would report on nothing. Scripts use this; the app uses
 * `delegationAvailable`.
 */
export async function delegationAvailableOnLedger(): Promise<boolean> {
  if (availability !== null) return availability

  try {
    const client = await ledger()
    const res = (await client.request({ command: 'feature' } as never)) as {
      result: { features?: Record<string, { name?: string; enabled?: boolean }> }
    }
    const features = res.result.features
    if (!features) return false

    const found = Object.values(features).find((f) => f.name === DELEGATION_AMENDMENT)
    const enabled = found?.enabled === true
    // Only a positive answer is cached. A false could mean "not activated yet"
    // OR that this particular server would not answer, and caching that would
    // keep delegation switched off until a restart for no good reason.
    if (enabled) availability = true
    return enabled
  } catch {
    // `feature` is admin-only on many public servers. Unknown is treated as
    // unavailable: minting one-by-one still works, whereas submitting a
    // delegated mint to a network that does not support it fails per ticket.
    return false
  }
}

/** Test seam — the cache would otherwise leak one test's answer into the next. */
export function resetDelegationCache(): void {
  availability = null
}

/**
 * Has this organizer actually granted the delegate this permission, right now?
 *
 * The ledger is the authority, not a column we set when they signed. An
 * organizer can revoke in Xaman without telling us — exactly as they can move a
 * ticket without telling us — so a cached "yes" would have us submitting mints
 * that fail one per ticket.
 *
 * Returns false when the ledger cannot be read as well as when there is no
 * grant, which is the safe direction for a permission check: callers refuse to
 * ACT on a doubtful answer. Anything that would report "revoked" to a person
 * must use `readPermission` instead and keep "unknown" distinct.
 */
export async function hasPermission(
  params: { organizerAddress: string; delegateAddress: string },
  permission: string,
): Promise<boolean> {
  return (await readPermission(params, permission)) === 'granted'
}

/**
 * Like `hasPermission`, but "we could not tell" is its own answer.
 *
 * "The ledger did not answer" and "there is no grant" are opposite facts:
 * collapsing them would tell an organizer their grant was revoked every time a
 * public node blinks — the same rule `/api/health` follows for the broker.
 */
export async function readPermission(
  params: { organizerAddress: string; delegateAddress: string },
  permission: string,
): Promise<'granted' | 'absent' | 'unknown'> {
  const set = await readPermissionSet(params)
  if (set === 'unknown') return 'unknown'
  return set.includes(permission) ? 'granted' : 'absent'
}

/**
 * `readPermission` against the REAL ledger regardless of mode. See
 * `delegationAvailableOnLedger` for why scripts must use this one.
 */
export async function readPermissionOnLedger(
  params: { organizerAddress: string; delegateAddress: string },
  permission: string,
): Promise<'granted' | 'absent' | 'unknown'> {
  const set = await readPermissionSetOnLedger(params)
  if (set === 'unknown') return 'unknown'
  return set.includes(permission) ? 'granted' : 'absent'
}

/**
 * Everything this organizer has granted this delegate, as the ledger holds it.
 *
 * The WHOLE set matters, not one permission at a time: a `DelegateSet` replaces
 * it, so computing a new grant or a partial revoke needs the current contents.
 * `'unknown'` is "the ledger did not answer" and must never be treated as an
 * empty set — building a revoke from a set we could not read could silently
 * remove a permission the organizer meant to keep.
 */
export async function readPermissionSet(params: {
  organizerAddress: string
  delegateAddress: string
}): Promise<string[] | 'unknown'> {
  if (ledgerMode === 'stub') {
    return stubLedger.delegationSet(params.organizerAddress, params.delegateAddress)
  }
  return readPermissionSetOnLedger(params)
}

export async function readPermissionSetOnLedger(params: {
  organizerAddress: string
  delegateAddress: string
}): Promise<string[] | 'unknown'> {
  let client
  try {
    client = await ledger()
  } catch {
    return 'unknown'
  }
  try {
    const res = await client.request({
      command: 'account_objects',
      account: params.organizerAddress,
      type: 'delegate' as never,
      ledger_index: 'validated',
    })
    // Via `unknown`: xrpl.js types account_objects as a union of every ledger
    // entry, and `Delegate` is not in that union in 5.0.0.
    const objects = res.result.account_objects as unknown as Array<Record<string, unknown>>
    const held = new Set<string>()
    for (const o of objects) {
      if (o.Authorize !== params.delegateAddress) continue
      for (const p of (o.Permissions ?? []) as Array<{ Permission?: { PermissionValue?: string } }>) {
        if (p.Permission?.PermissionValue) held.add(p.Permission.PermissionValue)
      }
    }
    return [...held].sort()
  } catch (err) {
    // An account with no delegate objects at all can answer actNotFound rather
    // than an empty set, and "no grant" is the correct reading of THAT. Any
    // other failure is a transport problem and says nothing about the grant.
    const message = err instanceof Error ? err.message : String(err)
    return /actNotFound|Account not found/i.test(message) ? [] : 'unknown'
  }
}

/** Has this organizer granted the mint permission? See `hasPermission`. */
export async function hasMintPermission(params: {
  organizerAddress: string
  delegateAddress: string
}): Promise<boolean> {
  return hasPermission(params, MINT_PERMISSION)
}
