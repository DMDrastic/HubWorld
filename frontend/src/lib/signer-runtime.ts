/**
 * What the page can ask of a wallet the person owns, without knowing whose it is.
 *
 * The Privy SDK is heavy (it pulls in wallet-connection libraries), so it lives in its own
 * code-split chunk that is only fetched where it is needed. Everything else in the app talks to
 * THIS small interface through a React context, which is empty (null) wherever the chunk was not
 * loaded. A component that finds null simply does not offer the option, so a visitor who never
 * needs an email login never downloads a byte of it.
 */
import { createContext, useContext } from 'react'

export type PrivyTokens = { accessToken: string; identityToken: string }
export type PrivyWallet = { address: string; publicKey: string }

export interface SignerRuntime {
  /** The SDK has started and knows whether anyone is signed in. */
  ready: boolean
  /** Someone is signed in to Privy in this browser (not the same as signed in to HubWorld). */
  authenticated: boolean
  /** The XRPL address of the signed-in person's own wallet, if they have one. */
  walletAddress: string | null
  /** Open Privy's email login. Completion shows up as `authenticated` turning true. */
  openLogin(): void
  /** Fresh tokens for the server to verify. Null if nobody is signed in. */
  getTokens(): Promise<PrivyTokens | null>
  /** The person's XRPL wallet, creating it the first time. */
  ensureWallet(): Promise<PrivyWallet>
  /** Ask the wallet to sign a hash (64 hex characters). Returns the signature as hex. */
  signHash(address: string, hashHex: string): Promise<string>
  logout(): Promise<void>
}

export const SignerRuntimeContext = createContext<SignerRuntime | null>(null)

/** The runtime, or null where it was not loaded. */
export function useSignerRuntime(): SignerRuntime | null {
  return useContext(SignerRuntimeContext)
}
