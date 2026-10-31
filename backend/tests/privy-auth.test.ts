/**
 * Reading a Privy login: who it is, and which XRPL wallet is theirs.
 *
 * Tokens here are signed with a throwaway key and verified against a local key set, so the
 * checks run for real (signature, issuer, audience, expiry, algorithm) with no network.
 * Each refusal is its own test because each is a different way to forge a login.
 */
import { describe, expect, it } from 'vitest'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { ECDSA, Wallet } from 'xrpl'
import { PrivyAuthError, bindPublicKey, makePrivyVerifier } from '../src/privy-auth.js'

const APP = 'cmtestapp0000000000000000'
const DID = 'did:privy:cmtestuser00000000'

const { publicKey, privateKey } = await generateKeyPair('ES256')
const other = await generateKeyPair('ES256')
const jwk = { ...(await exportJWK(publicKey)), alg: 'ES256', use: 'sig' }
const verifier = makePrivyVerifier({ appId: APP, keys: createLocalJWKSet({ keys: [jwk] }) })

const wallet = Wallet.generate(ECDSA.secp256k1)
const xrplAccount = (over: object = {}) => ({
  id: 'w1',
  type: 'wallet',
  address: wallet.classicAddress,
  chain_type: 'xrpl',
  wallet_client_type: 'privy',
  ...over,
})

async function token(
  opts: { sub?: string; aud?: string; iss?: string; exp?: string | number; key?: CryptoKey; linked?: unknown; rawLinked?: string } = {},
) {
  const claims: Record<string, unknown> = {}
  if (opts.linked !== undefined) claims.linked_accounts = JSON.stringify(opts.linked)
  if (opts.rawLinked !== undefined) claims.linked_accounts = opts.rawLinked
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject(opts.sub ?? DID)
    .setIssuer(opts.iss ?? 'privy.io')
    .setAudience(opts.aud ?? APP)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '1h')
    .sign(opts.key ?? privateKey)
}

const code = async (p: Promise<unknown>) => {
  try {
    await p
    return 'ok'
  } catch (e) {
    return e instanceof PrivyAuthError ? e.code : `other:${(e as Error).message}`
  }
}

describe('verifying a login', () => {
  it('returns the person and the wallet from the identity token', async () => {
    const got = await verifier.verify(await token(), await token({ linked: [{ type: 'email', address: 'a@b.c' }, xrplAccount()] }))
    expect(got).toEqual({ did: DID, address: wallet.classicAddress })
  })

  it('refuses an expired token', async () => {
    const id = await token({ linked: [xrplAccount()] })
    expect(await code(verifier.verify(await token({ exp: Math.floor(Date.now() / 1000) - 120 }), id))).toBe('invalid_token')
  })

  it('refuses a token minted for another app', async () => {
    const id = await token({ linked: [xrplAccount()] })
    expect(await code(verifier.verify(await token({ aud: 'someone-elses-app' }), id))).toBe('invalid_token')
  })

  it('refuses a token from another issuer', async () => {
    const id = await token({ linked: [xrplAccount()] })
    expect(await code(verifier.verify(await token({ iss: 'evil.example' }), id))).toBe('invalid_token')
  })

  it('refuses a token signed with a key that is not Privy\'s', async () => {
    const access = await token()
    const forged = await token({ key: other.privateKey, linked: [xrplAccount()] })
    expect(await code(verifier.verify(access, forged))).toBe('invalid_token')
  })

  it('refuses a token that names a different algorithm than ES256, even if the key set would verify it', async () => {
    // Offers the key set an HMAC key too, the classic algorithm-confusion setup. NOTE: `jose`
    // already refuses symmetric keys from a key set, so this passes with or without our own
    // `algorithms: ['ES256']` pin; that pin is defence in depth that no test can distinguish.
    // The test still guards the outcome (an HS256 token is refused) if either layer is removed
    // alongside a library change.
    const secret = new TextEncoder().encode('0123456789abcdef0123456789abcdef')
    const hmacKey = { kty: 'oct', k: Buffer.from(secret).toString('base64url'), alg: 'HS256', use: 'sig' }
    const permissive = makePrivyVerifier({ appId: APP, keys: createLocalJWKSet({ keys: [jwk, hmacKey] }) })
    const hs = await new SignJWT({ linked_accounts: JSON.stringify([xrplAccount()]) })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(DID).setIssuer('privy.io').setAudience(APP).setExpirationTime('1h')
      .sign(secret)
    expect(await code(permissive.verify(await token(), hs))).toBe('invalid_token')
  })

  it('refuses an access token and identity token that belong to different people', async () => {
    const id = await token({ sub: 'did:privy:someoneelse', linked: [xrplAccount()] })
    expect(await code(verifier.verify(await token(), id))).toBe('mismatched_tokens')
  })

  it('fails closed, saying why, when no XRPL wallet came with the token', async () => {
    const id = await token({ linked: [{ type: 'email', address: 'a@b.c' }] })
    expect(await code(verifier.verify(await token(), id))).toBe('no_wallet')
  })

  it('does not take an XRPL address that only claims to be a Privy wallet', async () => {
    const external = await token({ linked: [xrplAccount({ wallet_client_type: 'metamask' })] })
    expect(await code(verifier.verify(await token(), external))).toBe('no_wallet')
    const bad = await token({ linked: [xrplAccount({ address: 'not-an-address' })] })
    expect(await code(verifier.verify(await token(), bad))).toBe('no_wallet')
  })

  it('uses the OLDEST wallet when a login holds several, so the account is stable', async () => {
    const newer = Wallet.generate(ECDSA.secp256k1).classicAddress
    const id = await token({ linked: [xrplAccount(), xrplAccount({ id: 'w2', address: newer })] })
    expect((await verifier.verify(await token(), id)).address).toBe(wallet.classicAddress)
    // The other way round is a different account: order is what decides, nothing else.
    const flipped = await token({ linked: [xrplAccount({ id: 'w2', address: newer }), xrplAccount()] })
    expect((await verifier.verify(await token(), flipped)).address).toBe(newer)
  })

  it('skips an entry that is not a usable Privy XRPL wallet and takes the next one', async () => {
    const id = await token({ linked: [xrplAccount({ address: 'not-an-address' }), xrplAccount({ id: 'w2' })] })
    expect((await verifier.verify(await token(), id)).address).toBe(wallet.classicAddress)
  })

  it('treats unreadable linked accounts as no wallet, not as a crash', async () => {
    const id = await token({ rawLinked: '{not json' })
    expect(await code(verifier.verify(await token(), id))).toBe('no_wallet')
  })
})

describe('binding the public key to the verified address', () => {
  it('accepts the wallet\'s own key, in either case', () => {
    expect(bindPublicKey(wallet.publicKey, wallet.classicAddress)).toBe(wallet.publicKey.toUpperCase())
    expect(bindPublicKey(wallet.publicKey.toLowerCase(), wallet.classicAddress)).toBe(wallet.publicKey.toUpperCase())
  })

  it('refuses a key that belongs to a different wallet', () => {
    const stranger = Wallet.generate(ECDSA.secp256k1)
    expect(() => bindPublicKey(stranger.publicKey, wallet.classicAddress)).toThrow(PrivyAuthError)
  })

  it('refuses garbage rather than throwing something else', () => {
    for (const junk of ['', 'abc', 'zz'.repeat(33), wallet.publicKey.slice(2)]) {
      expect(() => bindPublicKey(junk, wallet.classicAddress)).toThrow(PrivyAuthError)
    }
  })
})
