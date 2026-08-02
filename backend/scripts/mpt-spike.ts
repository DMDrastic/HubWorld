/**
 * SPIKE: can Multi-Purpose Tokens carry general admission at thousands-scale?
 *
 * NOT production code and not imported by anything. It exists to answer three
 * questions with observed facts rather than assumption, because the decision it
 * informs — whether general admission becomes an MPT issuance while reserved
 * seating stays NFTs — is expensive to get wrong.
 *
 *   Q1  Does one issuance really cover the whole supply, with a royalty?
 *       (This is the organizer bottleneck: 3,000 NFTokenMints, each signed by
 *       one human, is the wall that stops thousands-scale today.)
 *   Q2  Can a unit be RESOLD with a fee captured, neither party able to settle
 *       alone? This is what `NFTokenAcceptOffer` + `NFTokenBrokerFee` gives us
 *       for NFTs, and it is what the platform fee and the whole auction
 *       mechanism rest on.
 *   Q3  Can the door tell "already admitted" from "no ticket"? A fungible unit
 *       cannot be individually marked used, only counted.
 *
 * Testnet only, funded from the faucet. It touches no repo credentials and no
 * database. Run:  npx tsx scripts/mpt-spike.ts
 */
import { Client, Wallet, type MPTokenIssuanceCreate, type Payment } from 'xrpl'

const TESTNET = 'wss://s.altnet.rippletest.net:51233'

/** 5% — the same royalty shape an organizer sets today via royaltyBps. */
const TRANSFER_FEE = 5000 // MPT TransferFee is in units of 1/100,000
const SUPPLY = '3000' // the scale the NFT path cannot reach

