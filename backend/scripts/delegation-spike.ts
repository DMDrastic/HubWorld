/**
 * SPIKE: can an organizer delegate ONLY `NFTokenMint` to HubWorld, and does the
 * resulting NFT still have the ORGANIZER as its issuer?
 *
 * This is the corner of the minting triangle we wrote off. `CLAUDE.md` says the
 * organizer must be the issuer because `TransferFee` pays the issuer, and that
 * HubWorld cannot sign as anyone — so the organizer taps once per ticket and the
 * product caps out in the low hundreds. `PermissionDelegationV1_1` offers scoped
 * delegation, unlike `RegularKey`, which is unscoped and would also hand over
 * the ability to send payments.
 *
 * THE QUESTION THAT DECIDES IT: after a delegated mint, is `Issuer` the
 * organizer or the delegate? If it is the delegate, the royalty model collapses
 * and this whole path is dead. Everything else here is secondary.
 *
 * Runs on DEVNET, where PermissionDelegationV1_1 is already active (it is still
 * pending on testnet and absent from mainnet). Faucet-funded throwaway wallets;
 * touches no repo credentials and no database.
 *
 *   npx tsx scripts/delegation-spike.ts
 */
import { Client, Wallet } from 'xrpl'

const DEVNET = 'wss://s.devnet.rippletest.net:51233'

/** 5% royalty, the same shape an organizer sets today via royaltyBps. */
const TRANSFER_FEE = 5000
const TAXON = 70_001

function head(s: string) {
  console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`)
}

async function submit(client: Client, signer: Wallet, tx: object, label: string) {
  try {
    const prepared = await client.autofill(tx as never)
    const res = await client.submitAndWait(signer.sign(prepared).tx_blob)
    const meta = res.result.meta
    const code = typeof meta === 'object' ? meta.TransactionResult : String(meta)
    console.log(`  ${label}: ${code}`)
    return { code, res }
  } catch (e) {
    const msg = (e as Error).message
    console.log(`  ${label}: THREW — ${msg.slice(0, 200)}`)
    return { code: 'threw', res: null }
  }
}

async function xrpBalance(client: Client, address: string): Promise<number> {
  const r = await client.request({
    command: 'account_info',
    account: address,
    ledger_index: 'validated',
  })
  return Number(r.result.account_data.Balance) / 1_000_000
}

async function main() {
  const client = new Client(DEVNET)
  await client.connect()

  const info = await client.request({ command: 'server_info' })
  console.log(`devnet rippled: ${info.result.info.build_version}`)

  head('Wallets')
  const { wallet: organizer } = await client.fundWallet()
  const { wallet: hubworld } = await client.fundWallet()
  console.log(`  organizer (issuer, delegator): ${organizer.classicAddress}`)
  console.log(`  hubworld  (delegate, signer) : ${hubworld.classicAddress}`)

  // ------------------------------------------------------------ delegate ----
  head('1. Organizer grants HubWorld the NFTokenMint permission ONLY')
  const grant = await submit(
    client,
    organizer,
    {
      TransactionType: 'DelegateSet',
      Account: organizer.classicAddress,
      Authorize: hubworld.classicAddress,
      Permissions: [{ Permission: { PermissionValue: 'NFTokenMint' } }],
    },
    'DelegateSet (NFTokenMint only)',
  )
  if (grant.code !== 'tesSUCCESS') {
    console.log('\n  Delegation was not granted — everything below is moot.')
    await client.disconnect()
    return
  }

  // ---------------------------------------------------------- the test ----
  head('2. HubWorld mints AS the organizer — signed with HubWorld\'s key')
  const orgBefore = await xrpBalance(client, organizer.classicAddress)
  const hubBefore = await xrpBalance(client, hubworld.classicAddress)

  const mint = await submit(
    client,
    hubworld, // signed by HubWorld...
    {
      TransactionType: 'NFTokenMint',
      Account: organizer.classicAddress, // ...but the account is the organizer
      Delegate: hubworld.classicAddress,
      NFTokenTaxon: TAXON,
      TransferFee: TRANSFER_FEE,
      Flags: 8, // tfTransferable
      URI: Buffer.from('ipfs://hubworld-delegation-spike').toString('hex').toUpperCase(),
    },
    'NFTokenMint by delegate',
  )

  head('3. THE ANSWER: who is the issuer?')
  if (mint.code === 'tesSUCCESS') {
    const nfts = await client.request({
      command: 'account_nfts',
      account: organizer.classicAddress,
      ledger_index: 'validated',
    })
    const list = nfts.result.account_nfts
    console.log(`  NFTs now in the ORGANIZER's account: ${list.length}`)
    if (list.length > 0) {
      const n = list[0]!
      console.log(`    NFTokenID  : ${n.NFTokenID}`)
      console.log(`    Issuer     : ${n.Issuer ?? organizer.classicAddress} ${
        (n.Issuer ?? organizer.classicAddress) === organizer.classicAddress
          ? '  <-- ORGANIZER. Royalty model survives.'
          : '  <-- NOT the organizer. Royalty model collapses.'
      }`)
      console.log(`    TransferFee: ${n.TransferFee} (${(n.TransferFee ?? 0) / 1000}%)`)
    }
    const hubNfts = await client.request({
      command: 'account_nfts',
      account: hubworld.classicAddress,
      ledger_index: 'validated',
    })
    console.log(`  NFTs in HUBWORLD's account: ${hubNfts.result.account_nfts.length} (expect 0)`)
  } else {
    console.log('  Mint failed, so there is nothing to inspect.')
  }

  head('4. Who paid the transaction fee?')
  const orgAfter = await xrpBalance(client, organizer.classicAddress)
  const hubAfter = await xrpBalance(client, hubworld.classicAddress)
  console.log(`  organizer: ${orgBefore.toFixed(6)} -> ${orgAfter.toFixed(6)}  (${(orgAfter - orgBefore).toFixed(6)})`)
  console.log(`  hubworld : ${hubBefore.toFixed(6)} -> ${hubAfter.toFixed(6)}  (${(hubAfter - hubBefore).toFixed(6)})`)

  // ------------------------------------------------------------- scope ----
  head('5. Is the permission really scoped? HubWorld tries to send the organizer\'s XRP')
  await submit(
    client,
    hubworld,
    {
      TransactionType: 'Payment',
      Account: organizer.classicAddress,
      Delegate: hubworld.classicAddress,
      Destination: hubworld.classicAddress,
      Amount: '1000000',
    },
    'Payment as organizer (must FAIL)',
  )
  console.log('  >> A failure here is the point: this is what RegularKey would have allowed.')

  // -------------------------------------------------------- revocation ----
  head('6. Revocation')
  await submit(
    client,
    organizer,
    {
      TransactionType: 'DelegateSet',
      Account: organizer.classicAddress,
      Authorize: hubworld.classicAddress,
      Permissions: [],
    },
    'DelegateSet with empty Permissions',
  )
  await submit(
    client,
    hubworld,
    {
      TransactionType: 'NFTokenMint',
      Account: organizer.classicAddress,
      Delegate: hubworld.classicAddress,
      NFTokenTaxon: TAXON,
      TransferFee: TRANSFER_FEE,
      Flags: 8,
    },
    'mint after revocation (must FAIL)',
  )

  head('Done — devnet, throwaway wallets')
  await client.disconnect()
}

main().catch((e) => {
  console.error('SPIKE FAILED:', e)
  process.exit(1)
})
