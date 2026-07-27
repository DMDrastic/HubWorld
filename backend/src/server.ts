import { createApp } from './app.js'
import { env, brokerMode } from './env.js'
import { prisma } from './prisma.js'
import { disconnectLedger } from './ledger.js'
import { settleDueAuctions } from './settlement.js'
import { withLock } from './job-lock.js'
import { attachRealtime, closeRealtime } from './realtime.js'

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
/** Comfortably longer than a sweep; a crashed process only stalls this long. */
const SWEEP_LOCK_TTL_MS = 2 * 60_000
const SWEEP_LOCK = 'auction-sweep'

let sweeping = false

const sweep = async () => {
  if (sweeping) return
  sweeping = true
  try {
    const results = await withLock(SWEEP_LOCK, SWEEP_LOCK_TTL_MS, () => settleDueAuctions())
    // null means another process holds the lease — a skipped run, not a failure.
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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (timer) clearInterval(timer)
    server.close(() => {
      void Promise.allSettled([closeRealtime(), disconnectLedger(), prisma.$disconnect()]).then(() =>
        process.exit(0),
      )
    })
  })
}
