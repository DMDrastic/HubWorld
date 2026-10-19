/**
 * Unattended bulk minting.
 *
 * An organizer has granted Hubworld's delegate account `NFTokenMint` on their
 * behalf (see `delegation.ts`). This worker spends that grant: it signs waves of
 * mints locally with the delegate key, submits them with `Account` = organizer,
 * and records each validated ticket — with nobody tapping anything.
 *
 * The shape of the loop is dictated by failures that were each found the hard
 * way on devnet, and none of them look like failures:
 *
 *   - Firing all N at once drops most of them (rippled holds only a few
 *     future-sequence transactions per account): 402 of 1,000 existed. So: WAVES,
 *     each confirmed before the next.
 *   - `Sequence` belongs to the ORGANIZER (`Account`), the fee to the delegate.
 *     Using the delegate's sequence appears to work when two fresh accounts
 *     happen to share a starting number, then mints zero with `terPRE_SEQ`.
 *   - A `tec` still consumes its sequence and fee, so "the sequence advanced"
 *     is not "a ticket was minted". Success is read per transaction from the
 *     validated result, never inferred.
 *   - One dropped transaction blocks every later sequence on the account, so
 *     each wave starts from the sequence the LEDGER reports, not from a counter.
 *
 * The ledger is the authority on every one of those. This file only decides what
 * to do next; the network sits behind `MintLedger` so those decisions can be
 * tested against a ledger that misbehaves on demand.
 */
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { NETWORK } from './network.js'
import { renewLock, acquireLock, releaseLock } from './job-lock.js'
import { withOrganizerLease } from './organizer-lease.js'
import { assertPublicBaseUrl, ticketMetadataUri } from './nft-metadata.js'
import { buildMintTx } from './ledger.js'
import { asDelegatedMint } from './delegation.js'
import { MintSubmitThrottled, type MintLedger, type MintToSign } from './mint-ledger.js'
import {
  DEFAULT_MAX_FEE_DROPS,
  decideFee,
  judgeWave,
  nextWaveSize,
  waveOutcome,
} from './bulk-mint-policy.js'

export type WorkerDeps = {
  ledger: MintLedger
  sleep?: (ms: number) => Promise<void>
  maxFeeDrops?: number
  /** How long one run may hold the job before yielding to the next sweep. */
  budgetMs?: number
  /** How long a wave waits for the organizer's account before backing off. */
  accountWaitMs?: number
}

/** Ledgers a wave stays valid for. ~4s each, so roughly 80s to land. */
const LAST_LEDGER_BUFFER = 20
/** Short lease, renewed every wave. */
const LEASE_TTL_MS = 90_000
const SETTLE_POLL_MS = 1_500
const SETTLE_MAX_WAIT_MS = 60_000
const LOOKUP_CHUNK = 20
const DEFAULT_BUDGET_MS = 4 * 60_000

const THROTTLE_BACKOFF_MS = 30_000
const FEE_BACKOFF_MS = 60_000
const ACCOUNT_BUSY_BACKOFF_MS = 10_000

type PendingWave = { hashes: string[]; firstSequence: number; lastLedgerSequence: number }

const lockName = (jobId: string) => `mint-job:${jobId}`

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function parsePending(value: Prisma.JsonValue | null): PendingWave | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.hashes) || typeof v.lastLedgerSequence !== 'number') return null
  return {
    hashes: v.hashes.filter((h): h is string => typeof h === 'string'),
    firstSequence: Number(v.firstSequence ?? 0),
    lastLedgerSequence: v.lastLedgerSequence,
  }
}

/**
 * Jobs a sweep should look at: unfinished and, if waiting, due.
 *
 * `RUNNING` is included on purpose. A job left RUNNING means a worker died with
 * it, and its lease will have lapsed — picking it up is the recovery path.
 */
