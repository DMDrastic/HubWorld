/** A stand-in for the Privy runtime: records what the page asks of the wallet, signs nothing real. */
import { vi } from 'vitest'
import type { ReactNode } from 'react'
import { SignerRuntimeContext, type SignerRuntime } from '@/lib/signer-runtime'

export const WALLET = { address: 'rWalletAddress000000000000000000', publicKey: '02'.padEnd(66, 'A') }

export function fakeRuntime(over: Partial<SignerRuntime> = {}): SignerRuntime & {
  calls: { openLogin: number; signHash: Array<[string, string]> }
} {
  const calls = { openLogin: 0, signHash: [] as Array<[string, string]> }
  return {
    calls,
    ready: true,
    authenticated: true,
    walletAddress: WALLET.address,
    openLogin: () => {
      calls.openLogin += 1
    },
    getTokens: vi.fn(async () => ({ accessToken: 'a'.repeat(30), identityToken: 'i'.repeat(30) })),
    ensureWallet: vi.fn(async () => WALLET),
    signHash: vi.fn(async (address: string, hash: string) => {
      calls.signHash.push([address, hash])
      return 'ab'.repeat(64)
    }),
    logout: vi.fn(async () => {}),
    ...over,
  }
}

export function WithRuntime({ runtime, children }: { runtime: SignerRuntime | null; children: ReactNode }) {
  return <SignerRuntimeContext.Provider value={runtime}>{children}</SignerRuntimeContext.Provider>
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
