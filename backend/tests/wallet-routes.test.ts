/**
 * The wallet's own page of facts: its address, what it holds, and (on testnet only) a way to fill it. Written before the code.
 *
 * The address and amounts come from the SESSION and the ledger, never from anything the browser sends, and the faucet is
 * decided by the server's own network. Mainnet has its own file (wallet-routes.mainnet.test.ts).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { ECDSA, RippledError, Wallet } from 'xrpl'

const funds = vi.hoisted(() => ({
  read: async (_a: string): Promise<{ spendableDrops: bigint; reserveIncDrops: bigint }> => ({ spendableDrops: 50_000_000n, reserveIncDrops: 200_000n }),
  balance: async (_a: string): Promise<bigint> => 52_000_000n,
}))
const faucet = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, result: { ok: true, amountXrp: 100 } as Record<string, unknown> }))

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return { ...actual, accountFunding: (a: string) => funds.read(a), accountBalanceDrops: (a: string) => funds.balance(a) }
})
vi.mock('../src/faucet.js', async () => {
  const actual = await vi.importActual<typeof import('../src/faucet.js')>('../src/faucet.js')
  return { ...actual, requestFaucet: async (i: Record<string, unknown>) => { faucet.calls.push(i); return faucet.result } }
})

const { prisma } = await import('../src/prisma.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')
const app = createApp()
const P = 'wr_'

async function person(name: string, signerKind: 'PRIVY' | 'XAMAN' = 'PRIVY') {
  const key = Wallet.generate(ECDSA.secp256k1)
  const user = await prisma.user.create({
    data: {
      username: `${P}${name}`,
      xrplAddress: key.classicAddress,
      wallet: { create: { xrplAddress: key.classicAddress, signerKind, providerUserId: signerKind === 'PRIVY' ? `did:privy:${P}${name}` : null, publicKey: key.publicKey } },
    },
  })
  const { token } = await createSession(user.id)
  return { id: user.id, address: key.classicAddress, cookie: `hubworld_session=${token}` }
}
async function cleanup() {
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: P } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: P } } })
}
beforeEach(async () => {
  await cleanup()
  faucet.calls = []
  faucet.result = { ok: true, amountXrp: 100 }
  funds.read = async () => ({ spendableDrops: 50_000_000n, reserveIncDrops: 200_000n })
  funds.balance = async () => 52_000_000n
})
afterEach(cleanup)
afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('GET /api/wallet/status', () => {
  it('needs a session', async () => {
    expect((await request(app).get('/api/wallet/status')).status).toBe(401)
  })

  it('gives the session\'s own address, what it holds and what it can spend, and that the faucet is offered here', async () => {
    const me = await person('a')
    const res = await request(app).get('/api/wallet/status').set('Cookie', me.cookie)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      address: me.address,
      network: 'testnet',
      exists: true,
      balanceDrops: '52000000',
      spendableDrops: '50000000',
      activationDrops: '1000000',
      canFund: true,
      signer: 'PRIVY',
    })
  })

  it('a wallet that does not exist on the ledger yet says so, and says what brings it into being', async () => {
    const me = await person('b')
    funds.read = async () => { throw new RippledError('Account not found.', { error: 'actNotFound' }) }
    funds.balance = async () => { throw new RippledError('Account not found.', { error: 'actNotFound' }) }
    const res = await request(app).get('/api/wallet/status').set('Cookie', me.cookie)
    expect(res.body).toMatchObject({ address: me.address, exists: false, activationDrops: '1000000', canFund: true })
    expect(res.body.balanceDrops).toBeUndefined()
  })

  it('a ledger that cannot be read is reported as unknown, not as empty', async () => {
    const me = await person('c')
    funds.read = async () => { throw new Error('node down') }
    funds.balance = async () => { throw new Error('node down') }
    const res = await request(app).get('/api/wallet/status').set('Cookie', me.cookie)
    expect(res.status).toBe(200)
    expect(res.body.exists).toBeNull()
    expect(res.body.balanceDrops).toBeUndefined()
  })
})

describe('POST /api/wallet/fund (testnet)', () => {
  it('needs a session', async () => {
    expect((await request(app).post('/api/wallet/fund')).status).toBe(401)
    expect(faucet.calls).toHaveLength(0)
  })

  it('funds the SESSION\'s own address, and ignores any address in the request', async () => {
    const me = await person('d')
    const res = await request(app).post('/api/wallet/fund').set('Cookie', me.cookie).send({ address: 'rSomebodyElsesWallet', destination: 'rAnother' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, amountXrp: 100 })
    expect(faucet.calls).toHaveLength(1)
    expect(faucet.calls[0]).toMatchObject({ userId: me.id, address: me.address, network: 'testnet' })
  })

  it('passes the limit refusal on in words, with a 429', async () => {
    const me = await person('e')
    faucet.result = { ok: false, code: 'FAUCET_LIMIT', error: 'You can request test XRP 3 times a day. Try again tomorrow.' }
    const res = await request(app).post('/api/wallet/fund').set('Cookie', me.cookie)
    expect(res.status).toBe(429)
    expect(res.body).toMatchObject({ code: 'FAUCET_LIMIT' })
  })

  it('a faucet that is down is a 502 with a retry message', async () => {
    const me = await person('f')
    faucet.result = { ok: false, code: 'FAUCET_FAILED', error: 'The test faucet could not fund your wallet just now. Try again in a moment.' }
    expect((await request(app).post('/api/wallet/fund').set('Cookie', me.cookie)).status).toBe(502)
  })
})
