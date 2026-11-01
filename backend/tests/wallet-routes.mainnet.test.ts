/** On mainnet there is no faucet: the route does not exist, and the status never offers one. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.XRPL_NETWORK = 'mainnet'
})

import request from 'supertest'
import { ECDSA, Wallet } from 'xrpl'

const faucetCalls = vi.hoisted(() => ({ n: 0 }))
vi.mock('../src/faucet.js', async () => {
  const actual = await vi.importActual<typeof import('../src/faucet.js')>('../src/faucet.js')
  return { ...actual, requestFaucet: async () => { faucetCalls.n++; return { ok: true, amountXrp: 100 } } }
})
vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return { ...actual, accountFunding: async () => ({ spendableDrops: 0n, reserveIncDrops: 200_000n }), accountBalanceDrops: async () => 0n }
})

const { prisma } = await import('../src/prisma.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')
const app = createApp()
const P = 'wm_'

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

async function person() {
  const key = Wallet.generate(ECDSA.secp256k1)
  const user = await prisma.user.create({
    data: { username: `${P}a`, xrplAddress: key.classicAddress, wallet: { create: { xrplAddress: key.classicAddress, signerKind: 'PRIVY', providerUserId: `did:privy:${P}a`, publicKey: key.publicKey } } },
  })
  const { token } = await createSession(user.id)
  return { address: key.classicAddress, cookie: `hubworld_session=${token}` }
}

describe('on mainnet', () => {
  it('there is no faucet: the route answers as if it did not exist, and the faucet is never called', async () => {
    const me = await person()
    const res = await request(app).post('/api/wallet/fund').set('Cookie', me.cookie)
    expect(res.status).toBe(404)
    expect(faucetCalls.n).toBe(0)
  })

  it('the status shows the address and what brings the wallet into being, and never offers to fund it', async () => {
    const me = await person()
    const res = await request(app).get('/api/wallet/status').set('Cookie', me.cookie)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ address: me.address, network: 'mainnet', canFund: false, activationDrops: '1000000' })
  })
})
