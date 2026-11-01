/** LEDGER=stub WITH Xaman credentials: the pretend ledger, whatever Xaman is. */
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.LEDGER = 'stub'
  process.env.XAMAN_API_KEY = 'placeholder-key'
  process.env.XAMAN_API_SECRET = 'placeholder-secret'
})

const { ledgerMode, xamanMode } = await import('../src/env.js')
const { defaultPrimarySaleLedger } = await import('../src/primary-sale-ledger.js')
const { defaultMintLedger } = await import('../src/mint-ledger.js')

describe('LEDGER=stub with Xaman credentials', () => {
  it('uses the pretend ledger', () => {
    expect(xamanMode).toBe('live')
    expect(ledgerMode).toBe('stub')
    expect(defaultPrimarySaleLedger().kind).toBe('stub')
    expect(defaultMintLedger().kind).toBe('stub')
  })
})
