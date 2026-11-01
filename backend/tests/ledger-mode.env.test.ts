/** LEDGER=real with NO Xaman credentials: the real ledger, a stubbed Xaman. What the local stack runs. */
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.LEDGER = 'real'
  // ABSENT, not empty: an empty Xaman key is present-but-invalid and stops the process (see CLAUDE.md, e2e traps).
  delete process.env.XAMAN_API_KEY
  delete process.env.XAMAN_API_SECRET
  delete process.env.DELEGATE_SEED
})

const { ledgerMode, xamanMode } = await import('../src/env.js')
const { delegateConfigured } = await import('../src/delegate-account.js')
const { defaultPrimarySaleLedger } = await import('../src/primary-sale-ledger.js')
const { defaultMintLedger } = await import('../src/mint-ledger.js')

describe('LEDGER=real without Xaman credentials', () => {
  it('talks to the real ledger, while Xaman stays stubbed', () => {
    expect(ledgerMode).toBe('real')
    expect(xamanMode).toBe('stub')
  })

  it('needs a real delegate key to sell or mint (the pretend one is only for the pretend ledger)', () => {
    expect(delegateConfigured).toBe(false)
  })

  it('builds the real sale and mint ledgers, not the in-memory ones', () => {
    expect(defaultPrimarySaleLedger().kind).toBe('real')
    expect(defaultMintLedger().kind).toBe('real')
  })
})
