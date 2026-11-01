/**
 * The dev-only simulate endpoint can carry a REAL transaction hash. Written before the change.
 *
 * Against the real test network with Xaman pretended (the local stack), a stand-in user signs their own transaction on
 * the ledger and then tells the pretend Xaman it was signed. Without the real hash the stub fabricates one on its own
 * fake ledger, the gift poll asks the REAL ledger about it, and the gift never resolves. With it, the poll confirms the
 * transaction that actually happened.
 */
import { describe, expect, it } from 'vitest'
import request from 'supertest'

const { createApp } = await import('../src/app.js')
const { signing, tryGetPayload } = await import('../src/signing.js')
const app = createApp()

const ACCOUNT = 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w'
const TX = { TransactionType: 'NFTokenAcceptOffer', Account: ACCOUNT, NFTokenSellOffer: 'AD'.repeat(32) }

describe('POST /dev/payloads/:uuid/simulate', () => {
  it('records the hash it is given, instead of fabricating one', async () => {
    const p = await signing.createPayload(TX, { flow: 'GIFT_ACCEPT' })
    const txid = 'C0FFEE'.repeat(10) + 'ABCD'
    const res = await request(app).post(`/api/dev/payloads/${p.uuid}/simulate`).send({ account: ACCOUNT, txid })
    expect(res.status).toBe(200)
    const status = await tryGetPayload(p.uuid)
    expect(status).toMatchObject({ signed: true, account: ACCOUNT, txid })
  })

  it('still fabricates one when none is given (the existing e2e suite depends on it)', async () => {
    const p = await signing.createPayload(TX, { flow: 'GIFT_ACCEPT' })
    await request(app).post(`/api/dev/payloads/${p.uuid}/simulate`).send({ account: ACCOUNT }).expect(200)
    const status = await tryGetPayload(p.uuid)
    expect(status && status !== 'unavailable' && status.txid).toMatch(/^[0-9A-F]{64}$/)
  })

  it('refuses a hash that is not 64 hex characters', async () => {
    const p = await signing.createPayload(TX, { flow: 'GIFT_ACCEPT' })
    expect((await request(app).post(`/api/dev/payloads/${p.uuid}/simulate`).send({ txid: 'nope' })).status).toBe(400)
  })
})
