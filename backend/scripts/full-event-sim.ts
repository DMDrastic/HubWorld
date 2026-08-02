/**
 * SIMULATION: a whole event, minted and sold, end to end.
 *
 * The scale spike proved 1,000 tickets can be MINTED on one organizer
 * signature. That is only half a product — tickets nobody can buy are not
 * tickets. This runs the rest: mint the event, put every ticket up for sale
 * unattended, have buyers actually buy them, and see what the organizer's
 * signature count really is once distribution is included.
 *
 * It also answers the auction question properly. `auction-policy.ts` requires
 * `minted >= ticketCount` AND `organizerHolds === 0`, so an event only becomes
 * auctionable once the tickets have genuinely LEFT the organizer. Minting alone
 * never satisfies that; selling should.
 *
 * WHAT THIS EXPOSES ABOUT TRUST: unattended selling needs
 * `NFTokenCreateOffer` delegated as well as `NFTokenMint`, and those two are
 * not equally safe. Minting only creates value for the organizer. Offer
 * creation lets the delegate GIVE THE ORGANIZER'S TICKETS AWAY — measured: a
 * zero-price offer from the organizer's account to the delegate succeeds. Money
 * stays protected (a `Payment` is still refused), but inventory does not.
 *
 * Devnet only:
 *   XRPL_NETWORK=devnet npx tsx scripts/full-event-sim.ts --count 1000 --buyers 4
 */
import type { Wallet } from 'xrpl'
import { ledger, disconnectLedger, buildMintTx } from '../src/ledger.js'
import { asDelegatedMint, delegationAvailable } from '../src/delegation.js'
import { env } from '../src/env.js'

const TAXON = 70_020
const ROYALTY_BPS = 500
const PRICE_DROPS = '100000' // 0.1 XRP a ticket, so faucet buyers can afford a run

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : Number(process.argv[i + 1])
}

