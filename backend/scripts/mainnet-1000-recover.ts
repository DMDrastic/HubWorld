/**
 * Finishes a mainnet-1000-check run that stopped after minting.
 *
 * The proof script keeps the organizer seed in the Keychain whenever a run does
 * not finish cleanly. This reads it, then does what the child never reached:
 * proves the headline from the ledger alone (one organizer signature, N delegated
 * mints), burns every ticket with the delegate, revokes the grant, sweeps the
 * spare XRP back and only then drops the seed.
 *
 *   DELEGATE_SEED=$(security find-generic-password -s hubworld-delegate-seed -w) \
 *   XRPL_NETWORK=mainnet npx tsx scripts/mainnet-1000-recover.ts \
 *     --organizer r... --return-to r... [--yes]
 *
 * Without --yes it only reads the ledger and says what it would do.
 */
import { execFileSync } from 'node:child_process'
import { Wallet, isValidClassicAddress, parseNFTokenID, type Client } from 'xrpl'
import { env } from '../src/env.js'
import { withBackoff } from '../src/xrpl-errors.js'
import { WAVE_SIZE, decideFee, DEFAULT_MAX_FEE_DROPS, nextWaveSize } from '../src/bulk-mint-policy.js'

const argv = process.argv.slice(2)
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const YES = argv.includes('--yes')
const ORGANIZER = value('organizer')
const RETURN_TO = value('return-to')
const ESCROW_ITEM = 'hubworld-mainnet-check-organizer'

