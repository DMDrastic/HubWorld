/**
 * One thing at a time on an organizer's account, fairly.
 *
 * Real Postgres for the lease; the point under test is ordering and not
 * deadlocking, which a polling lease alone gets wrong under a crowd.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/prisma.js'
import { acquireLock, releaseLock } from '../src/job-lock.js'
import { withOrganizerLease } from '../src/organizer-lease.js'

const ADDR = (tag: string) => `rLeaseTest${tag}${Math.random().toString(36).slice(2, 8)}`
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

afterEach(async () => {
  await prisma.$executeRaw`DELETE FROM "JobLock" WHERE "name" LIKE 'org-seq:rLeaseTest%'`
})
afterAll(async () => {
  await prisma.$disconnect()
})

describe('withOrganizerLease', () => {
  it('runs one at a time on the same account', async () => {
    const addr = ADDR('a')
    let inside = 0
    let peak = 0
    const work = async () => {
      inside += 1
      peak = Math.max(peak, inside)
      await sleep(15)
      inside -= 1
    }

    await Promise.all(Array.from({ length: 8 }, () => withOrganizerLease(addr, work, 10_000)))

    expect(peak).toBe(1)
  })

  it('serves a crowd in the order it arrived', async () => {
    const addr = ADDR('b')
    const order: number[] = []

    await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        await sleep(i * 3) // arrive in a known order
        return withOrganizerLease(addr, async () => {
          order.push(i)
          await sleep(5)
        }, 10_000)
      }),
    )

    expect(order).toEqual(Array.from({ length: 12 }, (_, i) => i))
  })

  it('lets different accounts run at the same time', async () => {
    let inside = 0
    let peak = 0
    const work = async () => {
      inside += 1
      peak = Math.max(peak, inside)
      await sleep(40)
      inside -= 1
    }

    await Promise.all([withOrganizerLease(ADDR('c1'), work), withOrganizerLease(ADDR('c2'), work), withOrganizerLease(ADDR('c3'), work)])

    expect(peak).toBe(3)
  })

  it('says "busy" when the wait runs out, without running the work', async () => {
    const addr = ADDR('d')
    let ran = false
    const slow = withOrganizerLease(addr, () => sleep(400), 5_000)

    const waiter = await withOrganizerLease(addr, async () => (ran = true), 100)

    expect(waiter).toEqual({ busy: true })
    expect(ran).toBe(false)
    await slow
  })

  it('a waiter that gave up does not block the ones behind it', async () => {
    const addr = ADDR('e')
    const first = withOrganizerLease(addr, () => sleep(300), 5_000)
    await sleep(10)
    const impatient = withOrganizerLease(addr, async () => 'impatient', 50)
    await sleep(10)
    const patient = withOrganizerLease(addr, async () => 'patient', 5_000)

    expect(await impatient).toEqual({ busy: true })
    expect(await patient).toEqual({ busy: false, value: 'patient' })
    await first
  })

  it('releases after a throw, so one failure does not stall the account', async () => {
    const addr = ADDR('f')
    await expect(
      withOrganizerLease(addr, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(await withOrganizerLease(addr, async () => 'next', 1_000)).toEqual({ busy: false, value: 'next' })
  })

  it('waits for a lease another process holds, then goes', async () => {
    const addr = ADDR('g')
    // Another instance (or the bulk worker) holds the database lease.
    expect(await acquireLock(`org-seq:${addr}`, 60_000)).toBe(true)
    setTimeout(() => void releaseLock(`org-seq:${addr}`), 250)

    const r = await withOrganizerLease(addr, async () => 'ran', 5_000)

    expect(r).toEqual({ busy: false, value: 'ran' })
  })
})
