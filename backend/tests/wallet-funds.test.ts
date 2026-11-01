/**
 * A buyer whose wallet cannot pay is told so plainly, before anything is held or signed. Written before the code.
 *
 * A Privy wallet starts empty: an XRPL account does not exist until it holds the base reserve. Without this the first
 * purchase fails somewhere deep with a cryptic ledger code after the person has approved it. These pin the rule that
 * decides "can this wallet pay", what it says it needs, the testnet-only faucet that fills it, and that none of this
 * is ever offered on mainnet, where the answer is the address and the amount and nothing is minted for free.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fundsGap, FEE_HEADROOM_DROPS, BASE_RESERVE_DROPS } from '../src/wallet-funds.js'
import { isAccountNotFound } from '../src/xrpl-errors.js'
import { RippledError } from 'xrpl'

const XRP = 1_000_000n
const INC = 200_000n

describe('fundsGap: what a wallet is short, if anything', () => {
  const ok = { accountExists: true, spendableDrops: 100n * XRP, reserveIncDrops: INC }

  it('is null when the wallet can pay with room to spare', () => {
    expect(fundsGap({ ...ok, amountDrops: 20_700_000n })).toBeNull()
  })

  it('needs the price, the reserve the offer itself locks, and a little for the network fee', () => {
    const need = 20_700_000n + INC + FEE_HEADROOM_DROPS
    expect(fundsGap({ ...ok, spendableDrops: need, amountDrops: 20_700_000n })).toBeNull()
    expect(fundsGap({ ...ok, spendableDrops: need - 1n, amountDrops: 20_700_000n })).toEqual({ neededDrops: need, haveDrops: need - 1n })
  })

  it('an account that does not exist yet also needs the base reserve to come into being', () => {
    const gap = fundsGap({ accountExists: false, spendableDrops: 0n, reserveIncDrops: INC, amountDrops: 10n * XRP })
    expect(gap).toEqual({ neededDrops: 10n * XRP + INC + FEE_HEADROOM_DROPS + BASE_RESERVE_DROPS, haveDrops: 0n })
  })

  it('never reports a negative amount held', () => {
    expect(fundsGap({ ...ok, spendableDrops: 0n, amountDrops: 1n })?.haveDrops).toBe(0n)
  })

  it('the base reserve is the network\'s 1 XRP and the headroom is a tenth of one', () => {
    expect(BASE_RESERVE_DROPS).toBe(1_000_000n)
    expect(FEE_HEADROOM_DROPS).toBe(100_000n)
  })
})

describe('isAccountNotFound: an account that does not exist yet is not an error', () => {
  it('recognises it as the node delivers it (on data.error)', () => {
    expect(isAccountNotFound(new RippledError('Account not found.', { error: 'actNotFound', error_code: 19 }))).toBe(true)
  })
  it('is not fooled by a busy or unreachable node', () => {
    expect(isAccountNotFound(new RippledError('busy', { error: 'tooBusy' }))).toBe(false)
    expect(isAccountNotFound(new Error('WebSocket is not open'))).toBe(false)
    expect(isAccountNotFound('actNotFound')).toBe(false)
  })
})

// ------------------------------------------------------------------ faucet --

import { prisma } from '../src/prisma.js'
import { requestFaucet, FAUCET_PER_DAY, type FaucetDeps } from '../src/faucet.js'
import { Wallet } from 'xrpl'

const UTAG = 'fc_'
let uniq = ''
async function mkUser(name: string) {
  return prisma.user.create({ data: { username: `${UTAG}${name}_${uniq}`.slice(0, 20), xrplAddress: Wallet.generate().classicAddress } })
}
async function cleanup() {
  await prisma.faucetGrant.deleteMany({ where: { user: { username: { startsWith: UTAG } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: UTAG } } })
}
beforeEach(async () => {
  uniq = Math.random().toString(36).slice(2, 7)
  await cleanup()
})
afterEach(cleanup)
afterAll(async () => {
  await prisma.$disconnect()
})

const deps = (over: Partial<FaucetDeps> = {}): FaucetDeps & { calls: Array<{ url: string; body: unknown }> } => {
  const calls: Array<{ url: string; body: unknown }> = []
  return {
    network: 'testnet',
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify({ account: { classicAddress: 'r' }, amount: 100 }), { status: 200 })
    }) as never,
    now: new Date(),
    calls,
    ...over,
  }
}

describe('requestFaucet', () => {
  it('on testnet, asks the test faucet to fund THIS wallet\'s own address, and records the grant', async () => {
    const u = await mkUser('a')
    const d = deps()
    const r = await requestFaucet({ userId: u.id, address: 'rWalletAddress1', ...d })
    expect(r).toEqual({ ok: true, amountXrp: 100 })
    expect(d.calls).toHaveLength(1)
    expect(d.calls[0]!.url).toMatch(/^https:\/\/faucet\.altnet\.rippletest\.net\/accounts$/)
    expect(d.calls[0]!.body).toEqual({ destination: 'rWalletAddress1' })
    expect(await prisma.faucetGrant.count({ where: { userId: u.id } })).toBe(1)
  })

  it.each(['mainnet', 'devnet'] as const)('is NEVER available on %s: no request is made and nothing is recorded', async (network) => {
    const u = await mkUser(`n${network}`)
    const d = deps({ network })
    const r = await requestFaucet({ userId: u.id, address: 'rWalletAddress1', ...d })
    expect(r).toMatchObject({ ok: false, code: 'FAUCET_UNAVAILABLE' })
    expect(d.calls).toHaveLength(0)
    expect(await prisma.faucetGrant.count({ where: { userId: u.id } })).toBe(0)
  })

  it('limits each person to a few grants a day, then says when to come back', async () => {
    const u = await mkUser('lim')
    const d = deps()
    for (let i = 0; i < FAUCET_PER_DAY; i++) expect((await requestFaucet({ userId: u.id, address: 'rWalletAddress1', ...d })).ok).toBe(true)
    const r = await requestFaucet({ userId: u.id, address: 'rWalletAddress1', ...d })
    expect(r).toMatchObject({ ok: false, code: 'FAUCET_LIMIT' })
    expect(d.calls).toHaveLength(FAUCET_PER_DAY)
  })

  it('counts a day, not for ever: grants older than 24 hours do not count', async () => {
    const u = await mkUser('old')
    for (let i = 0; i < FAUCET_PER_DAY; i++) {
      await prisma.faucetGrant.create({ data: { userId: u.id, address: 'rX', createdAt: new Date(Date.now() - 25 * 3_600_000) } })
    }
    expect((await requestFaucet({ userId: u.id, address: 'rWalletAddress1', ...deps() })).ok).toBe(true)
  })

  it('the limit is per person: one person using theirs up does not stop another', async () => {
    const a = await mkUser('pa')
    const b = await mkUser('pb')
    for (let i = 0; i < FAUCET_PER_DAY; i++) await requestFaucet({ userId: a.id, address: 'rA', ...deps() })
    expect((await requestFaucet({ userId: b.id, address: 'rB', ...deps() })).ok).toBe(true)
  })

  it('does not record a grant when the faucet itself says no (the person can try again)', async () => {
    const u = await mkUser('fail')
    const r = await requestFaucet({ userId: u.id, address: 'rWalletAddress1', ...deps({ fetchImpl: (async () => new Response('busy', { status: 503 })) as never }) })
    expect(r).toMatchObject({ ok: false, code: 'FAUCET_FAILED' })
    expect(await prisma.faucetGrant.count({ where: { userId: u.id } })).toBe(0)
  })

  it('does not record a grant when the faucet cannot be reached', async () => {
    const u = await mkUser('down')
    const r = await requestFaucet({ userId: u.id, address: 'rWalletAddress1', ...deps({ fetchImpl: (async () => { throw new Error('ECONNRESET') }) as never }) })
    expect(r).toMatchObject({ ok: false, code: 'FAUCET_FAILED' })
    expect(await prisma.faucetGrant.count({ where: { userId: u.id } })).toBe(0)
  })

  it('two requests at once cannot both slip under the limit', async () => {
    const u = await mkUser('race')
    const d = deps()
    const results = await Promise.all(Array.from({ length: FAUCET_PER_DAY + 3 }, () => requestFaucet({ userId: u.id, address: 'rWalletAddress1', ...d })))
    expect(results.filter((r) => r.ok)).toHaveLength(FAUCET_PER_DAY)
    expect(await prisma.faucetGrant.count({ where: { userId: u.id } })).toBe(FAUCET_PER_DAY)
  })

  it('gives up on a faucet that never answers', async () => {
    const u = await mkUser('hang')
    // Never answers on its own. If no timeout signal is set, nothing ever wakes it and the test times out instead of passing.
    let sawSignal = false
    const hang = (async (_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        sawSignal = init.signal instanceof AbortSignal
        init.signal?.addEventListener('abort', () => rej(new Error('aborted')))
      })) as never
    const t0 = Date.now()
    const r = await requestFaucet({ userId: u.id, address: 'rWalletAddress1', ...deps({ fetchImpl: hang, timeoutMs: 60 }) })
    expect(r).toMatchObject({ ok: false, code: 'FAUCET_FAILED' })
    expect(sawSignal).toBe(true)
    expect(Date.now() - t0).toBeLessThan(2_000)
  })
})
void vi
