/**
 * SPIKE: can one signature mint a ticket AND list it for sale?
 *
 * NOT production code and not imported by anything. It exists to answer, with
 * observed facts, whether `NFTokenMintOffer` collapses two organizer signatures
 * into one without giving up anything the brokered model depends on.
 *
 * Why it matters: the mainnet rehearsal measured the real cost of an event at
 * roughly THREE payloads per ticket sold — mint, list, buy — plus two per
 * attendee. A 20-ticket event is ~100 payloads against a cap we have hit at ~77.
 * Payload count, not ledger cost, is what caps event size today. Removing the
 * separate list step takes a third off the per-ticket cost, and unlike scoped
 * delegation it needs no amendment we are waiting for: `NFTokenMintOffer` is
 * ENABLED on mainnet (verified 2026-08-13).
 *
 * Four questions, and a "no" to any one of them sinks it:
 *
 *   Q1  Does NFTokenMint with Amount + Destination actually create a sell offer
 *       in the same transaction?
 *   Q2  Can we still read the offer index back out of the metadata? Our whole
 *       Listing model is keyed on it, and `offerIndexFromTx` was written for
 *       NFTokenCreateOffer.
 *   Q3  Does the resulting offer carry Destination = broker? Without it, a buyer
 *       could take the offer directly and the platform fee is bypassable —
 *       brokerage is only enforced when neither party can settle alone.
 *   Q4  Does a brokered NFTokenAcceptOffer still settle it, with the fee taken
 *       from the spread?
 *
 * Testnet only, funded from the faucet, signing directly. It touches no repo
 * credentials, no database, and crucially NO XAMAN PAYLOADS — the quota this
 * whole exercise exists to conserve.
 *
 *   npx tsx scripts/mint-offer-spike.ts
 */
import {
  Client,
  Wallet,
  convertStringToHex,
  type NFTokenAcceptOffer,
  type NFTokenCreateOffer,
  type NFTokenMint,
} from 'xrpl'

const TESTNET = 'wss://s.altnet.rippletest.net:51233'

const TF_TRANSFERABLE = 8
const TF_MUTABLE = 16
const TF_SELL_NFTOKEN = 1

const PRICE_DROPS = '1000000' // 1 XRP, as in the mainnet rehearsal
const PLATFORM_FEE_DROPS = '25000' // 250 bps of 1 XRP
const ROYALTY = 5000 // 5%, expressed as TransferFee

const xrp = (drops: string | number) => (Number(drops) / 1_000_000).toFixed(6)

function head(s: string) {
  console.log(`\n=== ${s} ===`)
}

async function balance(c: Client, address: string): Promise<number> {
  const r = await c.request({ command: 'account_info', account: address, ledger_index: 'validated' })
  return Number(r.result.account_data.Balance)
}

