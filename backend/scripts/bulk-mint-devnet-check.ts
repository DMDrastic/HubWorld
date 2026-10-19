/**
 * Runs the SHIPPED bulk-mint worker against a real ledger.
 *
 * The worker's unit tests use a fake ledger, which is the only way to make a
 * ledger drop transactions on demand — but a fake cannot prove the real calls
 * (`fee`, `ledger`, `tx` lookups, `getNFTokenID`) or the sequence rules the
 * worker depends on. This does, with faucet-funded throwaway wallets and a
 * throwaway organizer + event written to the database you point it at.
 *
 *   DOTENV_CONFIG_PATH=/nonexistent XRPL_NETWORK=devnet \
 *   DATABASE_URL=<local test db> DELEGATE_SEED=<a seed you generated> \
 *     npx tsx scripts/bulk-mint-devnet-check.ts --count 100
 *
 * DELEGATE_SEED must be the seed of a devnet account this script is allowed to
 * fund from the faucet; it is read from the environment (never printed) so the
 * app's own `delegateWallet()` is what signs, exactly as in production. Devnet
 * and testnet only: it refuses mainnet, and it refuses a remote database.
 */
import { Wallet } from 'xrpl'
import { prisma } from '../src/prisma.js'
import { NETWORK } from '../src/network.js'
import { env } from '../src/env.js'
import { assertSafeDatabase } from '../src/db-guard.js'
import { ledger, delegateWallet, disconnectLedger } from '../src/ledger.js'
import { buildDelegateMintTx, readPermissionOnLedger, delegationAvailableOnLedger, MINT_PERMISSION } from '../src/delegation.js'
import { realMintLedger } from '../src/mint-ledger.js'
import { runMintJob } from '../src/bulk-mint.js'

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : Number(process.argv[i + 1])
}

