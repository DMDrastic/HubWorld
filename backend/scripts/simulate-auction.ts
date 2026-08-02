/**
 * Drive a complete auction end to end with simulated wallets.
 *
 * A real auction needs on-ledger signatures from a holder and every bidder, so
 * it normally cannot be produced without people and phones. This generates
 * throwaway wallets, funds them from the testnet faucet, and signs as them — so
 * the offers are REAL NFTokenCreateOffers, the settlement is a real brokered
 * NFTokenAcceptOffer, and the money genuinely moves.
 *
 * That distinction matters. `auction:create` fabricates Bid rows for the chart
 * and settles against nothing; this produces an auction the sweep can actually
 * close.
 *
 *   npm run simulate:auction                 # ends in 10 minutes, watch it live
 *   npm run simulate:auction -- --now        # already closed, sweep settles it
 *
 * DEV ONLY. It holds seeds for the wallets it creates, which is exactly why it
 * refuses to run in production or against mainnet.
 */
import { Client, Wallet, type SubmittableTransaction } from 'xrpl'
import { prisma } from '../src/prisma.js'
import { NETWORK } from '../src/network.js'
import { env } from '../src/env.js'
import {
  XRPL_ENDPOINT,
  buildBuyOfferTx,
  buildMintTx,
  buildSellOfferTx,
  auctionSellAmountDrops,
  platformAddress,
  platformFeeDrops,
} from '../src/ledger.js'

const XRP = 1_000_000n
const TAG = 'sim'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

/** Sign and submit as a simulated wallet, returning the validated metadata. */
async function submit(client: Client, wallet: Wallet, tx: SubmittableTransaction) {
  const prepared = await client.autofill(tx)
  const signed = wallet.sign(prepared)
  const res = await client.submitAndWait(signed.tx_blob)
  const meta = res.result.meta
  const result = meta && typeof meta !== 'string' ? meta.TransactionResult : 'unknown'
  if (result !== 'tesSUCCESS') {
    throw new Error(`${tx.TransactionType} failed: ${result}`)
  }
  return { hash: res.result.hash, meta }
}

/** The ledger assigns offer indexes; they are only readable from metadata. */
function offerIndexFrom(meta: unknown): string {
  const nodes = (meta as { AffectedNodes?: unknown[] })?.AffectedNodes ?? []
  for (const node of nodes) {
    const created = (node as { CreatedNode?: { LedgerEntryType?: string; LedgerIndex?: string } })
      .CreatedNode
    if (created?.LedgerEntryType === 'NFTokenOffer' && created.LedgerIndex) {
      return created.LedgerIndex
    }
  }
  throw new Error('no NFTokenOffer created')
}

function nfTokenIdFrom(meta: unknown): string {
  // The minted id appears as the new entry in the owner's NFTokenPage.
  const nodes = (meta as { AffectedNodes?: unknown[] })?.AffectedNodes ?? []
  const ids: string[] = []
  for (const node of nodes) {
    for (const key of ['CreatedNode', 'ModifiedNode'] as const) {
      const n = (node as Record<string, { LedgerEntryType?: string; NewFields?: unknown; FinalFields?: unknown }>)[key]
      if (n?.LedgerEntryType !== 'NFTokenPage') continue
      const fields = (n.NewFields ?? n.FinalFields) as { NFTokens?: Array<{ NFToken: { NFTokenID: string } }> }
      for (const t of fields?.NFTokens ?? []) ids.push(t.NFToken.NFTokenID)
    }
  }
  if (ids.length === 0) throw new Error('no NFTokenID in mint metadata')
  // Highest serial is the newest.
  return ids.sort().at(-1)!
}