const head = (s: string) => console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const xrp = (d: bigint | number) => (Number(d) / 1e6).toFixed(6)
const explorer = (hash: string) => `https://livenet.xrpl.org/transactions/${hash}`
const checks: Array<{ name: string; ok: boolean }> = []
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`)
}

async function* accountTransactions(client: Client, account: string) {
  let marker: unknown
  do {
    const r = (await withBackoff(() =>
      client.request({ command: 'account_tx', account, limit: 400, forward: true, ledger_index_min: -1, ledger_index_max: -1, ...(marker ? { marker } : {}) } as never),
    )) as unknown as { result: { transactions: Array<Record<string, unknown>>; marker?: unknown } }
    for (const row of r.result.transactions) {
      const tx = (row.tx_json ?? row.tx ?? {}) as Record<string, unknown>
      yield { hash: String(row.hash ?? tx.hash ?? ''), tx }
    }
    marker = r.result.marker
  } while (marker)
}

async function allNfts(client: Client, account: string) {
  const out: Array<{ NFTokenID: string; Issuer?: string; NFTokenTaxon: number; URI?: string }> = []
  let marker: unknown
  do {
    const r = (await withBackoff(() =>
      client.request({ command: 'account_nfts', account, ledger_index: 'validated', limit: 400, ...(marker ? { marker } : {}) } as never),
    )) as unknown as { result: { account_nfts: typeof out; marker?: unknown } }
    out.push(...r.result.account_nfts)
    marker = r.result.marker
  } while (marker)
  return out
}

async function accountOf(client: Client, address: string) {
  const r = await withBackoff(() => client.request({ command: 'account_info', account: address, ledger_index: 'validated' }))
  return { balance: BigInt(r.result.account_data.Balance), owners: r.result.account_data.OwnerCount ?? 0 }
}

async function main() {
  if (env.XRPL_NETWORK !== 'mainnet') throw new Error(`XRPL_NETWORK is "${env.XRPL_NETWORK}"; this recovers a MAINNET run.`)
  if (!ORGANIZER || !isValidClassicAddress(ORGANIZER)) throw new Error('--organizer <address> is required')
  if (RETURN_TO && !isValidClassicAddress(RETURN_TO)) throw new Error('--return-to is not a valid address')

  const seed = execFileSync('security', ['find-generic-password', '-a', 'hubworld', '-s', ESCROW_ITEM, '-w'], { encoding: 'utf8' }).trim()
  const organizer = Wallet.fromSeed(seed)
  if (organizer.classicAddress !== ORGANIZER) throw new Error(`The escrowed seed belongs to ${organizer.classicAddress}, not ${ORGANIZER}. Refusing.`)

  const { ledger, delegateWallet, disconnectLedger } = await import('../src/ledger.js')
  const { buildDelegateSetTx, readPermissionSetOnLedger } = await import('../src/delegation.js')
  const { realMintLedger } = await import('../src/mint-ledger.js')
  const client = await ledger()
  const delegate = delegateWallet()
  const pair = { organizerAddress: organizer.classicAddress, delegateAddress: delegate.classicAddress }
  const mintLedger = realMintLedger()
  try {
    const info = (await withBackoff(() => client.request({ command: 'server_info' }))).result.info.validated_ledger
    const base = BigInt(Math.round((info?.reserve_base_xrp ?? 1) * 1e6))
    const inc = BigInt(Math.round((info?.reserve_inc_xrp ?? 0.2) * 1e6))

    head('Where the stopped run stands')
    const nfts = await allNfts(client, organizer.classicAddress)
    const taxons = new Set(nfts.map((n) => n.NFTokenTaxon))
    const before = await accountOf(client, organizer.classicAddress)
    const granted = await readPermissionSetOnLedger(pair)
    console.log(`  organizer ${organizer.classicAddress}: ${xrp(before.balance)} XRP, ${before.owners} owned objects, ${nfts.length} tokens, taxons ${[...taxons].join(',')}`)
    console.log(`  grant on the ledger: ${JSON.stringify(granted)}`)
    if (taxons.size !== 1) throw new Error('Expected every token to share one taxon; refusing to burn anything.')
    const taxon = [...taxons][0]!

    head('THE HEADLINE (proved from the ledger alone, before any burn)')
    let signedByOrganizer = 0
    let delegatedMints = 0
    const mintHashes: string[] = []
    let grantHash = ''
    const key = organizer.publicKey.toUpperCase()
    for await (const row of accountTransactions(client, organizer.classicAddress)) {
      if (String(row.tx.SigningPubKey ?? '').toUpperCase() === key) {
        signedByOrganizer += 1
        if (row.tx.TransactionType === 'DelegateSet' && !grantHash) grantHash = row.hash
      }
      if (row.tx.TransactionType === 'NFTokenMint' && row.tx.Delegate === delegate.classicAddress && row.tx.Account === organizer.classicAddress) {
        delegatedMints += 1
        mintHashes.push(row.hash)
      }
    }
    const issuers = new Set(nfts.map((n) => n.Issuer ?? ''))
    const parsed = nfts.map((n) => parseNFTokenID(n.NFTokenID))
    check('the organizer\'s key signed EXACTLY ONE transaction', signedByOrganizer === 1, `${signedByOrganizer}`)
    check(`${delegatedMints} mints were signed by the delegate as the organizer, one per token`, delegatedMints === nfts.length && delegatedMints > 0, `${delegatedMints} mints, ${nfts.length} tokens`)
    check('every token is issued by the ORGANIZER', issuers.size === 1 && issuers.has(organizer.classicAddress))
    check('every token carries the 5% royalty', new Set(parsed.map((p) => p.TransferFee)).size === 1 && parsed[0]!.TransferFee === 5000)
    console.log(`  network     : mainnet\n  organizer   : ${organizer.classicAddress}\n  delegate    : ${delegate.classicAddress}`)
    if (grantHash) console.log(`  grant       : ${explorer(grantHash)}`)
    for (const i of [0, Math.floor(mintHashes.length / 2), mintHashes.length - 1]) {
      if (mintHashes[i]) console.log(`  mint ${String(i + 1).padStart(5)} : ${explorer(mintHashes[i]!)}`)
    }
    console.log(`  sample token: ${nfts[0]?.NFTokenID}`)

    if (!YES) {
      console.log(`\nDry run: would burn ${nfts.length} tokens, revoke the grant${RETURN_TO ? `, sweep to ${RETURN_TO}` : ''} and drop the escrow. Add --yes.`)
      return
    }

    head('The delegate burns every ticket')
    let remaining = nfts.map((n) => n.NFTokenID)
    let stalled = 0
    const t0 = Date.now()
    while (remaining.length > 0 && stalled < 5) {
      const size = nextWaveSize(remaining.length, WAVE_SIZE)
      const fee = decideFee(await mintLedger.feeQuote(), DEFAULT_MAX_FEE_DROPS)
      if (!fee.ok) {
        console.log(`  ${fee.reason}`)
        await sleep(30_000)
        continue
      }
      const firstSequence = await mintLedger.organizerSequence(organizer.classicAddress)
      const lastLedgerSequence = (await mintLedger.validatedLedgerIndex()) + 20
      const signed = mintLedger.sign(
        remaining.slice(0, size).map(
          (id, i) =>
            ({ TransactionType: 'NFTokenBurn', Account: organizer.classicAddress, Delegate: delegate.classicAddress, NFTokenID: id, Sequence: firstSequence + i, Fee: String(fee.feeDrops), LastLedgerSequence: lastLedgerSequence }) as unknown as Parameters<typeof mintLedger.sign>[0][number],
        ),
      )
      await Promise.all(signed.map((s) => mintLedger.submit(s.blob).catch(() => 'error')))
      // One cheap read per poll, not a lookup per transaction: the public node
      // meters this client (10,000 units a minute, 500,000 an hour) and a burn of
      // 1,000 tickets polled per hash spent the whole quota. The organizer's
      // validated Sequence moves past the wave once every transaction has landed
      // (a failed one still consumes its Sequence), and the ledger passing
      // LastLedgerSequence ends the wait either way.
      const wanted = firstSequence + signed.length
      for (let wait = 0; wait < 60; wait++) {
        await sleep(3_000)
        const seq = (await withBackoff(() => client.request({ command: 'account_info', account: organizer.classicAddress, ledger_index: 'validated' }))).result.account_data.Sequence
        if (seq >= wanted) break
        if ((await mintLedger.validatedLedgerIndex()) > lastLedgerSequence) break
      }
      const left = new Set((await allNfts(client, organizer.classicAddress)).filter((n) => n.NFTokenTaxon === taxon).map((n) => n.NFTokenID))
      const next = remaining.filter((id) => left.has(id))
      stalled = next.length === remaining.length ? stalled + 1 : 0
      remaining = next
      if (remaining.length % 100 < size) console.log(`  ${remaining.length} left  ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    }
    const leftNow = (await allNfts(client, organizer.classicAddress)).filter((n) => n.NFTokenTaxon === taxon).length
    const afterBurn = await accountOf(client, organizer.classicAddress)
    console.log(`  burned in ${((Date.now() - t0) / 1000).toFixed(0)}s; organizer now owns ${afterBurn.owners} object(s)`)
    check('every ticket was burned by the delegate', leftNow === 0, `${leftNow} left`)
    check('the page reserve was freed', afterBurn.owners <= 1, `${afterBurn.owners} owned objects`)

    head('The organizer revokes the grant')
    const revoke = await client.autofill(buildDelegateSetTx(pair, []) as never)
    const revoked = await client.submitAndWait(organizer.sign(revoke).tx_blob)
    console.log(`  ${explorer(revoked.result.hash)}`)
    const gone = await readPermissionSetOnLedger(pair)
    check('the grant is revoked', Array.isArray(gone) && gone.length === 0)

    let swept = true
    if (RETURN_TO) {
      head('Sweeping back')
      const a = await accountOf(client, organizer.classicAddress)
      const amount = a.balance - (base + BigInt(a.owners) * inc) - 200n
      if (amount > 0n) {
        const prepared = await client.autofill({ TransactionType: 'Payment', Account: organizer.classicAddress, Destination: RETURN_TO, Amount: String(amount) } as never)
        const sent = await client.submitAndWait(organizer.sign(prepared).tx_blob)
        const meta = sent.result.meta
        const result = typeof meta === 'object' ? meta.TransactionResult : String(meta)
        console.log(`  swept ${xrp(amount)} XRP: ${result}   ${explorer(String(sent.result.hash))}`)
        swept = result === 'tesSUCCESS'
      }
    }

    const failed = checks.filter((c) => !c.ok)
    console.log(`\n  ${checks.length - failed.length} of ${checks.length} checks passed`)
    if (failed.length === 0 && swept) {
      execFileSync('security', ['delete-generic-password', '-a', 'hubworld', '-s', ESCROW_ITEM], { stdio: 'ignore' })
      console.log('  Keychain escrow removed.')
    } else {
      console.log('  Not everything passed, so the organizer seed is KEPT in the Keychain.')
      process.exitCode = 1
    }
  } finally {
    await disconnectLedger()
  }
}

main().catch((e) => {
  console.error('RECOVERY FAILED (the seed is still in the Keychain; rerun to resume):', e instanceof Error ? e.message : e)
  // The ledger websocket keeps the process alive, so exit explicitly.
  process.exit(1)
})