const head = (s: string) => console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`)

async function main() {
  if (env.XRPL_NETWORK === 'mainnet') {
    console.error('This check mints throwaway tickets. It is for devnet/testnet only.')
    process.exit(1)
  }
  if (!env.DELEGATE_SEED) {
    console.error('Set DELEGATE_SEED to the seed of a devnet account (see the header).')
    process.exit(1)
  }
  assertSafeDatabase('bulk-mint-devnet-check')

  const count = arg('count', 100)
  const client = await ledger()

  head('0. Is delegation usable on this ledger?')
  if (!(await delegationAvailableOnLedger())) {
    console.error('  PermissionDelegationV1_1 is not enabled here.')
    await disconnectLedger()
    return
  }

  head('1. Wallets')
  const delegate = delegateWallet()
  await client.fundWallet(delegate) // top the delegate up from the faucet
  const { wallet: organizer } = await client.fundWallet()
  console.log(`  organizer: ${organizer.classicAddress}`)
  console.log(`  delegate : ${delegate.classicAddress}`)

  head('2. The organizer grants NFTokenMint — their only signature')
  const grant = await client.autofill(
    buildDelegateMintTx({ organizerAddress: organizer.classicAddress, delegateAddress: delegate.classicAddress }) as never,
  )
  await client.submitAndWait(organizer.sign(grant).tx_blob)
  const granted = await readPermissionOnLedger(
    { organizerAddress: organizer.classicAddress, delegateAddress: delegate.classicAddress },
    MINT_PERMISSION,
  )
  console.log(`  permission on ledger: ${granted}`)
  if (granted !== 'granted') throw new Error('grant not visible')

  head(`3. Create a throwaway event and a run of ${count} tickets`)
  const tag = Math.random().toString(36).slice(2, 8)
  const user = await prisma.user.create({
    data: { username: `bmd_${tag}`, xrplAddress: organizer.classicAddress, role: 'ORGANIZER' },
  })
  const event = await prisma.event.create({
    data: {
      network: NETWORK,
      slug: `bmd-${tag}`,
      title: 'Bulk Mint Devnet Check',
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: user.id,
      nftTaxon: 73_000 + Math.floor(Math.random() * 900),
      royaltyBps: 500,
      platformBps: 250,
      ticketCount: count,
      status: 'PUBLISHED',
    },
  })
  const job = await prisma.mintJob.create({
    data: {
      network: NETWORK,
      eventId: event.id,
      organizerId: user.id,
      organizerAddress: organizer.classicAddress,
      delegateAddress: delegate.classicAddress,
      total: count,
    },
  })

  head('4. Run the worker')
  const started = Date.now()
  // The worker yields after its time slice, exactly as it does under the sweep;
  // keep calling it until the job stops needing us.
  for (let pass = 1; pass <= 50; pass++) {
    await runMintJob(job.id, { ledger: realMintLedger() })
    const j = await prisma.mintJob.findUniqueOrThrow({ where: { id: job.id } })
    console.log(`  pass ${pass}: ${j.status}  ${j.minted}/${j.total}  failedTxs=${j.failedTxs}${j.statusReason ? `  (${j.statusReason})` : ''}`)
    if (j.status !== 'RUNNING' && j.status !== 'QUEUED') break
    if (j.nextAttemptAt && j.nextAttemptAt.getTime() > Date.now()) {
      await new Promise((r) => setTimeout(r, Math.min(15_000, j.nextAttemptAt!.getTime() - Date.now())))
      await prisma.mintJob.update({ where: { id: job.id }, data: { nextAttemptAt: null } })
    }
  }
  const secs = (Date.now() - started) / 1000

  head('5. RESULTS')
  const done = await prisma.mintJob.findUniqueOrThrow({ where: { id: job.id } })
  const recorded = await prisma.ticket.count({ where: { eventId: event.id } })
  let onLedger = 0
  let marker: unknown
  let issuers = new Set<string>()
  do {
    const r = (await client.request({
      command: 'account_nfts',
      account: organizer.classicAddress,
      ledger_index: 'validated',
      limit: 400,
      ...(marker ? { marker } : {}),
    } as never)) as unknown as {
      result: { account_nfts: Array<{ Issuer?: string; NFTokenTaxon: number }>; marker?: unknown }
    }
    for (const n of r.result.account_nfts) {
      if (n.NFTokenTaxon === event.nftTaxon) {
        onLedger++
        issuers.add(n.Issuer ?? '')
      }
    }
    marker = r.result.marker
  } while (marker)

  const delegateAfter = Number((await client.request({ command: 'account_info', account: delegate.classicAddress, ledger_index: 'validated' })).result.account_data.Balance)
  console.log(`  job status        : ${done.status}`)
  console.log(`  requested         : ${count}`)
  console.log(`  recorded in DB    : ${recorded}   job.minted=${done.minted}`)
  console.log(`  on the ledger     : ${onLedger}   ${onLedger === count && recorded === count ? '(all, and they agree)' : '(MISMATCH)'}`)
  console.log(`  issuer(s)         : ${[...issuers].join(', ') || '(none)'}  ${issuers.size === 1 && issuers.has(organizer.classicAddress) ? '>> the ORGANIZER' : '>> NOT only the organizer'}`)
  console.log(`  wall time         : ${secs.toFixed(1)}s  (${(recorded / secs).toFixed(1)} tickets/s)`)
  console.log(`  failed txs        : ${done.failedTxs}`)
  console.log(`  delegate balance  : ${(delegateAfter / 1e6).toFixed(6)} XRP after`)

  head('6. Clean up the database rows (the tickets stay on devnet)')
  await prisma.transfer.deleteMany({ where: { ticket: { eventId: event.id } } })
  await prisma.ticket.deleteMany({ where: { eventId: event.id } })
  await prisma.mintJob.deleteMany({ where: { eventId: event.id } })
  await prisma.event.delete({ where: { id: event.id } })
  await prisma.user.delete({ where: { id: user.id } })
}

main()
  .catch((e) => {
    console.error('CHECK FAILED:', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    await disconnectLedger()
  })
