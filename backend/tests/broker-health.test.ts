/**
 * Whether sales can settle must be visible from outside the process.
 *
 * The broker submits every `NFTokenAcceptOffer`, so it pays every settlement
 * fee. Drain it and settlement stops platform-wide — silently. No request
 * fails, nothing 500s, auctions simply close and never complete. Roadmap §4
 * carries this as a missing safety net.
 *
 * The distinction this file exists to pin is `unknown` versus `unfunded`. They
 * are opposite facts — "we could not read the ledger" and "there is no money" —
 * and collapsing them would fire a funding alarm every time a public XRPL node
 * blinks, which is how an alarm gets ignored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const accountFunding = vi.fn()
const platformAddress = vi.fn()
let brokerModeValue: 'live' | 'disabled' = 'live'

vi.mock('../src/env.js', async () => {
  const actual = await vi.importActual<typeof import('../src/env.js')>('../src/env.js')
  return {
    ...actual,
    get brokerMode() {
      return brokerModeValue
    },
  }
})

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return {
    ...actual,
    platformAddress: () => platformAddress(),
    accountFunding: (...a: unknown[]) => accountFunding(...a),
  }
})

const { brokerHealth, resetBrokerHealthCache } = await import('../src/broker-health.js')

beforeEach(() => {
  brokerModeValue = 'live'
  accountFunding.mockReset()
  platformAddress.mockReset()
  platformAddress.mockReturnValue('rBrokerFixtureAddress0000000000000')
  resetBrokerHealthCache()
})

afterEach(() => {
  vi.useRealTimers()
})

const funding = (spendableDrops: bigint) => ({ spendableDrops, reserveIncDrops: 200_000n })

describe('brokerHealth', () => {
  it('reports disabled when no broker key is configured', async () => {
    brokerModeValue = 'disabled'

    await expect(brokerHealth()).resolves.toEqual({ mode: 'disabled' })
    // No key means no address to read; it must not reach the ledger to say so.
    expect(accountFunding).not.toHaveBeenCalled()
  })

  it('reports misconfigured when a key is set but unusable, and does not throw', async () => {
    // The bug CI caught. `brokerMode` only asks whether PLATFORM_SEED is
    // PRESENT; deriving an address asks whether it is VALID. A malformed seed
    // threw straight through /api/health, which answered 500 to a request whose
    // entire contract is that it always answers 200.
    platformAddress.mockImplementation(() => {
      throw new Error('PLATFORM_SEED is not set — cannot broker a sale')
    })

    await expect(brokerHealth()).resolves.toEqual({ mode: 'misconfigured' })
    // Distinct from `disabled`: the operator believes settlement is on. And it
    // must never reach the ledger with an address it could not derive.
    expect(accountFunding).not.toHaveBeenCalled()
  })

  it('reports ok with a funded broker', async () => {
    accountFunding.mockResolvedValue(funding(50_000_000n))

    const health = await brokerHealth()

    expect(health).toMatchObject({ mode: 'live', status: 'ok', spendableDrops: 50_000_000n })
  })

  it('reports low before the broker is empty, not after', async () => {
    // The whole point of a watermark: an alarm that fires at zero fires too late
    // to act on, because settlement has already stopped by then.
    accountFunding.mockResolvedValue(funding(499_999n))

    await expect(brokerHealth()).resolves.toMatchObject({ status: 'low' })
  })

  it('treats the watermark as a floor, not a ceiling', async () => {
    accountFunding.mockResolvedValue(funding(500_000n))

    await expect(brokerHealth()).resolves.toMatchObject({ status: 'ok' })
  })

  it('reports unfunded when the broker cannot pay a fee', async () => {
    // Zero SPENDABLE, which is not the same as an empty account — one sitting
    // exactly at its reserve reads zero too, and equally cannot pay.
    accountFunding.mockResolvedValue(funding(0n))

    await expect(brokerHealth()).resolves.toMatchObject({ status: 'unfunded' })
  })

  it('reports unknown — never unfunded — when the ledger cannot be read', async () => {
    // The assertion this file is really for. A node blip must not look like an
    // empty account, and it must not throw either: /api/health always answers.
    accountFunding.mockRejectedValue(new Error('websocket closed'))

    const health = await brokerHealth()

    expect(health).toEqual({
      mode: 'live',
      address: 'rBrokerFixtureAddress0000000000000',
      status: 'unknown',
    })
    expect(health).not.toHaveProperty('spendableDrops')
  })

  it('caches, so a polled health endpoint is not a load test on a public node', async () => {
    accountFunding.mockResolvedValue(funding(50_000_000n))

    await brokerHealth(1_000)
    await brokerHealth(1_500)
    await brokerHealth(60_000)

    // Counted by CALLS rather than by the value returned: a cache that returns
    // the right answer while still making the request has not cached anything.
    expect(accountFunding).toHaveBeenCalledTimes(1)
  })

  it('re-reads once the cached value is stale', async () => {
    accountFunding.mockResolvedValue(funding(50_000_000n))

    await brokerHealth(1_000)
    await brokerHealth(1_000 + 60_001)

    expect(accountFunding).toHaveBeenCalledTimes(2)
  })

  it('gives up on a ledger read that hangs', async () => {
    vi.useFakeTimers()
    // Never resolves. Without the race, /api/health would hang with it — and a
    // health check that hangs is worse than one that reports a problem.
    accountFunding.mockReturnValue(new Promise(() => {}))

    const pending = brokerHealth()
    await vi.advanceTimersByTimeAsync(2_500)

    await expect(pending).resolves.toMatchObject({ status: 'unknown' })
  })
})
