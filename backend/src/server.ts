import { createApp } from './app.js'
import { env, brokerMode } from './env.js'
import { prisma } from './prisma.js'
import { disconnectLedger } from './ledger.js'
import { settleDueAuctions } from './settlement.js'

const app = createApp()

const server = app.listen(env.PORT, () => {
  console.log(`backend listening on http://localhost:${env.PORT} (${env.NODE_ENV})`)
})

/**
 * Auction closer.
 *
 * An auction ends at a wall-clock time, not when someone happens to open the
 * page, so settlement cannot be driven by a request. This sweep is what actually
 * closes auctions.
 *
 * Single-process only: two instances running this would try to broker the same
 * auction twice. Before scaling out, this needs an advisory lock or a proper job
 * runner. Noted rather than pretended otherwise.
 */
const SWEEP_MS = 15_000
let sweeping = false

const sweep = async () => {
  // Overlap guard: settlement submits transactions and waits for validation,
  // which can easily outlast the interval.
  if (sweeping) return
  sweeping = true
  try {
    const results = await settleDueAuctions()
    for (const { auctionId, outcome } of results) {
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
      void Promise.allSettled([disconnectLedger(), prisma.$disconnect()]).then(() =>
        process.exit(0),
      )
    })
  })
}