export async function dueMintJobs(limit = 3) {
  return prisma.mintJob.findMany({
    where: {
      network: NETWORK,
      status: { in: ['QUEUED', 'RUNNING'] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })
}

/** Run every due job once. Errors are contained per job: one bad job must not starve the rest. */
export async function runDueMintJobs(deps: WorkerDeps): Promise<string[]> {
  const ran: string[] = []
  for (const job of await dueMintJobs()) {
    try {
      await runMintJob(job.id, deps)
      ran.push(job.id)
    } catch (err) {
      console.error(`mint job ${job.id.slice(0, 8)} errored:`, err)
      // A throw is a bug or an infrastructure fault, not an outcome. Back off so
      // a job that throws every time cannot sit at the front of the queue and be
      // retried into the same wall on every sweep.
      await prisma.mintJob
        .update({
          where: { id: job.id },
          data: {
            nextAttemptAt: new Date(Date.now() + FEE_BACKOFF_MS),
            statusReason: 'Hit an unexpected error; retrying shortly',
          },
        })
        .catch(() => undefined)
    }
  }
  return ran
}

/**
 * Work one job until it finishes, needs someone, has to wait, or its time slice
 * is up. Safe to call repeatedly and from several processes: it takes a lease,
 * and everything it does resumes from the database and the ledger.
 */
export async function runMintJob(jobId: string, deps: WorkerDeps): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep
  const maxFee = deps.maxFeeDrops ?? DEFAULT_MAX_FEE_DROPS
  const deadline = Date.now() + (deps.budgetMs ?? DEFAULT_BUDGET_MS)

  if (!(await acquireLock(lockName(jobId), LEASE_TTL_MS))) return
  try {
    let stalledWaves = 0

    for (;;) {
      // Losing the lease means another worker owns the job now; carrying on
      // would be the second copy the lease exists to prevent.
      if (!(await renewLock(lockName(jobId), LEASE_TTL_MS))) return

      const job = await prisma.mintJob.findUnique({
        where: { id: jobId },
        include: { event: true, organizer: true },
      })
      if (!job || (job.status !== 'QUEUED' && job.status !== 'RUNNING')) return
      if (job.network !== NETWORK) return // never act on another ledger's job

      if (job.status === 'QUEUED') {
        await prisma.mintJob.update({
          where: { id: job.id },
          data: { status: 'RUNNING', startedAt: job.startedAt ?? new Date(), nextAttemptAt: null, statusReason: null },
        })
      }

      // Everything below submits as the ORGANIZER, so it consumes THEIR sequence. A
      // checkout creating a sell offer on the same account at the same moment
      // would read the same number, and one of the two would be lost — or block
      // the ones behind it. Take the account's lease for the whole wave.
      const leased = await withOrganizerLease(
        job.organizerAddress,
        async () => {
        // A wave already in flight WILL land whatever we decide next, so it is
        // settled and recorded before anything else — including cancelling.
        const pending = parsePending(job.pendingWave)
        if (pending) {
          const settled = await settleWave(job.id, pending, deps.ledger, sleep)
          if (settled.kind === 'waiting') return // still in flight; the next sweep resumes it

          const verdict = judgeWave({
            codes: settled.codes,
            minted: settled.minted,
            stalledWaves: settled.minted === 0 ? stalledWaves + 1 : 0,
          })
          stalledWaves = settled.minted === 0 ? stalledWaves + 1 : 0
          if (verdict.kind === 'pause') return void (await finish(job.id, 'PAUSED', verdict.reason))
          if (verdict.kind === 'fail') return void (await finish(job.id, 'FAILED', verdict.reason))
          return 'again' as const
        }

        if (job.cancelRequested) return void (await finish(job.id, 'CANCELLED', 'Cancelled'))

        if (job.minted >= job.total) return void (await finish(job.id, 'DONE', null))

        if (Date.now() > deadline) return // yield; the next sweep carries on

        // The grant is the authority, and the organizer can withdraw it in Xaman
        // without telling us. Re-read it before EVERY wave: submitting against a
        // revoked grant burns a fee per ticket for nothing.
        const permission = await deps.ledger.readPermission(job.organizerAddress, job.delegateAddress)
        if (permission === 'absent') {
          return void (await finish(job.id, 'PAUSED', 'Your minting permission was withdrawn. Approve it again to continue.'))
        }
        if (permission === 'unknown') {
          return void (await wait(job.id, THROTTLE_BACKOFF_MS, 'Could not read the ledger; retrying shortly'))
        }

        // Never mint past the advertised size, whatever else has happened: a ticket
        // past `ticketCount` cannot be taken back.
        const room = await capRoom(job.eventId, job.event.ticketCount)
        const size = nextWaveSize(Math.min(job.total - job.minted, room))
        if (size === 0) {
          return void (await finish(job.id, 'DONE', job.minted >= job.total ? null : 'The event is full'))
        }

        try {
          assertPublicBaseUrl()
        } catch (err) {
          return void (await finish(job.id, 'FAILED', err instanceof Error ? err.message : 'Metadata URL is not public'))
        }

        const fee = decideFee(await deps.ledger.feeQuote(), maxFee)
        if (!fee.ok) return void (await wait(job.id, FEE_BACKOFF_MS, fee.reason))

        // Sequence comes from the LEDGER every wave. One dropped transaction
        // blocks every later sequence on the account, so a local counter marching
        // on regardless would silently abandon the rest of the event.
        const firstSequence = await deps.ledger.organizerSequence(job.organizerAddress)
        const lastLedgerSequence = (await deps.ledger.validatedLedgerIndex()) + LAST_LEDGER_BUFFER

        const uri = ticketMetadataUri(job.event.slug)
        const txs: MintToSign[] = []
        for (let i = 0; i < size; i++) {
          txs.push({
            ...asDelegatedMint(
              buildMintTx({
                issuerAddress: job.organizerAddress,
                taxon: job.event.nftTaxon,
                royaltyBps: job.event.royaltyBps,
                uri,
              }),
              job.delegateAddress,
            ),
            Sequence: firstSequence + i,
            Fee: String(fee.feeDrops),
            LastLedgerSequence: lastLedgerSequence,
          })
        }
        const signed = deps.ledger.sign(txs)

        // Recorded BEFORE submitting. Hashes are known once signed, so a crash
        // between submit and record is recoverable by asking the ledger about each
        // one — instead of guessing from balances.
        const wave: PendingWave = { hashes: signed.map((s) => s.hash), firstSequence, lastLedgerSequence }
        await prisma.mintJob.update({ where: { id: job.id }, data: { pendingWave: wave as unknown as Prisma.InputJsonValue } })

        const submitted = await Promise.all(
          signed.map((s) => deps.ledger.submit(s.blob).then(() => 'ok' as const, (e: unknown) => e)),
        )
        if (submitted.every((r) => r instanceof MintSubmitThrottled)) {
          // The node is refusing us for load. Nothing landed, and hammering it is
          // how a throttle becomes a ban.
          return void (await wait(job.id, THROTTLE_BACKOFF_MS, 'The network node is busy; retrying shortly'))
        }
        // Loop round: the pending wave is settled at the top.
          return 'again' as const
        },
        deps.accountWaitMs ?? 30_000,
      )
      if (leased.busy) {
        return void (await wait(job.id, ACCOUNT_BUSY_BACKOFF_MS, 'Waiting for a sale on your account to finish'))
      }
      if (leased.value !== 'again') return
    }
  } finally {
    await releaseLock(lockName(jobId)).catch(() => undefined)
  }
}

type Settled =
  | { kind: 'waiting' }
  | { kind: 'settled'; minted: number; codes: string[] }

/**
 * Find out what a wave actually did, and record it.
 *
 * Waits until every hash is either in a validated ledger or provably dead (past
 * its `LastLedgerSequence` in a VALIDATED ledger — an open ledger passing it
 * proves nothing). Gives up waiting after a minute and leaves the wave pending
 * for the next sweep rather than blocking the worker on a slow ledger.
 */
async function settleWave(
  jobId: string,
  wave: PendingWave,
  ledger: MintLedger,
  sleep: (ms: number) => Promise<void>,
): Promise<Settled> {
  const validated = new Map<string, { result: string; nfTokenId: string | null }>()
  const started = Date.now()

  for (;;) {
    const todo = wave.hashes.filter((h) => !validated.has(h))
    for (let i = 0; i < todo.length; i += LOOKUP_CHUNK) {
      const chunk = todo.slice(i, i + LOOKUP_CHUNK)
      const found = await Promise.all(chunk.map((h) => ledger.lookup(h).then((r) => [h, r] as const)))
      for (const [hash, r] of found) {
        if (r.state === 'validated') validated.set(hash, { result: r.result, nfTokenId: r.nfTokenId })
      }
    }

    const outcome = waveOutcome({
      hashes: wave.hashes,
      validated: new Set(validated.keys()),
      currentLedger: await ledger.validatedLedgerIndex(),
      lastLedgerSequence: wave.lastLedgerSequence,
    })
    if (outcome === 'settled') break
    if (Date.now() - started > SETTLE_MAX_WAIT_MS) return { kind: 'waiting' }
    await sleep(SETTLE_POLL_MS)
  }

  const job = await prisma.mintJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { event: true, organizer: true },
  })

  let minted = 0
  let failed = 0
  const codes: string[] = []
  for (const [hash, r] of validated) {
    codes.push(r.result)
    if (r.result === 'tesSUCCESS' && r.nfTokenId) {
      if (await recordTicket(job, r.nfTokenId, hash)) minted += 1
    } else if (r.result !== 'tesSUCCESS') {
      failed += 1
    }
  }

  await prisma.mintJob.update({
    where: { id: jobId },
    data: { pendingWave: Prisma.DbNull, failedTxs: { increment: failed } },
  })
  return { kind: 'settled', minted, codes }
}

