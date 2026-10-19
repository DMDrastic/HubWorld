/**
 * Reading a delegation off the ledger, and the stub/real split.
 *
 * `xamanMode === 'stub'` only means "no Xaman credentials". A script pointed at
 * devnet or mainnet with throwaway wallets is in stub mode too, and it must not
 * be answered by the in-memory fake: the first mainnet-style run of the shipped
 * code reported "not granted" for a grant that plainly existed, because the
 * stub shortcut swallowed the read. The `OnLedger` readers exist so scripts can
 * never take that path, and this pins that they do not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ORGANIZER = 'rOrganizerFixture000000000000'
const DELEGATE = 'rDelegateFixture0000000000000'

const request = vi.fn<(req: Record<string, unknown>) => Promise<unknown>>()

vi.mock('../src/ledger.js', () => ({
  ledger: async () => ({ request: (r: Record<string, unknown>) => request(r) }),
}))
vi.mock('../src/env.js', () => ({ xamanMode: 'stub' as const }))

const {
  delegationAvailable,
  delegationAvailableOnLedger,
  readPermission,
  readPermissionOnLedger,
  resetDelegationCache,
  MINT_PERMISSION,
} = await import('../src/delegation.js')

const pair = { organizerAddress: ORGANIZER, delegateAddress: DELEGATE }

const grantObject = (permission: string, authorize = DELEGATE) => ({
  Account: ORGANIZER,
  Authorize: authorize,
  LedgerEntryType: 'Delegate',
  Permissions: [{ Permission: { PermissionValue: permission } }],
})

beforeEach(() => {
  request.mockReset()
  resetDelegationCache()
})

describe('readPermissionOnLedger', () => {
  it('reads the organizer\'s Delegate object, even in stub mode', async () => {
    request.mockResolvedValue({ result: { account_objects: [grantObject('NFTokenMint')] } })

    expect(await readPermissionOnLedger(pair, MINT_PERMISSION)).toBe('granted')
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'account_objects', account: ORGANIZER, type: 'delegate' }),
    )
  })

  it('does not count a grant to a different delegate, or for a different permission', async () => {
    request.mockResolvedValue({
      result: {
        account_objects: [
          grantObject('NFTokenMint', 'rSomeoneElse0000000000000000'),
          grantObject('NFTokenCreateOffer'),
        ],
      },
    })

    expect(await readPermissionOnLedger(pair, MINT_PERMISSION)).toBe('absent')
  })

  it('reads an account with no objects as absent', async () => {
    request.mockResolvedValue({ result: { account_objects: [] } })
    expect(await readPermissionOnLedger(pair, MINT_PERMISSION)).toBe('absent')
  })

  it('reads an unfunded account (actNotFound) as absent: there is no grant to find', async () => {
    request.mockRejectedValue(new Error('Account not found. actNotFound'))
    expect(await readPermissionOnLedger(pair, MINT_PERMISSION)).toBe('absent')
  })

  it('reads a transport failure as UNKNOWN, never as a revocation', async () => {
    request.mockRejectedValue(new Error('websocket closed'))
    expect(await readPermissionOnLedger(pair, MINT_PERMISSION)).toBe('unknown')
  })
})

describe('the stub-aware readers', () => {
  it('answer from the fake ledger and never touch the network in stub mode', async () => {
    request.mockResolvedValue({ result: { account_objects: [grantObject('NFTokenMint')] } })

    // The fake knows of no grant, so the app-facing reader says absent even
    // though the (mocked) real ledger has one — which is exactly why scripts
    // must not use it.
    expect(await readPermission(pair, MINT_PERMISSION)).toBe('absent')
    expect(request).not.toHaveBeenCalled()
  })

  it('claims support in stub mode without asking a ledger', async () => {
    expect(await delegationAvailable()).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })
})

describe('delegationAvailableOnLedger', () => {
  it('is true only when the amendment is enabled', async () => {
    request.mockResolvedValue({
      result: { features: { ABC: { name: 'PermissionDelegationV1_1', enabled: true } } },
    })
    expect(await delegationAvailableOnLedger()).toBe(true)
  })

  it('is false when the amendment is present but not enabled', async () => {
    request.mockResolvedValue({
      result: { features: { ABC: { name: 'PermissionDelegationV1_1', enabled: false } } },
    })
    expect(await delegationAvailableOnLedger()).toBe(false)
  })

  it('is false when the feature RPC is not available to us', async () => {
    request.mockRejectedValue(new Error('noPermission'))
    expect(await delegationAvailableOnLedger()).toBe(false)
  })

  it('does not cache a negative answer', async () => {
    request.mockResolvedValueOnce({
      result: { features: { ABC: { name: 'PermissionDelegationV1_1', enabled: false } } },
    })
    expect(await delegationAvailableOnLedger()).toBe(false)

    request.mockResolvedValueOnce({
      result: { features: { ABC: { name: 'PermissionDelegationV1_1', enabled: true } } },
    })
    expect(await delegationAvailableOnLedger()).toBe(true)
  })
})
