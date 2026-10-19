/**
 * The delegate pays the fee of every delegated mint, so a dry one stops every
 * bulk mint on the platform at once and silently. It shares its reading rules
 * with the broker (`account-health.ts`); this pins that the delegate is wired to
 * ITS OWN key and mode, and not quietly reporting on the broker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const accountFunding = vi.fn()
const delegateAddress = vi.fn()
const platformAddress = vi.fn()
let delegateModeValue: 'live' | 'disabled' = 'live'

vi.mock('../src/env.js', async () => {
  const actual = await vi.importActual<typeof import('../src/env.js')>('../src/env.js')
  return {
    ...actual,
    get delegateMode() {
      return delegateModeValue
    },
    brokerMode: 'live' as const,
  }
})

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return {
    ...actual,
    delegateAddress: () => delegateAddress(),
    platformAddress: () => platformAddress(),
    accountFunding: (...a: unknown[]) => accountFunding(...a),
  }
})

const { delegateHealth, resetDelegateHealthCache } = await import('../src/delegate-health.js')
const { brokerHealth, resetBrokerHealthCache } = await import('../src/broker-health.js')

const ADDR = 'rDelegateHealthFixture00000000'

beforeEach(() => {
  resetDelegateHealthCache()
  resetBrokerHealthCache()
  accountFunding.mockReset()
  delegateAddress.mockReset().mockReturnValue(ADDR)
  platformAddress.mockReset().mockReturnValue('rBrokerHealthFixture0000000000')
  delegateModeValue = 'live'
})
afterEach(() => vi.restoreAllMocks())

describe('delegateHealth', () => {
  it('is disabled without a delegate key', async () => {
    delegateModeValue = 'disabled'
    expect(await delegateHealth()).toEqual({ mode: 'disabled' })
    expect(accountFunding).not.toHaveBeenCalled()
  })

  it('reads the DELEGATE account, not the broker', async () => {
    accountFunding.mockResolvedValue({ spendableDrops: 5_000_000n, reserveIncDrops: 200_000n })

    const h = await delegateHealth()

    expect(h).toMatchObject({ mode: 'live', address: ADDR, status: 'ok', spendableDrops: 5_000_000n })
    expect(accountFunding).toHaveBeenCalledWith(ADDR)
  })

  it('separates unfunded, low and ok', async () => {
    accountFunding.mockResolvedValueOnce({ spendableDrops: 0n, reserveIncDrops: 1n })
    expect((await delegateHealth()).mode === 'live' && (await delegateHealth())).toMatchObject({ status: 'unfunded' })
    resetDelegateHealthCache()
    accountFunding.mockResolvedValueOnce({ spendableDrops: 499_999n, reserveIncDrops: 1n })
    expect(await delegateHealth()).toMatchObject({ status: 'low' })
    resetDelegateHealthCache()
    accountFunding.mockResolvedValueOnce({ spendableDrops: 500_000n, reserveIncDrops: 1n })
    expect(await delegateHealth()).toMatchObject({ status: 'ok' })
  })

  it('reports an unreadable ledger as unknown, never as unfunded', async () => {
    accountFunding.mockRejectedValue(new Error('node down'))
    const h = await delegateHealth()
    expect(h).toEqual({ mode: 'live', address: ADDR, status: 'unknown' })
  })

  it('reports a malformed seed as misconfigured, without ever touching the ledger', async () => {
    delegateAddress.mockImplementation(() => {
      throw new Error('bad seed')
    })
    expect(await delegateHealth()).toEqual({ mode: 'misconfigured' })
    expect(accountFunding).not.toHaveBeenCalled()
  })

  it('caches a reading, so the health endpoint is not a load generator', async () => {
    accountFunding.mockResolvedValue({ spendableDrops: 5_000_000n, reserveIncDrops: 1n })
    await delegateHealth(1_000)
    await delegateHealth(30_000)
    expect(accountFunding).toHaveBeenCalledTimes(1)
    await delegateHealth(1_000 + 61_000)
    expect(accountFunding).toHaveBeenCalledTimes(2)
  })

  it('keeps the two accounts\' caches separate', async () => {
    accountFunding.mockImplementation(async (a: string) =>
      a === ADDR
        ? { spendableDrops: 9_000_000n, reserveIncDrops: 1n }
        : { spendableDrops: 0n, reserveIncDrops: 1n },
    )
    expect(await delegateHealth()).toMatchObject({ status: 'ok' })
    expect(await brokerHealth()).toMatchObject({ status: 'unfunded' })
  })
})
