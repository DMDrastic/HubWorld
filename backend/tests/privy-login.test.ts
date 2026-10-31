/**
 * Signing in with Privy, end to end through the real routes and the real database.
 *
 * Tokens are signed with a throwaway key and verified against a local key set, so Privy itself is
 * the only thing faked. Everything that decides who gets an account is real: token checks, the
 * key-to-address binding, the handle rules and the single write that creates an account with its
 * wallet.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.SIGNERS = 'xaman,privy'
  process.env.PRIVY_APP_ID = 'cmprivylogin0000000000000'
})

import request from 'supertest'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { ECDSA, Wallet } from 'xrpl'

const APP = 'cmprivylogin0000000000000'
const { prisma } = await import('../src/prisma.js')
const { createApp } = await import('../src/app.js')
const { makePrivyVerifier } = await import('../src/privy-auth.js')
const { setPrivyVerifierForTests } = await import('../src/routes/privy-auth.js')

const app = createApp()
const P = 'privytest_'
const keys = await generateKeyPair('ES256')
const jwk = { ...(await exportJWK(keys.publicKey)), alg: 'ES256', use: 'sig' }

beforeAll(() => setPrivyVerifierForTests(makePrivyVerifier({ appId: APP, keys: createLocalJWKSet({ keys: [jwk] }) })))
afterAll(() => setPrivyVerifierForTests(null))

async function cleanup() {
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: P } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: P } } })
}
beforeEach(cleanup)
afterEach(cleanup)
afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

type Person = { did: string; wallet: Wallet }
const person = (n: string): Person => ({ did: `did:privy:privytest${n}`, wallet: Wallet.generate(ECDSA.secp256k1) })

async function login(p: Person, over: { aud?: string; linked?: unknown[]; publicKey?: string } = {}) {
  const linked = over.linked ?? [
    { type: 'wallet', address: p.wallet.classicAddress, chain_type: 'xrpl', wallet_client_type: 'privy' },
  ]
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(p.did)
      .setIssuer('privy.io')
      .setAudience(over.aud ?? APP)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(keys.privateKey)
  return {
    accessToken: await sign({ sid: 's' }),
    identityToken: await sign({ linked_accounts: JSON.stringify(linked) }),
    publicKey: over.publicKey ?? p.wallet.publicKey,
  }
}

describe('a new person', () => {
  it('is asked for a handle, and nothing is created yet', async () => {
    const p = person('a')
    const res = await request(app).post('/api/auth/privy').send(await login(p))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ state: 'needs_username' })
    expect(await prisma.wallet.count({ where: { providerUserId: p.did } })).toBe(0)
  })

  it('claims a handle: one account, one PRIVY wallet, a live session', async () => {
    const p = person('b')
    const agent = request.agent(app)
    const res = await agent.post('/api/auth/privy/claim').send({ ...(await login(p)), username: `${P}b` })
    expect(res.status).toBe(201)
    expect(res.body.state).toBe('authenticated')
    expect(String(res.headers['set-cookie'])).toContain('hubworld_session')

    const user = await prisma.user.findUniqueOrThrow({ where: { username: `${P}b` }, include: { wallet: true } })
    expect(user.xrplAddress).toBe(p.wallet.classicAddress)
    expect(user.wallet).toMatchObject({
      xrplAddress: p.wallet.classicAddress,
      signerKind: 'PRIVY',
      providerUserId: p.did,
      publicKey: p.wallet.publicKey.toUpperCase(),
    })
    // The cookie it was handed actually works.
    const me = await agent.get('/api/auth/me')
    expect(me.status).toBe(200)
    expect(me.body.username ?? me.body.user?.username).toBe(`${P}b`)
  })

  it('does not make a second account when the claim is repeated', async () => {
    const p = person('c')
    const body = { ...(await login(p)), username: `${P}c` }
    expect((await request(app).post('/api/auth/privy/claim').send(body)).status).toBe(201)
    expect((await request(app).post('/api/auth/privy/claim').send(body)).status).toBe(200)
    expect(await prisma.user.count({ where: { username: { startsWith: `${P}c` } } })).toBe(1)
    expect(await prisma.wallet.count({ where: { providerUserId: p.did } })).toBe(1)
  })

  it('is told a handle is taken, and leaves nothing behind', async () => {
    const first = person('d1')
    await request(app).post('/api/auth/privy/claim').send({ ...(await login(first)), username: `${P}d` })
    const second = person('d2')
    const res = await request(app).post('/api/auth/privy/claim').send({ ...(await login(second)), username: `${P}d` })
    expect(res.status).toBe(409)
    expect(await prisma.wallet.count({ where: { providerUserId: second.did } })).toBe(0)
  })
})

describe('a returning person', () => {
  it('signs straight in as the same account', async () => {
    const p = person('e')
    await request(app).post('/api/auth/privy/claim').send({ ...(await login(p)), username: `${P}e` })
    const res = await request(app).post('/api/auth/privy').send(await login(p))
    expect(res.status).toBe(200)
    expect(res.body.state).toBe('authenticated')
    expect(res.body.user.username).toBe(`${P}e`)
  })

  it('is refused if the login now points at a different wallet', async () => {
    const p = person('f')
    await request(app).post('/api/auth/privy/claim').send({ ...(await login(p)), username: `${P}f` })
    const moved = { ...p, wallet: Wallet.generate(ECDSA.secp256k1) }
    const res = await request(app).post('/api/auth/privy').send(await login(moved))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('wallet_changed')
    expect(res.headers['set-cookie']).toBeUndefined()
  })
})

describe('things that must not get in', () => {
  it('refuses a public key that is not the wallet\'s, and creates nothing', async () => {
    const p = person('g')
    const res = await request(app)
      .post('/api/auth/privy/claim')
      .send({ ...(await login(p, { publicKey: Wallet.generate(ECDSA.secp256k1).publicKey })), username: `${P}g` })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('bad_key')
    expect(await prisma.user.count({ where: { username: `${P}g` } })).toBe(0)
  })

  it('refuses a token minted for another app', async () => {
    const p = person('h')
    const res = await request(app).post('/api/auth/privy').send(await login(p, { aud: 'someone-elses-app' }))
    expect(res.status).toBe(401)
  })

  it('says so, and creates nothing, when the token carries no wallet', async () => {
    const p = person('i')
    const res = await request(app)
      .post('/api/auth/privy/claim')
      .send({ ...(await login(p, { linked: [{ type: 'email', address: 'a@b.c' }] })), username: `${P}i` })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('no_wallet')
    expect(await prisma.user.count({ where: { username: `${P}i` } })).toBe(0)
  })

  it('will not give a second account to a wallet that already has one', async () => {
    const p = person('j')
    await prisma.user.create({
      data: { username: `${P}xaman`, xrplAddress: p.wallet.classicAddress, wallet: { create: { xrplAddress: p.wallet.classicAddress, signerKind: 'XAMAN' } } },
    })
    const res = await request(app).post('/api/auth/privy').send(await login(p))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('address_taken')
  })
})
