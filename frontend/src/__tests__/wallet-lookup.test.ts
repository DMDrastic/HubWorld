// @vitest-environment node
/**
 * Finding someone's wallet without making a second one.
 *
 * The bug this exists for was found the first time the real login ran: a person whose email already
 * had an XRPL wallet was told "already linked to an XRPL account" and could not get past it.
 */
import { describe, expect, it, vi } from 'vitest'
import { findOrCreateWallet } from '@/lib/wallet-lookup'

const W = { address: 'rExisting0000000000000000000000', publicKey: '02ab'.padEnd(66, 'c') }
const upper = W.publicKey.toUpperCase()
const instant = async () => {}

describe('findOrCreateWallet', () => {
  it('uses the wallet that is already there and creates nothing', async () => {
    const create = vi.fn()
    const got = await findOrCreateWallet({ read: () => W, create, wait: instant })
    expect(got).toEqual({ address: W.address, publicKey: upper })
    expect(create).not.toHaveBeenCalled()
  })

  it('accepts the key under either name Privy uses', async () => {
    const got = await findOrCreateWallet({
      read: () => ({ address: W.address, public_key: W.publicKey }),
      create: vi.fn(),
      wait: instant,
    })
    expect(got.publicKey).toBe(upper)
  })

  it('creates one when there is none', async () => {
    const create = vi.fn(async () => W)
    const got = await findOrCreateWallet({ read: () => null, create, wait: instant })
    expect(got).toEqual({ address: W.address, publicKey: upper })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('finds the wallet when creating it is refused because it exists and the user object just lagged', async () => {
    let reads = 0
    const got = await findOrCreateWallet({
      // Empty on the first look, there on the next: the user object catching up with login.
      read: () => (++reads < 3 ? null : W),
      create: async () => {
        throw new Error('User already has an XRPL wallet')
      },
      wait: instant,
    })
    expect(got).toEqual({ address: W.address, publicKey: upper })
  })

  it('reports the real reason when there is genuinely no wallet and creating one fails', async () => {
    await expect(
      findOrCreateWallet({
        read: () => null,
        create: async () => {
          throw new Error('Privy is unavailable')
        },
        wait: instant,
        looks: 3,
      }),
    ).rejects.toThrow('Privy is unavailable')
  })

  it('does not wait forever', async () => {
    const wait = vi.fn(instant)
    await expect(
      findOrCreateWallet({ read: () => null, create: async () => null, wait, looks: 4 }),
    ).rejects.toThrow(/details were not returned/)
    expect(wait).toHaveBeenCalledTimes(4)
  })

  it('does not take a wallet that has an address but no key, since the server needs the key', async () => {
    await expect(
      findOrCreateWallet({ read: () => ({ address: W.address }), create: async () => null, wait: instant, looks: 1 }),
    ).rejects.toThrow()
  })
})
