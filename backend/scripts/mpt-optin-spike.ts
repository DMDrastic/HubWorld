/**
 * SPIKE: is `MPTokenAuthorize` actually REQUIRED before a buyer can receive an
 * MPT ticket, or did the first spike just call it out of caution?
 *
 * This is the whole purchase UX. If the opt-in is mandatory, buying a ticket is
 * two buyer signatures — opt in, then pay — plus a delivery they do not control.
 * If it is not, buying is ONE signature: pay, and the ticket arrives.
 *
 * The first spike (`mpt-spike.ts`) authorized every holder unconditionally
 * without testing whether a Payment would have worked regardless, so the cost
 * it reported per attendee may be wrong. This settles it.
 *
 * Testnet, faucet-funded, read-nothing-from-the-repo. Run:
 *   npx tsx scripts/mpt-optin-spike.ts
 */
import { Client, Wallet, type MPTokenIssuanceCreate } from 'xrpl'

const TESTNET = 'wss://s.altnet.rippletest.net:51233'

async function trySubmit(client: Client, wallet: Wallet, tx: object, label: string) {
  try {
    const prepared = await client.autofill(tx as never)
    const res = await client.submitAndWait(wallet.sign(prepared).tx_blob)
    const meta = res.result.meta
    const code = typeof meta === 'object' ? meta.TransactionResult : String(meta)
    console.log(`  ${label}: ${code}`)
    return code
  } catch (e) {
    const msg = (e as Error).message
    console.log(`  ${label}: THREW — ${msg.slice(0, 120)}`)
    return `threw:${msg.slice(0, 40)}`
  }
}

async function mptObjects(client: Client, address: string) {
  const res = await client.request({
    command: 'account_objects',
    account: address,
    type: 'mptoken',
    ledger_index: 'validated',
  })
  return res.result.account_objects as Array<Record<string, unknown>>
}

async function main() {
  const client = new Client(TESTNET)
  await client.connect()

  const { wallet: issuer } = await client.fundWallet()
  const { wallet: buyerA } = await client.fundWallet() // will NOT opt in
  const { wallet: buyerB } = await client.fundWallet() // WILL opt in, as control

  console.log(`issuer: ${issuer.classicAddress}`)
  console.log(`buyerA (no opt-in): ${buyerA.classicAddress}`)
  console.log(`buyerB (opts in)  : ${buyerB.classicAddress}`)

  // Deliberately WITHOUT tfMPTRequireAuth — the most permissive issuance, which
  // is what a ticketing product would use. If an opt-in is still required here,
  // it is required always.
  const create: MPTokenIssuanceCreate = {
    TransactionType: 'MPTokenIssuanceCreate',
    Account: issuer.classicAddress,
    AssetScale: 0,
    MaximumAmount: '3000',
    Flags: { tfMPTCanTransfer: true },
  }
  const created = await trySubmit(client, issuer, create, 'issuance (no RequireAuth)')
  if (created !== 'tesSUCCESS') throw new Error('issuance failed')

  const res = await client.request({
    command: 'account_objects',
    account: issuer.classicAddress,
    type: 'mpt_issuance',
    ledger_index: 'validated',
  })
  const id = String(
    (res.result.account_objects[0] as Record<string, unknown>).mpt_issuance_id ??
      (res.result.account_objects[0] as Record<string, unknown>).MPTokenIssuanceID ??
      '',
  )
  console.log(`  issuance id: ${id}`)

  console.log('\n--- THE TEST: pay a buyer who has NOT opted in ---')
  const code = await trySubmit(
    client,
    issuer,
    {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: buyerA.classicAddress,
      Amount: { mpt_issuance_id: id, value: '1' },
    },
    'issuer -> buyerA (no opt-in)',
  )
  const aObjs = await mptObjects(client, buyerA.classicAddress)
  console.log(`  buyerA MPToken objects after: ${aObjs.length}`)
  if (aObjs.length) console.log(`  buyerA holds: ${aObjs[0]!.MPTAmount}`)

  console.log('\n--- CONTROL: same payment, but buyer opted in first ---')
  await trySubmit(
    client,
    buyerB,
    {
      TransactionType: 'MPTokenAuthorize',
      Account: buyerB.classicAddress,
      MPTokenIssuanceID: id,
    },
    'buyerB MPTokenAuthorize',
  )
  await trySubmit(
    client,
    issuer,
    {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: buyerB.classicAddress,
      Amount: { mpt_issuance_id: id, value: '1' },
    },
    'issuer -> buyerB (opted in)',
  )
  const bObjs = await mptObjects(client, buyerB.classicAddress)
  console.log(`  buyerB holds: ${bObjs.length ? bObjs[0]!.MPTAmount : '(none)'}`)

  console.log('\n--- Can the ISSUER create the holder object on the buyer\'s behalf? ---')
  await trySubmit(
    client,
    issuer,
    {
      TransactionType: 'MPTokenAuthorize',
      Account: issuer.classicAddress,
      MPTokenIssuanceID: id,
      Holder: buyerA.classicAddress,
    },
    'issuer MPTokenAuthorize with Holder=buyerA',
  )
  console.log(`  buyerA MPToken objects now: ${(await mptObjects(client, buyerA.classicAddress)).length}`)

  console.log('\nVERDICT:')
  console.log(`  Payment to a non-opted-in buyer returned: ${code}`)
  console.log('  tesSUCCESS  => buying is ONE buyer signature (just pay).')
  console.log('  anything else => the opt-in is mandatory and buying costs TWO.')

  await client.disconnect()
}

main().catch((e) => {
  console.error('SPIKE FAILED:', e)
  process.exit(1)
})