/**
 * Record one validated mint as a ticket, and count it, in ONE transaction.
 *
 * Atomic on purpose: if the ticket and the job's counter were separate writes, a
 * crash between them would leave a ticket the job did not count, and the re-run
 * would see it already exists, skip it, and mint a replacement — one ticket over
 * the advertised size, with nothing to say why.
 *
 * Idempotent: the unique `nfTokenId` makes a repeat a no-op, and a repeat is not
 * counted twice. Returns whether this call created it.
 */
async function recordTicket(
  job: { id: string; eventId: string; organizerId: string; organizerAddress: string },
  nfTokenId: string,
  txHash: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.ticket.findUnique({
      where: { network_nfTokenId: { network: NETWORK, nfTokenId } },
    })
    if (existing) return false

    const ticket = await tx.ticket.create({
      data: {
        nfTokenId,
        network: NETWORK,
        eventId: job.eventId,
        // Freshly minted: the issuer holds it until it is gifted or sold.
        ownerId: job.organizerId,
        ownerAddress: job.organizerAddress,
        syncedAt: new Date(),
        status: 'MINTED',
      },
    })
    await tx.transfer.create({
      data: {
        ticketId: ticket.id,
        network: NETWORK,
        fromAddress: null, // a mint has no sender
        toAddress: job.organizerAddress,
        txHash,
        kind: 'MINT',
        occurredAt: new Date(),
      },
    })
    await tx.mintJob.update({ where: { id: job.id }, data: { minted: { increment: 1 } } })
    return true
  })
}

