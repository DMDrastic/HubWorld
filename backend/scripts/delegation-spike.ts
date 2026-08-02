/**
 * Exercises `src/delegation.ts` against a real ledger.
 *
 * Originally a spike with hand-written transactions; it now drives the SHIPPED
 * builders, so it verifies the code that would actually run rather than a
 * parallel implementation that happens to agree. The unit tests pin the shape
 * of those transactions; this pins that the ledger accepts them and does what
 * we claim.
 *
 * THE QUESTION THAT DECIDES THE DESIGN: after a delegated mint, is `Issuer` the
 * organizer or the delegate? If it is the delegate, `TransferFee` pays Hubworld,
 * the organizer never sees their royalty, and the whole path is dead.
 *
 * Must run against **devnet** — `PermissionDelegationV1_1` is active there,
 * pending on testnet, absent from mainnet:
 *
 *   XRPL_NETWORK=devnet npx tsx scripts/delegation-spike.ts
 *
 * Faucet-funded throwaway wallets. Touches no repo credentials and no database.
 */
import type { Wallet } from 'xrpl'
import { ledger, disconnectLedger, buildMintTx } from '../src/ledger.js'
import {
  asDelegatedMint,
  buildDelegateMintTx,
  buildRevokeMintTx,
  delegationAvailable,
  hasMintPermission,
} from '../src/delegation.js'
import { env } from '../src/env.js'

const TRANSFER_FEE_BPS = 500 // 5%, as an organizer would set via royaltyBps
const TAXON = 70_001

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
    return code
  } catch (e) {
    const msg = (e as Error).message
    // A terNO_DELEGATE_PERMISSION arrives as a throw once the payload expires;
    // the preliminary result is the informative part.
    console.log(`  ${label}: ${msg.includes('terNO_DELEGATE') ? 'terNO_DELEGATE_PERMISSION' : msg.slice(0, 120)}`)
    return 'failed'
  }
}

async function main() {
  if (env.XRPL_NETWORK !== 'devnet') {
    console.error(
      `XRPL_NETWORK is "${env.XRPL_NETWORK}". PermissionDelegationV1_1 is only active on devnet.\n` +
        'Re-run with: XRPL_NETWORK=devnet npx tsx scripts/delegation-spike.ts',
    )
    process.exit(1)
  }

  const client = await ledger()

  head('0. Is the amendment actually usable here?')
  const available = await delegationAvailable()
  console.log(`  delegationAvailable(): ${available}`)
  if (!available) {
    console.log('  Refusing to continue — the gate the routes will use says no.')
    await disconnectLedger()
    return
  }

  head('Wallets')
  const { wallet: organizer } = await client.fundWallet()
  const { wallet: platform } = await client.fundWallet()
  console.log(`  organizer (issuer)  : ${organizer.classicAddress}`)
  console.log(`  platform  (delegate): ${platform.classicAddress}`)

  const pair = {
    organizerAddress: organizer.classicAddress,
    platformAddress: platform.classicAddress,
  }

  head('1. Before any grant, do we believe we have permission?')
  console.log(`  hasMintPermission(): ${await hasMintPermission(pair)}  (expect false)`)

  head('2. Organizer grants NFTokenMint — and only that')
  const grant = buildDelegateMintTx(pair)
  console.log(`  permissions in the grant: ${JSON.stringify(grant.Permissions)}`)
  if ((await submit(organizer, grant, 'DelegateSet')) !== 'tesSUCCESS') {
    await disconnectLedger()
    return
  }
  console.log(`  hasMintPermission(): ${await hasMintPermission(pair)}  (expect true)`)

  head('3. Platform mints AS the organizer')
  const mint = buildMintTx({
    issuerAddress: organizer.classicAddress,
    taxon: TAXON,
    royaltyBps: TRANSFER_FEE_BPS,
    uri: 'ipfs://hubworld-delegated-mint',
  })
  const delegated = asDelegatedMint(mint, platform.classicAddress)
  console.log(`  Account=${delegated.Account}`)
  console.log(`  Delegate=${delegated.Delegate}`)
  await submit(platform, delegated, 'NFTokenMint (signed by platform)')

  head('4. THE ANSWER: who issued it?')
  const nfts = await client.request({
    command: 'account_nfts',
    account: organizer.classicAddress,
    ledger_index: 'validated',
  })
  const list = nfts.result.account_nfts
  console.log(`  NFTs in the ORGANIZER's account: ${list.length}`)
  if (list.length > 0) {
    const n = list[0]!
    const issuer = n.Issuer ?? organizer.classicAddress
    console.log(`    Issuer     : ${issuer}`)
    console.log(`    TransferFee: ${n.TransferFee} (${(n.TransferFee ?? 0) / 1000}%)`)
    console.log(
      issuer === organizer.classicAddress
        ? '    >> ORGANIZER. The royalty reaches them; the model survives.'
        : '    >> NOT the organizer. The royalty model collapses.',
    )
  }
  const held = await client.request({
    command: 'account_nfts',
    account: platform.classicAddress,
    ledger_index: 'validated',
  })
  console.log(`  NFTs in the PLATFORM's account: ${held.result.account_nfts.length} (expect 0)`)

  head('5. Is the grant really scoped? Platform tries to spend the organizer\'s XRP')
  await submit(
    platform,
    {
      TransactionType: 'Payment',
      Account: organizer.classicAddress,
      Delegate: platform.classicAddress,
      Destination: platform.classicAddress,
      Amount: '1000000',
    },
    'Payment as organizer (must FAIL)',
  )
  console.log('  >> Refusal is the point: this is exactly what RegularKey would have allowed.')

  head('6. Revocation takes effect immediately')
  await submit(organizer, buildRevokeMintTx(pair), 'DelegateSet (revoke)')
  console.log(`  hasMintPermission(): ${await hasMintPermission(pair)}  (expect false)`)
  await submit(
    platform,
    asDelegatedMint(
      buildMintTx({ issuerAddress: organizer.classicAddress, taxon: TAXON, royaltyBps: TRANSFER_FEE_BPS }),
      platform.classicAddress,
    ),
    'mint after revocation (must FAIL)',
  )

  head('Done — devnet, throwaway wallets')
  // The websocket keeps the event loop alive; without this the script hangs and
  // its output is never flushed, which looks exactly like a crash.
  await disconnectLedger()
}

main().catch(async (e) => {
  console.error('SPIKE FAILED:', e)
  await disconnectLedger()
  process.exit(1)
})
