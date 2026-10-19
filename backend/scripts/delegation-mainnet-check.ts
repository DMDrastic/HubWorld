/**
 * Does scoped delegation behave on MAINNET as it did on devnet?
 *
 * `delegation-spike.ts` measured every claim on devnet, where
 * `PermissionDelegationV1_1` was the only place it ran. It was found enabled on
 * mainnet on 2026-10-19; this repeats the same six steps there, driving the
 * SHIPPED builders in `src/delegation.ts`.
 *
 * THIS SPENDS REAL XRP, and the one NFT it mints is permanent. Differences from
 * the devnet script, all deliberate:
 *
 *   - Mainnet has no faucet. Two throwaway wallets are generated in memory and
 *     the script waits for YOU to fund them (from Xaman). Seeds are never
 *     written to disk, printed, or taken from the environment, and nothing
 *     here reads PLATFORM_SEED or the database.
 *   - Dry run by default. Without --yes it prints what it would do and stops;
 *     it generates no wallets, because they would not survive to the real run.
 *   - One ticket only. The 1,000-mint figure stays a devnet measurement.
 *   - It sweeps what it can back to --return-to, whether the checks pass or not.
 *
 *   DOTENV_CONFIG_PATH=/nonexistent DATABASE_URL=unused XRPL_NETWORK=mainnet \
 *     npx tsx scripts/delegation-mainnet-check.ts --yes --return-to r...
 *
 * DOTENV_CONFIG_PATH points at nothing so no credential is loaded;
 * DATABASE_URL is only there because env parsing requires the key to exist.
 */
import { Wallet, isValidClassicAddress, type Client } from 'xrpl'
import { ledger, disconnectLedger, buildMintTx } from '../src/ledger.js'
import {
  asDelegatedMint,
  buildDelegateMintTx,
  buildRevokeMintTx,
  delegationAvailable,
  hasMintPermission,
} from '../src/delegation.js'
import { env } from '../src/env.js'

const TAXON = 70_099
const TRANSFER_FEE_BPS = 500
const FUNDING_TIMEOUT_MS = 15 * 60_000
const POLL_MS = 5_000

const yes = process.argv.includes('--yes')
const returnTo = (() => {
  const i = process.argv.indexOf('--return-to')
  return i === -1 ? undefined : process.argv[i + 1]
})()

