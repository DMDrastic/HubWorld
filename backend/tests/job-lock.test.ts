/**
 * Job-lease exclusion, tested against the real database.
 *
 * The sweep must not run in two processes at once: both would pick the same due
 * auction and try to broker it, and the loser would burn a transaction fee
 * discovering the offers were already consumed.
 *
 * These hit Postgres deliberately. The whole correctness argument rests on
 * `INSERT ... ON CONFLICT ... WHERE` being atomic under concurrency, and a mock
 * would test my belief about that rather than the behaviour.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/prisma.js'
import { acquireLock, releaseLock, withLock, PROCESS_ID } from '../src/job-lock.js'

const LOCK = 'test-lock'

async function clear() {
  await prisma.jobLock.deleteMany({ where: { name: { startsWith: 'test-' } } })
}

beforeEach(clear)
afterEach(async () => {
  await clear()
  await prisma.$disconnect()
})

describe('acquireLock', () => {
  it('grants a free lock and then refuses it', async () => {
    expect(await acquireLock(LOCK, 60_000)).toBe(true)
    // Same process, second attempt: still refused. The lease is about the job
    // running, not about who is asking.
    expect(await acquireLock(LOCK, 60_000)).toBe(false)
  })

  it('grants it again once the lease has expired', async () => {
    // Negative TTL: already expired, which is how a crashed holder self-heals.
    expect(await acquireLock(LOCK, -1000)).toBe(true)
    expect(await acquireLock(LOCK, 60_000)).toBe(true)
  })

  it('lets exactly one of many concurrent racers win', async () => {
    // The real scenario: several processes waking on the same interval.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => acquireLock(LOCK, 60_000)),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
  })
})

describe('releaseLock', () => {
  it('frees the lock for the next runner', async () => {
    expect(await acquireLock(LOCK, 60_000)).toBe(true)
    await releaseLock(LOCK)
    expect(await acquireLock(LOCK, 60_000)).toBe(true)
  })

  it('will not release a lease held by someone else', async () => {
    // A process that overran its TTL must not be able to release the lease a
    // different process has since legitimately taken.
    await acquireLock(LOCK, 60_000)
    await prisma.jobLock.update({ where: { name: LOCK }, data: { owner: 'someone-else' } })

    await releaseLock(LOCK)

    expect(await acquireLock(LOCK, 60_000)).toBe(false)
  })
})

describe('withLock', () => {
  it('runs the job and returns its value', async () => {
    expect(await withLock(LOCK, 60_000, async () => 'done')).toBe('done')
  })

  it('returns null instead of running when the lock is held', async () => {
    await acquireLock(LOCK, 60_000)
    let ran = false
    const out = await withLock(LOCK, 60_000, async () => {
      ran = true
      return 'done'
    })
    expect(out).toBeNull()
    expect(ran).toBe(false)
  })

  it('releases even when the job throws', async () => {
    // Otherwise one failure stalls the sweep for the whole TTL.
    await expect(
      withLock(LOCK, 60_000, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(await acquireLock(LOCK, 60_000)).toBe(true)
  })

  it('serialises overlapping runs rather than interleaving them', async () => {
    const order: string[] = []

    // Both calls race to acquire, so "which one wins" is not deterministic.
    // Waiting until the first has demonstrably STARTED before firing the second
    // tests the property that matters — no interleaving — instead of testing
    // which coroutine the scheduler happened to run first.
    let started: () => void
    const hasStarted = new Promise<void>((resolve) => {
      started = resolve
    })

    const slow = withLock(LOCK, 60_000, async () => {
      order.push('start')
      started()
      await new Promise((r) => setTimeout(r, 60))
      order.push('end')
    })

    await hasStarted
    const blocked = withLock(LOCK, 60_000, async () => {
      order.push('second')
    })

    await Promise.all([slow, blocked])

    // The second never ran, so the first was uninterrupted.
    expect(order).toEqual(['start', 'end'])
    expect(await blocked).toBeNull()
  })

  it('records which process holds it', async () => {
    await acquireLock(LOCK, 60_000)
    const row = await prisma.jobLock.findUnique({ where: { name: LOCK } })
    expect(row?.owner).toBe(PROCESS_ID)
  })
})
