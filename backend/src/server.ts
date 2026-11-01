import { createApp } from './app.js'
import { env, brokerMode } from './env.js'
import { prisma } from './prisma.js'
import { disconnectLedger } from './ledger.js'
import { settleDueAuctions } from './settlement.js'
import { cancelAbandonedPayloads, reconcileStalePayloads } from './payload-store.js'
import { withLock } from './job-lock.js'
import { attachRealtime, closeRealtime } from './realtime.js'
import { assertDatabaseNetwork } from './network-guard.js'
import { runDueMintJobs } from './bulk-mint.js'
import { defaultMintLedger } from './mint-ledger.js'
import { delegateConfigured } from './delegate-account.js'
import { releaseExpiredHolds } from './primary-sale.js'
import { expireClaims } from './claim.js'
import { advanceStuckSales, reportStuckSettling } from './listing-advance.js'
import { defaultPrimarySaleLedger } from './primary-sale-ledger.js'

// Before anything is served. A process serving another ledger's rows is worse
// than one that does not start: the failure is silent, and on mainnet it is
// silent and expensive. Exits on evidence of a mismatch; a database that cannot
// be reached is left to /api/health to report.
await assertDatabaseNetwork()

const app = createApp()

const server = app.listen(env.PORT, () => {
  console.log(`backend listening on http://localhost:${env.PORT} (${env.NODE_ENV})`)
})

// Realtime shares the HTTP server, so there is one port and the Vite proxy
// needs no extra target.
attachRealtime(server)

/**
 * Auction closer.
 *
 * An auction ends at a wall-clock time, not when someone happens to open the
 * page, so settlement cannot be driven by a request. This sweep is what actually
 * closes auctions.
 *
 * Guarded twice over. The in-process flag stops this instance overlapping
 * itself, since settlement waits on ledger validation and can outlast the
 * interval. The database lease stops TWO instances settling the same auction —
 * the loser would burn a transaction fee discovering the offers were already
 * consumed.
 */
const SWEEP_MS = 15_000
/**
 * Hygiene runs under one lease; settlement takes a lease PER AUCTION inside
 * `settleDueAuctions`.
 *
 * These jobs have opposite shapes. Payload reconciliation and cancellation are
 * short, global and pointless to duplicate, so one lease is right. Settlement is
 * a queue of independent items, and a single lease over the whole queue meant a
 * stall on one auction blocked every other auction in the system until the TTL
 * lapsed — and a second instance could never take a share of the work.
 */
const HYGIENE_LOCK = 'payload-hygiene'
/** Short: these are a handful of API calls, not ledger submissions. */
const HYGIENE_LOCK_TTL_MS = 60_000

let sweeping = false
const saleLedger = defaultPrimarySaleLedger()

const sweep = async () => {
  if (sweeping) return
  sweeping = true
  try {
    await withLock(HYGIENE_LOCK, HYGIENE_LOCK_TTL_MS, async () => {
      // Webhooks get lost — a deploy mid-flight, a blip, a bad URL. Without this
      // a real signature would sit unrecognised until it expired, which for a
      // mint or a bid means money stuck.
      const recovered = await reconcileStalePayloads()
      if (recovered > 0) console.log(`reconciled ${recovered} payload(s) with no webhook`)

      // Xaman caps OPEN payloads per application. Abandoned ones hold a slot
      // until cancelled, and once the cap is hit the account cannot create any
      // payload at all — sign-in breaks for everyone. Observed at 67.
      const freed = await cancelAbandonedPayloads()
      if (freed > 0) console.log(`cancelled ${freed} abandoned Xaman payload(s)`)
    })

    // Sales whose buyer has signed but is no longer watching. A sale only moved
    // when somebody's browser polled it; for a box-office purchase that left a
    // paid-for ticket in limbo whenever the tab closed.
    const advanced = await advanceStuckSales()
    if (advanced > 0) console.log(`advanced ${advanced} sale(s) nobody was watching`)

    // A sale that is still SETTLING after a quarter of an hour is not finishing by itself: say so, once.
    await reportStuckSettling()

    // Checkouts nobody finished: give the ticket back and take its offer off the
    // ledger. Idempotent, so two instances doing it together is harmless.
    const reclaimed = await releaseExpiredHolds(saleLedger)
    if (reclaimed > 0) console.log(`released ${reclaimed} abandoned checkout hold(s)`)

    // Claim offers nobody accepted: take them off the ledger so they stop holding the organizer's reserve.
    const lapsed = await expireClaims(saleLedger)
    if (lapsed > 0) console.log(`expired ${lapsed} unaccepted claim offer(s)`)

    // Not wrapped in a lease here: each auction takes its own, so an instance
    // that loses one simply moves to the next instead of skipping the sweep.
    const results = await settleDueAuctions()
    for (const { auctionId, outcome } of results ?? []) {
      if (outcome.kind === 'not-due') continue
      console.log(`auction ${auctionId.slice(0, 8)}: ${outcome.kind}`,
        outcome.kind === 'settled' ? `${outcome.amountDrops} drops, tx ${outcome.txHash.slice(0, 12)}` : '')
    }
  } catch (err) {
    // A sweep failure must never take the server down; the next one retries.
    console.error('auction sweep failed:', err)
  } finally {
    sweeping = false
  }
}

let timer: NodeJS.Timeout | null = null
if (brokerMode === 'live') {
  timer = setInterval(() => void sweep(), SWEEP_MS)
  // Do not hold the process open for the sake of the sweep.
  timer.unref()
} else {
  console.warn('Auction settlement disabled: no platform broker account configured.')
}

/**
 * Bulk-mint worker.
 *
 * Independent of the auction sweep on purpose: minting needs the delegate key,
 * not the broker, and a deployment can have one without the other. Each job
 * takes its own lease inside `runMintJob`, so two instances share the queue
 * rather than one starving the other, and a job left RUNNING by a dead process
 * is simply picked up again once its lease lapses.
 */
const MINT_SWEEP_MS = 10_000
let mintSweeping = false
const mintLedger = defaultMintLedger()

const mintSweep = async () => {
  if (mintSweeping) return
  mintSweeping = true
  try {
    await runDueMintJobs({ ledger: mintLedger })
  } catch (err) {
    // Must never take the server down; the next sweep retries.
    console.error('mint sweep failed:', err)
  } finally {
    mintSweeping = false
  }
}

let mintTimer: NodeJS.Timeout | null = null
if (delegateConfigured) {
  mintTimer = setInterval(() => void mintSweep(), MINT_SWEEP_MS)
  mintTimer.unref()
} else {
  console.warn('Bulk minting disabled: no DELEGATE_SEED configured.')
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (timer) clearInterval(timer)
    if (mintTimer) clearInterval(mintTimer)
    server.close(() => {
      void Promise.allSettled([closeRealtime(), disconnectLedger(), prisma.$disconnect()]).then(() =>
        process.exit(0),
      )
    })
  })
}
