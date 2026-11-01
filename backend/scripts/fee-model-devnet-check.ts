/**
 * Runs the NEW fee model against a real ledger, through the shipped code, before FEE_MODEL=v2 is switched on anywhere.
 *
 * Unit tests fake the ledger, which is how they can pin every rule; they cannot show that the real ledger agrees with the
 * arithmetic. This does the whole chain with faucet-funded throwaway accounts and a throwaway event:
 *
 *   1. a ticket the database says someone holds is CLAIMED: the delegate makes the free, expiring, holder-only offer
 *      (`startClaim`), a stranger is refused when they try to take it, and the holder accepts it;
 *   2. that holder RESELLS it under the new terms: the buyer pays exactly the price, the seller pays the 5%, and the
 *      organizer's royalty lands (`resaleListingTerms`, then `advanceListing` drives the broker match);
 *   3. an AUCTION on a second claimed ticket settles at its frozen 5% (`settleAuction`);
 *   4. a claim nobody accepts is CANCELLED once it lapses (`expireClaims`), by the broker, which is neither the offer's
 *      creator nor its destination: the one rule here that is a claim about the ledger rather than about our code.
 *
 * What it does NOT run: the HTTP routes. In stub mode the app's ledger helpers answer from memory, so to reach the real
 * ledger the script supplies throwaway Xaman credentials (to select the real helpers) and records each signature as an
 * already-resolved payload, which is what a resolved poll would have read. Nothing calls Xaman. The route wiring is pinned
 * by `listing-v2.routes.test.ts` and `auction-open-v2.routes.test.ts` against a database.
 *
 *   DOTENV_CONFIG_PATH=/nonexistent XRPL_NETWORK=devnet FEE_MODEL=v2 XRP_USD_CENTS=134 \
 *   XAMAN_API_KEY=throwaway XAMAN_API_SECRET=throwaway \
 *   DATABASE_URL=<local test db> DELEGATE_SEED=<seed> PLATFORM_SEED=<other seed> \
 *     npx tsx scripts/fee-model-devnet-check.ts
 *
 * Takes about 13 minutes, because the last step waits out a real offer expiry. Devnet/testnet only; refuses mainnet and a
 * remote database.
 */
import { randomUUID } from 'node:crypto'
import { getNFTokenID, rippleTimeToUnixTime, Wallet, type Transaction } from 'xrpl'
import { prisma } from '../src/prisma.js'
import { NETWORK } from '../src/network.js'
import { env } from '../src/env.js'
import { assertSafeDatabase } from '../src/db-guard.js'
import {
  auctionSellAmountDrops,
  buildAcceptOfferTx,
  buildBuyOfferTx,
  buildMintTx,
  buildSellOfferTx,
  delegateWallet,
  disconnectLedger,
  ledger,
  platformWallet,
} from '../src/ledger.js'
import { buildDelegateSetTx, delegationAvailableOnLedger, MINT_PERMISSION, OFFER_PERMISSION } from '../src/delegation.js'
import { ticketMetadataUri } from '../src/nft-metadata.js'
import { startClaim, completeClaim, expireClaims } from '../src/claim.js'
import { CLAIM_GRACE_MS } from '../src/claim-policy.js'
import { realPrimarySaleLedger } from '../src/primary-sale-ledger.js'
import { buyerPaysDrops, configuredMinimumResaleDrops, resaleListingTerms } from '../src/listing-terms.js'
import { advanceListing, advanceStuckSales } from '../src/listing-advance.js'
import { settleAuction } from '../src/settlement.js'

const head = (s: string) => console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`)
const xrp = (d: bigint | number) => (Number(d) / 1e6).toFixed(6)
const checks: Array<{ ok: boolean; what: string }> = []
function check(ok: boolean, what: string) {
  checks.push({ ok, what })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`)
}

let cleanup: (() => Promise<void>) | null = null

