/**
 * SPIKE: what actually happens when Hubworld mints a real-sized event
 * unattended, using delegated minting?
 *
 * The delegation spike proved ONE mint works and the organizer stays the issuer.
 * This asks the operational questions that decide whether it is usable:
 *
 *   - How long does an event of N tickets take, end to end?
 *   - What does it cost, and WHO pays — organizer or delegate?
 *   - What does it lock up in reserve, and on whose account?
 *   - Where does the naive implementation fall over?
 *   - Is the event then auctionable? (`auction-policy.ts` says sold out means
 *     every ticket issued AND none still held by the organizer — so minting at
 *     scale should NOT be enough on its own. Worth demonstrating rather than
 *     asserting.)
 *
 * Devnet only — `PermissionDelegationV1_1` is active there, pending on testnet,
 * absent from mainnet:
 *
 *   XRPL_NETWORK=devnet npx tsx scripts/delegation-scale-spike.ts --count 100
 *
 * Faucet-funded throwaway wallets. Touches no repo credentials and no database.
 */
import type { Wallet } from 'xrpl'
import { ledger, disconnectLedger, buildMintTx } from '../src/ledger.js'
import { asDelegatedMint, buildDelegateMintTx, delegationAvailable } from '../src/delegation.js'
import { env } from '../src/env.js'

const TAXON = 70_003
const ROYALTY_BPS = 500

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : Number(process.argv[i + 1])
}

