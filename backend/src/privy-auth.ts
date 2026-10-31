/**
 * Who a Privy login is, and which XRPL wallet is theirs.
 *
 * Verified with Privy's PUBLIC keys only: the app id is public (it is the audience of every
 * token and ships to the browser), so there is no Privy secret anywhere in HubWorld. Checked
 * against a live app 2026-10-31: both the access token and the identity token verify with `jose`
 * against `https://auth.privy.io/api/v1/apps/<APP_ID>/jwks.json`, issuer `privy.io`, audience
 * the app id, ES256, about an hour of life. The identity token's `linked_accounts` (a
 * stringified JSON array) carries the XRPL wallet as `{ id, type:'wallet', address,
 * chain_type:'xrpl', wallet_client_type:'privy' }`. It does NOT carry the public key.
 *
 * Two rules this module exists to keep:
 *
 * - **The wallet address comes from the VERIFIED identity token, never from the client.** A
 *   client that could name its own address could sign in as anyone.
 * - **The public key is supplied by the client and bound to that address by arithmetic, not
 *   trust.** An XRPL address is a hash of its key, so `deriveAddress(publicKey)` must equal the
 *   verified address; a wrong key cannot pass.
 *
 * The identity token only exists while the dashboard setting "Return user data in an identity
 * token" (User management > Authentication > Advanced) is ON. If it is off, or the token has no
 * wallet in it, login fails closed with a message that says why, never a half-made account.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { deriveAddress, isValidClassicAddress } from 'xrpl'

export type PrivyIdentity = {
  /** Privy's id for this person (`did:privy:...`). The stable key; an email can change. */
  did: string
  /** The one XRPL wallet Privy holds for them. */
  address: string
}

export type PrivyAuthFailure = 'invalid_token' | 'mismatched_tokens' | 'no_wallet' | 'bad_key'

export class PrivyAuthError extends Error {
  constructor(
    readonly code: PrivyAuthFailure,
    message: string,
  ) {
    super(message)
    this.name = 'PrivyAuthError'
  }
}

type LinkedAccount = {
  type?: string
  chain_type?: string
  wallet_client_type?: string
  address?: string
}

export function makePrivyVerifier(opts: { appId: string; keys?: JWTVerifyGetKey }) {
  // Built lazily so importing this module never makes a network call.
  let remote: JWTVerifyGetKey | null = null
  const keys: JWTVerifyGetKey = (header, token) => {
    remote ??= createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${opts.appId}/jwks.json`))
    return remote(header, token)
  }

  async function verifyOne(token: string, what: string) {
    try {
      const { payload } = await jwtVerify(token, opts.keys ?? keys, {
        issuer: 'privy.io',
        audience: opts.appId,
        // Pinned: accepting whatever algorithm the token names is how downgrades happen. (jose also
        // refuses symmetric keys from a key set, so this is a second layer, not the only one.)
        algorithms: ['ES256'],
      })
      if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('no subject')
      return payload
    } catch {
      throw new PrivyAuthError('invalid_token', `Your ${what} could not be verified. Sign in again.`)
    }
  }

  return {
    /**
     * Verify both tokens and return who they belong to.
     *
     * The ACCESS token proves the session is live; the IDENTITY token says which wallet is theirs.
     * They must name the same person, or one could be a stolen token paired with another's.
     */
    async verify(accessToken: string, identityToken: string): Promise<PrivyIdentity> {
      const access = await verifyOne(accessToken, 'sign-in')
      const identity = await verifyOne(identityToken, 'account details')
      if (access.sub !== identity.sub) {
        throw new PrivyAuthError('mismatched_tokens', 'Those tokens belong to different accounts.')
      }

      let linked: LinkedAccount[] = []
      try {
        const raw = identity.linked_accounts
        linked = typeof raw === 'string' ? (JSON.parse(raw) as LinkedAccount[]) : []
      } catch {
        linked = []
      }
      const wallets = linked.filter(
        (a) =>
          a.type === 'wallet' &&
          a.chain_type === 'xrpl' &&
          a.wallet_client_type === 'privy' &&
          typeof a.address === 'string' &&
          isValidClassicAddress(a.address),
      )
      if (wallets.length === 0) {
        throw new PrivyAuthError(
          'no_wallet',
          'No XRPL wallet came with your sign-in yet. Create one and try again.',
        )
      }
      // A Privy login CAN hold more than one XRPL wallet (it did, the first time this ran for real:
      // an earlier attempt had made a second). Refusing left that person locked out, so the OLDEST
      // is the account's wallet: the array is in the order they were linked, and the page picks the
      // first one it sees in the same list. If the two ever disagreed, the key binding below would
      // refuse the login rather than quietly use the wrong wallet. Any others are simply unused.
      return { did: identity.sub as string, address: wallets[0]!.address! }
    },
  }
}

/**
 * Accept a client-supplied public key only if it IS the verified wallet's key.
 *
 * Returns the key normalised to the uppercase hex xrpl.js uses. The check is arithmetic: an
 * address is derived from the key, so no one can pair their own key with someone else's address.
 */
export function bindPublicKey(publicKey: string, address: string): string {
  const key = publicKey.trim().toUpperCase()
  let derived: string | null = null
  try {
    derived = /^[0-9A-F]{66}$/.test(key) ? deriveAddress(key) : null
  } catch {
    derived = null
  }
  if (derived !== address) {
    throw new PrivyAuthError('bad_key', 'That key does not belong to this wallet.')
  }
  return key
}
