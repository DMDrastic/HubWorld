/**
 * The Privy SDK, adapted to the small `SignerRuntime` the rest of the app uses.
 *
 * Only ever imported through `React.lazy` (see `WithSigner`), so Privy and its dependencies are
 * a separate chunk fetched on demand. Do not import this file from anywhere else.
 *
 * It does not wrap the page: it is loaded beside it and reports the runtime upward (see `WithSigner`).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
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

  const getTokens = useCallback(async () => {
    const accessToken = await getAccessToken()
    const identityToken = await getIdentityToken()
    return accessToken && identityToken ? { accessToken, identityToken } : null
  }, [getAccessToken])

  const ensureWallet = useCallback(
    () =>
      findOrCreateWallet({
        read: () => xrplWalletOf(userRef.current),
        create: async () => (await createWallet({ chainType: 'xrpl' })).wallet as unknown as LinkedWallet,
      }),
    [createWallet],
  )

  const signHash = useCallback(
    async (address: string, hashHex: string) => {
      const { signature } = await signRawHash({ address, chainType: 'xrpl', hash: `0x${hashHex}` })
      return signature.replace(/^0x/, '')
    },
    [signRawHash],
  )

  const walletAddress = xrplWalletOf(user)?.address ?? null
  const runtime = useMemo<SignerRuntime>(
    () => ({
      ready,
      authenticated,
      walletAddress,
      openLogin: () => login(),
      getTokens,
      ensureWallet,
      signHash,
      logout: () => logout(),
    }),
    [ready, authenticated, walletAddress, login, getTokens, ensureWallet, signHash, logout],
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
