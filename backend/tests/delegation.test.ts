/**
 * Scoped minting delegation.
 *
 * These assertions are the trust model in executable form. An organizer granting
 * delegation is agreeing that Hubworld may act as them, and the ONLY thing that
 * makes that acceptable is the scope being exactly one transaction type. A test
 * that let a second permission through would not fail loudly — it would quietly
 * widen what every organizer had already agreed to.
 *
 * The issuer assertion matters for the same reason the `TransferFee` tests do:
 * a delegated mint that named Hubworld as `Account` would issue the NFT from
 * OUR account, so the royalty would accrue to us and the organizer would never
 * see it. That is not a crash. It is a silently wrong issuer, found on mainnet,
 * on a ticket that cannot be reminted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  asDelegatedMint,
  buildDelegateMintTx,
  buildDelegateSetTx,
  buildRevokeMintTx,
  DELEGATION_AMENDMENT,
  MINT_PERMISSION,
  OFFER_PERMISSION,
  KNOWN_PERMISSIONS,
  permissionsAfterGrant,
  permissionsAfterRevoke,
  samePermissions,
} from '../src/delegation.js'
import { buildMintTx } from '../src/ledger.js'

const ORGANIZER = 'r4wQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf'
const PLATFORM = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildDelegateMintTx', () => {
  it('grants exactly one permission, and it is NFTokenMint', () => {
    const tx = buildDelegateMintTx({ organizerAddress: ORGANIZER, delegateAddress: PLATFORM })

    expect(tx.TransactionType).toBe('DelegateSet')
    expect(tx.Account).toBe(ORGANIZER) // the organizer grants
    expect(tx.Authorize).toBe(PLATFORM) // ...to us
    // The whole trust argument. One entry, and it is the mint.
    expect(tx.Permissions).toHaveLength(1)
    expect(tx.Permissions[0]!.Permission.PermissionValue).toBe('NFTokenMint')
  })

  /**
   * `RegularKey` was rejected because it is unscoped — an organizer granting it
   * would also grant the ability to send payments from their account. The value
   * of this path is that the grant cannot reach anything else, so nothing may
   * ever quietly append to it.
   */
  it('never grants payment or account-control permissions', () => {
    const tx = buildDelegateMintTx({ organizerAddress: ORGANIZER, delegateAddress: PLATFORM })
    const granted = tx.Permissions.map((p) => p.Permission.PermissionValue)

    for (const forbidden of [
      'Payment',
      'AccountSet',
      'SetRegularKey',
      'SignerListSet',
      'NFTokenBurn',
      'NFTokenCreateOffer',
      'AccountDelete',
    ]) {
      expect(granted).not.toContain(forbidden)
    }
  })

  /**
   * Delegating to yourself is a no-op the ledger would happily accept, so it
   * would present as "granted" while nothing worked. Almost always a caller
   * that has swapped the two addresses.
   */
  it('refuses to delegate an account to itself', () => {
    expect(() =>
      buildDelegateMintTx({ organizerAddress: ORGANIZER, delegateAddress: ORGANIZER }),
    ).toThrow(/same account/i)
  })
})

describe('buildRevokeMintTx', () => {
  /**
   * Revocation must stay exactly as cheap as granting, or "revocable" is
   * marketing rather than a property. An empty Permissions array is the
   * revocation — confirmed on devnet, where the next delegated mint was refused
   * with terNO_DELEGATE_PERMISSION.
   */
  it('withdraws everything, addressed to the same delegate', () => {
    const tx = buildRevokeMintTx({ organizerAddress: ORGANIZER, delegateAddress: PLATFORM })

    expect(tx.TransactionType).toBe('DelegateSet')
    expect(tx.Account).toBe(ORGANIZER)
    expect(tx.Authorize).toBe(PLATFORM)
    expect(tx.Permissions).toEqual([])
  })

  it('is the exact inverse of the grant', () => {
    const grant = buildDelegateMintTx({ organizerAddress: ORGANIZER, delegateAddress: PLATFORM })
    const revoke = buildRevokeMintTx({ organizerAddress: ORGANIZER, delegateAddress: PLATFORM })

    // Same account, same delegate — only the permission set differs. A
    // revocation aimed at a different delegate would silently leave the real
    // grant in place.
    expect(revoke.Account).toBe(grant.Account)
    expect(revoke.Authorize).toBe(grant.Authorize)
    expect(revoke.Permissions).toHaveLength(0)
  })
})

