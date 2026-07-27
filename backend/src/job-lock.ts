/**
 * Lease-based locking for periodic jobs.
 *
 * The auction sweep must not run concurrently in two processes: both would pick
 * the same due auction and try to broker it, and the loser would burn a
 * transaction fee discovering the offers were already consumed.
 *
 * This is a **lease**, not a Postgres advisory lock. Advisory locks are scoped to
 * a connection and Prisma pools connections, so the unlock can land on a
 * different connection than the lock and leak it permanently. A row with an
 * expiry is connection-agnostic and self-healing — a process that dies holding
 * the lease simply lets it lapse.
 *
 * Acquisition is a single atomic statement. Two processes racing cannot both
 * succeed, because Postgres serialises the conflicting upsert and the `WHERE`
 * clause re-checks expiry against the committed row.
 */
import { randomUUID } from 'node:crypto'
import { prisma } from './prisma.js'

/** Identifies this process in the lock row, for debugging who holds what. */
export const PROCESS_ID = `${process.pid}-${randomUUID().slice(0, 8)}`

/**
 * Try to take a named lease.
 *
 * The TTL must comfortably exceed the job's worst-case runtime: if it expires
 * mid-run another process starts a second copy, which is the very thing being
 * prevented. Too long and a crashed process blocks the job until it lapses.
 */
export async function acquireLock(name: string, ttlMs: number): Promise<boolean> {
  const until = new Date(Date.now() + ttlMs)

  // ON CONFLICT ... WHERE is what makes this atomic: the row is only taken over
  // when the existing lease has actually expired.
  const rows = await prisma.$queryRaw<Array<{ name: string }>>`
    INSERT INTO "JobLock" ("name", "lockedUntil", "owner", "updatedAt")
    VALUES (${name}, ${until}, ${PROCESS_ID}, now())
    ON CONFLICT ("name") DO UPDATE
      SET "lockedUntil" = EXCLUDED."lockedUntil",
          "owner"       = EXCLUDED."owner",
          "updatedAt"   = now()
      WHERE "JobLock"."lockedUntil" < now()
    RETURNING "name"
  `
  return rows.length > 0
}

/**
 * Release a lease we hold.
 *
 * Scoped to `owner` so a process that overran its TTL cannot release a lease
 * another process has since legitimately taken.
 */
export async function releaseLock(name: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "JobLock"
       SET "lockedUntil" = now(), "updatedAt" = now()
     WHERE "name" = ${name} AND "owner" = ${PROCESS_ID}
  `
}

/**
 * Run `fn` only if the lease can be taken. Returns null when another process
 * holds it — a skipped run, not an error.
 */
export async function withLock<T>(
  name: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  if (!(await acquireLock(name, ttlMs))) return null
  try {
    return await fn()
  } finally {
    // Always released, even on throw: otherwise one failure would stall the job
    // for the whole TTL.
    await releaseLock(name).catch(() => undefined)
  }
}
