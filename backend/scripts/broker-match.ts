/**
 * Dev tool: broker two specific offers and report exactly where the money went.
 *
 * Written to answer a question that must not be guessed: when a buy offer exceeds
 * the sell offer plus the broker fee, **who receives the surplus?** That decides
 * whether an auction winner's excess bid reaches the seller or is absorbed
 * elsewhere, so it is measured rather than assumed.
 *
 *   npm run broker:match -- --sell <offerIndex> --buy <offerIndex> [--fee <drops>]
 *
 * Dev-only: it submits a real brokered settlement with Hubworld's key.
 */
import { prisma } from '../src/prisma.js'
import { env } from '../src/env.js'
import { brokerSale, disconnectLedger, ledger, platformAddress } from '../src/ledger.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function balances(addresses: string[]): Promise<Map<string, bigint>> {
  const c = await ledger()
  const out = new Map<string, bigint>()
  for (const a of addresses) {
    try {
      const r = await c.request({ command: 'account_info', account: a, ledger_index: 'validated' })
      out.set(a, BigInt(r.result.account_data.Balance))
    } catch {
      out.set(a, 0n)
    }
  }
  return out
}

async function main() {
  if (env.NODE_ENV === 'production') {
    console.error('Refusing to run in production.')
    process.exit(1)
  }

  const sell = arg('sell')
  const buy = arg('buy')
  if (!sell || !buy) {
    console.error('Usage: --sell <offerIndex> --buy <offerIndex> [--fee <drops>]')
    process.exit(1)
  }
  const fee = BigInt(arg('fee') ?? '0')

  // Label every account we know about, so the balance deltas are readable.
  const users = await prisma.user.findMany({ select: { username: true, xrplAddress: true } })
  const labels = new Map(users.map((u) => [u.xrplAddress, `@${u.username}`]))
  labels.set(platformAddress(), 'HubWorld (broker)')

  const watched = [...labels.keys()]
  const before = await balances(watched)

  const c = await ledger()
  // Read both offers first: the amounts are the whole point of the comparison.
  const readOffer = async (index: string) => {
    try {
      const r = await c.request({ command: 'ledger_entry', index, ledger_index: 'validated' })
      const node = r.result.node as unknown as Record<string, unknown> | undefined
      return node ? { amount: String(node.Amount), owner: String(node.Owner), flags: Number(node.Flags ?? 0) } : null
    } catch {
      return null
    }
  }
  const sellOffer = await readOffer(sell)
  const buyOffer = await readOffer(buy)

  console.log('offers before settlement:')
  console.log(`  sell  ${sellOffer?.amount ?? '?'} drops  owner ${labels.get(sellOffer?.owner ?? '') ?? sellOffer?.owner}`)
  console.log(`  buy   ${buyOffer?.amount ?? '?'} drops  owner ${labels.get(buyOffer?.owner ?? '') ?? buyOffer?.owner}`)
  console.log(`  broker fee requested: ${fee} drops`)
  if (sellOffer && buyOffer) {
    const surplus = BigInt(buyOffer.amount) - BigInt(sellOffer.amount) - fee
    console.log(`  surplus (buy - sell - fee): ${surplus} drops = ${Number(surplus) / 1e6} XRP`)
  }
  console.log()

  const result = await brokerSale({
    sellOfferIndex: sell,
    buyOfferIndex: buy,
    brokerFeeDrops: fee,
  })

  console.log(`settlement: ${result.result} (${result.succeeded ? 'succeeded' : 'FAILED'})`)
  console.log(`  tx ${result.hash}`)
  if (!result.succeeded) {
    console.log('\nNothing moved. The most likely causes are buy < sell + fee, or a spent balance.')
    return
  }

  const after = await balances(watched)
  console.log('\nbalance changes:')
  const rows = watched
    .map((a) => ({ label: labels.get(a) ?? a, delta: (after.get(a) ?? 0n) - (before.get(a) ?? 0n) }))
    .filter((r) => r.delta !== 0n)
    .sort((x, y) => (y.delta > x.delta ? 1 : -1))
  for (const r of rows) {
    console.log(`  ${r.label.padEnd(22)} ${r.delta > 0n ? '+' : ''}${r.delta} drops  (${Number(r.delta) / 1e6} XRP)`)
  }
  console.log('\nCompare the seller line against the sell-offer amount: if it exceeds it,')
  console.log('the surplus flows to the seller; if it matches, the surplus went elsewhere.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    // The XRPL websocket keeps the event loop alive; without closing it the
    // script never exits and its output is never flushed.
    await disconnectLedger()
    await prisma.$disconnect()
  })
