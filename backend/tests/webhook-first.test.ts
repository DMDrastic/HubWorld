/**
 * Push is the primary path; polling is a fallback that has to earn its keep.
 *
 * Xaman asked for this directly: "the 1.5-second reconciliation loop is
 * technically still polling. Could you please use webhooks or WebSockets for
 * real-time updates, and only use polling sparingly as a fallback or periodic
 * check?" Elevated limits depend on it, and limits are adjusted on observed
 * behaviour — so this is not only compliance, it is the mechanism by which our
 * capacity grows.
 *
 * The fallback is made CONDITIONAL rather than deleted, and that distinction is
 * the whole design. `XAMAN_WEBHOOK_SECRET` being set says a URL exists; it does
 * not say Xaman can reach it. A deployment where the console entry was never
 * made looks identical from the inside, and CLAUDE.md already names it the worst
 * of both worlds — throttled polling and no push. Now that resolution TRUSTS
 * push, that state would be worse still: silence until a payload expired.
 *
 * So the cache is served only once callbacks have been OBSERVED arriving. Until
 * then we poll exactly as before, which is also what keeps local development
 * working with no public URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getPayload = vi.fn()
let webhookModeValue: 'live' | 'disabled' = 'live'

vi.mock('../src/env.js', async () => {
  const actual = await vi.importActual<typeof import('../src/env.js')>('../src/env.js')
  return {
    ...actual,
    get webhookMode() {
      return webhookModeValue
    },
  }
})

vi.mock('../src/xaman.js', async () => {
  const actual = await vi.importActual<typeof import('../src/xaman.js')>('../src/xaman.js')
  return {
    ...actual,
    xaman: {
      mode: 'stub' as const,
      getPayload: (...a: unknown[]) => getPayload(...a),
      createPayload: async () => ({ uuid: 'x', next: '', qrPng: '' }),
      createSignInPayload: async () => ({ uuid: 'x', next: '', qrPng: '' }),
      cancelPayload: async () => true,
    },
  }
})

const { prisma } = await import('../src/prisma.js')
const { resolvePayload, resetWebhookProof, webhooksArriving } = await import(
  '../src/payload-store.js'
)

const TAG = '00000000-0000-4000-9000-'
const uuidFor = (n: number) => `${TAG}${String(n).padStart(12, '0')}`

const PENDING = { signed: false, cancelled: false, expired: false, account: null, txid: null }

async function seedPayload(uuid: string, source: 'webhook' | 'poll', fetchedAt: Date) {
  await prisma.xamanPayload.create({
    data: {
      uuid,
      network: (await import('../src/network.js')).NETWORK,
      signer: 'stub',
      flow: 'SIGNIN',
      signed: false,
      cancelled: false,
      expired: false,
      terminal: false,
      source,
      fetchedAt,
    },
  })
}

async function cleanup() {
  await prisma.xamanPayload.deleteMany({ where: { uuid: { startsWith: TAG } } })
}

beforeEach(async () => {
  webhookModeValue = 'live'
  getPayload.mockReset()
  getPayload.mockResolvedValue(PENDING)
  resetWebhookProof()
  await cleanup()
})

afterEach(cleanup)

describe('once callbacks are observed arriving', () => {
  it('serves the cache without calling Xaman', async () => {
    // A webhook-sourced row is the evidence. Long stale on purpose: under the
    // old rule 1.5s would have forced a refresh, and that is exactly the loop
    // Xaman objected to.
    await seedPayload(uuidFor(1), 'webhook', new Date(Date.now() - 60_000))

    const result = await resolvePayload(uuidFor(1))

    expect(result).toMatchObject({ signed: false })
    expect(getPayload).not.toHaveBeenCalled()
  })

  it('still serves an answer for a payload it has never seen', async () => {
    // The client polls immediately after creating a payload, before any callback
    // could have arrived. That must not throw or return null — it is pending.
    await seedPayload(uuidFor(2), 'webhook', new Date())

    const result = await resolvePayload(uuidFor(99))

    expect(result).toMatchObject({ signed: false, cancelled: false })
    expect(getPayload).not.toHaveBeenCalled()
  })
})

describe('while a secret is set but nothing has ever arrived', () => {
  it('keeps polling, so an unregistered URL is not silence', async () => {
    // The documented failure: configured, unreachable, and previously invisible.
    // Deleting the fallback outright would turn it into a payload that never
    // resolves — worse than the throttled polling it replaced.
    await seedPayload(uuidFor(3), 'poll', new Date(Date.now() - 60_000))

    await resolvePayload(uuidFor(3))

    expect(getPayload).toHaveBeenCalledTimes(1)
  })

  it('reports itself unverified rather than claiming to work', async () => {
    await seedPayload(uuidFor(4), 'poll', new Date())

    await expect(webhooksArriving()).resolves.toBe(false)
  })
})

describe('with no webhook configured at all', () => {
  it('asks Xaman every time, exactly as before', async () => {
    // Local development has no public URL. This is the path that keeps it
    // working, and it must not be collateral damage.
    webhookModeValue = 'disabled'
    resetWebhookProof()

    await resolvePayload(uuidFor(5))
    await resolvePayload(uuidFor(5))

    expect(getPayload).toHaveBeenCalledTimes(2)
    await expect(webhooksArriving()).resolves.toBe(false)
  })
})

describe('the proof that callbacks arrive', () => {
  it('is re-checked, so registering the URL does not need a restart', async () => {
    // A negative answer is cached only briefly: someone fixing the console entry
    // should see it take effect without redeploying.
    await expect(webhooksArriving(1_000)).resolves.toBe(false)

    await seedPayload(uuidFor(6), 'webhook', new Date())

    // Inside the window, still the cached negative.
    await expect(webhooksArriving(1_500)).resolves.toBe(false)
    // Past it, the evidence is found.
    await expect(webhooksArriving(1_000 + 30_001)).resolves.toBe(true)
  })

  it('never re-queries once proven, since it cannot become false', async () => {
    await seedPayload(uuidFor(7), 'webhook', new Date())
    await expect(webhooksArriving()).resolves.toBe(true)

    await cleanup()

    // Still true without touching the database: a deployment that has received
    // a callback has proven reachability for good.
    await expect(webhooksArriving()).resolves.toBe(true)
  })
})