function head(s: string) {
  console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`)
}

async function submit(client: Client, wallet: Wallet, tx: object, label: string) {
  const prepared = await client.autofill(tx as never)
  const signed = wallet.sign(prepared)
  const res = await client.submitAndWait(signed.tx_blob)
  const meta = res.result.meta
  const code = typeof meta === 'object' ? meta.TransactionResult : String(meta)
  console.log(`  ${label}: ${code}`)
  return res
}

/** Units of an issuance held by an account, read from its MPToken objects. */
async function heldUnits(client: Client, address: string, issuanceId: string): Promise<string> {
  const res = await client.request({
    command: 'account_objects',
    account: address,
    type: 'mptoken',
    ledger_index: 'validated',
  })
  const obj = (res.result.account_objects as Array<Record<string, unknown>>).find(
    (o) => o.MPTokenIssuanceID === issuanceId,
  )
  return obj ? String(obj.MPTAmount ?? '0') : '(no MPToken object — not opted in)'
}

async function main() {
  const client = new Client(TESTNET)
  await client.connect()

  head('Funding throwaway testnet wallets')
  const { wallet: issuer } = await client.fundWallet()
  const { wallet: alice } = await client.fundWallet()
  const { wallet: bob } = await client.fundWallet()
  console.log(`  issuer (organizer): ${issuer.classicAddress}`)
  console.log(`  alice  (buyer)    : ${alice.classicAddress}`)
  console.log(`  bob    (resale)   : ${bob.classicAddress}`)

  // ---------------------------------------------------------------- Q1 ----
  head('Q1  One issuance for the whole supply, carrying a royalty')

  const create: MPTokenIssuanceCreate = {
    TransactionType: 'MPTokenIssuanceCreate',
    Account: issuer.classicAddress,
    AssetScale: 0, // whole tickets; there is no half admission
    MaximumAmount: SUPPLY,
    TransferFee: TRANSFER_FEE,
    // TransferFee is only permitted when the token can actually be transferred.
    // CanTrade is set too, so Q2 is tested with the most permissive issuance
    // rather than being refused on a technicality.
    Flags: { tfMPTCanTransfer: true, tfMPTCanTrade: true },
  }
  const created = await submit(client, issuer, create, `MPTokenIssuanceCreate (supply ${SUPPLY})`)
  const createdMeta = created.result.meta as { mpt_issuance_id?: string }
  const issuanceId = createdMeta.mpt_issuance_id
  if (!issuanceId) throw new Error('no mpt_issuance_id in metadata')
  console.log(`  issuance id: ${issuanceId}`)
  console.log(`  >> ${SUPPLY} tickets created in ONE signature by the organizer.`)

  // A holder must opt in before receiving units.
  head('Distribution: holders opt in, then the issuer pays out')
  await submit(
    client,
    alice,
    { TransactionType: 'MPTokenAuthorize', Account: alice.classicAddress, MPTokenIssuanceID: issuanceId },
    'alice MPTokenAuthorize (opt-in)',
  )
  await submit(
    client,
    bob,
    { TransactionType: 'MPTokenAuthorize', Account: bob.classicAddress, MPTokenIssuanceID: issuanceId },
    'bob MPTokenAuthorize (opt-in)',
  )

  const pay: Payment = {
    TransactionType: 'Payment',
    Account: issuer.classicAddress,
    Destination: alice.classicAddress,
    Amount: { mpt_issuance_id: issuanceId, value: '2' },
  }
  await submit(client, issuer, pay, 'issuer -> alice, 2 units')
  console.log(`  alice holds: ${await heldUnits(client, alice.classicAddress, issuanceId)}`)
  console.log('  >> NOTE: opt-in is one signature PER ATTENDEE, before they can be sent a ticket.')

  // ---------------------------------------------------------------- Q2 ----
  head('Q2  Can a unit be resold with a fee captured, atomically?')

  console.log('\n  (a) OfferCreate — can an MPT sit on the DEX order book?')
  try {
    await submit(
      client,
      alice,
      {
        TransactionType: 'OfferCreate',
        Account: alice.classicAddress,
        TakerGets: { mpt_issuance_id: issuanceId, value: '1' },
        TakerPays: '10000000',
      },
      'alice OfferCreate (MPT for XRP)',
    )
  } catch (err) {
    console.log(`  REJECTED: ${(err as Error).message.slice(0, 160)}`)
  }

  console.log('\n  (b) Payment alice -> bob — does TransferFee apply, and to whom?')
  const beforeIssuer = await heldUnits(client, issuer.classicAddress, issuanceId)
  await submit(
    client,
    alice,
    {
      TransactionType: 'Payment',
      Account: alice.classicAddress,
      Destination: bob.classicAddress,
      Amount: { mpt_issuance_id: issuanceId, value: '1' },
    },
    'alice -> bob, 1 unit',
  )
  console.log(`  alice now holds : ${await heldUnits(client, alice.classicAddress, issuanceId)}`)
  console.log(`  bob now holds   : ${await heldUnits(client, bob.classicAddress, issuanceId)}`)
  console.log(`  issuer held     : ${beforeIssuer} -> ${await heldUnits(client, issuer.classicAddress, issuanceId)}`)
  console.log('  >> A Payment moves the TICKET only. Nothing moves XRP the other way in')
  console.log('     the same transaction, so there is no atomic swap and no spread for a')
  console.log('     broker fee to be taken from.')

  // ---------------------------------------------------------------- Q3 ----
  head('Q3  Can the door distinguish "already admitted" from "no ticket"?')
  const res = await client.request({
    command: 'account_objects',
    account: bob.classicAddress,
    type: 'mptoken',
    ledger_index: 'validated',
  })
  console.log('  bob\'s MPToken object as the door would see it:')
  console.log('  ' + JSON.stringify(res.result.account_objects[0], null, 2).replace(/\n/g, '\n  '))
  console.log('\n  >> The object carries a COUNT and no per-unit identity. A holder of 2')
  console.log('     units admitted once is indistinguishable from one admitted twice,')
  console.log('     unless redemption is tracked off-ledger per account.')

  head('Done — throwaway wallets, nothing else touched')
  await client.disconnect()
}

main().catch(async (e) => {
  console.error('\nSPIKE FAILED:', e)
  process.exit(1)
})
