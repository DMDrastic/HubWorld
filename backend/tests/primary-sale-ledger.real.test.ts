/**
 * The real sell-offer submit, against a client that behaves like mainnet.
 *
 * The first real mainnet run lost one of two simultaneous buyers: the second
 * offer read the organizer's sequence from a view that had not yet seen the
 * first, and came back `tefPAST_SEQ`. Devnet is one node and never showed it.
 * This pins the half of the fix that lives in the ledger seam: the organizer's
 * account is not handed back until the new sequence is VISIBLE.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const ORGANIZER = 'rOrganizerFixture000000000000'
const requests: Array<Record<string, unknown>> = []
let staleReads = 0
let submitResult = 'tesSUCCESS'

const client = {
  autofill: async (tx: Record<string, unknown>) => ({ ...tx, Sequence: 500, Fee: '12', LastLedgerSequence: 99_999 }),
  request: async (req: Record<string, unknown>) => {
    requests.push(req)
    if (req.command === 'submit') return { result: { engine_result: submitResult } }
    if (req.command === 'account_info') {
      // The first N reads still see the OLD sequence: a stale view.
      if (staleReads > 0) {
        staleReads -= 1
        return { result: { account_data: { Sequence: 500 } } }
      }
      return { result: { account_data: { Sequence: 501 } } }
    }
    throw new Error(`unexpected request ${String(req.command)}`)
  },
}

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return {
    ...actual,
    ledger: async () => client,
    delegateWallet: () => ({ sign: () => ({ tx_blob: 'BLOB', hash: 'H'.repeat(64) }) }),
  }
})

const { realPrimarySaleLedger } = await import('../src/primary-sale-ledger.js')

const tx = { TransactionType: 'NFTokenCreateOffer', Account: ORGANIZER, Delegate: 'rD', NFTokenID: 'AB', Amount: '1', Flags: 1 } as never

beforeEach(() => {
  requests.length = 0
  staleReads = 0
  submitResult = 'tesSUCCESS'
})

describe('realPrimarySaleLedger.startSellOffer', () => {
  it('does not return until the organizer\'s new sequence is visible', async () => {
    staleReads = 3 // three reads still see the old number

    const r = await realPrimarySaleLedger().startSellOffer(tx)

    expect(r).toMatchObject({ ok: true, hash: 'H'.repeat(64) })
    const reads = requests.filter((q) => q.command === 'account_info')
    // It kept looking until it saw 501, instead of releasing the account on the
    // stale 500 and letting the next checkout reuse that number.
    expect(reads.length).toBe(4)
    expect(reads.every((q) => q.account === ORGANIZER && q.ledger_index === 'current')).toBe(true)
  })

  it('reads once when the view is already current', async () => {
    await realPrimarySaleLedger().startSellOffer(tx)
    expect(requests.filter((q) => q.command === 'account_info').length).toBe(1)
  })

  it('does not wait for anything when the submit was refused', async () => {
    submitResult = 'tefPAST_SEQ'

    const r = await realPrimarySaleLedger().startSellOffer(tx)

    expect(r).toEqual({ ok: false, code: 'tefPAST_SEQ' })
    expect(requests.filter((q) => q.command === 'account_info').length).toBe(0)
  })

  it('still reports success if the view never catches up, rather than inviting a second offer', async () => {
    staleReads = 10_000

    const started = Date.now()
    const r = await realPrimarySaleLedger().startSellOffer(tx)

    // The offer IS submitted; calling it a failure would make a caller try again
    // and create another. The wait is bounded, and the retry on tefPAST_SEQ is the
    // backstop for a racing reader.
    expect(r.ok).toBe(true)
    expect(Date.now() - started).toBeLessThan(8_000)
  }, 12_000)
})
