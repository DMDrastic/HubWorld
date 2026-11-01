/**
 * The pretend-Xaman simulate endpoint must not exist in production. Written after #144 added `txid` to it, when it was
 * found that nothing pinned the guard.
 *
 * The endpoint fakes "this payload was signed" (and can now name any transaction hash), so on a live server it would be a
 * bypass of every signature check in the product. Three layers keep it out, each pinned:
 *   1. NODE_ENV=production: 404, even with pretend Xaman (this file);
 *   2. real Xaman credentials (production's case): 404, because there is no stub to drive (this file);
 *   3. the server refuses to BOOT with pretend Xaman under production at all (env.ts; see `boot refusal` below).
 * A positive control proves the 404s come from the guard, not from a broken request.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import request from 'supertest'

const state = vi.hoisted(() => ({ nodeEnv: 'development' as string, live: false }))

vi.mock('../src/env.js', async () => {
  const actual = await vi.importActual<typeof import('../src/env.js')>('../src/env.js')
  return { ...actual, env: new Proxy(actual.env, { get: (t, k) => (k === 'NODE_ENV' ? state.nodeEnv : Reflect.get(t, k)) }) }
})
vi.mock('../src/signing.js', async () => {
  const actual = await vi.importActual<typeof import('../src/signing.js')>('../src/signing.js')
  // "Live" = real Xaman credentials: asStub finds no pretend client to drive.
  return { ...actual, asStub: (s: Parameters<typeof actual.asStub>[0]) => (state.live ? null : actual.asStub(s)) }
})

const { createApp } = await import('../src/app.js')
const { signing, tryGetPayload } = await import('../src/signing.js')
const app = createApp()

const ACCOUNT = 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w'
const TXID = 'C0FFEE'.repeat(10) + 'ABCD'
const TX = { TransactionType: 'NFTokenAcceptOffer', Account: ACCOUNT, NFTokenSellOffer: 'AD'.repeat(32) }

async function attempt() {
  const p = await signing.createPayload(TX, { flow: 'GIFT_ACCEPT' })
  const res = await request(app).post(`/api/dev/payloads/${p.uuid}/simulate`).send({ account: ACCOUNT, txid: TXID })
  const after = await tryGetPayload(p.uuid)
  return { status: res.status, signed: after !== 'unavailable' && after !== null && after.signed === true }
}

afterEach(() => {
  state.nodeEnv = 'development'
  state.live = false
})

describe('POST /api/dev/payloads/:uuid/simulate is not reachable in production', () => {
  it('positive control: in development with pretend Xaman it works (so the 404s below are the guard)', async () => {
    expect(await attempt()).toEqual({ status: 200, signed: true })
  })

  it('NODE_ENV=production: 404 and nothing is marked signed, even with pretend Xaman', async () => {
    state.nodeEnv = 'production'
    expect(await attempt()).toEqual({ status: 404, signed: false })
  })

  it('real Xaman credentials: 404 and nothing is marked signed, in any NODE_ENV', async () => {
    state.live = true
    expect(await attempt()).toEqual({ status: 404, signed: false })
    state.nodeEnv = 'production'
    expect(await attempt()).toEqual({ status: 404, signed: false })
  })

  it('boot refusal: a production process with pretend Xaman exits before serving anything', () => {
    let failed: { status: number | null; stderr: string } | null = null
    try {
      execFileSync(process.execPath, ['--import', 'tsx', '-e', "await import('./src/env.ts')"], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'production',
          DATABASE_URL: process.env.DATABASE_URL,
          // No XAMAN_API_KEY/SECRET: pretend Xaman. Pointed at no dotenv file, so nothing real is loaded.
          DOTENV_CONFIG_PATH: '/nonexistent/.env',
        },
        stdio: 'pipe',
        encoding: 'utf8',
      })
    } catch (err) {
      const e = err as { status: number | null; stderr: string }
      failed = { status: e.status, stderr: e.stderr }
    }
    expect(failed?.status).toBe(1)
    expect(failed?.stderr).toMatch(/not permitted in production/)
  })
})