function head(s: string) {
  console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`)
}

const xrp = (drops: number) => (drops / 1_000_000).toFixed(6)

async function balanceDrops(client: Client, address: string): Promise<number | null> {
  try {
    const r = await client.request({ command: 'account_info', account: address, ledger_index: 'validated' })
    return Number(r.result.account_data.Balance)
  } catch {
    return null // not funded yet
  }
}

async function ownerCount(client: Client, address: string): Promise<number> {
  const r = await client.request({ command: 'account_info', account: address, ledger_index: 'validated' })
  return r.result.account_data.OwnerCount ?? 0
}

/** Submit and wait for validation; returns the final result code. */
async function submit(client: Client, signer: Wallet, tx: object, label: string): Promise<string> {
  try {
    const prepared = await client.autofill(tx as never)
    const res = await client.submitAndWait(signer.sign(prepared).tx_blob)
    const meta = res.result.meta
    const code = typeof meta === 'object' ? meta.TransactionResult : String(meta)
    console.log(`  ${label}: ${code}   tx ${res.result.hash}`)
    return code
  } catch (e) {
    console.log(`  ${label}: threw — ${(e as Error).message.slice(0, 160)}`)
    return 'failed'
  }
}

/**
 * Submit a transaction that is EXPECTED to be refused and read the preliminary
 * result. `submitAndWait` would sit out the whole LastLedgerSequence window on a
 * `ter` code, and the preliminary result is the informative part anyway.
 */
async function submitExpectRefusal(client: Client, signer: Wallet, tx: object, label: string): Promise<string> {
  try {
    const prepared = await client.autofill(tx as never)
    const res = await client.submit(signer.sign(prepared).tx_blob)
    const code = res.result.engine_result
    console.log(`  ${label}: ${code}`)
    return code
  } catch (e) {
    console.log(`  ${label}: threw — ${(e as Error).message.slice(0, 160)}`)
    return 'failed'
  }
}

async function reserves(client: Client): Promise<{ baseDrops: number; incDrops: number }> {
  const r = await client.request({ command: 'server_info' })
  const v = r.result.info.validated_ledger
  if (!v) throw new Error('server_info carried no validated_ledger; cannot read reserves')
  return { baseDrops: Math.round(v.reserve_base_xrp * 1e6), incDrops: Math.round(v.reserve_inc_xrp * 1e6) }
}

/** Send everything above reserve back, leaving a small margin for the fee. */
async function sweep(client: Client, from: Wallet, to: string, res: { baseDrops: number; incDrops: number }, label: string) {
  const balance = await balanceDrops(client, from.classicAddress)
  if (balance === null) return
  const reserve = res.baseDrops + (await ownerCount(client, from.classicAddress)) * res.incDrops
  const amount = balance - reserve - 200 // fee is ~12 drops; 200 is slack
  if (amount <= 0) {
    console.log(`  ${label}: nothing above reserve (${xrp(balance)} XRP, reserve ${xrp(reserve)})`)
    return
  }
  await submit(
    client,
    from,
    { TransactionType: 'Payment', Account: from.classicAddress, Destination: to, Amount: String(amount) },
    `${label} sweep ${xrp(amount)} XRP`,
  )
}

async function main() {
  if (env.XRPL_NETWORK !== 'mainnet') {
    console.error(`XRPL_NETWORK is "${env.XRPL_NETWORK}". This script is for mainnet only; the devnet run is delegation-spike.ts.`)
    process.exit(1)
  }
  if (!returnTo || !isValidClassicAddress(returnTo)) {
    console.error('Pass --return-to <rAddress>: where the leftover balance goes. It must be an account you control.')
    process.exit(1)
  }

  const client = await ledger()
  const res = await reserves(client)
  // Organizer owns the Delegate object and an NFT page (2 owner units); the
  // platform owns nothing. 0.1 XRP of slack each covers fees many times over.
  const slack = 100_000
  const organizerNeeds = res.baseDrops + 2 * res.incDrops + slack
  const platformNeeds = res.baseDrops + slack

  head('Plan')
  console.log(`  network            : mainnet (${env.XRPL_NETWORK})`)
  console.log(`  reserves           : base ${xrp(res.baseDrops)} XRP, per object ${xrp(res.incDrops)} XRP`)
  console.log(`  organizer needs    : ${xrp(organizerNeeds)} XRP`)
  console.log(`  platform needs     : ${xrp(platformNeeds)} XRP`)
  console.log(`  total to send      : ${xrp(organizerNeeds + platformNeeds)} XRP (fees burned: well under 0.001 XRP)`)
  console.log(`  swept back to      : ${returnTo}`)
  console.log('  stranded for good  : both base reserves + the NFT page reserve (account deletion is blocked by the NFT)')

  head('0. Is the amendment actually usable here?')
  const available = await delegationAvailable()
  console.log(`  delegationAvailable(): ${available}`)
  if (!available) {
    console.log('  Refusing to continue — the gate the routes will use says no.')
    await disconnectLedger()
    return
  }

  if (!yes) {
    console.log('\nDry run — nothing generated or sent. Re-run with --yes to fund and execute.')
    await disconnectLedger()
    return
  }

  const organizer = Wallet.generate()
  const platform = Wallet.generate()

  head('Fund these two throwaway accounts (seeds are held in memory only)')
  console.log(`  organizer (issuer)  : ${organizer.classicAddress}   send >= ${xrp(organizerNeeds)} XRP`)
  console.log(`  platform  (delegate): ${platform.classicAddress}   send >= ${xrp(platformNeeds)} XRP`)
  console.log('  Waiting for both to reach their amounts (15 minute limit)...')
  console.log('  If this process dies after you fund them, the seeds are gone with it.')

  const deadline = Date.now() + FUNDING_TIMEOUT_MS
  for (;;) {
    const [o, p] = await Promise.all([
      balanceDrops(client, organizer.classicAddress),
      balanceDrops(client, platform.classicAddress),
    ])
    if ((o ?? 0) >= organizerNeeds && (p ?? 0) >= platformNeeds) break
    if (Date.now() > deadline) {
      console.error('Timed out waiting for funding. Anything you sent to those addresses is not recoverable.')
      await disconnectLedger()
      process.exit(1)
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  console.log('  Both funded.')

  const pair = { organizerAddress: organizer.classicAddress, platformAddress: platform.classicAddress }
  const outcome: Record<string, boolean> = {}

  try {
    const startO = (await balanceDrops(client, organizer.classicAddress))!
    const startP = (await balanceDrops(client, platform.classicAddress))!

    head('1. Before any grant, do we believe we have permission?')
    const before = await hasMintPermission(pair)
    console.log(`  hasMintPermission(): ${before}  (expect false)`)
    outcome['no permission before grant'] = before === false

    head('2. Organizer grants NFTokenMint — and only that')
    const grant = buildDelegateMintTx(pair)
    console.log(`  permissions in the grant: ${JSON.stringify(grant.Permissions)}`)
    const grantCode = await submit(client, organizer, grant, 'DelegateSet')
    outcome['grant accepted'] = grantCode === 'tesSUCCESS'
    if (grantCode !== 'tesSUCCESS') throw new Error('grant failed; stopping before any mint')
    const after = await hasMintPermission(pair)
    console.log(`  hasMintPermission(): ${after}  (expect true)`)
    outcome['permission visible after grant'] = after === true

    head('3. Platform mints AS the organizer')
    const balOBefore = (await balanceDrops(client, organizer.classicAddress))!
    const balPBefore = (await balanceDrops(client, platform.classicAddress))!
    const mint = buildMintTx({ issuerAddress: organizer.classicAddress, taxon: TAXON, royaltyBps: TRANSFER_FEE_BPS })
    const delegated = asDelegatedMint(mint, platform.classicAddress)
    console.log(`  Account=${delegated.Account}  Delegate=${delegated.Delegate}`)
    const mintCode = await submit(client, platform, delegated, 'NFTokenMint (signed by platform)')
    outcome['delegated mint accepted'] = mintCode === 'tesSUCCESS'

    const balOAfter = (await balanceDrops(client, organizer.classicAddress))!
    const balPAfter = (await balanceDrops(client, platform.classicAddress))!
    console.log(`  fee paid by organizer: ${balOBefore - balOAfter} drops`)
    console.log(`  fee paid by platform : ${balPBefore - balPAfter} drops   (devnet: the delegate pays)`)
    outcome['delegate paid the fee'] = balPBefore - balPAfter > 0 && balOBefore - balOAfter === 0

    head('4. THE ANSWER: who issued it?')
    const nfts = await client.request({ command: 'account_nfts', account: organizer.classicAddress, ledger_index: 'validated' })
    const list = nfts.result.account_nfts
    console.log(`  NFTs in the ORGANIZER's account: ${list.length}`)
    if (list.length > 0) {
      const n = list[0]! as (typeof list)[number] & { TransferFee?: number }
      const issuer = n.Issuer ?? organizer.classicAddress
      console.log(`    NFTokenID  : ${n.NFTokenID}`)
      console.log(`    Issuer     : ${issuer}`)
      console.log(`    TransferFee: ${n.TransferFee} (${(n.TransferFee ?? 0) / 1000}%)`)
      outcome['issuer is the organizer'] = issuer === organizer.classicAddress
      // The ledger stores TransferFee in thousandths of a percent (50000 = 50%),
      // so 500 bps is 5000 on-ledger. Comparing it to the bps value read as a
      // failure on the first mainnet run when nothing was wrong.
      outcome['TransferFee intact'] = n.TransferFee === TRANSFER_FEE_BPS * 10
      console.log(
        issuer === organizer.classicAddress
          ? '    >> ORGANIZER. The royalty reaches them; the model survives.'
          : '    >> NOT the organizer. The royalty model collapses.',
      )
    } else {
      outcome['issuer is the organizer'] = false
      outcome['TransferFee intact'] = false
    }
    const held = await client.request({ command: 'account_nfts', account: platform.classicAddress, ledger_index: 'validated' })
    console.log(`  NFTs in the PLATFORM's account: ${held.result.account_nfts.length} (expect 0)`)
    outcome['platform holds nothing'] = held.result.account_nfts.length === 0

    head("5. Is the grant really scoped? Platform tries to spend the organizer's XRP")
    const pay = await submitExpectRefusal(
      client,
      platform,
      {
        TransactionType: 'Payment',
        Account: organizer.classicAddress,
        Delegate: platform.classicAddress,
        Destination: platform.classicAddress,
        Amount: '1000000',
      },
      'Payment as organizer (must be refused)',
    )
    outcome['payment refused'] = pay === 'terNO_DELEGATE_PERMISSION'

    head('6. Revocation takes effect immediately')
    const revokeCode = await submit(client, organizer, buildRevokeMintTx(pair), 'DelegateSet (revoke)')
    outcome['revoke accepted'] = revokeCode === 'tesSUCCESS'
    const revoked = await hasMintPermission(pair)
    console.log(`  hasMintPermission(): ${revoked}  (expect false)`)
    outcome['permission gone after revoke'] = revoked === false
    const late = await submitExpectRefusal(
      client,
      platform,
      asDelegatedMint(
        buildMintTx({ issuerAddress: organizer.classicAddress, taxon: TAXON, royaltyBps: TRANSFER_FEE_BPS }),
        platform.classicAddress,
      ),
      'mint after revocation (must be refused)',
    )
    outcome['mint refused after revoke'] = late === 'terNO_DELEGATE_PERMISSION'

    head('Verdict')
    for (const [k, v] of Object.entries(outcome)) console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`)
    const endO = (await balanceDrops(client, organizer.classicAddress))!
    const endP = (await balanceDrops(client, platform.classicAddress))!
    console.log(`\n  fees burned: organizer ${startO - endO} drops, platform ${startP - endP} drops`)
  } finally {
    head('Sweeping leftovers back')
    try {
      await sweep(client, organizer, returnTo, res, 'organizer')
      await sweep(client, platform, returnTo, res, 'platform')
    } catch (e) {
      console.error('  sweep failed:', (e as Error).message)
    }
  }

  head('Done — mainnet, throwaway wallets')
  // The websocket keeps the event loop alive; without this the script hangs and
  // its output is never flushed, which looks exactly like a crash.
  await disconnectLedger()
}

main().catch(async (e) => {
  console.error('CHECK FAILED:', e)
  await disconnectLedger()
  process.exit(1)
})
