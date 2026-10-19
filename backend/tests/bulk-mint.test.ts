/**
 * The bulk-mint worker against a ledger that misbehaves on demand.
 *
 * Real Postgres, fake network. The fake ledger models the rule that makes bulk
 * minting hard: sequences apply strictly in order, so one dropped transaction
 * blocks every later one — they come back `terPRE_SEQ` and never validate. That
 * is exactly how 402 of 1,000 tickets ended up existing on devnet.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'

const readPermission = vi.fn<() => Promise<'granted' | 'absent' | 'unknown'>>()

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { runMintJob, runDueMintJobs } = await import('../src/bulk-mint.js')
const { MintSubmitThrottled } = await import('../src/mint-ledger.js')
const { acquireLock, releaseLock } = await import('../src/job-lock.js')
import type { MintLedger, MintToSign, TxLookup } from '../src/mint-ledger.js'

const UTAG = 'bm_'
const ORGANIZER_ADDRESS_PREFIX = 'rBMORG'
const DELEGATE = 'rBMDelegateFixture0000000000'

// --------------------------------------------------------------- fake ledger

type Knobs = {
  /** Drop a transaction before it reaches the ledger (never validates). */
  drop?: (n: number) => boolean
  /** Code a transaction is applied with (tec codes still consume the sequence). */
  code?: (n: number) => string
  feeQuote?: { minimumFee: number; openLedgerFee: number }
  throttleSubmits?: boolean
  /** Called after each submit batch, e.g. to flip permission mid-run. */
  onSubmitted?: (submittedSoFar: number) => void | Promise<void>
}

class FakeLedger implements MintLedger {
  sequence = 500
  ledgerIndex = 10_000
  submitted = 0 // transactions the ledger was handed, in order
  signedSequences: number[] = []
  signedBy: string[] = []
  results = new Map<string, TxLookup>()
  blobs = new Map<string, MintToSign>()
  knobs: Knobs

  constructor(knobs: Knobs = {}) {
    this.knobs = knobs
  }

  async readPermission() {
    return readPermission()
  }
  async organizerSequence() {
    return this.sequence
  }
  async validatedLedgerIndex() {
    // Advances quickly so a wave's LastLedgerSequence passes within a few reads.
    this.ledgerIndex += 6
    return this.ledgerIndex
  }
  async feeQuote() {
    return this.knobs.feeQuote ?? { minimumFee: 10, openLedgerFee: 10 }
  }
  sign(txs: MintToSign[]) {
    return txs.map((tx) => {
      const hash = randomBytes(32).toString('hex').toUpperCase()
      this.blobs.set(hash, tx)
      this.signedSequences.push(tx.Sequence)
      this.signedBy.push(String((tx as { Delegate?: string }).Delegate))
      return { blob: hash, hash }
    })
  }
  async submit(blob: string) {
    if (this.knobs.throttleSubmits) throw new MintSubmitThrottled('slowDown')
    const tx = this.blobs.get(blob)!
    const n = this.submitted++
    if (this.knobs.drop?.(n)) return 'tesSUCCESS' // accepted by the node, lost before a ledger
    if (tx.Sequence !== this.sequence) return 'terPRE_SEQ' // blocked behind a gap
    const code = this.knobs.code?.(n) ?? 'tesSUCCESS'
    this.sequence += 1 // even a tec consumes its sequence and fee
    this.results.set(blob, {
      state: 'validated',
      result: code,
      nfTokenId: code === 'tesSUCCESS' ? randomBytes(32).toString('hex').toUpperCase() : null,
    })
    await this.knobs.onSubmitted?.(this.submitted)
    return code
  }
  async lookup(hash: string): Promise<TxLookup> {
    return this.results.get(hash) ?? { state: 'unknown' }
  }
}

// ------------------------------------------------------------------ fixtures

let uniq = ''

