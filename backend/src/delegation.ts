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
 * **This is dormant until the amendment activates.** It is live on devnet,
 * pending on testnet and absent from mainnet, so every entry point here is
 * gated on `delegationAvailable()` rather than assuming support. Building it
 * now is deliberate: the alternative under consideration was an MPT tier, which
 * would have cost the royalty, brokered settlement, resale, auctions and the
 * door's per-ticket verdicts permanently. See `ROADMAP.md` §5b.
 */
import type { DelegateSet, NFTokenMint } from 'xrpl'
import { ledger } from './ledger.js'

/**
 * The one permission Hubworld ever asks for.
 *
 * Named as a constant because the whole trust argument rests on it being
 * exactly this and nothing more — a reviewer should be able to grep one symbol
 * and see the entire scope of what an organizer grants us.
 */
export const MINT_PERMISSION = 'NFTokenMint' as const

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
  platformAddress: string
}): DelegateSet {
  if (params.organizerAddress === params.platformAddress) {
    // Delegating to yourself is meaningless, and it usually means a caller has
    // confused the two addresses — which would be a silent no-op otherwise.
    throw new Error('cannot delegate to the same account')
  }
  return {
    TransactionType: 'DelegateSet',
    Account: params.organizerAddress,
    Authorize: params.platformAddress,
    Permissions: [{ Permission: { PermissionValue: MINT_PERMISSION } }],
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
  platformAddress: string
}): DelegateSet {
  return {
    TransactionType: 'DelegateSet',
    Account: params.organizerAddress,
    Authorize: params.platformAddress,
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
export function asDelegatedMint(mint: NFTokenMint, platformAddress: string): NFTokenMint {
  if (mint.Account === platformAddress) {
    // Would mint an NFT ISSUED BY HUBWORLD — the royalty would accrue to us and
    // the organizer would never receive it. Worth refusing loudly: it is not a
    // crash, it is a silently wrong issuer discovered later on mainnet.
    throw new Error('a delegated mint must be issued by the organizer, not the platform')
  }
  return { ...mint, Delegate: platformAddress }
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
 * Has this organizer actually granted us the mint permission, right now?
 *
 * The ledger is the authority, not a column we set when they signed. An
 * organizer can revoke in Xaman without telling us — exactly as they can move a
 * ticket without telling us — so a cached "yes" would have us submitting mints
 * that fail one per ticket.
 */
export async function hasMintPermission(params: {
  organizerAddress: string
  platformAddress: string
}): Promise<boolean> {
  const client = await ledger()
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
    return objects.some((o) => {
      if (o.Authorize !== params.platformAddress) return false
      const permissions = (o.Permissions ?? []) as Array<{
        Permission?: { PermissionValue?: string }
      }>
      return permissions.some((p) => p.Permission?.PermissionValue === MINT_PERMISSION)
    })
  } catch {
    // An account with no delegate objects at all can 404 rather than return an
    // empty set, and "no grant" is the correct reading of that.
    return false
  }
}