function head(s: string) {
  console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`)
}

async function currentSequence(address: string): Promise<number> {
  const client = await ledger()
  const r = await client.request({
    command: 'account_info',
    account: address,
    ledger_index: 'current',
  })
  return r.result.account_data.Sequence
}

/**
 * Submit `count` transactions against ONE account, paced.
 *
 * The sequence belongs to `account` even when somebody else signs — that is the
 * delegated case, and getting it from the signer instead produces terPRE_SEQ on
 * everything. Waves are confirmed by watching the sequence actually advance,
 * because rippled holds only a few future-sequence transactions per account and
 * silently drops the rest.
 */
async function paced(opts: {
  account: string
  signer: Wallet
  count: number
  wave: number
  label: string
  build: (i: number) => object
}): Promise<number> {
  const client = await ledger()
  const startSeq = await currentSequence(opts.account)
  const started = Date.now()
  let sent = 0
  let stalled = 0

  while (sent < opts.count) {
    const size = Math.min(opts.wave, opts.count - sent)
    const ledgerNow = await client.getLedgerIndex()
    const blobs: string[] = []
    for (let i = 0; i < size; i++) {
      blobs.push(
        opts.signer.sign({
          ...opts.build(sent + i),
          Sequence: startSeq + sent + i,
          Fee: '20',
          LastLedgerSequence: ledgerNow + 20,
        } as never).tx_blob,
      )
    }
    await Promise.all(
      blobs.map((b) =>
        client.request({ command: 'submit', tx_blob: b } as never).catch(() => null),
      ),
    )

    const target = startSeq + sent + size
    let ok = false
    for (let poll = 0; poll < 20; poll++) {
      if ((await currentSequence(opts.account)) >= target) {
        ok = true
        break
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (!ok) {
      // Resume from where the ledger really got to — one dropped transaction
      // blocks every later sequence on this account permanently.
      sent = (await currentSequence(opts.account)) - startSeq
      if (++stalled > 5) {
        console.log(`  ${opts.label}: aborting after 5 consecutive stalls at ${sent}/${opts.count}`)
        break
      }
      continue
    }
    stalled = 0
    sent += size
    if (sent % 250 === 0 || sent === opts.count) {
      const secs = (Date.now() - started) / 1000
      console.log(`  ${opts.label}: ${sent}/${opts.count} — ${secs.toFixed(0)}s (${(sent / secs).toFixed(1)}/s)`)
    }
  }
  return sent
}

/**
 * Wait for the VALIDATED ledger to catch up with what we just submitted.
 *
 * Submission is paced against the `current` ledger, which runs ahead of
 * `validated` by a few closes. Reading validated immediately after a burst
 * reports zero and looks like total failure when nothing is wrong at all.
 */
async function settle<T>(read: () => Promise<T[]>, want: number, label: string): Promise<T[]> {
  let last: T[] = []
  for (let i = 0; i < 30; i++) {
    last = await read()
    if (last.length >= want) return last
    await new Promise((r) => setTimeout(r, 2000))
  }
  console.log(`  ${label}: settled at ${last.length}/${want}`)
  return last
}

async function allNftIds(address: string): Promise<string[]> {
  const client = await ledger()
  const ids: string[] = []
  let marker: unknown
  do {
    const res = await client.request({
      command: 'account_nfts',
      account: address,
      ledger_index: 'validated',
      limit: 400,
      ...(marker ? { marker } : {}),
    } as never)
    for (const n of res.result.account_nfts) ids.push(n.NFTokenID)
    marker = (res.result as { marker?: unknown }).marker
  } while (marker)
  return ids
}

/**
 * Sell offers the organizer owns, with their ledger index and destination.
 *
 * Paged WITHOUT a `type` filter and filtered client-side. With
 * `type: 'nft_offer'` the marker walk returned only 454 of 1,000 offers and
 * then stopped — the limit applies to objects scanned rather than matched, so a
 * filtered page can end early and the marker never covers the rest. Reading the
 * whole owner directory and filtering here is slower and correct.
 */
async function sellOffers(address: string) {
  const client = await ledger()
  const out: Array<{ index: string; dest?: string }> = []
  let marker: unknown
  do {
    const res = await client.request({
      command: 'account_objects',
      account: address,
      ledger_index: 'validated',
      limit: 400,
      ...(marker ? { marker } : {}),
    } as never)
    for (const o of res.result.account_objects as Array<Record<string, unknown>>) {
      if (o.LedgerEntryType !== 'NFTokenOffer') continue
      out.push({ index: String(o.index), dest: o.Destination as string | undefined })
    }
    marker = (res.result as { marker?: unknown }).marker
  } while (marker)
  return out
}

async function main() {
  if (env.XRPL_NETWORK !== 'devnet') {
    console.error(`XRPL_NETWORK is "${env.XRPL_NETWORK}"; delegation is devnet-only.`)
    process.exit(1)
  }
  const COUNT = arg('count', 1000)
  const BUYERS = arg('buyers', 4)
  const WAVE = arg('wave', 10)

  const client = await ledger()
  if (!(await delegationAvailable())) {
    console.error('delegationAvailable() is false')
    await disconnectLedger()
    return
  }

  head(`Full event: ${COUNT} tickets, minted and sold`)
  const { wallet: organizer } = await client.fundWallet()
  const { wallet: platform } = await client.fundWallet()
  const buyers: Wallet[] = []
  for (let i = 0; i < BUYERS; i++) buyers.push((await client.fundWallet()).wallet)
  console.log(`  organizer: ${organizer.classicAddress}`)
  console.log(`  platform : ${platform.classicAddress}`)
  console.log(`  buyers   : ${BUYERS}`)

  const t0 = Date.now()

  head('1. The organizer signs ONCE — granting mint AND offer-creation')
  const grant = await client.autofill({
    TransactionType: 'DelegateSet',
    Account: organizer.classicAddress,
    Authorize: platform.classicAddress,
    Permissions: [
      { Permission: { PermissionValue: 'NFTokenMint' } },
      // Required for unattended SELLING. Strictly more dangerous than minting:
      // it lets the delegate give the organizer's tickets away.
      { Permission: { PermissionValue: 'NFTokenCreateOffer' } },
    ],
  } as never)
  await client.submitAndWait(organizer.sign(grant).tx_blob)
  console.log('  granted. The organizer does not sign again for the rest of this run.')

  head('2. Platform mints the event, unattended')
  const minted = await paced({
    account: organizer.classicAddress,
    signer: platform,
    count: COUNT,
    wave: WAVE,
    label: 'mint',
    build: (i) =>
      asDelegatedMint(
        buildMintTx({
          issuerAddress: organizer.classicAddress,
          taxon: TAXON,
          royaltyBps: ROYALTY_BPS,
          uri: `ipfs://hubworld-sim/${i}`,
        }),
        platform.classicAddress,
      ),
  })
  const ids = await settle(() => allNftIds(organizer.classicAddress), minted, 'mint')
  console.log(`  minted ${minted}, on-ledger ${ids.length}`)

  head('3. Platform puts every ticket up for sale, unattended')
  const offered = await paced({
    account: organizer.classicAddress,
    signer: platform,
    count: ids.length,
    wave: WAVE,
    label: 'offer',
    build: (i) => ({
      TransactionType: 'NFTokenCreateOffer',
      Account: organizer.classicAddress,
      Delegate: platform.classicAddress,
      NFTokenID: ids[i],
      Amount: PRICE_DROPS,
      // Reserved for one buyer, so accepts cannot race each other.
      Destination: buyers[i % buyers.length]!.classicAddress,
      Flags: 1,
    }),
  })
  console.log(`  offers created: ${offered}`)

  head('4. Buyers buy — each signs for their own tickets')
  const offers = await settle(() => sellOffers(organizer.classicAddress), offered, 'offers')
  console.log(`  sell offers on-ledger: ${offers.length}`)
  let bought = 0
  for (const buyer of buyers) {
    const mine = offers.filter((o) => o.dest === buyer.classicAddress)
    if (mine.length === 0) continue
    bought += await paced({
      account: buyer.classicAddress,
      signer: buyer,
      count: mine.length,
      wave: WAVE,
      label: `buy(${buyer.classicAddress.slice(0, 6)})`,
      build: (i) => ({
        TransactionType: 'NFTokenAcceptOffer',
        Account: buyer.classicAddress,
        NFTokenSellOffer: mine[i]!.index,
      }),
    })
  }

  head('RESULTS')
  await new Promise((r) => setTimeout(r, 5000)) // let the last accepts validate
  const held = await allNftIds(organizer.classicAddress)
  const totalSecs = (Date.now() - t0) / 1000
  let inWallets = 0
  for (const b of buyers) inWallets += (await allNftIds(b.classicAddress)).length

  console.log(`  tickets minted        : ${ids.length}`)
  console.log(`  tickets sold          : ${bought}`)
  console.log(`  now in buyer wallets  : ${inWallets}`)
  console.log(`  still held by organizer: ${held.length}`)
  console.log(`  wall time             : ${(totalSecs / 60).toFixed(1)} min`)
  console.log('')
  console.log(`  ORGANIZER SIGNATURES  : 1  (the grant, and nothing else)`)
  console.log(`  platform signatures   : ${ids.length + offered}  (mints + offers, all unattended)`)
  console.log(`  buyer signatures      : ${bought}  (one per ticket, spread across buyers)`)

  head('Is the event auctionable NOW?')
  console.log(`  soldOut = minted >= ticketCount AND organizerHolds === 0`)
  console.log(`    minted           : ${ids.length} of ${COUNT}`)
  console.log(`    organizer holds  : ${held.length}`)
  console.log(
    held.length === 0 && ids.length >= COUNT
      ? '  >> SOLD OUT. The secondary market opens: auctions become available.'
      : `  >> not yet — ${held.length} tickets still with the organizer.`,
  )

  await disconnectLedger()
}

main().catch(async (e) => {
  console.error('SIM FAILED:', e)
  await disconnectLedger()
  process.exit(1)
})
