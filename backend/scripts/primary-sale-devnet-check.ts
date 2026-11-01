/**
 * Runs the SHIPPED lazy primary sale against a real ledger.
 *
 * The unit tests fake the ledger, which is how they can make a crowd collide on
 * demand — but a fake cannot show that the real ledger accepts a sell offer
 * created AS the organizer, signed by the delegate, with `NFTokenCreateOffer`
 * delegated; that the broker can then match it against a buyer's bid; or what a
 * sale actually pays out. This does, with faucet-funded throwaway wallets and a
 * throwaway event written to the database you point it at.
 *
 *   DOTENV_CONFIG_PATH=/nonexistent XRPL_NETWORK=devnet \
 *   DATABASE_URL=<local test db> DELEGATE_SEED=<seed> PLATFORM_SEED=<seed> \
 *     npx tsx scripts/primary-sale-devnet-check.ts --buyers 5
 *
 * Two DIFFERENT seeds, both devnet accounts it may fund from the faucet. Devnet
 * and testnet only; it refuses mainnet and a remote database.
 */
import { Wallet } from 'xrpl'
import { prisma } from '../src/prisma.js'
import { NETWORK } from '../src/network.js'
import { env } from '../src/env.js'
import { assertSafeDatabase } from '../src/db-guard.js'
import {
  brokerSaleOnLedger,
  buildBuyOfferTx,
  buildMintTx,
  delegateWallet,
  disconnectLedger,
  ledger,
  platformWallet,
} from '../src/ledger.js'
import { buildDelegateSetTx, delegationAvailableOnLedger, MINT_PERMISSION, OFFER_PERMISSION, readPermissionSetOnLedger } from '../src/delegation.js'
import { startCheckout } from '../src/primary-sale.js'
import { realPrimarySaleLedger } from '../src/primary-sale-ledger.js'
import { platformFeeDrops } from '../src/ledger.js'
import { ticketMetadataUri } from '../src/nft-metadata.js'
import { getNFTokenID } from 'xrpl'
import { cancellableByBroker, findOrphanOffers } from '../src/orphan-offers.js'
import { offersOwnedBy } from '../src/organizer-offers.js'

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : Number(process.argv[i + 1])
}
const head = (s: string) => console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`)
const xrp = (d: bigint | number) => (Number(d) / 1e6).toFixed(6)

async function balance(address: string): Promise<bigint> {
  const c = await ledger()
  const r = await c.request({ command: 'account_info', account: address, ledger_index: 'validated' })
  return BigInt(r.result.account_data.Balance)
}

async function main() {
  if (env.XRPL_NETWORK === 'mainnet') {
    console.error('Devnet/testnet only.')
    process.exit(1)
  }
  if (!env.DELEGATE_SEED || !env.PLATFORM_SEED) {
    console.error('Set DELEGATE_SEED and PLATFORM_SEED (two different devnet seeds).')
    process.exit(1)
  }
  assertSafeDatabase('primary-sale-devnet-check')

  const buyersCount = arg('buyers', 5)
  const priceDrops = BigInt(arg('priceXrp', 10)) * 1_000_000n
  const client = await ledger()

  head('0. Is delegation usable here?')
  if (!(await delegationAvailableOnLedger())) {
    console.error('  PermissionDelegationV1_1 is not enabled on this ledger.')
    return
  }

  head('1. Wallets: organizer, delegate, broker, and buyers')
  const delegate = delegateWallet()
  const broker = platformWallet()
  await client.fundWallet(delegate)
  await client.fundWallet(broker)
  const { wallet: organizer } = await client.fundWallet()
  const buyers: Wallet[] = []
  for (let i = 0; i < buyersCount; i++) buyers.push((await client.fundWallet()).wallet)
  console.log(`  organizer ${organizer.classicAddress}\n  delegate  ${delegate.classicAddress}\n  broker    ${broker.classicAddress}\n  ${buyers.length} buyers`)

  head('2. The organizer grants BOTH permissions with one signature')
  const pair = { organizerAddress: organizer.classicAddress, delegateAddress: delegate.classicAddress }
  const grant = await client.autofill(buildDelegateSetTx(pair, [MINT_PERMISSION, OFFER_PERMISSION].sort()) as never)
  await client.submitAndWait(organizer.sign(grant).tx_blob)
  console.log(`  held on ledger: ${JSON.stringify(await readPermissionSetOnLedger(pair))}`)

  head(`3. Mint ${buyersCount} tickets (the organizer's own signature; minting is not under test)`)
  const tag = Math.random().toString(36).slice(2, 7)
  const user = await prisma.user.create({ data: { username: `psd_${tag}`, xrplAddress: organizer.classicAddress, role: 'ORGANIZER' } })
  const taxon = 75_000 + Math.floor(Math.random() * 900)
  const event = await prisma.event.create({
    data: {
      network: NETWORK,
      slug: `psd-${tag}`,
      title: 'Primary Sale Devnet Check',
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: user.id,
      nftTaxon: taxon,
      royaltyBps: 500,
      platformBps: env.PLATFORM_FEE_BPS,
      ticketCount: buyersCount,
      status: 'PUBLISHED',
      primaryPriceDrops: priceDrops,
    },
  })
  for (let i = 0; i < buyersCount; i++) {
    const tx = await client.autofill(
      buildMintTx({ issuerAddress: organizer.classicAddress, taxon, royaltyBps: 500, uri: ticketMetadataUri(event.slug) }) as never,
    )
    const res = await client.submitAndWait(organizer.sign(tx).tx_blob)
    const meta = res.result.meta
    const nfTokenId = typeof meta === 'object' ? getNFTokenID(meta) : undefined
    if (!nfTokenId) throw new Error('mint produced no NFTokenID')
    await prisma.ticket.create({
      data: { nfTokenId, network: NETWORK, eventId: event.id, ownerId: user.id, ownerAddress: organizer.classicAddress, status: 'MINTED' },
    })
  }
  console.log(`  ${buyersCount} tickets minted and recorded`)

  head(`4. ${buyersCount} buyers check out AT ONCE`)
  const ledgerSeam = realPrimarySaleLedger()
  const buyerUsers = await Promise.all(
    buyers.map((w, i) => prisma.user.create({ data: { username: `psb${i}_${tag}`.slice(0, 20), xrplAddress: w.classicAddress } })),
  )
  const t0 = Date.now()
  const outcomes = await Promise.all(
    buyerUsers.map(async (b) => {
      const started = Date.now()
      const o = await startCheckout({ slug: event.slug, buyerId: b.id, ledger: ledgerSeam })
      return { o, ms: Date.now() - started, b }
    }),
  )
  console.log(`  all checkouts returned after ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  for (const { o, ms, b } of outcomes) {
    console.log(`  ${b.username.padEnd(20)} ${o.kind === 'ok' ? 'ok' : `REFUSED ${o.status} ${o.code ?? ''} ${o.error}`}  (${(ms / 1000).toFixed(1)}s)`)
  }
  const okCount = outcomes.filter((x) => x.o.kind === 'ok').length

  head('5. Each buyer signs their bid; the broker matches the pair')
  const before = {
    organizer: await balance(organizer.classicAddress),
    broker: await balance(broker.classicAddress),
  }
  let sold = 0
  for (const { o, b } of outcomes) {
    if (o.kind !== 'ok') continue
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: o.listingId }, include: { ticket: true } })
    const wallet = buyers[buyerUsers.findIndex((u) => u.id === b.id)]!
    const buyTx = buildBuyOfferTx({
      buyerAddress: wallet.classicAddress,
      ownerAddress: organizer.classicAddress,
      nfTokenId: listing.ticket.nfTokenId,
      amountDrops: listing.priceDrops + listing.platformFeeDrops,
      brokerAddress: broker.classicAddress,
    })
    const prepared = await client.autofill(buyTx as never)
    const res = await client.submitAndWait(wallet.sign(prepared).tx_blob)
    const meta = res.result.meta
    let buyOfferIndex: string | undefined
    if (typeof meta === 'object') {
      for (const n of meta.AffectedNodes) if ('CreatedNode' in n && n.CreatedNode.LedgerEntryType === 'NFTokenOffer') buyOfferIndex = n.CreatedNode.LedgerIndex
    }
    if (!buyOfferIndex || !listing.offerIndex) throw new Error('missing an offer index')
    const matched = await brokerSaleOnLedger({
      sellOfferIndex: listing.offerIndex,
      buyOfferIndex,
      brokerFeeDrops: listing.platformFeeDrops,
    })
    console.log(`  ${b.username.padEnd(20)} broker match: ${matched.result}`)
    if (matched.succeeded) sold++
  }

  head('6. RESULTS')
  const after = {
    organizer: await balance(organizer.classicAddress),
    broker: await balance(broker.classicAddress),
  }
  const expectedFee = platformFeeDrops(priceDrops, env.PLATFORM_FEE_BPS)
  // Reads the NFT list rather than the DB so what is checked is the ledger.
  const held = await client.request({ command: 'account_nfts', account: organizer.classicAddress, ledger_index: 'validated', limit: 400 } as never) as unknown as { result: { account_nfts: unknown[] } }
  const open = await client.request({ command: 'account_objects', account: organizer.classicAddress, type: 'nft_offer', ledger_index: 'validated' } as never) as unknown as { result: { account_objects: unknown[] } }

  console.log(`  checkouts ok          : ${okCount} of ${buyersCount}`)
  console.log(`  sales settled         : ${sold}`)
  console.log(`  tickets still held    : ${held.result.account_nfts.length} by the organizer  (expect ${buyersCount - sold})`)
  console.log(`  offers left open      : ${open.result.account_objects.length}  (expect 0 once all settled)`)
  console.log(`  organizer received    : ${xrp(after.organizer - before.organizer)} XRP  (price ${xrp(priceDrops)} x ${sold} = ${xrp(priceDrops * BigInt(sold))}; a primary sale skips the royalty)`)
  console.log(`  broker net            : ${xrp(after.broker - before.broker)} XRP  (fee ${xrp(expectedFee)} x ${sold}, less network fees)`)

  head('6b. Does the orphan-offer check notice what it should?')
  // Two things that must not go unnoticed: an offer the delegate made that we lost
  // track of (inert, the broker can tidy it), and an OPEN offer — what a delegate
  // being misused to give a ticket away would leave behind.
  const probeTx = async (open: boolean) => {
    const mintTx = await client.autofill(
      buildMintTx({ issuerAddress: organizer.classicAddress, taxon, royaltyBps: 500, uri: ticketMetadataUri(event.slug) }) as never,
    )
    const m = await client.submitAndWait(organizer.sign(mintTx).tx_blob)
    const id = typeof m.result.meta === 'object' ? getNFTokenID(m.result.meta) : undefined
    if (!id) throw new Error('probe mint produced no id')
    const offer = await client.autofill({
      TransactionType: 'NFTokenCreateOffer',
      Account: organizer.classicAddress,
      NFTokenID: id,
      Amount: '1000000',
      Flags: 1,
      ...(open ? {} : { Destination: broker.classicAddress }),
    } as never)
    await client.submitAndWait(organizer.sign(offer).tx_blob)
  }
  await probeTx(false) // broker-only, no Listing: inert
  await probeTx(true) // open to anyone, no Listing: exposed
  const found = findOrphanOffers({
    offers: await offersOwnedBy(organizer.classicAddress),
    known: new Map(),
    brokerAddress: broker.classicAddress,
  })
  for (const o of found) console.log(`  ${o.kind.padEnd(8)} ${o.why}  (broker can cancel: ${cancellableByBroker(o, broker.classicAddress)})`)
  console.log(`  ${found.length === 2 && found.some((o) => o.kind === 'exposed') && found.some((o) => o.kind === 'inert') ? 'detected both, classified correctly' : 'UNEXPECTED RESULT'}`)

  head('7. Clean up the database rows (the tickets stay on devnet)')
  // Payload rows are written by the signer seam even in stub mode, and a DEVNET
  // row left in a database a testnet process uses is exactly what the boot-time
  // network guard exists to refuse.
  await prisma.xamanPayload.deleteMany({ where: { userId: { in: buyerUsers.map((u) => u.id) } } })
  await prisma.transfer.deleteMany({ where: { ticket: { eventId: event.id } } })
  await prisma.listingBuyerNotice.deleteMany({ where: { listing: { ticket: { eventId: event.id } } } })
  await prisma.listing.deleteMany({ where: { ticket: { eventId: event.id } } })
  await prisma.ticket.deleteMany({ where: { eventId: event.id } })
  await prisma.event.delete({ where: { id: event.id } })
  await prisma.user.deleteMany({ where: { id: { in: [user.id, ...buyerUsers.map((u) => u.id)] } } })
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
