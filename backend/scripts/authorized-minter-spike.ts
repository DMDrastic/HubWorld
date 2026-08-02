/**
 * SPIKE: `NFTokenMinter` — can an organizer authorise Hubworld to mint NFTs
 * whose ISSUER is the organizer, without any amendment?
 *
 * This matters because of timing. `PermissionDelegationV1_1` lifts the minting
 * ceiling but is devnet-only, so nothing ships until it activates. The
 * `NFTokenMinter` account setting has existed since the original NFT amendment,
 * which means if it does the same job it works on MAINNET TODAY.
 *
 * The questions, in order of how much they matter:
 *
 *   Q1  Does it work on TESTNET? (If yes, it works on mainnet — that is the
 *       whole point of running this here rather than on devnet.)
 *   Q2  Is the resulting NFT's `Issuer` the ORGANIZER, with TransferFee intact?
 *       Without that the royalty model dies, exactly as it would have under a
 *       bad delegation.
 *   Q3  WHO HOLDS the minted ticket — the organizer or Hubworld? This is the
 *       one that decides the trust model. If it lands in Hubworld's account we
 *       hold the inventory, which is custody by another name, and the primary
 *       sale proceeds would come to us too.
 *   Q4  Is the authorisation scoped? Can Hubworld do anything else with it?
 *   Q5  Can it be revoked?
 *
 * Testnet, faucet-funded, touches no repo credentials and no database.
 *   npx tsx scripts/authorized-minter-spike.ts
 */
import type { Wallet } from 'xrpl'
import { ledger, disconnectLedger, buildMintTx } from '../src/ledger.js'
import { env } from '../src/env.js'

/** asfAuthorizedNFTokenMinter — the AccountSet flag that grants this. */
const ASF_AUTHORIZED_NFTOKEN_MINTER = 10

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
    console.log(`  ${label}: FAILED — ${(e as Error).message.slice(0, 140)}`)
    return 'failed'
  }
}

async function nfts(address: string) {
  const client = await ledger()
  const r = await client.request({
    command: 'account_nfts',
    account: address,
    ledger_index: 'validated',
  })
  return r.result.account_nfts
}

async function main() {
  const client = await ledger()
  const info = await client.request({ command: 'server_info' })
  console.log(`network: ${env.XRPL_NETWORK}  rippled ${info.result.info.build_version}`)
  if (env.XRPL_NETWORK === 'devnet') {
    console.log('NOTE: running on devnet proves nothing here — the point is availability on testnet/mainnet.')
  }

  head('Wallets')
  const { wallet: organizer } = await client.fundWallet()
  const { wallet: hubworld } = await client.fundWallet()
  console.log(`  organizer: ${organizer.classicAddress}`)
  console.log(`  hubworld : ${hubworld.classicAddress}`)

  head('Q1. Organizer authorises Hubworld as their NFTokenMinter')
  const granted = await submit(
    organizer,
    {
      TransactionType: 'AccountSet',
      Account: organizer.classicAddress,
      NFTokenMinter: hubworld.classicAddress,
      SetFlag: ASF_AUTHORIZED_NFTOKEN_MINTER,
    },
    'AccountSet NFTokenMinter',
  )
  if (granted !== 'tesSUCCESS') {
    console.log('\n  Not supported here — everything below is moot.')
    await disconnectLedger()
    return
  }

  head('Q2/Q3. Hubworld mints, naming the organizer as issuer')
  const mint = {
    ...buildMintTx({ issuerAddress: hubworld.classicAddress, taxon: 70_040, royaltyBps: 500 }),
    // Account is HUBWORLD (we sign as ourselves, no delegation), but Issuer
    // names the organizer so the royalty is theirs.
    Issuer: organizer.classicAddress,
  }
  const minted = await submit(hubworld, mint, 'NFTokenMint with Issuer=organizer')

  if (minted === 'tesSUCCESS') {
    const hub = await nfts(hubworld.classicAddress)
    const org = await nfts(organizer.classicAddress)
    console.log(`\n  NFTs in HUBWORLD's account : ${hub.length}`)
    console.log(`  NFTs in ORGANIZER's account: ${org.length}`)

    const found = hub[0] ?? org[0]
    if (found) {
      console.log(`    Issuer     : ${found.Issuer}`)
      console.log(`    TransferFee: ${found.TransferFee} (${(found.TransferFee ?? 0) / 1000}%)`)
      console.log(
        found.Issuer === organizer.classicAddress
          ? '    >> ORGANIZER is the issuer. The royalty is theirs.'
          : '    >> NOT the organizer. Royalty model dies.',
      )
    }
    console.log(
      hub.length > 0
        ? '\n  >> THE TICKET LANDS WITH HUBWORLD. We would hold the inventory —\n' +
            '     and, on a primary sale, receive the proceeds. That is custody.'
        : '\n  >> The ticket lands with the ORGANIZER. No custody.',
    )
  }

  head('Q4. Is it scoped? What else can Hubworld do with this authorisation?')
  await submit(
    hubworld,
    {
      TransactionType: 'Payment',
      Account: organizer.classicAddress,
      Destination: hubworld.classicAddress,
      Amount: '1000000',
    },
    'Payment AS the organizer (must fail — we are not a delegate)',
  )
  await submit(
    hubworld,
    {
      ...buildMintTx({ issuerAddress: organizer.classicAddress, taxon: 70_041, royaltyBps: 500 }),
    },
    'mint with Account=organizer (must fail — that needs delegation, not this)',
  )

  head('Q5. Revocation')
  await submit(
    organizer,
    {
      TransactionType: 'AccountSet',
      Account: organizer.classicAddress,
      ClearFlag: ASF_AUTHORIZED_NFTOKEN_MINTER,
    },
    'AccountSet ClearFlag',
  )
  await submit(
    hubworld,
    {
      ...buildMintTx({ issuerAddress: hubworld.classicAddress, taxon: 70_042, royaltyBps: 500 }),
      Issuer: organizer.classicAddress,
    },
    'mint after revocation (must FAIL)',
  )

  await disconnectLedger()
}

main().catch(async (e) => {
  console.error('SPIKE FAILED:', e)
  await disconnectLedger()
  process.exit(1)
})
