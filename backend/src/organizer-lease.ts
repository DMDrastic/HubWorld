/**
 * One thing at a time on an organizer's account.
 *
 * Every transaction Hubworld submits AS an organizer — a delegated mint, a
 * delegated sell offer — consumes the ORGANIZER's `Sequence`, not the signer's.
 * Two of them in flight at once read the same sequence, and one is lost
 * (`tefPAST_SEQ`), or worse blocks the ones behind it. The bulk-mint worker and
 * the checkout both do this, so they take the same short lease around the moment
 * a sequence is read and the transaction is settled.
 *
 * A lease rather than an in-process mutex because there can be two instances, and
 * a lease rather than a Postgres advisory lock for the reason `job-lock.ts`
 * gives: Prisma pools connections, so an unlock can land on a different one.
 *
 * The honest cost: this serialises sales per organizer. One offer takes about a
 * ledger close to validate, so a single organizer's checkouts open at roughly one
 * every few seconds. That is a ceiling to MEASURE and then lift (a pre-listed
 * pool of offers), not one to hide — see `ROADMAP.md` §5b.
 */
import { acquireLock, releaseLock } from './job-lock.js'

const TTL_MS = 60_000
const RETRY_MIN_MS = 120
const RETRY_JITTER_MS = 180

/** How long a checkout waits in line for the account before saying "busy". */
export const DEFAULT_WAIT_MS = 20_000

const lockName = (organizerAddress: string) => `org-seq:${organizerAddress}`

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * A first-come-first-served line, per account, inside this process.
 *
 * Polling the database lease alone is unfair and wasteful under a crowd: every
 * waiter retries on its own jittered timer, so who gets the account next is a
 * lottery, the tail gets long, and N waiters hammer one row. In a rush most of
 * the contenders are in THIS process, so they queue here — each waiting on the
 * one before it, no polling — and only the head of the line goes to the database,
 * where it competes with other instances and the bulk-mint worker.
 */
const tails = new Map<string, Promise<void>>()

async function enterLine(address: string, deadline: number): Promise<(() => void) | null> {
  const prev = tails.get(address) ?? Promise.resolve()
  let leave!: () => void
  const mine = new Promise<void>((r) => (leave = r))
  const tail = prev.then(() => mine)
  tails.set(address, tail)

  const done = () => {
    leave()
    // Forget an idle line, or the map grows by one entry per organizer forever.
    if (tails.get(address) === tail) tails.delete(address)
  }

  const reached = await Promise.race([
    prev.then(() => true),
    sleep(Math.max(0, deadline - Date.now())).then(() => false),
  ])
  if (!reached) {
    // Our turn would come after the deadline. Leave the line as soon as the one
    // ahead of us finishes, so we never block the people behind us.
    void prev.then(done)
    return null
  }
  return done
}

/**
 * Run `fn` holding the organizer's lease, waiting up to `timeoutMs` for it.
 *
 * Returns `{ busy: true }` rather than throwing when the wait runs out, because
 * a busy account is an expected condition under load and the caller needs to say
 * so to a person ("try again in a moment"), not log an error.
 */
export async function withOrganizerLease<T>(
  organizerAddress: string,
  fn: () => Promise<T>,
  timeoutMs = DEFAULT_WAIT_MS,
): Promise<{ busy: true } | { busy: false; value: T }> {
  const deadline = Date.now() + timeoutMs

  const leaveLine = await enterLine(organizerAddress, deadline)
  if (!leaveLine) return { busy: true }

  try {
    const name = lockName(organizerAddress)
    while (!(await acquireLock(name, TTL_MS))) {
      if (Date.now() > deadline) return { busy: true }
      await sleep(RETRY_MIN_MS + Math.random() * RETRY_JITTER_MS)
    }
    try {
      return { busy: false, value: await fn() }
    } finally {
      // Always released, even on throw: otherwise one failure stalls every sale
      // for the whole TTL.
      await releaseLock(name).catch(() => undefined)
    }
  } finally {
    leaveLine()
  }
}