async function mkJob(opts: { total: number; ticketCount?: number; pendingWave?: object; status?: 'QUEUED' | 'RUNNING' }) {
  const organizer = await prisma.user.create({
    data: {
      username: `${UTAG}org_${uniq}`.slice(0, 20),
      xrplAddress: `${ORGANIZER_ADDRESS_PREFIX}${uniq}`.padEnd(28, 'x'),
      role: 'ORGANIZER',
    },
  })
  const event = await prisma.event.create({
    data: {
      network: NETWORK,
      slug: `bm-${uniq}`,
      title: 'Bulk Mint Test',
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: organizer.id,
      nftTaxon: 71_000 + Math.floor(Math.random() * 900),
      royaltyBps: 500,
      platformBps: 250,
      ticketCount: opts.ticketCount ?? opts.total,
      status: 'PUBLISHED',
    },
  })
  const job = await prisma.mintJob.create({
    data: {
      network: NETWORK,
      eventId: event.id,
      organizerId: organizer.id,
      organizerAddress: organizer.xrplAddress,
      delegateAddress: DELEGATE,
      total: opts.total,
      status: opts.status ?? 'QUEUED',
      ...(opts.pendingWave ? { pendingWave: opts.pendingWave } : {}),
    },
  })
  return { organizer, event, job }
}

const reload = (id: string) => prisma.mintJob.findUniqueOrThrow({ where: { id } })
const ticketCount = (eventId: string) => prisma.ticket.count({ where: { eventId } })
const noSleep = async () => undefined

async function cleanup() {
  const events = { event: { slug: { startsWith: 'bm-' } } }
  await prisma.transfer.deleteMany({ where: { ticket: events } })
  await prisma.ticket.deleteMany({ where: events })
  await prisma.mintJob.deleteMany({ where: { event: { slug: { startsWith: 'bm-' } } } })
  await prisma.event.deleteMany({ where: { slug: { startsWith: 'bm-' } } })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: UTAG } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: UTAG } } })
}

beforeEach(async () => {
  uniq = Math.random().toString(36).slice(2, 8)
  await cleanup()
  readPermission.mockReset()
  readPermission.mockResolvedValue('granted')
})
afterEach(cleanup)
afterAll(async () => {
  await prisma.$disconnect()
})

const run = (id: string, ledger: FakeLedger, extra: object = {}) =>
  runMintJob(id, { ledger, sleep: noSleep, ...extra })

// --------------------------------------------------------------------- tests

describe('a clean run', () => {
  it('mints exactly the total, in waves, as the organizer, signed by the delegate', async () => {
    const { job, event, organizer } = await mkJob({ total: 45 })
    const ledger = new FakeLedger()

    await run(job.id, ledger)

    const done = await reload(job.id)
    expect(done).toMatchObject({ status: 'DONE', minted: 45, failedTxs: 0, pendingWave: null })
    expect(done.finishedAt).not.toBeNull()
    expect(await ticketCount(event.id)).toBe(45)

    // Sequences are the ORGANIZER's, contiguous from the ledger's own count.
    expect(ledger.signedSequences).toEqual(Array.from({ length: 45 }, (_, i) => 500 + i))
    // Every mint names the delegate as signer, never the platform.
    expect(new Set(ledger.signedBy)).toEqual(new Set([DELEGATE]))
    // Issued by the organizer: the signed transactions' Account is theirs.
    for (const tx of ledger.blobs.values()) expect(tx.Account).toBe(organizer.xrplAddress)
  })

  it('records every ticket as held by the organizer, with MINT provenance', async () => {
    const { job, event, organizer } = await mkJob({ total: 3 })
    await run(job.id, new FakeLedger())

    const tickets = await prisma.ticket.findMany({ where: { eventId: event.id }, include: { transfers: true } })
    expect(tickets).toHaveLength(3)
    for (const t of tickets) {
      expect(t.ownerId).toBe(organizer.id)
      expect(t.status).toBe('MINTED')
      expect(t.transfers).toHaveLength(1)
      expect(t.transfers[0]).toMatchObject({ kind: 'MINT', fromAddress: null, toAddress: organizer.xrplAddress })
    }
  })

  it('submits waves of at most 20', async () => {
    const { job } = await mkJob({ total: 45 })
    const ledger = new FakeLedger()
    const sizes: number[] = []
    const original = ledger.sign.bind(ledger)
    ledger.sign = (txs) => (sizes.push(txs.length), original(txs))

    await run(job.id, ledger)
    expect(sizes).toEqual([20, 20, 5])
  })
})

