/**
 * The Privy SDK, adapted to the small `SignerRuntime` the rest of the app uses.
 *
 * Only ever imported through `React.lazy` (see `WithSigner`), so Privy and its dependencies are
 * a separate chunk fetched on demand. Do not import this file from anywhere else.
 *
 * It does not wrap the page: it is loaded beside it and reports the runtime upward (see `WithSigner`).
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { PrivyProvider, getIdentityToken, usePrivy } from '@privy-io/react-auth'
import { useCreateWallet, useSignRawHash } from '@privy-io/react-auth/extended-chains'
import type { SignerRuntime } from '@/lib/signer-runtime'
import { findOrCreateWallet, firstXrplWallet as xrplWalletOf } from '@/lib/wallet-lookup'

type LinkedWallet = { type?: string; chainType?: string; address?: string; publicKey?: string; public_key?: string }

/** Reads the Privy hooks and reports the app-facing runtime upward. Draws nothing. */
function Bridge({ onRuntime }: { onRuntime: (r: SignerRuntime) => void }) {
  const { ready, authenticated, login, logout, user, getAccessToken } = usePrivy()
  const { createWallet } = useCreateWallet()
  const { signRawHash } = useSignRawHash()

  // The newest user object, for functions that run after login or after a wallet was just made.
  // A LAYOUT effect on purpose: when login completes, the sign-in screen below reacts in an ordinary
  // effect, and ordinary effects of a child run before those of its parent. With a normal effect here
  // the screen asked for the wallet while this still held the signed-out user, found none, and tried
  // to create a second one, which Privy refuses. Layout effects all run before any ordinary effect.
  const userRef = useRef(user)
  useLayoutEffect(() => {
    userRef.current = user
  }, [user])

  // The SDK hands back NEW function identities on every render. Anything reported upward must not depend on them, or the
  // page re-renders, so this re-renders, so the "different" runtime is reported again, for ever (React stops it with
  // "Maximum update depth exceeded"). So the functions are read through a ref that always holds the latest, and the object
  // reported upward changes only when something the page can SEE changes: ready, authenticated, or the wallet address.
  const latest = useRef({ login, logout, getAccessToken, createWallet, signRawHash })
  useLayoutEffect(() => {
    latest.current = { login, logout, getAccessToken, createWallet, signRawHash }
  })

  const walletAddress = xrplWalletOf(user)?.address ?? null
  const runtime = useMemo<SignerRuntime>(
    () => ({
      ready,
      authenticated,
      walletAddress,
      openLogin: () => latest.current.login(),
      getTokens: async () => {
        const accessToken = await latest.current.getAccessToken()
        const identityToken = await getIdentityToken()
        return accessToken && identityToken ? { accessToken, identityToken } : null
      },
      ensureWallet: () =>
        findOrCreateWallet({
          read: () => xrplWalletOf(userRef.current),
          create: async () => (await latest.current.createWallet({ chainType: 'xrpl' })).wallet as unknown as LinkedWallet,
        }),
      signHash: async (address: string, hashHex: string) => {
        const { signature } = await latest.current.signRawHash({ address, chainType: 'xrpl', hash: `0x${hashHex}` })
        return signature.replace(/^0x/, '')
      },
      logout: () => latest.current.logout(),
    }),
    [ready, authenticated, walletAddress],
  )

  useEffect(() => {
    onRuntime(runtime)
  }, [runtime, onRuntime])

  return null
}

export default function PrivyRuntime({ appId, onRuntime }: { appId: string; onRuntime: (r: SignerRuntime) => void }) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['email'],
        // Wallets are created explicitly, once, and only the XRPL one.
        embeddedWallets: { ethereum: { createOnLogin: 'off' }, solana: { createOnLogin: 'off' } },
      }}
    >
      <Bridge onRuntime={onRuntime} />
    </PrivyProvider>
  )
}
