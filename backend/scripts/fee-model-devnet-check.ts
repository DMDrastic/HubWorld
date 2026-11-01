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
import { advanceListing } from '../src/listing-advance.js'
import { settleAuction } from '../src/settlement.js'

const head = (s: string) => console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`)
const xrp = (d: bigint | number) => (Number(d) / 1e6).toFixed(6)
const checks: Array<{ ok: boolean; what: string }> = []
function check(ok: boolean, what: string) {
  checks.push({ ok, what })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`)
}

async function main() {
  if (env.XRPL_NETWORK === 'mainnet') throw new Error('Devnet/testnet only.')
  if (env.FEE_MODEL !== 'v2' || !env.XRP_USD_CENTS) throw new Error('Run with FEE_MODEL=v2 and XRP_USD_CENTS set.')
  if (!env.DELEGATE_SEED || !env.PLATFORM_SEED) throw new Error('Set DELEGATE_SEED and PLATFORM_SEED (two different devnet seeds).')
  assertSafeDatabase('fee-model-devnet-check')

  const client = await ledger()
  const seam = realPrimarySaleLedger()
  const paidFees = new Map<string, bigint>()

  /** Sign, submit and wait. The fee a party pays is remembered so balances can be read net of it. */
  async function send(wallet: Wallet, tx: Transaction) {
    const prepared = await client.autofill(tx as never)
    const res = await client.submitAndWait(wallet.sign(prepared as never).tx_blob)
    const meta = res.result.meta
    const code = typeof meta === 'object' ? meta.TransactionResult : 'unknown'
    paidFees.set(wallet.classicAddress, (paidFees.get(wallet.classicAddress) ?? 0n) + BigInt(String((res.result as { Fee?: string }).Fee ?? '0')))
    return { hash: res.result.hash, code, meta }
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
    for (const w of [organizer, holderW, buyer, bidder1, bidder2]) {
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
  const taxon = 77_000 + Math.floor(Math.random() * 900)
  const event = await prisma.event.create({
    data: { network: NETWORK, slug: `fm-${tag}`, title: 'Fee Model Devnet Check', startsAt: new Date(Date.now() + 864e5), organizerId: orgU.id, nftTaxon: taxon, royaltyBps: 500, platformBps: env.PLATFORM_FEE_BPS, ticketCount: 3, status: 'PUBLISHED' },
  })
  const tickets: Array<{ id: string; nfTokenId: string }> = []
  for (let i = 0; i < 3; i++) {
    const m = await send(organizer, buildMintTx({ issuerAddress: organizer.classicAddress, taxon, royaltyBps: 500, uri: ticketMetadataUri(event.slug) }) as never)
    const nfTokenId = typeof m.meta === 'object' ? getNFTokenID(m.meta as never) : undefined
    if (!nfTokenId) throw new Error('mint produced no NFTokenID')
    const t = await prisma.ticket.create({
      data: { nfTokenId, network: NETWORK, eventId: event.id, ownerId: holderU.id, ownerAddress: organizer.classicAddress, status: 'MINTED' },
    })
    tickets.push({ id: t.id, nfTokenId })
  }
  const [T1, T2, T3] = tickets as [(typeof tickets)[0], (typeof tickets)[0], (typeof tickets)[0]]
  console.log('  T1 resale, T2 auction, T3 left unaccepted to lapse')

  head('3. CLAIM: the free, expiring, holder-only offer')
  const claim3 = await startClaim({ nfTokenId: T3.nfTokenId, holderId: holderU.id, ledger: seam }) // clock starts now
  check(claim3.kind === 'ok', 'T3 claim offer created (left unaccepted; its expiry is checked at the end)')
  const claim1 = await startClaim({ nfTokenId: T1.nfTokenId, holderId: holderU.id, ledger: seam })
  const claim2 = await startClaim({ nfTokenId: T2.nfTokenId, holderId: holderU.id, ledger: seam })
  if (claim1.kind !== 'ok' || claim2.kind !== 'ok' || claim3.kind !== 'ok') throw new Error(`claim refused: ${JSON.stringify([claim1, claim2, claim3])}`)

  const entry1 = await offerEntry(claim1.offerIndex)
  check(
    entry1?.Amount === '0' && entry1?.Destination === holderW.classicAddress && entry1?.Owner === organizer.classicAddress && typeof entry1?.Expiration === 'number',
    `on the ledger: Amount 0, Destination = the holder, created as the organizer, with an Expiration (${entry1 ? new Date(rippleTimeToUnixTime(entry1.Expiration as number)).toISOString() : 'missing'})`,
  )
  const again = await startClaim({ nfTokenId: T1.nfTokenId, holderId: holderU.id, ledger: seam })
  check(again.kind === 'ok' && again.reused && again.offerIndex === claim1.offerIndex, 'a retried claim returns the SAME offer; none was created')
  const offersBefore = ((await client.request({ command: 'account_objects', account: organizer.classicAddress, type: 'nft_offer', ledger_index: 'validated' } as never)) as unknown as { result: { account_objects: unknown[] } }).result.account_objects.length
  check(offersBefore === 3, `the organizer has exactly 3 open claim offers (one per ticket), found ${offersBefore}`)

  const steal = await send(stranger, buildAcceptOfferTx({ accepterAddress: stranger.classicAddress, offerIndex: claim2.offerIndex }) as never)
  check(steal.code !== 'tesSUCCESS', `a stranger accepting the holder's offer is refused by the ledger (${steal.code})`)
  check((await holder(T2.nfTokenId)).join() === organizer.classicAddress, 'T2 is still with the organizer after the attempt')

  const orgBeforeClaim = await balance(organizer.classicAddress)
  const accept1 = await send(holderW, buildAcceptOfferTx({ accepterAddress: holderW.classicAddress, offerIndex: claim1.offerIndex }) as never)
  const accept2 = await send(holderW, buildAcceptOfferTx({ accepterAddress: holderW.classicAddress, offerIndex: claim2.offerIndex }) as never)
  check(accept1.code === 'tesSUCCESS' && accept2.code === 'tesSUCCESS', 'the holder accepts both offers')
  check((await holder(T1.nfTokenId)).join() === holderW.classicAddress, 'T1 is now in the holder\'s wallet, on the ledger')
  await completeClaim(claim1.claimId, accept1.hash)
  await completeClaim(claim2.claimId, accept2.hash)
  check((await prisma.ticket.findUniqueOrThrow({ where: { id: T1.id } })).ownerAddress === holderW.classicAddress, 'our records agree')
  console.log(`  organizer balance change over the two handovers: ${xrp((await balance(organizer.classicAddress)) - orgBeforeClaim)} XRP (no money moved)`)

  /** What a resolved poll would have read: this signature, already validated. */
  const resolved = (userId: string, account: string, txid: string, flow: 'LISTING_CREATE' | 'LISTING_BUY' | 'AUCTION_OPEN' | 'AUCTION_BID') =>
    prisma.xamanPayload
      .create({ data: { uuid: randomUUID(), flow, network: NETWORK, signer: 'xaman', userId, signed: true, account, txid, terminal: true, source: 'script' } })
      .then((p) => p.uuid)

  head('4. V2 RESALE: the seller pays 5%, the buyer pays exactly the price')
  const PRICE = 10_000_000n
  const terms = resaleListingTerms({ priceDrops: PRICE, minimumDrops: configuredMinimumResaleDrops() })
  if (!terms.ok) throw new Error(terms.reason)
  console.log(`  price ${xrp(PRICE)}  fee ${xrp(terms.feeDrops)} (${terms.feeBps} bps)  sell offer ${xrp(terms.sellOfferDrops)}  buyer pays ${xrp(terms.buyerPaysDrops)}`)
  const sellTx = await send(holderW, buildSellOfferTx({ ownerAddress: holderW.classicAddress, nfTokenId: T1.nfTokenId, amountDrops: terms.sellOfferDrops, brokerAddress: broker.classicAddress }) as never)
  const listing = await prisma.listing.create({
    data: {
      ticketId: T1.id, network: NETWORK, sellerId: holderU.id, sellerAddress: holderW.classicAddress, brokerAddress: broker.classicAddress,
      priceDrops: PRICE, platformFeeDrops: terms.feeDrops, feeModel: 'SELLER_PAYS_V2', feeBps: terms.feeBps, isPrimarySale: false,
      listPayloadUuid: await resolved(holderU.id, holderW.classicAddress, sellTx.hash, 'LISTING_CREATE'),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  })
  const activated = await advanceListing(listing.id)
  check(activated?.state === 'active', `the listing goes active (${activated?.state})`)
  const buyTx = await send(buyer, buildBuyOfferTx({ buyerAddress: buyer.classicAddress, ownerAddress: holderW.classicAddress, nfTokenId: T1.nfTokenId, amountDrops: buyerPaysDrops({ ...listing, feeModel: 'SELLER_PAYS_V2' }), brokerAddress: broker.classicAddress }) as never)
  await prisma.listing.update({
    where: { id: listing.id },
    data: { status: 'BUYER_PENDING', buyerId: buyerU.id, buyerAddress: buyer.classicAddress, buyPayloadUuid: await resolved(buyerU.id, buyer.classicAddress, buyTx.hash, 'LISTING_BUY') },
  })
  const before = { buyer: await balance(buyer.classicAddress), seller: await balance(holderW.classicAddress), organizer: await balance(organizer.classicAddress), broker: await balance(broker.classicAddress) }
  const settled = await advanceListing(listing.id)
  check(settled?.state === 'sold', `the sale settles (${settled?.state}${settled && 'reason' in settled ? ` ${(settled as { reason?: string }).reason}` : ''})`)
  const after = { buyer: await balance(buyer.classicAddress), seller: await balance(holderW.classicAddress), organizer: await balance(organizer.classicAddress), broker: await balance(broker.classicAddress) }
  const brokerFeesPaid = 12n // the broker pays its own network fee on the match
  const royalty = ((PRICE - terms.feeDrops) * 500n) / 10_000n
  const received = {
    buyer: after.buyer - before.buyer, // the offer fee was paid BEFORE `before` was read, so this is the sale alone
    seller: after.seller - before.seller,
    organizer: after.organizer - before.organizer,
    broker: after.broker - before.broker,
  }
  console.log('\n  party       received            expected')
  console.log(`  buyer      ${xrp(received.buyer).padStart(12)}      ${xrp(-PRICE)}  (exactly the price shown)`)
  console.log(`  seller     ${xrp(received.seller).padStart(12)}      ${xrp(PRICE - terms.feeDrops - royalty)}  (price - 5% fee - royalty)`)
  console.log(`  organizer  ${xrp(received.organizer).padStart(12)}      ${xrp(royalty)}  (5% of price - fee)`)
  console.log(`  broker     ${xrp(received.broker).padStart(12)}      ${xrp(terms.feeDrops)}  (less its network fee)`)
  check(received.buyer === -PRICE, 'the buyer paid EXACTLY the price')
  check(received.seller === PRICE - terms.feeDrops - royalty, 'the seller received price - fee - royalty')
  check(received.organizer === royalty, 'the royalty landed: 5% of (price - fee)')
  check(received.broker + brokerFeesPaid === terms.feeDrops, 'the broker received exactly the fee (before its network fee)')
  check(received.seller + received.organizer + received.broker + brokerFeesPaid === PRICE, 'conservation: nothing created or lost')
  check((await holder(T1.nfTokenId)).join() === buyer.classicAddress, 'T1 is in the buyer\'s wallet')

  head('5. AUCTION at the frozen 5%')
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
  const live = await advanceListing(aListing.id)
  check(live?.state === 'active' && (await prisma.auction.findUniqueOrThrow({ where: { id: auction.id } })).status === 'LIVE', 'the auction listing goes live')
  const bids: Array<{ id: string; amount: bigint }> = []
  for (const [w, u, amt] of [[bidder1, b1U, 25_000_000n], [bidder2, b2U, 30_000_000n]] as const) {
    const t = await send(w, buildBuyOfferTx({ buyerAddress: w.classicAddress, ownerAddress: holderW.classicAddress, nfTokenId: T2.nfTokenId, amountDrops: amt, brokerAddress: broker.classicAddress }) as never)
    const bid = await prisma.bid.create({
      data: { network: NETWORK, auctionId: auction.id, bidderId: u.id, bidderAddress: w.classicAddress, amountDrops: amt, status: 'COMMITTED', buyTxHash: t.hash, buyOfferIndex: offerIndexOf(t.meta), committedAt: new Date() },
    })
    bids.push({ id: bid.id, amount: amt })
  }
  const a0 = { seller: await balance(holderW.classicAddress), organizer: await balance(organizer.classicAddress), broker: await balance(broker.classicAddress), b2: await balance(bidder2.classicAddress) }
  const outcome = await settleAuction(auction.id)
  check(outcome.kind === 'settled', `the auction settles (${outcome.kind})`)
  const WIN = 30_000_000n
  const aFee = (WIN * BigInt(terms.feeBps)) / 10_000n
  const aRoyalty = ((WIN - aFee) * 500n) / 10_000n
  const a1 = { seller: await balance(holderW.classicAddress), organizer: await balance(organizer.classicAddress), broker: await balance(broker.classicAddress), b2: await balance(bidder2.classicAddress) }
  console.log('\n  party        received            expected   (winning bid 30, reserve 20)')
  console.log(`  winner     ${xrp(a1.b2 - a0.b2).padStart(12)}      ${xrp(-WIN)}`)
  console.log(`  seller     ${xrp(a1.seller - a0.seller).padStart(12)}      ${xrp(WIN - aFee - aRoyalty)}  (bid - 5% of the BID - royalty)`)
  console.log(`  organizer  ${xrp(a1.organizer - a0.organizer).padStart(12)}      ${xrp(aRoyalty)}`)
  console.log(`  broker     ${xrp(a1.broker - a0.broker).padStart(12)}      ${xrp(aFee)}  (less network fees)`)
  check(outcome.kind === 'settled' && outcome.feeDrops === aFee, `the fee is 5% of the winning BID (${xrp(aFee)}), not of the reserve`)
  check(a1.b2 - a0.b2 === -WIN, 'the winner paid exactly their bid')
  check(a1.seller - a0.seller === WIN - aFee - aRoyalty, 'the seller received bid - fee - royalty')
  check(a1.organizer - a0.organizer === aRoyalty, 'the royalty landed on the auction too')
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
  const swept = await expireClaims(seam, new Date())
  check(swept === 1, `the sweep expires it (${swept})`)
  check((await offerEntry(claim3.offerIndex)) === null, 'the lapsed offer is GONE from the ledger: cancelled by the broker, who is neither its creator nor its destination')
  check((await prisma.ticketClaim.findUniqueOrThrow({ where: { ticketId: T3.id } })).status === 'EXPIRED', 'the claim is EXPIRED in our records')
  const finalOffers = ((await client.request({ command: 'account_objects', account: organizer.classicAddress, type: 'nft_offer', ledger_index: 'validated' } as never)) as unknown as { result: { account_objects: unknown[] } }).result.account_objects.length
  check(finalOffers === 0, `no offers left open on the organizer's account (${finalOffers})`)
  void strangerU

  head('7. Clean up the database rows (the accounts stay on devnet)')
  const ids = [orgU.id, holderU.id, buyerU.id, b1U.id, b2U.id, strangerU.id]
  await prisma.xamanPayload.deleteMany({ where: { userId: { in: ids } } })
  await prisma.bid.deleteMany({ where: { auctionId: auction.id } })
  await prisma.transfer.deleteMany({ where: { ticket: { eventId: event.id } } })
  await prisma.listing.deleteMany({ where: { ticket: { eventId: event.id } } })
  await prisma.auction.deleteMany({ where: { ticketId: { in: tickets.map((t) => t.id) } } })
  await prisma.ticketClaim.deleteMany({ where: { ticket: { eventId: event.id } } })
  await prisma.ticket.deleteMany({ where: { eventId: event.id } })
  await prisma.event.delete({ where: { id: event.id } })
  await prisma.wallet.deleteMany({ where: { userId: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })

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
    await prisma.$disconnect()
    await disconnectLedger()
  })