describe('transactions that go missing', () => {
  it('re-reads the sequence from the ledger after a dropped transaction and still finishes', async () => {
    const { job, event } = await mkJob({ total: 40 })
    // The 5th transaction is lost. Everything behind it is blocked (terPRE_SEQ).
    const ledger = new FakeLedger({ drop: (n) => n === 4 })

    await run(job.id, ledger)

    const done = await reload(job.id)
    expect(done.status).toBe('DONE')
    expect(done.minted).toBe(40)
    expect(await ticketCount(event.id)).toBe(40)
    // The first wave landed only 4 before the gap; the next wave restarted at the
    // ledger's sequence (504), not at a counter that had already marched on.
    expect(ledger.signedSequences[20]).toBe(504)
  })

  it('gives up with a reason when nothing ever lands', async () => {
    const { job, event } = await mkJob({ total: 20 })
    const ledger = new FakeLedger({ drop: () => true })

    await run(job.id, ledger)

    const done = await reload(job.id)
    expect(done.status).toBe('FAILED')
    expect(done.statusReason).toMatch(/No tickets were minted/)
    expect(await ticketCount(event.id)).toBe(0)
  })
})

describe('a transaction applied with a failure code', () => {
  it('is counted as failed, not as a ticket, and a funding shortfall pauses the run', async () => {
    const { job, event } = await mkJob({ total: 20 })
    const ledger = new FakeLedger({ code: (n) => (n < 5 ? 'tesSUCCESS' : 'tecINSUFFICIENT_RESERVE') })

    await run(job.id, ledger)

    const paused = await reload(job.id)
    expect(paused.status).toBe('PAUSED')
    expect(paused.statusReason).toMatch(/reserve/)
    expect(paused.minted).toBe(5)
    expect(paused.failedTxs).toBe(15)
    // The sequence advancing is NOT a mint: only 5 tickets exist.
    expect(await ticketCount(event.id)).toBe(5)
    expect(paused.finishedAt).toBeNull() // paused is resumable, not finished
  })
})

