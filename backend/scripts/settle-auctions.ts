/**
 * Settle every auction whose close time has passed, on demand.
 *
 * The server sweeps automatically every 15s; this exists for running settlement
 * deliberately and seeing the outcome, which the sweep only logs.
 */
import { prisma } from '../src/prisma.js'
import { disconnectLedger } from '../src/ledger.js'
import { settleDueAuctions } from '../src/settlement.js'

async function main() {
  const results = await settleDueAuctions()
  if (results.length === 0) {
    console.log('No auctions are due.')
    return
  }
  for (const { auctionId, outcome } of results) {
    console.log(`auction ${auctionId.slice(0, 8)}: ${outcome.kind}`)
    if (outcome.kind === 'settled') {
      console.log(`  winner pays ${Number(outcome.amountDrops) / 1e6} XRP`)
      console.log(`  platform fee ${Number(outcome.feeDrops) / 1e6} XRP`)
      console.log(`  seller nets ${Number(outcome.amountDrops - outcome.feeDrops) / 1e6} XRP before royalty`)
      console.log(`  tx ${outcome.txHash}`)
    }
    if (outcome.kind === 'reserve-not-met') {
      console.log(`  top bid ${Number(outcome.topDrops) / 1e6} < reserve ${Number(outcome.reserveDrops) / 1e6} XRP`)
    }
    if (outcome.kind === 'no-sell-offer') {
      console.log('  the holder has no ACTIVE listing to broker against')
    }
    if (outcome.kind === 'failed') console.log(`  ${outcome.reason}`)
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await disconnectLedger()
    await prisma.$disconnect()
  })
