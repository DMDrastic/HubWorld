/**
 * Signing out ends BOTH sessions: HubWorld's, and the email wallet's. Written before the fix.
 *
 * Privy remembers who signed in. Signing out of HubWorld alone left that memory behind, so the email button went straight back in as
 * the same person, and nobody could sign in as anyone else on that browser. The wallet's sign-out must happen whatever the server
 * answered, and a wallet that fails to sign out must never keep someone signed in to HubWorld.
 */
import { describe, expect, it, vi } from 'vitest'
import { signOutEverywhere } from '@/lib/sign-out'

describe('signOutEverywhere', () => {
  it('ends the HubWorld session, then the wallet’s, and reports what the server said', async () => {
    const order: string[] = []
    const server = vi.fn(async () => {
      order.push('server')
      return { revoked: true }
    })
    const wallet = vi.fn(async () => {
      order.push('wallet')
    })
    expect(await signOutEverywhere(server, wallet)).toEqual({ revoked: true })
    expect(order).toEqual(['server', 'wallet'])
  })

  it('signs the wallet out even when the server could not be reached, and still reports that failure', async () => {
    const wallet = vi.fn(async () => {})
    const boom = new Error('backend down')
    await expect(signOutEverywhere(async () => { throw boom }, wallet)).rejects.toBe(boom)
    expect(wallet).toHaveBeenCalledTimes(1)
  })

  it('a wallet that fails to sign out does not turn a good sign-out into a failure', async () => {
    const r = await signOutEverywhere(async () => ({ revoked: false }), async () => { throw new Error('sdk blew up') })
    expect(r).toEqual({ revoked: false })
  })

  it('works with no email wallet at all (a Xaman user, or the code never loaded)', async () => {
    expect(await signOutEverywhere(async () => ({ revoked: true }), null)).toEqual({ revoked: true })
  })

  it('calls each exactly once', async () => {
    const server = vi.fn(async () => ({ revoked: true }))
    const wallet = vi.fn(async () => {})
    await signOutEverywhere(server, wallet)
    expect(server).toHaveBeenCalledTimes(1)
    expect(wallet).toHaveBeenCalledTimes(1)
  })
})