describe('the grant', () => {
  it('stops and pauses when the organizer withdraws it mid-run, spending nothing further', async () => {
    const { job, event } = await mkJob({ total: 100 })
    const ledger = new FakeLedger()
    // Granted for the first wave, then withdrawn.
    readPermission.mockResolvedValueOnce('granted').mockResolvedValue('absent')

    await run(job.id, ledger)

    const paused = await reload(job.id)
    expect(paused.status).toBe('PAUSED')
    expect(paused.statusReason).toMatch(/withdrawn/)
    expect(paused.minted).toBe(20) // the one wave that went out
    expect(await ticketCount(event.id)).toBe(20)
    expect(ledger.submitted).toBe(20) // nothing submitted against a revoked grant
  })

  it('re-reads the grant before EVERY wave', async () => {
    const { job } = await mkJob({ total: 60 })
    await run(job.id, new FakeLedger())
    expect(readPermission.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('waits, rather than pausing, when the ledger cannot be read', async () => {
    const { job } = await mkJob({ total: 20 })
    const ledger = new FakeLedger()
    readPermission.mockResolvedValue('unknown')

    await run(job.id, ledger)

    const waiting = await reload(job.id)
    // "We could not tell" is not "revoked": no pause, no failure, no spend.
    expect(waiting.status).toBe('QUEUED')
    expect(waiting.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now())
    expect(ledger.submitted).toBe(0)
  })
})

describe('fees and a busy network', () => {
  it('waits out a fee spike instead of overpaying', async () => {
    const { job } = await mkJob({ total: 20 })
    const ledger = new FakeLedger({ feeQuote: { minimumFee: 10, openLedgerFee: 50_000 } })

    await run(job.id, ledger)

    const waiting = await reload(job.id)
    expect(waiting.status).toBe('QUEUED')
    expect(waiting.statusReason).toMatch(/fees are high/i)
    expect(ledger.submitted).toBe(0)
  })

  it('pays a margin over the quoted fee', async () => {
    const { job } = await mkJob({ total: 2 })
    const ledger = new FakeLedger({ feeQuote: { minimumFee: 10, openLedgerFee: 100 } })
    await run(job.id, ledger)
    for (const tx of ledger.blobs.values()) expect(tx.Fee).toBe('120')
  })

  it('backs off when the node throttles every submission', async () => {
    const { job } = await mkJob({ total: 20 })
    const ledger = new FakeLedger({ throttleSubmits: true })

    await run(job.id, ledger)

    const waiting = await reload(job.id)
    expect(waiting.status).toBe('QUEUED')
    expect(waiting.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now())
    expect(waiting.statusReason).toMatch(/busy/i)
  })
})

describe('the advertised size', () => {
  it('never mints past ticketCount, even if the job asked for more', async () => {
    const { job, event } = await mkJob({ total: 50, ticketCount: 30 })
    await run(job.id, new FakeLedger())

    expect(await ticketCount(event.id)).toBe(30)
    const done = await reload(job.id)
    expect(done.status).toBe('DONE')
    expect(done.statusReason).toMatch(/full/)
  })

  it('counts tickets that already exist', async () => {
    const { job, event, organizer } = await mkJob({ total: 20, ticketCount: 25 })
    for (let i = 0; i < 10; i++) {
      await prisma.ticket.create({
        data: {
          nfTokenId: `EXISTING${uniq}${i}`.padEnd(64, '0').toUpperCase(),
          network: NETWORK,
          eventId: event.id,
          ownerId: organizer.id,
          ownerAddress: organizer.xrplAddress,
          status: 'MINTED',
        },
      })
    }
    await run(job.id, new FakeLedger())
    expect(await ticketCount(event.id)).toBe(25)
  })
})

describe('recovering from a crash', () => {
  it('records a wave that landed while the worker was down, exactly once', async () => {
    const { job, event } = await mkJob({ total: 10, status: 'RUNNING' })
    const ledger = new FakeLedger()
    // The wave was signed, submitted and validated; then the process died before
    // recording anything. The job row only knows the hashes.
    const txs: MintToSign[] = Array.from({ length: 10 }, (_, i) => ({
      TransactionType: 'NFTokenMint',
      Account: 'rX',
      NFTokenTaxon: 1,
      Sequence: 500 + i,
      Fee: '12',
      LastLedgerSequence: 99_999,
    })) as MintToSign[]
    const signed = ledger.sign(txs)
    await Promise.all(signed.map((s) => ledger.submit(s.blob)))
    await prisma.mintJob.update({
      where: { id: job.id },
      data: { pendingWave: { hashes: signed.map((s) => s.hash), firstSequence: 500, lastLedgerSequence: 99_999 } },
    })
    const signedBefore = ledger.signedSequences.length

    await run(job.id, ledger)

    const done = await reload(job.id)
    expect(done).toMatchObject({ status: 'DONE', minted: 10, pendingWave: null })
    expect(await ticketCount(event.id)).toBe(10)
    // Nothing new was minted: it recognised the landed wave instead of repeating it.
    expect(ledger.signedSequences.length).toBe(signedBefore)
  })

  it('does not count a ticket twice if it is settled again', async () => {
    const { job, event } = await mkJob({ total: 4, status: 'RUNNING' })
    const ledger = new FakeLedger()
    const txs = Array.from({ length: 4 }, (_, i) => ({
      TransactionType: 'NFTokenMint',
      Account: 'rX',
      NFTokenTaxon: 1,
      Sequence: 500 + i,
      Fee: '12',
      LastLedgerSequence: 99_999,
    })) as MintToSign[]
    const signed = ledger.sign(txs)
    await Promise.all(signed.map((s) => ledger.submit(s.blob)))
    const wave = { hashes: signed.map((s) => s.hash), firstSequence: 500, lastLedgerSequence: 99_999 }

    // Settled once...
    await prisma.mintJob.update({ where: { id: job.id }, data: { pendingWave: wave } })
    await run(job.id, ledger)
    expect((await reload(job.id)).minted).toBe(4)

    // ...and the same wave presented again (a crash after recording, before the
    // pending marker was cleared). The tickets exist, so nothing is added.
    await prisma.mintJob.update({ where: { id: job.id }, data: { status: 'QUEUED', pendingWave: wave } })
    await run(job.id, ledger)

    expect((await reload(job.id)).minted).toBe(4)
    expect(await ticketCount(event.id)).toBe(4)
  })
})

describe('cancelling', () => {
  it('lets the wave in flight land and be recorded, then stops', async () => {
    const { job, event } = await mkJob({ total: 100 })
    const ledger = new FakeLedger({
      // Cancel is requested while the first wave is going out.
      onSubmitted: async (n) => {
        if (n === 1) await prisma.mintJob.update({ where: { id: job.id }, data: { cancelRequested: true } })
      },
    })

    await run(job.id, ledger)

    const done = await reload(job.id)
    expect(done.status).toBe('CANCELLED')
    // The first wave was already on the ledger, so its tickets are recorded
    // rather than orphaned — and nothing further was submitted.
    expect(done.minted).toBe(20)
    expect(await ticketCount(event.id)).toBe(20)
    expect(ledger.submitted).toBe(20)
  })
})

describe('the organizer\'s account', () => {
  it('waits, spending nothing, while a checkout is using the same account', async () => {
    const { job, organizer } = await mkJob({ total: 20 })
    const ledger = new FakeLedger()
    // A checkout is mid-offer on this organizer: it holds their sequence.
    expect(await acquireLock(`org-seq:${organizer.xrplAddress}`, 60_000)).toBe(true)

    await run(job.id, ledger, { accountWaitMs: 300 })

    const waiting = await reload(job.id)
    expect(waiting.status).toBe('QUEUED')
    expect(waiting.statusReason).toMatch(/sale on your account/i)
    expect(waiting.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now())
    // Two things signing as one account at once would read the same sequence.
    expect(ledger.submitted).toBe(0)
    await releaseLock(`org-seq:${organizer.xrplAddress}`)
  })

  it('takes the account for a wave and gives it back', async () => {
    const { job, organizer } = await mkJob({ total: 20 })
    await run(job.id, new FakeLedger())

    // Released: a checkout can have the account the moment the wave is over.
    expect(await acquireLock(`org-seq:${organizer.xrplAddress}`, 5_000)).toBe(true)
    await releaseLock(`org-seq:${organizer.xrplAddress}`)
  })
})

describe('who may work a job', () => {
  it('does nothing while another worker holds the lease', async () => {
    const { job } = await mkJob({ total: 20 })
    const ledger = new FakeLedger()
    expect(await acquireLock(`mint-job:${job.id}`, 60_000)).toBe(true)

    // Same process id, so the lease is "ours" but already taken: the worker must
    // not start a second copy.
    await run(job.id, ledger)

    expect(ledger.submitted).toBe(0)
    await releaseLock(`mint-job:${job.id}`)
  })

  it('ignores a job that belongs to another ledger', async () => {
    const { job } = await mkJob({ total: 20 })
    const other = NETWORK === 'MAINNET' ? 'TESTNET' : 'MAINNET'
    await prisma.mintJob.update({ where: { id: job.id }, data: { network: other } })
    const ledger = new FakeLedger()

    await run(job.id, ledger)

    expect(ledger.submitted).toBe(0)
    expect((await reload(job.id)).minted).toBe(0)
  })

  it('does not touch paused, finished or cancelled jobs', async () => {
    const { job } = await mkJob({ total: 20 })
    for (const status of ['PAUSED', 'DONE', 'FAILED', 'CANCELLED'] as const) {
      await prisma.mintJob.update({ where: { id: job.id }, data: { status } })
      const ledger = new FakeLedger()
      await run(job.id, ledger)
      expect(ledger.submitted).toBe(0)
    }
  })

  it('does not hold the queue hostage: a throwing job backs off and the sweep goes on', async () => {
    const a = await mkJob({ total: 5 })
    uniq = Math.random().toString(36).slice(2, 8)
    const b = await mkJob({ total: 5 })
    const good = new FakeLedger()
    const original = good.organizerSequence.bind(good)
    let first = true
    good.organizerSequence = async (...args: []) => {
      if (first) {
        first = false
        throw new Error('boom')
      }
      return original(...args)
    }

    await runDueMintJobs({ ledger: good, sleep: noSleep })

    // The one that threw is deferred rather than retried into the same wall...
    const thrown = await reload(a.job.id)
    expect(thrown.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now())
    // ...and the other still ran to completion.
    expect((await reload(b.job.id)).status).toBe('DONE')
  })
})