describe('buildDelegateSetTx', () => {
  const pair = { organizerAddress: ORGANIZER, delegateAddress: PLATFORM }

  /**
   * `DelegateSet` REPLACES a delegate's permissions. Granting a second one by
   * sending only the new value would silently revoke minting, so a caller must
   * name the full set — and the builder must carry exactly what it is given.
   */
  it('carries exactly the permissions it is given, in order', () => {
    const tx = buildDelegateSetTx(pair, ['NFTokenMint', 'NFTokenCreateOffer'])
    expect(tx.Permissions.map((p) => p.Permission.PermissionValue)).toEqual([
      'NFTokenMint',
      'NFTokenCreateOffer',
    ])
  })

  it('an empty set is the revocation', () => {
    expect(buildDelegateSetTx(pair, [])).toEqual(buildRevokeMintTx(pair))
  })

  it('the mint grant is the single-permission case of it', () => {
    expect(buildDelegateMintTx(pair)).toEqual(buildDelegateSetTx(pair, [MINT_PERMISSION]))
  })

  it('still refuses to delegate to the same account', () => {
    expect(() =>
      buildDelegateSetTx({ organizerAddress: ORGANIZER, delegateAddress: ORGANIZER }, [MINT_PERMISSION]),
    ).toThrow(/same account/)
  })
})

describe('asDelegatedMint', () => {
  const mint = () =>
    buildMintTx({ issuerAddress: ORGANIZER, taxon: 70_001, royaltyBps: 500, uri: 'ipfs://x' })

  /**
   * The property the whole design depends on: Account stays the organizer, so
   * the ledger treats THEM as the issuer and the royalty reaches them. Only the
   * signer changes.
   */
  it('keeps the organizer as issuer and only adds the delegate', () => {
    const tx = asDelegatedMint(mint(), PLATFORM)

    expect(tx.Account).toBe(ORGANIZER) // issuer, and royalty recipient
    expect(tx.Delegate).toBe(PLATFORM) // signer only
  })

  /** The royalty and transferability must survive delegation untouched. */
  it('preserves every minting term', () => {
    const original = mint()
    const tx = asDelegatedMint(original, PLATFORM)

    expect(tx.TransferFee).toBe(original.TransferFee)
    expect(tx.NFTokenTaxon).toBe(original.NFTokenTaxon)
    expect(tx.Flags).toBe(original.Flags)
    expect(tx.URI).toBe(original.URI)
    expect(tx.TransactionType).toBe('NFTokenMint')
  })

  /**
   * The expensive mistake. Minting with Account = Hubworld issues the NFT from
   * OUR account: `TransferFee` would pay us, the organizer would receive
   * nothing, and it cannot be fixed after the fact because the issuer is baked
   * into the NFTokenID.
   */
  it('refuses to mint with the platform as issuer', () => {
    const wrong = buildMintTx({ issuerAddress: PLATFORM, taxon: 70_001, royaltyBps: 500 })
    expect(() => asDelegatedMint(wrong, PLATFORM)).toThrow(/issued by the organizer/i)
  })

  /** Building a delegated mint must not mutate the caller's transaction. */
  it('does not modify the transaction it was given', () => {
    const original = mint()
    asDelegatedMint(original, PLATFORM)
    expect(original).not.toHaveProperty('Delegate')
  })
})

describe('constants', () => {
  /**
   * Pinned deliberately. These two strings are the entire interface with the
   * amendment: a typo in either fails at submission time, per ticket, on a
   * network where minting had been working.
   */
  it('names the permission and amendment exactly', () => {
    expect(MINT_PERMISSION).toBe('NFTokenMint')
    expect(DELEGATION_AMENDMENT).toBe('PermissionDelegationV1_1')
  })
})

describe('permission set arithmetic', () => {
  it('a grant is the union, sorted and de-duplicated', () => {
    expect(permissionsAfterGrant(['NFTokenMint'], 'NFTokenCreateOffer')).toEqual(['NFTokenCreateOffer', 'NFTokenMint'])
    expect(permissionsAfterGrant(['NFTokenMint'], 'NFTokenMint')).toEqual(['NFTokenMint'])
    expect(permissionsAfterGrant([], 'NFTokenMint')).toEqual(['NFTokenMint'])
  })

  it('a revoke removes only what it names, and nothing means everything', () => {
    expect(permissionsAfterRevoke(['NFTokenCreateOffer', 'NFTokenMint'], 'NFTokenCreateOffer')).toEqual(['NFTokenMint'])
    expect(permissionsAfterRevoke(['NFTokenMint'], 'NFTokenCreateOffer')).toEqual(['NFTokenMint'])
    expect(permissionsAfterRevoke(['NFTokenCreateOffer', 'NFTokenMint'])).toEqual([])
  })

  it('compares as sets', () => {
    expect(samePermissions(['b', 'a'], ['a', 'b', 'b'])).toBe(true)
    expect(samePermissions(['a'], ['a', 'b'])).toBe(false)
    expect(samePermissions([], [])).toBe(true)
  })

  it('names the offer permission exactly, and it is not the mint one', () => {
    expect(OFFER_PERMISSION).toBe('NFTokenCreateOffer')
    expect(OFFER_PERMISSION).not.toBe(MINT_PERMISSION)
    expect([...KNOWN_PERMISSIONS]).toEqual(['NFTokenMint', 'NFTokenCreateOffer'])
  })
})
