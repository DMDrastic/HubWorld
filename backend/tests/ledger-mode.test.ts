/**
 * Which ledger the app talks to is its own setting, not a side effect of whether Xaman credentials happen to be set. Written before the change.
 *
 * Before: "no Xaman credentials" meant BOTH "fake Xaman sign-in" AND "pretend in-memory ledger". Two separate questions joined by
 * accident, so the only way to run against the real test network without Xaman was to set fake Xaman credentials, which broke Xaman
 * sign-in as a side effect. Now `LEDGER=real|stub` decides the ledger. Left unset it behaves EXACTLY as before.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ledgerModeRefusal, resolveLedgerMode } from '../src/env.js'

describe('resolveLedgerMode', () => {
  it('unset: exactly as before (Xaman credentials present means the real ledger, absent means the pretend one)', () => {
    expect(resolveLedgerMode({ explicit: undefined, xamanMode: 'live' })).toBe('real')
    expect(resolveLedgerMode({ explicit: undefined, xamanMode: 'stub' })).toBe('stub')
  })

  it('LEDGER=real uses the real ledger even with no Xaman credentials (the local stack)', () => {
    expect(resolveLedgerMode({ explicit: 'real', xamanMode: 'stub' })).toBe('real')
  })

  it('LEDGER=stub uses the pretend ledger even with Xaman credentials', () => {
    expect(resolveLedgerMode({ explicit: 'stub', xamanMode: 'live' })).toBe('stub')
  })
})

describe('ledgerModeRefusal: production never runs on a pretend ledger', () => {
  it('refuses the pretend ledger in production, in words', () => {
    expect(ledgerModeRefusal({ ledgerMode: 'stub', nodeEnv: 'production' })).toMatch(/pretend|stub/i)
  })
  it('allows the real ledger in production', () => {
    expect(ledgerModeRefusal({ ledgerMode: 'real', nodeEnv: 'production' })).toBeNull()
  })
  it('allows either in development and tests', () => {
    for (const nodeEnv of ['development', 'test'] as const) {
      expect(ledgerModeRefusal({ ledgerMode: 'stub', nodeEnv })).toBeNull()
      expect(ledgerModeRefusal({ ledgerMode: 'real', nodeEnv })).toBeNull()
    }
  })
})

describe('every ledger decision reads the ledger setting, never the Xaman one', () => {
  // A source check, deliberately: there are a dozen of these switches, and a single one left reading Xaman credentials would send
  // that one operation to the wrong ledger with nothing failing. This is how that is caught.
  const files = ['src/ledger.ts', 'src/delegation.ts', 'src/mint-ledger.ts', 'src/primary-sale-ledger.ts', 'src/delegate-account.ts']
  it.each(files)('%s does not branch on xamanMode', (f) => {
    const code = readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)) // comments may still explain the history
      .join('\n')
    expect(code).not.toMatch(/xamanMode/)
  })
})