/** Tickets still allowed under the advertised size, counting what is committed elsewhere. */
async function capRoom(eventId: string, ticketCount: number): Promise<number> {
  if (ticketCount <= 0) return Number.MAX_SAFE_INTEGER
  const [tickets, inFlight] = await Promise.all([
    prisma.ticket.count({ where: { eventId, network: NETWORK } }),
    prisma.mintRequest.count({
      where: { eventId, status: { in: ['PENDING', 'SIGNED'] }, expiresAt: { gt: new Date() } },
    }),
  ])
  return Math.max(0, ticketCount - tickets - inFlight)
}

async function finish(jobId: string, status: 'DONE' | 'PAUSED' | 'FAILED' | 'CANCELLED', reason: string | null) {
  await prisma.mintJob.update({
    where: { id: jobId },
    data: {
      status,
      statusReason: reason,
      nextAttemptAt: null,
      // PAUSED is not finished: the organizer can resume it.
      finishedAt: status === 'PAUSED' ? null : new Date(),
    },
  })
}

/** Transient wait: stay QUEUED, come back later, say why. */
async function wait(jobId: string, ms: number, reason: string) {
  await prisma.mintJob.update({
    where: { id: jobId },
    data: { status: 'QUEUED', nextAttemptAt: new Date(Date.now() + ms), statusReason: reason },
  })
}