async function fundedWallet(client: Client, label: string): Promise<Wallet> {
  const w = Wallet.generate()
  const res = await fetch('https://faucet.altnet.rippletest.net/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destination: w.classicAddress }),
  })
  if (!res.ok) throw new Error(`faucet failed for ${label}: ${res.status}`)

  // The faucet returns before the account is validated.
  for (let i = 0; i < 12; i++) {
    try {
      await client.request({ command: 'account_info', account: w.classicAddress, ledger_index: 'validated' })
      return w
    } catch {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  throw new Error(`${label} never activated`)
}

async function main() {
  if (env.NODE_ENV === 'production') {
    console.error('Refusing to run in production.')
    process.exit(1)
  }
  if (env.XRPL_NETWORK === 'mainnet') {
    console.error('Refusing to run against mainnet — this signs for generated wallets.')
    process.exit(1)
  }
  if (!env.PLATFORM_SEED) {
    console.error('PLATFORM_SEED is not set, so nothing could settle. Run platform:setup.')
    process.exit(1)
  }

  const closeNow = process.argv.includes('--now')
  const minutes = Number(arg('minutes') ?? 10)
  const reserve = BigInt(arg('reserve') ?? 10) * XRP
  const uniq = Date.now().toString(36).slice(-5)

  const client = new Client(XRPL_ENDPOINT)
  await client.connect()

  try {
    console.log('funding simulated wallets…')
    const [organizer, seller, bidderA, bidderB] = await Promise.all([
      fundedWallet(client, 'organizer'),
      fundedWallet(client, 'seller'),
      fundedWallet(client, 'bidder-a'),
      fundedWallet(client, 'bidder-b'),
    ])

    const mkUser = (w: Wallet, name: string) =>
      prisma.user.create({
        data: { username: `${TAG}-${name}-${uniq}`, xrplAddress: w.classicAddress },
      })

    const uOrganizer = await mkUser(organizer, 'organizer')
    const uSeller = await mkUser(seller, 'seller')
    const uA = await mkUser(bidderA, 'bidder-a')
    const uB = await mkUser(bidderB, 'bidder-b')
    await prisma.user.update({ where: { id: uOrganizer.id }, data: { role: 'ORGANIZER' } })

    const event = await prisma.event.create({
      data: {
        network: NETWORK,
        slug: `${TAG}-auction-${uniq}`,
        title: `Simulated Auction ${uniq}`,
        venue: 'The Nexus',
        startsAt: new Date(Date.now() + 7 * 86_400_000),
        organizerId: uOrganizer.id,
        nftTaxon: 50000 + Math.floor(Math.random() * 9000),
        royaltyBps: 500,
        platformBps: env.PLATFORM_FEE_BPS,
        ticketCount: 1,
        status: 'PUBLISHED',
      },
    })

    console.log('minting…')
    const mint = await submit(
      client,
      organizer,
      buildMintTx({ issuerAddress: organizer.classicAddress, taxon: event.nftTaxon, royaltyBps: 500 }) as SubmittableTransaction,
    )
    const nfTokenId = nfTokenIdFrom(mint.meta)

    // Move it to the seller so the organizer holds nothing — that is what makes
    // the event sold out, which is what permits an auction at all.
    console.log('transferring to the seller…')
    const giftOffer = await submit(client, organizer, {
      TransactionType: 'NFTokenCreateOffer',
      Account: organizer.classicAddress,
      NFTokenID: nfTokenId,
      Amount: '0',
      Destination: seller.classicAddress,
      Flags: 1,
    } as SubmittableTransaction)
    await submit(client, seller, {
      TransactionType: 'NFTokenAcceptOffer',
      Account: seller.classicAddress,
      NFTokenSellOffer: offerIndexFrom(giftOffer.meta),
    } as SubmittableTransaction)

    const ticket = await prisma.ticket.create({
      data: {
        network: NETWORK,
        nfTokenId,
        eventId: event.id,
        ownerId: uSeller.id,
        ownerAddress: seller.classicAddress,
        syncedAt: new Date(),
        tier: 'GA',
        status: 'IN_AUCTION',
      },
    })

    // The holder's sell offer, priced below the reserve by the fee-at-reserve so
    // a bid at exactly the reserve still satisfies buy >= sell + brokerFee.
    console.log('placing the sell offer…')
    const sellAmount = auctionSellAmountDrops(reserve, event.platformBps)
    const sellTx = await submit(
      client,
      seller,
      buildSellOfferTx({
        ownerAddress: seller.classicAddress,
        nfTokenId,
        amountDrops: sellAmount,
        brokerAddress: platformAddress(),
      }) as SubmittableTransaction,
    )

    const endsAt = closeNow ? new Date(Date.now() - 1000) : new Date(Date.now() + minutes * 60_000)
    const auction = await prisma.auction.create({
      data: {
        network: NETWORK,
        ticketId: ticket.id,
        startsAt: new Date(Date.now() - 60_000),
        endsAt,
        reserveDrops: reserve,
        status: 'LIVE',
      },
    })

    await prisma.listing.create({
      data: {
        network: NETWORK,
        ticketId: ticket.id,
        sellerId: uSeller.id,
        sellerAddress: seller.classicAddress,
        priceDrops: sellAmount,
        platformFeeDrops: platformFeeDrops(reserve, event.platformBps),
        listPayloadUuid: `${TAG}-${uniq}-list`,
        expiresAt: new Date(Date.now() + 86_400_000),
        offerIndex: offerIndexFrom(sellTx.meta),
        listTxHash: sellTx.hash,
        listedAt: new Date(),
        status: 'ACTIVE',
        auctionId: auction.id,
      },
    })

    console.log('placing bids…')
    const bids: Array<{ wallet: Wallet; user: { id: string }; amount: bigint }> = [
      { wallet: bidderA, user: uA, amount: reserve + 2n * XRP },
      { wallet: bidderB, user: uB, amount: reserve + 5n * XRP },
    ]

    for (const [i, b] of bids.entries()) {
      const tx = await submit(
        client,
        b.wallet,
        buildBuyOfferTx({
          buyerAddress: b.wallet.classicAddress,
          ownerAddress: seller.classicAddress,
          nfTokenId,
          amountDrops: b.amount,
          brokerAddress: platformAddress(),
        }) as SubmittableTransaction,
      )
      await prisma.bid.create({
        data: {
          network: NETWORK,
          auctionId: auction.id,
          bidderId: b.user.id,
          bidderAddress: b.wallet.classicAddress,
          amountDrops: b.amount,
          // Highest bid leads; the earlier one is already outbid.
          status: i === bids.length - 1 ? 'COMMITTED' : 'OUTBID',
          buyOfferIndex: offerIndexFrom(tx.meta),
          buyTxHash: tx.hash,
          committedAt: new Date(),
          bidPayloadUuid: `${TAG}-${uniq}-bid${i}`,
        },
      })
    }

    const top = bids.at(-1)!
    const fee = platformFeeDrops(top.amount, event.platformBps)

    console.log('\nauction ready — every offer is real and on-ledger')
    console.log(`  event      ${event.slug}`)
    console.log(`  seller     @${uSeller.username}`)
    console.log(`  reserve    ${Number(reserve) / 1e6} XRP`)
    console.log(`  bids       ${bids.map((b) => Number(b.amount) / 1e6).join(', ')} XRP`)
    console.log(`  closes     ${closeNow ? 'already (sweep settles within 15s)' : `in ${minutes} min`}`)
    console.log('\nexpected settlement:')
    console.log(`  winner pays      ${Number(top.amount) / 1e6}`)
    console.log(`  platform fee     ${Number(fee) / 1e6}`)
    console.log(`  royalty (5%)     ${Number(platformFeeDrops(top.amount - fee, 500)) / 1e6}`)
    console.log(
      `  seller receives  ${Number(top.amount - fee - platformFeeDrops(top.amount - fee, 500)) / 1e6}`,
    )
  } finally {
    await client.disconnect()
    await prisma.$disconnect()
  }
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err)
  await prisma.$disconnect()
  process.exit(1)
})
