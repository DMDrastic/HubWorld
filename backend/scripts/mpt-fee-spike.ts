/**
 * SPIKE (follow-up): what is an MPT `TransferFee` actually charged IN?
 *
 * `CLAUDE.md` assumes the royalty model survives a move to MPT because
 * "MPTokenIssuance carries a TransferFee". The first spike moved a single unit
 * and the recipient got the whole thing, which at 5% of 1 whole ticket could
 * simply be rounding. This settles it by moving an amount large enough that a
 * 5% fee cannot round away.
 *
 * What is at stake: the NFT `TransferFee` is charged on the SALE AMOUNT in XRP,
 * because `NFTokenAcceptOffer` knows the price. An MPT `Payment` carries no
 * price. So if the fee is charged in TOKENS, an organizer's royalty on a resale
 * is paid in fractions of tickets rather than money — which is not a royalty.
 *
 * Testnet only, faucet-funded. Run:  npx tsx scripts/mpt-fee-spike.ts
 */
import { Client, Wallet, type MPTokenIssuanceCreate } from 'xrpl'

const TESTNET = 'wss://s.altnet.rippletest.net:51233'
const TRANSFER_FEE = 5000 // 5%, in units of 1/100,000
const SEND = '100' // big enough that 5% is 5 whole units, not a rounding artefact

async function submit(client: Client, wallet: Wallet, tx: object, label: string) {
  const prepared = await client.autofill(tx as never)
  const res = await client.submitAndWait(wallet.sign(prepared).tx_blob)
  const meta = res.result.meta
  console.log(`  ${label}: ${typeof meta === 'object' ? meta.TransactionResult : meta}`)
  return res
}

async function held(client: Client, address: string, id: string): Promise<string> {
  const res = await client.request({
    command: 'account_objects',
    account: address,
    type: 'mptoken',
    ledger_index: 'validated',
  })
  const o = (res.result.account_objects as Array<Record<string, unknown>>).find(
    (x) => x.MPTokenIssuanceID === id,
  )
  return o ? String(o.MPTAmount ?? '0') : '(none)'
}

async function main() {
  const client = new Client(TESTNET)
  await client.connect()

  const { wallet: issuer } = await client.fundWallet()
  const { wallet: alice } = await client.fundWallet()
  const { wallet: bob } = await client.fundWallet()

  const create: MPTokenIssuanceCreate = {
    TransactionType: 'MPTokenIssuanceCreate',
    Account: issuer.classicAddress,
    AssetScale: 0,
    MaximumAmount: '10000',
    TransferFee: TRANSFER_FEE,
    Flags: { tfMPTCanTransfer: true },
  }
  const created = await submit(client, issuer, create, 'issuance with 5% TransferFee')
  const id = (created.result.meta as { mpt_issuance_id?: string }).mpt_issuance_id!

  for (const [w, name] of [
    [alice, 'alice'],
    [bob, 'bob'],
  ] as const) {
    await submit(
      client,
      w,
      { TransactionType: 'MPTokenAuthorize', Account: w.classicAddress, MPTokenIssuanceID: id },
      `${name} opt-in`,
    )
  }

  // Issuer -> alice. A transfer involving the issuer should be fee-free, the
  // same way XRPL skips NFT TransferFee when the issuer is party to the trade.
  await submit(
    client,
    issuer,
    {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: alice.classicAddress,
      Amount: { mpt_issuance_id: id, value: '200' },
    },
    'issuer -> alice, 200 units (primary sale)',
  )
  console.log(`  alice holds: ${await held(client, alice.classicAddress, id)}  (expect 200 if issuer is exempt)`)

  console.log(`\n  Now alice -> bob, ${SEND} units. A 5% fee would be 5 whole units.`)
  const aliceBefore = await held(client, alice.classicAddress, id)

  const res = await submit(
    client,
    alice,
    {
      TransactionType: 'Payment',
      Account: alice.classicAddress,
      Destination: bob.classicAddress,
      Amount: { mpt_issuance_id: id, value: SEND },
      // Without this the ledger cannot charge a fee on top of the sent amount.
      SendMax: { mpt_issuance_id: id, value: '1000' },
    },
    `alice -> bob, ${SEND} units`,
  )

  const meta = res.result.meta as { delivered_amount?: unknown; DeliveredAmount?: unknown }
  console.log(`  delivered_amount: ${JSON.stringify(meta.delivered_amount ?? meta.DeliveredAmount)}`)
  console.log(`  alice: ${aliceBefore} -> ${await held(client, alice.classicAddress, id)}`)
  console.log(`  bob  : ${await held(client, bob.classicAddress, id)}`)
  console.log(`  issuer holds back: ${await held(client, issuer.classicAddress, id)}`)

  console.log('\n  VERDICT:')
  console.log('  If alice lost more than bob gained, the fee is charged IN TOKENS —')
  console.log('  meaning an organizer royalty on resale is paid in fractions of')
  console.log('  tickets, not XRP, and the NFT royalty model does NOT carry over.')

  await client.disconnect()
}

main().catch(async (e) => {
  console.error('SPIKE FAILED:', e)
  process.exit(1)
})