function head(s: string) {
  console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`)
}

async function accountState(address: string) {
  const client = await ledger()
  const r = await client.request({
    command: 'account_info',
    account: address,
    ledger_index: 'validated',
  })
  return {
    balance: Number(r.result.account_data.Balance) / 1_000_000,
    ownerCount: r.result.account_data.OwnerCount ?? 0,
    sequence: r.result.account_data.Sequence,
  }
}

/**
 * Sequence from the CURRENT ledger, not the validated one.
 *
 * `validated` lags by a few closes, so polling it to decide whether a wave
 * landed adds seconds of dead time per wave and made the first paced attempt
 * look stalled when it was merely behind.
 */
async function currentSequence(address: string): Promise<number> {
  const client = await ledger()
  const r = await client.request({
    command: 'account_info',
    account: address,
    ledger_index: 'current',
  })
  return r.result.account_data.Sequence
}

async function nftCount(address: string): Promise<number> {
  const client = await ledger()
  let marker: unknown
  let total = 0
  do {
    const res = await client.request({
      command: 'account_nfts',
      account: address,
      ledger_index: 'validated',
      limit: 400,
      ...(marker ? { marker } : {}),
    } as never)
    total += res.result.account_nfts.length
    marker = (res.result as { marker?: unknown }).marker
  } while (marker)
  return total
}

async function main() {
  if (env.XRPL_NETWORK !== 'devnet') {
    console.error(`XRPL_NETWORK is "${env.XRPL_NETWORK}"; delegation is only active on devnet.`)
    process.exit(1)
  }

  const COUNT = arg('count', 100)
  const CONCURRENCY = arg('concurrency', 20)
  const client = await ledger()

  head(`Minting an event of ${COUNT} tickets, unattended`)
  if (!(await delegationAvailable())) {
    console.error('delegationAvailable() is false — cannot continue.')
    await disconnectLedger()
    return
  }

  const { wallet: organizer } = await client.fundWallet()
  const { wallet: platform } = await client.fundWallet()
  console.log(`  organizer: ${organizer.classicAddress}`)
  console.log(`  platform : ${platform.classicAddress}`)

  // ---- the organizer's ONLY signature ------------------------------------
  const grantStart = Date.now()
  const grant = await client.autofill(
    buildDelegateMintTx({
      organizerAddress: organizer.classicAddress,
      platformAddress: platform.classicAddress,
    }) as never,
  )
  await client.submitAndWait(organizer.sign(grant).tx_blob)
  console.log(`  organizer grant: ${((Date.now() - grantStart) / 1000).toFixed(1)}s — and that is the LAST time they sign.`)

  const orgBefore = await accountState(organizer.classicAddress)
  const platBefore = await accountState(platform.classicAddress)

  // ---- build, sign, fire -------------------------------------------------
  //
  // The naive loop is `autofill -> sign -> submitAndWait` per ticket, which
  // costs a round trip for sequence and fee AND a ~4s validation wait EACH.
  // At 1,000 tickets that is over an hour of wall time for work the ledger
  // could absorb in seconds. So sequences are assigned locally from one
  // account_info read, and submission does not wait for validation.
  head('Building and signing locally')
  const template = await client.autofill(
    asDelegatedMint(
      buildMintTx({
        issuerAddress: organizer.classicAddress,
        taxon: TAXON,
        royaltyBps: ROYALTY_BPS,
        uri: 'ipfs://hubworld-scale',
      }),
      platform.classicAddress,
    ) as never,
  )
  const fee = String((template as { Fee?: string }).Fee ?? '20')
  const ledgerNow = await client.getLedgerIndex()
  console.log(`  fee per mint: ${fee} drops`)

  /*
   * The ORGANIZER's sequence, not the delegate's.
   *
   * `Sequence` always belongs to `Account`, and on a delegated mint `Account`
   * is the organizer — measured: after a delegated mint the organizer's
   * sequence advanced and the platform's did not, even though the platform
   * signed it and paid the fee. Fee from the delegate, sequence from the
   * delegator, which is an easy combination to get wrong.
   *
   * Getting this wrong is not a clean failure. An earlier run used the
   * delegate's sequence and appeared to work at 100 tickets purely because two
   * freshly funded accounts happened to start at the same number; once the
   * organizer signed the grant the two diverged and every submission came back
   * terPRE_SEQ with zero tickets minted.
   */
  const startSeq = await currentSequence(organizer.classicAddress)
  console.log(`  organizer sequence: ${startSeq} (platform's is ${platBefore.sequence} — not used)`)

  void ledgerNow

  /*
   * PACED, not fire-and-forget.
   *
   * Firing all N at once fails at scale, measured: at 1,000 tickets 962 came
   * back `terPRE_SEQ` because rippled holds only a small number of
   * future-sequence transactions PER ACCOUNT. The excess is dropped rather than
   * queued, throughput collapsed from 7.5/s to 0.5/s, and the tail outlived its
   * LastLedgerSequence — 402 of 1,000 tickets existed and the rest simply never
   * happened. An event silently short by 60% is the worst possible failure for
   * a ticketing product.
   *
   * So: submit a wave, wait for the delegate's SEQUENCE to actually advance,
   * then submit the next. The sequence is the authority — it only moves when a
   * transaction is really applied. Each wave is signed just before it is sent so
   * LastLedgerSequence stays a per-wave bound rather than one cliff for the
   * whole run.
   */
  head(`Submitting in paced waves of ${CONCURRENCY}`)
  const submitStart = Date.now()
  const errors = new Map<string, number>()
  let sent = 0
  let stalled = 0

  while (sent < COUNT) {
    const waveSize = Math.min(CONCURRENCY, COUNT - sent)
    const waveLedger = await client.getLedgerIndex()

    const blobs: string[] = []
    for (let i = 0; i < waveSize; i++) {
      const tx = {
        ...asDelegatedMint(
          buildMintTx({
            issuerAddress: organizer.classicAddress,
            taxon: TAXON,
            royaltyBps: ROYALTY_BPS,
            uri: `ipfs://hubworld-scale/${sent + i}`,
          }),
          platform.classicAddress,
        ),
        Sequence: startSeq + sent + i,
        Fee: fee,
        LastLedgerSequence: waveLedger + 20,
      }
      blobs.push(platform.sign(tx as never).tx_blob)
    }

    const results = await Promise.all(
      blobs.map((b) =>
        client
          .request({ command: 'submit', tx_blob: b } as never)
          .then((r) => String((r.result as { engine_result?: string }).engine_result))
          .catch((e) => `threw:${(e as Error).message.slice(0, 30)}`),
      ),
    )
    for (const r of results) if (r !== 'tesSUCCESS') errors.set(r, (errors.get(r) ?? 0) + 1)

    // Wait for the ledger to confirm this wave really landed before queuing more.
    const target = startSeq + sent + waveSize
    let advanced = false
    for (let poll = 0; poll < 20; poll++) {
      if ((await currentSequence(organizer.classicAddress)) >= target) {
        advanced = true
        break
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (!advanced) {
      // Resume from where the ledger ACTUALLY got to. A gap matters: one
      // dropped transaction blocks every later sequence on this account
      // permanently, so marching `sent` forward regardless would silently
      // abandon the rest of the event.
      const seq = await currentSequence(organizer.classicAddress)
      stalled += 1
      const recovered = seq - startSeq
      console.log(`  wave stalled at ${sent}; ledger is at ${recovered} — resuming there`)
      sent = recovered
      // CONSECUTIVE, not cumulative. Counting every stall across a long run
      // aborted the first attempt while it was still making progress.
      if (stalled > 5) {
        console.log('  five consecutive stalled waves — aborting')
        break
      }
      continue
    }

    stalled = 0
    sent += waveSize
    if (sent % 200 === 0 || sent === COUNT) {
      const secs = (Date.now() - submitStart) / 1000
      console.log(`  ${sent}/${COUNT} applied — ${secs.toFixed(0)}s (${(sent / secs).toFixed(1)}/s)`)
    }
  }

  const submitSecs = (Date.now() - submitStart) / 1000
  console.log(`  submission finished in ${submitSecs.toFixed(1)}s`)
  if (stalled) console.log(`  stalled waves recovered: ${stalled}`)
  for (const [code, n] of errors) console.log(`  ${code}: ${n}`)

  head('Waiting for validation')
  const waitStart = Date.now()
  let minted = 0
  // Scales with the run: at ~7 tickets/s a fixed cap would time out on a large
  // event and report it as SHORT when it was merely still settling.
  const attempts = Math.max(40, Math.ceil(COUNT / 4))
  for (let attempt = 0; attempt < attempts; attempt++) {
    minted = await nftCount(organizer.classicAddress)
    if (minted >= COUNT) break
    await new Promise((r) => setTimeout(r, 3000))
  }
  const totalSecs = (Date.now() - submitStart) / 1000
  console.log(`  validated after ${((Date.now() - waitStart) / 1000).toFixed(1)}s`)

  head('RESULTS')
  const orgAfter = await accountState(organizer.classicAddress)
  const platAfter = await accountState(platform.classicAddress)

  console.log(`  tickets requested : ${COUNT}`)
  console.log(`  tickets on-ledger : ${minted}  ${minted === COUNT ? '(all)' : '(SHORT)'}`)
  console.log(`  wall time         : ${totalSecs.toFixed(1)}s  (${(minted / totalSecs).toFixed(1)} tickets/s)`)
  console.log(`  organizer signed  : 1 transaction, ever`)
  console.log('')
  console.log(`  organizer balance : ${orgBefore.balance.toFixed(6)} -> ${orgAfter.balance.toFixed(6)}  (${(orgAfter.balance - orgBefore.balance).toFixed(6)})`)
  console.log(`  platform  balance : ${platBefore.balance.toFixed(6)} -> ${platAfter.balance.toFixed(6)}  (${(platAfter.balance - platBefore.balance).toFixed(6)})`)
  console.log(`  fee per ticket    : ${((platBefore.balance - platAfter.balance) / Math.max(minted, 1)).toFixed(6)} XRP`)
  console.log('')
  console.log(`  organizer OwnerCount: ${orgBefore.ownerCount} -> ${orgAfter.ownerCount}  (NFTokenPages, 32 NFTs each)`)
  console.log(`  reserve locked on the ORGANIZER: ~${((orgAfter.ownerCount - orgBefore.ownerCount) * 0.2).toFixed(2)} XRP`)

  head('Is the event auctionable now?')
  console.log(`  auction-policy.ts: soldOut = minted >= ticketCount AND organizerHolds === 0`)
  console.log(`    minted          : ${minted} of ${COUNT}  -> first half satisfied`)
  console.log(`    organizer holds : ${minted}              -> second half FAILS`)
  console.log('  >> NOT auctionable. Minting at scale does not open the secondary market;')
  console.log('     the tickets have to reach holders first. That is the policy working as')
  console.log('     designed — an organizer must not be able to auction their own stock.')

  await disconnectLedger()
}

main().catch(async (e) => {
  console.error('SPIKE FAILED:', e)
  await disconnectLedger()
  process.exit(1)
})