async function main() {
  const client = new Client(TESTNET)
  await client.connect()

  head('funding three accounts from the faucet')
  const { wallet: organizer } = await client.fundWallet()
  const { wallet: broker } = await client.fundWallet()
  const { wallet: buyer } = await client.fundWallet()
  console.log('organizer (issuer):', organizer.classicAddress)
  console.log('broker:            ', broker.classicAddress)
  console.log('buyer:             ', buyer.classicAddress)

  // ---------------------------------------------------------------- Q1 + Q2 --
  head('Q1/Q2: mint AND list in one transaction')

  const mint: NFTokenMint = {
    TransactionType: 'NFTokenMint',
    Account: organizer.classicAddress,
    NFTokenTaxon: 1,
    Flags: TF_TRANSFERABLE | TF_MUTABLE,
    TransferFee: ROYALTY,
    URI: convertStringToHex('https://hubworld.app/api/events/spike/nft.json'),
    // The whole point: an offer created by the mint itself.
    Amount: PRICE_DROPS,
    Destination: broker.classicAddress,
  }

  const minted = await client.submitAndWait(mint, { wallet: organizer, autofill: true })
  const mintMeta = minted.result.meta
  if (typeof mintMeta === 'string' || !mintMeta) throw new Error('no metadata')
  console.log('result:', mintMeta.TransactionResult)
  if (mintMeta.TransactionResult !== 'tesSUCCESS') {
    console.log('ANSWER: NO — the combined mint was rejected.')
    await client.disconnect()
    return
  }

  const nfTokenId = (mintMeta as unknown as { nftoken_id?: string }).nftoken_id
  // Exactly what `offerIndexFromTx` does in src/ledger.ts, so a pass here means
  // the shipped helper needs no change.
  let offerIndex: string | null = null
  for (const node of mintMeta.AffectedNodes) {
    if ('CreatedNode' in node && node.CreatedNode.LedgerEntryType === 'NFTokenOffer') {
      offerIndex = node.CreatedNode.LedgerIndex
    }
  }

  console.log('NFTokenID:   ', nfTokenId)
  console.log('offer index: ', offerIndex ?? '(none — Q2 FAILS)')
  console.log('signatures so far: 1  (today this would be 2: mint, then list)')

  if (!nfTokenId || !offerIndex) {
    console.log('ANSWER: NO — mint produced no offer, or none we can read back.')
    await client.disconnect()
    return
  }

  // --------------------------------------------------------------------- Q3 --
  head('Q3: is the offer locked to the broker?')
  const offerEntry = await client.request({
    command: 'ledger_entry',
    index: offerIndex,
    ledger_index: 'validated',
  })
  const offer = offerEntry.result.node as unknown as {
    Amount: string
    Destination?: string
    Flags: number
    Owner: string
  }
  console.log('Amount:     ', xrp(offer.Amount), 'XRP')
  console.log('Destination:', offer.Destination ?? '(NONE — fee is bypassable)')
  console.log('Owner:      ', offer.Owner)
  console.log('sell offer: ', (offer.Flags & TF_SELL_NFTOKEN) === TF_SELL_NFTOKEN)
  const lockedToBroker = offer.Destination === broker.classicAddress

  // --------------------------------------------------------------------- Q4 --
  head('Q4: does it still settle brokered, with the fee from the spread?')

  const before = {
    organizer: await balance(client, organizer.classicAddress),
    broker: await balance(client, broker.classicAddress),
    buyer: await balance(client, buyer.classicAddress),
  }

  const bid: NFTokenCreateOffer = {
    TransactionType: 'NFTokenCreateOffer',
    Account: buyer.classicAddress,
    NFTokenID: nfTokenId,
    Amount: String(Number(PRICE_DROPS) + Number(PLATFORM_FEE_DROPS)),
    Owner: organizer.classicAddress,
    Destination: broker.classicAddress,
  }
  const bidResult = await client.submitAndWait(bid, { wallet: buyer, autofill: true })
  const bidMeta = bidResult.result.meta
  if (typeof bidMeta === 'string' || !bidMeta) throw new Error('no bid metadata')
  let buyOfferIndex: string | null = null
  for (const node of bidMeta.AffectedNodes) {
    if ('CreatedNode' in node && node.CreatedNode.LedgerEntryType === 'NFTokenOffer') {
      buyOfferIndex = node.CreatedNode.LedgerIndex
    }
  }
  console.log('buy offer:', buyOfferIndex)

  const accept: NFTokenAcceptOffer = {
    TransactionType: 'NFTokenAcceptOffer',
    Account: broker.classicAddress,
    NFTokenSellOffer: offerIndex,
    NFTokenBuyOffer: buyOfferIndex!,
    NFTokenBrokerFee: PLATFORM_FEE_DROPS,
  }
  const settled = await client.submitAndWait(accept, { wallet: broker, autofill: true })
  const settleMeta = settled.result.meta
  const settleOk =
    typeof settleMeta !== 'string' && settleMeta?.TransactionResult === 'tesSUCCESS'
  console.log('brokered accept:', typeof settleMeta === 'string' ? '?' : settleMeta?.TransactionResult)

  const after = {
    organizer: await balance(client, organizer.classicAddress),
    broker: await balance(client, broker.classicAddress),
    buyer: await balance(client, buyer.classicAddress),
  }

  head('money moved')
  for (const k of ['organizer', 'broker', 'buyer'] as const) {
    const d = (after[k] - before[k]) / 1_000_000
    console.log(`${k.padEnd(10)} ${d >= 0 ? '+' : ''}${d.toFixed(6)} XRP`)
  }

  const holder = await client.request({
    command: 'account_nfts',
    account: buyer.classicAddress,
  })
  const buyerHolds = holder.result.account_nfts.some((n) => n.NFTokenID === nfTokenId)

  head('ANSWER')
  console.log('Q1 mint creates a sell offer:      ', Boolean(offerIndex))
  console.log('Q2 offer index readable from meta: ', Boolean(offerIndex))
  console.log('Q3 locked to the broker:           ', lockedToBroker)
  console.log('Q4 settles brokered, fee taken:    ', settleOk && buyerHolds)
  console.log(
    '\nSignatures for one ticket sold:  2 (mint+list, buy)  vs  3 today.' +
      '\nThat is a third off the per-ticket payload cost.',
  )

  await client.disconnect()
}

main().catch(async (e) => {
  console.error('spike failed:', e)
  process.exit(1)
})
