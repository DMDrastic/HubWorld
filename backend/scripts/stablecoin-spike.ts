/**
 * SPIKE: can a ticket be priced in a STABLECOIN rather than XRP, without losing
 * brokered settlement, the platform fee, or the organizer's royalty?
 *
 * The motivation is onboarding. Asking a normal person to buy XRP before they
 * can buy a ticket is a real barrier, and pricing in something dollar-shaped
 * removes one part of it. The question is what it costs architecturally.
 *
 * `Amount` on both `NFTokenCreateOffer` and `NFTokenBrokerFee` is
 * `IssuedCurrencyAmount | string`, so the TYPES allow an IOU. That says nothing
 * about whether the ledger settles it correctly, which is what this measures:
 *
 *   Q1  Does a brokered sale work at all when both offers are denominated in an
 *       issued currency?
 *   Q2  Can `NFTokenBrokerFee` — the platform fee — be taken in that currency?
 *   Q3  Does `TransferFee` still pay the ORGANIZER their royalty, in the
 *       stablecoin? This is the one that decides it: a royalty that silently
 *       stops being collected is money quietly not earned.
 *   Q4  What does it cost the buyer in extra setup?
 *
 * Deliberately NOT reusing the shipped `buildSellOfferTx` / `buildBuyOfferTx`,
 * because those take `amountDrops: bigint` — the whole point is to find out
 * whether that signature would have to change.
 *
 * Testnet, faucet-funded. Touches no repo credentials and no database.
 *   npx tsx scripts/stablecoin-spike.ts
 */
import type { Wallet } from 'xrpl'
import { ledger, disconnectLedger, buildMintTx, offerIndexFromTx } from '../src/ledger.js'

const USD = 'USD'
const PRICE = '100' // what the seller asks
const FEE = '5' // Hubworld's cut, taken from the spread
const BID = '105' // buyer must cover price + fee
const ROYALTY_BPS = 500 // 5%, paid to the NFT issuer