async function main() {
  if (env.XRPL_NETWORK === 'mainnet') throw new Error('Devnet/testnet only.')
  if (env.FEE_MODEL !== 'v2' || !env.XRP_USD_CENTS) throw new Error('Run with FEE_MODEL=v2 and XRP_USD_CENTS set.')
  if (!env.DELEGATE_SEED || !env.PLATFORM_SEED) throw new Error('Set DELEGATE_SEED and PLATFORM_SEED (two different devnet seeds).')
  assertSafeDatabase('fee-model-devnet-check')

  // Re-fetched after the long wait: a socket idle for ten minutes may have been dropped.
  let client = await ledger()
  const seam = realPrimarySaleLedger()
  /** Sign, submit and wait. */
  async function send(wallet: Wallet, tx: Transaction) {
    for (let attempt = 1; ; attempt++) {
      const prepared = await client.autofill(tx as never)
      const signed = wallet.sign(prepared as never)
      try {
        const res = await client.submitAndWait(signed.tx_blob)
        const meta = res.result.meta
        return { hash: res.result.hash, code: typeof meta === 'object' ? meta.TransactionResult : 'unknown', meta }
      } catch (err) {
        // Devnet sometimes closes ledgers late: the deadline passes before the transaction validates. If that exact
        // transaction DID land, use it; if it provably did not (the deadline is past in a validated ledger), it can
        // never apply, so signing a fresh one cannot duplicate it.
        if (!/LastLedgerSequence/.test(String(err)) || attempt >= 3) throw err
        try {
          const r = await client.request({ command: 'tx', transaction: signed.hash })
          if (r.result.validated) {
            const meta = r.result.meta
            return { hash: signed.hash, code: typeof meta === 'object' ? meta.TransactionResult : 'unknown', meta }
          }
        } catch {
          // txnNotFound: it did not land.
        }
        console.log(`  (resubmitting ${tx.TransactionType}: it missed its ledger deadline and did not apply)`)
      }
    }
  }
  const offerIndexOf = (meta: unknown) => {
    if (typeof meta !== 'object' || !meta) return undefined
    for (const n of (meta as { AffectedNodes: Array<Record<string, { LedgerEntryType: string; LedgerIndex: string }>> }).AffectedNodes) {
      if ('CreatedNode' in n && n.CreatedNode!.LedgerEntryType === 'NFTokenOffer') return n.CreatedNode!.LedgerIndex
    }
    return undefined
  }
  const balance = async (a: string) =>
    BigInt((await client.request({ command: 'account_info', account: a, ledger_index: 'validated' })).result.account_data.Balance)
  const holder = async (nfTokenId: string) => {
    const owners: string[] = []
    for (const w of [organizer, holderW, buyer, buyer2, bidder1, bidder2, stranger]) {
      const r = (await client.request({ command: 'account_nfts', account: w.classicAddress, ledger_index: 'validated', limit: 400 } as never)) as unknown as {
        result: { account_nfts: Array<{ NFTokenID: string }> }
      }
      if (r.result.account_nfts.some((n) => n.NFTokenID === nfTokenId)) owners.push(w.classicAddress)
    }
    return owners
  }
  const offerEntry = async (index: string) => {
    try {
      const r = (await client.request({ command: 'ledger_entry', index, ledger_index: 'validated' } as never)) as unknown as {
        result: { node: Record<string, unknown> }
      }
      return r.result.node
    } catch {
      return null
    }
  }

  /** Balances of every named party AT ONE validated ledger, so a before/after pair covers exactly the ledgers between. */
  const snap = async (who: Record<string, string>) => {
    const idx = Number((await client.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index)
    const bal: Record<string, bigint> = {}
    for (const [k, a] of Object.entries(who)) {
      bal[k] = BigInt((await client.request({ command: 'account_info', account: a, ledger_index: idx })).result.account_data.Balance)
    }
    return { idx, bal }
  }
  /** Every transaction the broker SUBMITTED in ledgers (min, max], with the fee each actually paid, read from the ledger. */
  const brokerSpend = async (minExclusive: number, maxInclusive: number) => {
    const r = (await client.request({
      command: 'account_tx', account: broker.classicAddress, ledger_index_min: minExclusive + 1, ledger_index_max: maxInclusive, limit: 200,
    } as never)) as unknown as { result: { transactions: Array<{ tx_json?: Record<string, string>; tx?: Record<string, string>; hash?: string }> } }
    return r.result.transactions
      .map((t) => {
        const j = (t.tx_json ?? t.tx ?? {}) as Record<string, string>
        return { account: j.Account, type: String(j.TransactionType), fee: BigInt(j.Fee ?? '0'), hash: String(t.hash) }
      })
      .filter((t) => t.account === broker.classicAddress)
  }
  const FINAL = new Set(['sold', 'failed', 'cancelled', 'expired'])
  /** Poll as the real client does until the listing reaches a final state. Fails loudly on timeout. */
  const pollFinal = async (id: string, timeoutMs = 240_000) => {
    const begun = Date.now()
    let polls = 0
    for (;;) {
      const v = await advanceListing(id)
      polls++
      if (v && FINAL.has(String(v.state))) return { view: v, polls }
      if (Date.now() - begun > timeoutMs) throw new Error(`listing ${id} did not reach a final state in ${timeoutMs / 1000}s (last state: ${v?.state})`)
      await new Promise((r) => setTimeout(r, 2_000))
    }
  }
  const pollUntil = async (id: string, state: string, timeoutMs = 120_000) => {
    const begun = Date.now()
    for (;;) {
      const v = await advanceListing(id)
      if (v?.state === state) return v
      if (v && FINAL.has(String(v.state))) throw new Error(`listing ${id} ended as ${v.state} while waiting for ${state}`)
      if (Date.now() - begun > timeoutMs) throw new Error(`listing ${id} did not reach ${state} in ${timeoutMs / 1000}s (last: ${v?.state})`)
      await new Promise((r) => setTimeout(r, 2_000))
    }
  }

  head('1. Wallets (secp256k1, like a Privy wallet) and the delegation grant')
  if (!(await delegationAvailableOnLedger())) throw new Error('PermissionDelegationV1_1 is not enabled on this ledger.')
  const delegate = delegateWallet()
  const broker = platformWallet()
  await client.fundWallet(delegate)
  await client.fundWallet(broker)
  const fresh = async () => (await client.fundWallet(Wallet.generate('ecdsa-secp256k1' as never))).wallet
  const organizer = await fresh()
  const holderW = await fresh()
  const buyer = await fresh()
  const bidder1 = await fresh()
  const bidder2 = await fresh()
  const stranger = await fresh()
  const buyer2 = await fresh()
  console.log(`  organizer ${organizer.classicAddress}\n  holder    ${holderW.classicAddress}\n  broker    ${broker.classicAddress}\n  delegate  ${delegate.classicAddress}`)
  const pair = { organizerAddress: organizer.classicAddress, delegateAddress: delegate.classicAddress }
  await send(organizer, buildDelegateSetTx(pair, [MINT_PERMISSION, OFFER_PERMISSION].sort()) as never)

  head('2. Fixtures: an event, three minted tickets the DATABASE says the holder owns')
  const tag = Math.random().toString(36).slice(2, 7)
  const mkUser = async (name: string, w: Wallet, role: 'USER' | 'ORGANIZER' = 'USER') => {
    const u = await prisma.user.create({ data: { username: `fm${name}_${tag}`.slice(0, 20), xrplAddress: w.classicAddress, role } })
    await prisma.wallet.create({ data: { userId: u.id, xrplAddress: w.classicAddress, signerKind: 'PRIVY', providerUserId: `did:${name}:${tag}`, publicKey: w.publicKey } })
    return u
  }
  const orgU = await mkUser('org', organizer, 'ORGANIZER')
  const holderU = await mkUser('holder', holderW)
  const buyerU = await mkUser('buyer', buyer)
  const b1U = await mkUser('bid1', bidder1)
  const b2U = await mkUser('bid2', bidder2)
  const strangerU = await mkUser('stranger', stranger)
  const buyer2U = await mkUser('buyer2', buyer2)
  const taxon = 77_000 + Math.floor(Math.random() * 900)
  const event = await prisma.event.create({
    data: { network: NETWORK, slug: `fm-${tag}`, title: 'Fee Model Devnet Check', startsAt: new Date(Date.now() + 864e5), organizerId: orgU.id, nftTaxon: taxon, royaltyBps: 500, platformBps: env.PLATFORM_FEE_BPS, ticketCount: 4, status: 'PUBLISHED' },
  })
  const tickets: Array<{ id: string; nfTokenId: string }> = []
  for (let i = 0; i < 4; i++) {
    const m = await send(organizer, buildMintTx({ issuerAddress: organizer.classicAddress, taxon, royaltyBps: 500, uri: ticketMetadataUri(event.slug) }) as never)
    const nfTokenId = typeof m.meta === 'object' ? getNFTokenID(m.meta as never) : undefined
    if (!nfTokenId) throw new Error('mint produced no NFTokenID')
    const t = await prisma.ticket.create({
      data: { nfTokenId, network: NETWORK, eventId: event.id, ownerId: holderU.id, ownerAddress: organizer.classicAddress, status: 'MINTED' },
    })
    tickets.push({ id: t.id, nfTokenId })
  }
  const [T1, T2, T3, T4] = tickets as [(typeof tickets)[0], (typeof tickets)[0], (typeof tickets)[0], (typeof tickets)[0]]
  console.log('  T1 resale (client polls), T2 auction, T3 left unaccepted to lapse, T4 resale (client abandons)')
  cleanup = async () => {
    const ids = [orgU.id, holderU.id, buyerU.id, b1U.id, b2U.id, strangerU.id, buyer2U.id]
    await prisma.xamanPayload.deleteMany({ where: { userId: { in: ids } } })
    await prisma.bid.deleteMany({ where: { auction: { ticketId: { in: tickets.map((t) => t.id) } } } })
    await prisma.transfer.deleteMany({ where: { ticket: { eventId: event.id } } })
    await prisma.listingBuyerNotice.deleteMany({ where: { listing: { ticket: { eventId: event.id } } } })
    await prisma.listing.deleteMany({ where: { ticket: { eventId: event.id } } })
    await prisma.auction.deleteMany({ where: { ticketId: { in: tickets.map((t) => t.id) } } })
    await prisma.ticketClaim.deleteMany({ where: { ticket: { eventId: event.id } } })
    await prisma.ticket.deleteMany({ where: { eventId: event.id } })
    await prisma.event.delete({ where: { id: event.id } })
    await prisma.wallet.deleteMany({ where: { userId: { in: ids } } })
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
  }

  /** What a resolved poll would have read: this signature, already validated. */
  const resolved = (userId: string, account: string, txid: string, flow: 'LISTING_CREATE' | 'LISTING_BUY' | 'AUCTION_OPEN' | 'AUCTION_BID') =>
    prisma.xamanPayload
      .create({ data: { uuid: randomUUID(), flow, network: NETWORK, signer: 'xaman', userId, signed: true, account, txid, terminal: true, source: 'script' } })
      .then((p) => p.uuid)

  const who = () => ({ buyer: buyer.classicAddress, buyer2: buyer2.classicAddress, seller: holderW.classicAddress, organizer: organizer.classicAddress, broker: broker.classicAddress, bidder2: bidder2.classicAddress })
  const PRICE = 10_000_000n
  const terms = resaleListingTerms({ priceDrops: PRICE, minimumDrops: configuredMinimumResaleDrops() })
  if (!terms.ok) throw new Error(terms.reason)
  const royalty = ((PRICE - terms.feeDrops) * 500n) / 10_000n

  /** One v2 resale of `T` from the holder, end to end. `abandon`: the client signs the bid, polls once, and goes away. */
  const resale = async (label: string, T: { id: string; nfTokenId: string }, buyerW: Wallet, buyerU: { id: string }, abandon: boolean) => {
    console.log(`  price ${xrp(PRICE)}  fee ${xrp(terms.feeDrops)} (${terms.feeBps} bps)  sell offer ${xrp(terms.sellOfferDrops)}  buyer pays ${xrp(terms.buyerPaysDrops)}`)
    const sellTx = await send(holderW, buildSellOfferTx({ ownerAddress: holderW.classicAddress, nfTokenId: T.nfTokenId, amountDrops: terms.sellOfferDrops, brokerAddress: broker.classicAddress }) as never)
    const listing = await prisma.listing.create({
      data: {
        ticketId: T.id, network: NETWORK, sellerId: holderU.id, sellerAddress: holderW.classicAddress, brokerAddress: broker.classicAddress,
        priceDrops: PRICE, platformFeeDrops: terms.feeDrops, feeModel: 'SELLER_PAYS_V2', feeBps: terms.feeBps, isPrimarySale: false,
        listPayloadUuid: await resolved(holderU.id, holderW.classicAddress, sellTx.hash, 'LISTING_CREATE'),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    await pollUntil(listing.id, 'active')
    check(true, `${label}: the listing goes active`)
    const buyTx = await send(buyerW, buildBuyOfferTx({ buyerAddress: buyerW.classicAddress, ownerAddress: holderW.classicAddress, nfTokenId: T.nfTokenId, amountDrops: buyerPaysDrops({ ...listing, feeModel: 'SELLER_PAYS_V2' }), brokerAddress: broker.classicAddress }) as never)
    await prisma.listing.update({
      where: { id: listing.id },
      data: { status: 'BUYER_PENDING', buyerId: buyerU.id, buyerAddress: buyerW.classicAddress, buyPayloadUuid: await resolved(buyerU.id, buyerW.classicAddress, buyTx.hash, 'LISTING_BUY') },
    })
    const before = await snap(who())

    let polls = 0
    if (abandon) {
      // The client signed the bid and is GONE: it never polls. The sweep gives a live client 45 seconds before stepping
      // in beside it, so wait that out for real and let the sweep, on the real clock, be the only thing that acts.
      console.log('  the client has gone; waiting out the sweep\'s 45 second courtesy window (real time)...')
      await new Promise((r) => setTimeout(r, 50_000))
      const stateBefore = (await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).status
      check(stateBefore === 'BUYER_PENDING', `${label}: with no client, the sale is still BUYER_PENDING before the sweep (${stateBefore})`)
      const moved = await advanceStuckSales()
      const row = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })
      console.log(`  server sweep (advanceStuckSales) advanced ${moved} sale(s); this resale is now ${row.status}`)
      check(row.status === 'SOLD', `${label}: the server sweep ALONE finishes it (listing is ${row.status})`)
    }
    const done = await pollFinal(listing.id)
    polls += done.polls
    check(done.view.state === 'sold', `${label}: the sale settles (${done.view.state}${abandon ? `; the client polled ${done.polls} time(s), only to read the result` : `, ${polls} poll(s)`})`)
    const after = await snap(who())
    const spend = await brokerSpend(before.idx, after.idx)
    const netFees = spend.reduce((a, t) => a + t.fee, 0n)
    const got = (k: string) => after.bal[k]! - before.bal[k]!
    const wantBroker = terms.feeDrops - netFees
    console.log(`  broker network fees over this window: ${spend.map((t) => `${t.type} ${t.fee}`).join(', ') || 'none'} = ${netFees} drop(s)  (read from the ledger)`)
    console.log('\n  party       received            expected')
    console.log(`  buyer      ${xrp(got(abandon ? 'buyer2' : 'buyer')).padStart(12)}      ${xrp(-PRICE)}  (exactly the price shown)`)
    console.log(`  seller     ${xrp(got('seller')).padStart(12)}      ${xrp(PRICE - terms.feeDrops - royalty)}  (price - 5% fee - royalty)`)
    console.log(`  organizer  ${xrp(got('organizer')).padStart(12)}      ${xrp(royalty)}  (5% of price - fee)`)
    console.log(`  broker     ${xrp(got('broker')).padStart(12)}      ${xrp(wantBroker)}  (fee ${xrp(terms.feeDrops)} - real network fees ${netFees} drops)`)
    check(got(abandon ? 'buyer2' : 'buyer') === -PRICE, `${label}: the buyer paid EXACTLY the price`)
    check(got('seller') === PRICE - terms.feeDrops - royalty, `${label}: the seller received price - fee - royalty`)
    check(got('organizer') === royalty, `${label}: the royalty landed: 5% of (price - fee)`)
    check(got('broker') === wantBroker, `${label}: broker = fee - real network fees, to the drop`)
    check(spend.filter((t) => t.type === 'NFTokenAcceptOffer').length === 1, `${label}: exactly ONE broker match was made`)
    check(got('seller') + got('organizer') + got('broker') + netFees === PRICE, `${label}: conservation: every drop accounted for`)
    check((await holder(T.nfTokenId)).join() === buyerW.classicAddress, `${label}: the ticket is in the buyer's wallet`)
    const final = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id }, include: { ticket: true } })
    check(final.status === 'SOLD' && final.ticket.ownerAddress === buyerW.classicAddress, `${label}: our records agree (listing SOLD, owner updated)`)
  }

  const ONLY_B = process.argv.includes('--only-b')
  if (ONLY_B) {
    head('3. CLAIM (T4 only) and RESALE B: the client disappears after signing')
    const c4 = await startClaim({ nfTokenId: T4.nfTokenId, holderId: holderU.id, ledger: seam })
    if (c4.kind !== 'ok') throw new Error(`claim refused: ${JSON.stringify(c4)}`)
    const a4 = await send(holderW, buildAcceptOfferTx({ accepterAddress: holderW.classicAddress, offerIndex: c4.offerIndex }) as never)
    check(a4.code === 'tesSUCCESS', 'the holder accepts the claim offer for T4')
    await completeClaim(c4.claimId, a4.hash)
    check((await holder(T4.nfTokenId)).join() === holderW.classicAddress, 'T4 is in the holder\'s wallet')
    await resale('resale B', T4, buyer2, buyer2U, true)
    head('7. Clean up the database rows (the accounts stay on devnet)')
    await cleanup!()
    cleanup = null
    head(`RESULT: ${checks.filter((c) => c.ok).length} of ${checks.length} checks passed`)
    for (const c of checks.filter((x) => !x.ok)) console.log(`  FAILED: ${c.what}`)
    if (checks.some((c) => !c.ok)) process.exitCode = 1
    return
  }

  head('3. CLAIM: the free, expiring, holder-only offer')
  const claim3 = await startClaim({ nfTokenId: T3.nfTokenId, holderId: holderU.id, ledger: seam }) // clock starts now
  check(claim3.kind === 'ok', 'T3 claim offer created (left unaccepted; its expiry is checked at the end)')
  const claim1 = await startClaim({ nfTokenId: T1.nfTokenId, holderId: holderU.id, ledger: seam })
  const claim2 = await startClaim({ nfTokenId: T2.nfTokenId, holderId: holderU.id, ledger: seam })
  const claim4 = await startClaim({ nfTokenId: T4.nfTokenId, holderId: holderU.id, ledger: seam })
  if (claim4.kind !== 'ok') throw new Error(`claim refused: ${JSON.stringify(claim4)}`)
  if (claim1.kind !== 'ok' || claim2.kind !== 'ok' || claim3.kind !== 'ok') throw new Error(`claim refused: ${JSON.stringify([claim1, claim2, claim3])}`)

  const entry1 = await offerEntry(claim1.offerIndex)
  check(
    entry1?.Amount === '0' && entry1?.Destination === holderW.classicAddress && entry1?.Owner === organizer.classicAddress && typeof entry1?.Expiration === 'number',
    `on the ledger: Amount 0, Destination = the holder, created as the organizer, with an Expiration (${entry1 ? new Date(rippleTimeToUnixTime(entry1.Expiration as number)).toISOString() : 'missing'})`,
  )
  const again = await startClaim({ nfTokenId: T1.nfTokenId, holderId: holderU.id, ledger: seam })
  check(again.kind === 'ok' && again.reused && again.offerIndex === claim1.offerIndex, 'a retried claim returns the SAME offer; none was created')
  const offersBefore = ((await client.request({ command: 'account_objects', account: organizer.classicAddress, type: 'nft_offer', ledger_index: 'validated' } as never)) as unknown as { result: { account_objects: unknown[] } }).result.account_objects.length
  check(offersBefore === 4, `the organizer has exactly 4 open claim offers (one per ticket), found ${offersBefore}`)

  const steal = await send(stranger, buildAcceptOfferTx({ accepterAddress: stranger.classicAddress, offerIndex: claim2.offerIndex }) as never)
  check(steal.code !== 'tesSUCCESS', `a stranger accepting the holder's offer is refused by the ledger (${steal.code})`)
  check((await holder(T2.nfTokenId)).join() === organizer.classicAddress, 'T2 is still with the organizer after the attempt')

  const orgBeforeClaim = await balance(organizer.classicAddress)
  const accept1 = await send(holderW, buildAcceptOfferTx({ accepterAddress: holderW.classicAddress, offerIndex: claim1.offerIndex }) as never)
  const accept2 = await send(holderW, buildAcceptOfferTx({ accepterAddress: holderW.classicAddress, offerIndex: claim2.offerIndex }) as never)
  const accept4 = await send(holderW, buildAcceptOfferTx({ accepterAddress: holderW.classicAddress, offerIndex: claim4.offerIndex }) as never)
  check(accept1.code === 'tesSUCCESS' && accept2.code === 'tesSUCCESS' && accept4.code === 'tesSUCCESS', 'the holder accepts the offers for T1, T2 and T4')
  check((await holder(T1.nfTokenId)).join() === holderW.classicAddress, 'T1 is now in the holder\'s wallet, on the ledger')
  await completeClaim(claim1.claimId, accept1.hash)
  await completeClaim(claim2.claimId, accept2.hash)
  await completeClaim(claim4.claimId, accept4.hash)
  check((await prisma.ticket.findUniqueOrThrow({ where: { id: T1.id } })).ownerAddress === holderW.classicAddress, 'our records agree')
  console.log(`  organizer balance change over the two handovers: ${xrp((await balance(organizer.classicAddress)) - orgBeforeClaim)} XRP (no money moved)`)

  head('4. V2 RESALE: the client polls to the end')
  await resale('resale A', T1, buyer, buyerU, false)

  head('5. V2 RESALE where the client disappears after signing: the server sweep alone must finish it')
  await resale('resale B', T4, buyer2, buyer2U, true)

  head('5b. AUCTION at the frozen 5%')
  const RESERVE = 20_000_000n
  const sellAmount = auctionSellAmountDrops(RESERVE, terms.feeBps)
  const sell2 = await send(holderW, buildSellOfferTx({ ownerAddress: holderW.classicAddress, nfTokenId: T2.nfTokenId, amountDrops: sellAmount, brokerAddress: broker.classicAddress }) as never)
  const auction = await prisma.auction.create({
    data: { network: NETWORK, ticketId: T2.id, startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() - 1_000), reserveDrops: RESERVE, feeBps: terms.feeBps, status: 'SCHEDULED' },
  })
  const aListing = await prisma.listing.create({
    data: {
      ticketId: T2.id, network: NETWORK, sellerId: holderU.id, sellerAddress: holderW.classicAddress, brokerAddress: broker.classicAddress,
      priceDrops: sellAmount, platformFeeDrops: (RESERVE * BigInt(terms.feeBps)) / 10_000n, feeBps: terms.feeBps, auctionId: auction.id,
      listPayloadUuid: await resolved(holderU.id, holderW.classicAddress, sell2.hash, 'AUCTION_OPEN'), expiresAt: new Date(Date.now() + 3_600_000),
    },
  })
  await pollUntil(aListing.id, 'active')
  check((await prisma.auction.findUniqueOrThrow({ where: { id: auction.id } })).status === 'LIVE', 'the auction listing goes live')
  const bids: Array<{ id: string; amount: bigint }> = []
  for (const [w, u, amt] of [[bidder1, b1U, 25_000_000n], [bidder2, b2U, 30_000_000n]] as const) {
    const t = await send(w, buildBuyOfferTx({ buyerAddress: w.classicAddress, ownerAddress: holderW.classicAddress, nfTokenId: T2.nfTokenId, amountDrops: amt, brokerAddress: broker.classicAddress }) as never)
    const bid = await prisma.bid.create({
      data: { network: NETWORK, auctionId: auction.id, bidderId: u.id, bidderAddress: w.classicAddress, amountDrops: amt, status: 'COMMITTED', buyTxHash: t.hash, buyOfferIndex: offerIndexOf(t.meta), committedAt: new Date() },
    })
    bids.push({ id: bid.id, amount: amt })
  }
  const a0 = await snap(who())
  const outcome = await settleAuction(auction.id)
  check(outcome.kind === 'settled', `the auction settles (${outcome.kind})`)
  const a1 = await snap(who())
  const aSpend = await brokerSpend(a0.idx, a1.idx)
  const aNet = aSpend.reduce((a, t) => a + t.fee, 0n)
  const WIN = 30_000_000n
  const aFee = (WIN * BigInt(terms.feeBps)) / 10_000n
  const aRoyalty = ((WIN - aFee) * 500n) / 10_000n
  const ag = (k: string) => a1.bal[k]! - a0.bal[k]!
  console.log(`  broker network fees over this window: ${aSpend.map((t) => `${t.type} ${t.fee}`).join(', ') || 'none'} = ${aNet} drop(s)  (read from the ledger)`)
  console.log('\n  party        received            expected   (winning bid 30, reserve 20)')
  console.log(`  winner     ${xrp(ag('bidder2')).padStart(12)}      ${xrp(-WIN)}`)
  console.log(`  seller     ${xrp(ag('seller')).padStart(12)}      ${xrp(WIN - aFee - aRoyalty)}  (bid - 5% of the BID - royalty)`)
  console.log(`  organizer  ${xrp(ag('organizer')).padStart(12)}      ${xrp(aRoyalty)}`)
  console.log(`  broker     ${xrp(ag('broker')).padStart(12)}      ${xrp(aFee - aNet)}  (fee ${xrp(aFee)} - real network fees ${aNet} drops)`)
  check(outcome.kind === 'settled' && outcome.feeDrops === aFee, `the fee is 5% of the winning BID (${xrp(aFee)}), not of the reserve`)
  check(ag('bidder2') === -WIN, 'the winner paid exactly their bid')
  check(ag('seller') === WIN - aFee - aRoyalty, 'the seller received bid - fee - royalty')
  check(ag('organizer') === aRoyalty, 'the royalty landed on the auction too')
  check(ag('broker') === aFee - aNet, 'broker = fee - real network fees (match AND the losing-bid cancel), to the drop')
  check(aSpend.some((t) => t.type === 'NFTokenCancelOffer') && aSpend.some((t) => t.type === 'NFTokenAcceptOffer'), 'both the match and the cancel were found among the broker\'s transactions')
  check((await holder(T2.nfTokenId)).join() === bidder2.classicAddress, 'T2 is with the winner')
  const loserOffer = bids[0] ? (await prisma.bid.findUniqueOrThrow({ where: { id: bids[0].id } })).buyOfferIndex : null
  check(loserOffer !== null && (await offerEntry(loserOffer)) === null, 'the losing bid\'s offer was cancelled by the broker')

  head('6. EXPIRY: an unaccepted claim is cancelled once it lapses')
  const row3 = await prisma.ticketClaim.findUniqueOrThrow({ where: { ticketId: T3.id } })
  const cancelableAt = row3.expiresAt.getTime() + CLAIM_GRACE_MS + 2_000
  check((await offerEntry(claim3.offerIndex)) !== null, 'the T3 offer is still on the ledger before it lapses')
  const early = await expireClaims(seam, new Date())
  check(early === 0, 'the sweep leaves it alone while it is live')
  const waitMs = cancelableAt - Date.now()
  if (waitMs > 0) {
    console.log(`  waiting ${(waitMs / 1000).toFixed(0)}s for the offer to lapse on the ledger and its grace period to pass...`)
    await new Promise((r) => setTimeout(r, waitMs))
  }
  client = await ledger() // a socket idle this long may have been dropped
  const swept = await expireClaims(seam, new Date())
  check(swept === 1, `the sweep expires it (${swept})`)
  check((await offerEntry(claim3.offerIndex)) === null, 'the lapsed offer is GONE from the ledger: cancelled by the broker, who is neither its creator nor its destination')
  check((await prisma.ticketClaim.findUniqueOrThrow({ where: { ticketId: T3.id } })).status === 'EXPIRED', 'the claim is EXPIRED in our records')
  const finalOffers = ((await client.request({ command: 'account_objects', account: organizer.classicAddress, type: 'nft_offer', ledger_index: 'validated' } as never)) as unknown as { result: { account_objects: unknown[] } }).result.account_objects.length
  check(finalOffers === 0, `no offers left open on the organizer's account (${finalOffers})`)
  void strangerU

  head('7. Clean up the database rows (the accounts stay on devnet)')
  await cleanup!()
  cleanup = null

  head(`RESULT: ${checks.filter((c) => c.ok).length} of ${checks.length} checks passed`)
  for (const c of checks.filter((x) => !x.ok)) console.log(`  FAILED: ${c.what}`)
  if (checks.some((c) => !c.ok)) process.exitCode = 1
}

main()
  .catch((e) => {
    console.error('CHECK FAILED:', e)
    process.exitCode = 1
  })
  .finally(async () => {
    // Fixtures are removed even when a check throws, so a failed run leaves no devnet rows behind.
    if (cleanup) await cleanup().catch((e) => console.error('cleanup failed:', e))
    await prisma.$disconnect()
    await disconnectLedger()
  })