function head(s: string) {
  console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`)
}

async function submit(signer: Wallet, tx: object, label: string) {
  const client = await ledger()
  try {
    const prepared = await client.autofill(tx as never)
    const res = await client.submitAndWait(signer.sign(prepared).tx_blob)
    const meta = res.result.meta
    const code = typeof meta === 'object' ? meta.TransactionResult : String(meta)
    console.log(`  ${label}: ${code}`)
    return { code, hash: res.result.hash as string }
  } catch (e) {
    console.log(`  ${label}: FAILED — ${(e as Error).message.slice(0, 150)}`)
    return { code: 'failed', hash: '' }
  }
}

/** A holder's stablecoin balance, read from their trustlines. */
async function usdBalance(address: string, issuer: string): Promise<string> {
  const client = await ledger()
  const res = await client.request({ command: 'account_lines', account: address, peer: issuer })
  const line = res.result.lines.find((l) => l.currency === USD)
  return line ? line.balance : '(no trustline)'
}

async function main() {
  const client = await ledger()

  head('Wallets')
  const { wallet: bank } = await client.fundWallet() // the stablecoin issuer
  const { wallet: organizer } = await client.fundWallet() // NFT issuer, royalty recipient
  const { wallet: seller } = await client.fundWallet()
  const { wallet: buyer } = await client.fundWallet()
  const { wallet: broker } = await client.fundWallet() // Hubworld
  console.log(`  bank (stablecoin issuer): ${bank.classicAddress}`)
  console.log(`  organizer (NFT issuer)  : ${organizer.classicAddress}`)
  console.log(`  seller / buyer / broker  set up below`)

  head('Setup: the stablecoin, and who can hold it')
  // Without DefaultRipple, balances cannot move BETWEEN third parties — the
  // seller could never receive from the buyer. A real issuer sets this; worth
  // noting because it is a property of the stablecoin, not of Hubworld.
  await submit(
    bank,
    { TransactionType: 'AccountSet', Account: bank.classicAddress, SetFlag: 8 },
    'bank: asfDefaultRipple',
  )

  // EVERY party needs a trustline, including the organizer — otherwise there is
  // nowhere for their royalty to land.
  for (const [w, name] of [
    [organizer, 'organizer'],
    [seller, 'seller'],
    [buyer, 'buyer'],
    [broker, 'broker'],
  ] as const) {
    await submit(
      w,
      {
        TransactionType: 'TrustSet',
        Account: w.classicAddress,
        LimitAmount: { currency: USD, issuer: bank.classicAddress, value: '1000000' },
      },
      `${name}: trustline`,
    )
  }

  await submit(
    bank,
    {
      TransactionType: 'Payment',
      Account: bank.classicAddress,
      Destination: buyer.classicAddress,
      Amount: { currency: USD, issuer: bank.classicAddress, value: '1000' },
    },
    'bank funds the buyer with 1000 USD',
  )

  head('Setup: mint a ticket and move it to the seller')
  // The organizer must NOT be party to the sale, or XRPL skips TransferFee
  // entirely and Q3 would be untestable.
  const mint = await submit(
    organizer,
    buildMintTx({ issuerAddress: organizer.classicAddress, taxon: 70_002, royaltyBps: ROYALTY_BPS }),
    'organizer mints (5% royalty)',
  )
  const nfts = await client.request({
    command: 'account_nfts',
    account: organizer.classicAddress,
    ledger_index: 'validated',
  })
  const nfTokenId = nfts.result.account_nfts[0]!.NFTokenID
  console.log(`  NFTokenID: ${nfTokenId}`)

  const gift = await submit(
    organizer,
    {
      TransactionType: 'NFTokenCreateOffer',
      Account: organizer.classicAddress,
      NFTokenID: nfTokenId,
      Amount: '0',
      Destination: seller.classicAddress,
      Flags: 1,
    },
    'organizer gifts to seller',
  )
  const giftIndex = await offerIndexFromTx(gift.hash)
  await submit(
    seller,
    {
      TransactionType: 'NFTokenAcceptOffer',
      Account: seller.classicAddress,
      NFTokenSellOffer: giftIndex!,
    },
    'seller accepts',
  )

  head('Q1/Q2: a brokered sale priced entirely in USD')
  const before = {
    seller: await usdBalance(seller.classicAddress, bank.classicAddress),
    buyer: await usdBalance(buyer.classicAddress, bank.classicAddress),
    broker: await usdBalance(broker.classicAddress, bank.classicAddress),
    organizer: await usdBalance(organizer.classicAddress, bank.classicAddress),
  }

  const sell = await submit(
    seller,
    {
      TransactionType: 'NFTokenCreateOffer',
      Account: seller.classicAddress,
      NFTokenID: nfTokenId,
      Amount: { currency: USD, issuer: bank.classicAddress, value: PRICE },
      Destination: broker.classicAddress,
      Flags: 1, // tfSellNFToken
    },
    `seller lists at ${PRICE} USD (broker-only)`,
  )
  const buy = await submit(
    buyer,
    {
      TransactionType: 'NFTokenCreateOffer',
      Account: buyer.classicAddress,
      NFTokenID: nfTokenId,
      Amount: { currency: USD, issuer: bank.classicAddress, value: BID },
      Owner: seller.classicAddress,
      Destination: broker.classicAddress,
    },
    `buyer bids ${BID} USD (price + fee)`,
  )

  const sellIndex = await offerIndexFromTx(sell.hash)
  const buyIndex = await offerIndexFromTx(buy.hash)
  const settled = await submit(
    broker,
    {
      TransactionType: 'NFTokenAcceptOffer',
      Account: broker.classicAddress,
      NFTokenSellOffer: sellIndex!,
      NFTokenBuyOffer: buyIndex!,
      NFTokenBrokerFee: { currency: USD, issuer: bank.classicAddress, value: FEE },
    },
    `broker settles, taking ${FEE} USD`,
  )

  head('Q3: did the organizer receive their royalty, in USD?')
  const after = {
    seller: await usdBalance(seller.classicAddress, bank.classicAddress),
    buyer: await usdBalance(buyer.classicAddress, bank.classicAddress),
    broker: await usdBalance(broker.classicAddress, bank.classicAddress),
    organizer: await usdBalance(organizer.classicAddress, bank.classicAddress),
  }
  for (const k of ['buyer', 'seller', 'broker', 'organizer'] as const) {
    console.log(`  ${k.padEnd(10)} ${String(before[k]).padStart(10)} -> ${String(after[k]).padStart(10)}`)
  }

  const owner = await client.request({
    command: 'nft_info' as never,
    nft_id: nfTokenId,
  } as never).catch(() => null)
  if (owner) console.log(`  NFT owner now: ${(owner as { result?: { owner?: string } }).result?.owner}`)

  console.log('\n  Reading:')
  console.log('    seller up ~95, organizer up ~5, broker up 5  => everything survives in USD.')
  console.log('    organizer unchanged                          => the royalty is NOT collected.')
  console.log(`    settlement result was: ${settled.code}`)

  head('Q4: what did it cost the buyer in setup?')
  console.log('  1 TrustSet signature before they can hold the currency at all,')
  console.log('  plus 0.2 XRP of owner reserve for that trustline — so the buyer')
  console.log('  STILL needs XRP, and still needs a wallet. Pricing in a stablecoin')
  console.log('  removes the "buy XRP to pay" step, not the "fund a wallet" step.')

  await disconnectLedger()
}

main().catch(async (e) => {
  console.error('SPIKE FAILED:', e)
  await disconnectLedger()
  process.exit(1)
})
