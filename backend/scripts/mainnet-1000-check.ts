/**
 * Proves, on the real ledger, the claim HubWorld's scale story rests on:
 *
 *     ONE organizer signature, then 1,000 tickets minted unattended.
 *
 * That is made possible by `PermissionDelegationV1_1`. It has been shown on
 * mainnet at 3 tickets; the 1,000-ticket figure was measured on devnet, and
 * mainnet can differ in fees, node throttling, ledger timing and read-after-write
 * behaviour (the first real mainnet run already found a sequence race devnet hid).
 *
 * THIS SPENDS REAL XRP. Minting 1,000 tickets locks NFT-page reserve on the
 * organizer account WHILE THEY EXIST (about 9 XRP), so the peak funding is about
 * 11 XRP. With --burn-after the delegate then burns them all (the holder may
 * always burn its own NFTs, and the burn is delegated like the mint), freeing the
 * reserve; the sweep returns it and the net cost is the organizer's 1 XRP base
 * reserve plus fees. The proof is captured BEFORE any burn.
 *
 *   DOTENV_CONFIG_PATH=/nonexistent XRPL_NETWORK=mainnet \
 *   DATABASE_URL=<LOCAL hubworld_mainnet> \
 *   DELEGATE_SEED="$(security find-generic-password -a hubworld -s hubworld-delegate-seed -w)" \
 *     npx tsx scripts/mainnet-1000-check.ts --delegate-from-env --burn-after \
 *       --return-to r...                                  # dry run
 *     ...same command with --yes                          # for real
 *
 * WHAT IT PROVES, from the ledger alone (a stranger can recheck it with only the
 * organizer's address): the amendment is enabled; the organizer's key signed
 * exactly ONE transaction; N transactions carry `Delegate` = the delegate; N
 * tokens exist, every one issued by the organizer with the royalty set.
 *
 * HOW THE KEYS ARE HANDLED
 *
 * The shipped worker reads its signer from `DELEGATE_SEED`, exactly as in
 * production, so this is a PARENT and a CHILD. The parent generates the organizer
 * key in memory, prints only addresses, waits for funding, then starts the child
 * with the seeds in ITS environment alone. With ~11 XRP at stake "the keys die
 * with the process" is too risky, so the organizer seed is also escrowed in the
 * macOS Keychain until the sweep has succeeded; if the process dies, the seed is
 * recoverable (see `recover` below). Nothing is written to disk or printed.
 *
 * --delegate-from-env uses the DELEGATE_SEED already in the environment (the real
 * production delegate) instead of a throwaway, so the real account is what is
 * proven. --rehearse runs the identical flow on devnet from the faucet.
 */
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import { Wallet, isValidClassicAddress, parseNFTokenID, type Client } from 'xrpl'
import { env } from '../src/env.js'
import { reserveNeededDrops, WAVE_SIZE, decideFee, DEFAULT_MAX_FEE_DROPS, nextWaveSize, waveOutcome } from '../src/bulk-mint-policy.js'

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(`--${name}`)
const value = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}

const CHILD = process.env.MAINNET_1000_CHILD === '1'
const REHEARSE = flag('rehearse')
const YES = flag('yes')
const BURN_AFTER = flag('burn-after')
const DELEGATE_FROM_ENV = flag('delegate-from-env')
const RETURN_TO = value('return-to')
const TICKETS = Math.max(1, Number(value('tickets') ?? 1000))
/** Override the page count used to size funding, once it has been MEASURED. */
const ASSUME_PAGES = value('assume-pages') ? Number(value('assume-pages')) : undefined

const ESCROW_ITEM = 'hubworld-mainnet-check-organizer'
const BURN_PERMISSION = 'NFTokenBurn'

const head = (s: string) => console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`)
const xrp = (d: bigint | number) => (Number(d) / 1e6).toFixed(6)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const explorer = (hash: string) =>
  `${env.XRPL_NETWORK === 'mainnet' ? 'https://livenet.xrpl.org' : `https://${env.XRPL_NETWORK}.xrpl.org`}/transactions/${hash}`

type Reserves = { baseDrops: bigint; incDrops: bigint }

async function reserves(client: Client): Promise<Reserves> {
  const r = await client.request({ command: 'server_info' })
  const v = r.result.info.validated_ledger
  if (!v) throw new Error('server_info carried no validated_ledger; cannot read reserves')
  return { baseDrops: BigInt(Math.round(v.reserve_base_xrp * 1e6)), incDrops: BigInt(Math.round(v.reserve_inc_xrp * 1e6)) }
}

async function accountOf(client: Client, address: string) {
  try {
    const r = await client.request({ command: 'account_info', account: address, ledger_index: 'validated' })
    return { balance: BigInt(r.result.account_data.Balance), owners: r.result.account_data.OwnerCount ?? 0 }
  } catch {
    return null
  }
}

/**
 * What the organizer must hold at the PEAK, while all the tickets exist.
 *
 * The page count is the uncertain part: NFTokenPages split as they fill, so the
 * count is neither one per 32 nor one per 16. `reserveNeededDrops` is calibrated
 * from a measured 1,000-ticket run (41 pages) with margin already in it, so no
 * further percentage is added here; half an XRP of slack covers fees and rounding,
 * because running dry at ticket 900 is worse than parking half an XRP.
 * `--assume-pages` overrides it once a newer measurement exists.
 */
function organizerNeeds(res: Reserves): bigint {
  const pages = ASSUME_PAGES !== undefined ? BigInt(ASSUME_PAGES) * res.incDrops : reserveNeededDrops(TICKETS, res.incDrops)
  // base + the Delegate object + the pages + slack.
  return res.baseDrops + res.incDrops + pages + 500_000n
}

const delegateThrowawayNeeds = (res: Reserves) => res.baseDrops + 200_000n

// ======================================================================== //
//  PARENT                                                                    //
// ======================================================================== //

function keychainHas(): boolean {
  try {
    execFileSync('security', ['find-generic-password', '-a', 'hubworld', '-s', ESCROW_ITEM], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function parent() {
  if (!REHEARSE && env.XRPL_NETWORK !== 'mainnet') {
    console.error(`XRPL_NETWORK is "${env.XRPL_NETWORK}". This is the MAINNET proof; use --rehearse for devnet/testnet.`)
    process.exit(1)
  }
  if (REHEARSE && env.XRPL_NETWORK === 'mainnet') {
    console.error('--rehearse is for devnet/testnet only.')
    process.exit(1)
  }
  if (!REHEARSE && (!RETURN_TO || !isValidClassicAddress(RETURN_TO))) {
    console.error('Pass --return-to <rAddress>: where recovered XRP goes. It must be an account you control.')
    process.exit(1)
  }
  if (DELEGATE_FROM_ENV && !process.env.DELEGATE_SEED) {
    console.error('--delegate-from-env needs DELEGATE_SEED in the environment (see the header for the Keychain command).')
    process.exit(1)
  }

  const { ledger, disconnectLedger } = await import('../src/ledger.js')
  const { delegationAvailableOnLedger } = await import('../src/delegation.js')
  const client = await ledger()
  try {
    const res = await reserves(client)
    const orgNeeds = organizerNeeds(res)
    const throwaway = !DELEGATE_FROM_ENV
    const delegateWalletFromEnv = DELEGATE_FROM_ENV ? Wallet.fromSeed(process.env.DELEGATE_SEED!) : null
    const delegateNeeds = throwaway ? delegateThrowawayNeeds(res) : 0n
    const total = orgNeeds + delegateNeeds

    head('Plan')
    console.log(`  network           : ${env.XRPL_NETWORK}${REHEARSE ? '  (REHEARSAL: faucet-funded)' : '  (REAL XRP)'}`)
    console.log(`  tickets           : ${TICKETS} minted by the delegate, ${BURN_AFTER ? 'then burned to recover the reserve' : 'then KEPT (their reserve stays locked)'}`)
    console.log(`  reserves          : base ${xrp(res.baseDrops)} XRP, per object ${xrp(res.incDrops)} XRP`)
    console.log(`  organizer needs   : ${xrp(orgNeeds)} XRP at the PEAK (base + Delegate object + measured-and-margined NFT pages + slack)`)
    console.log(`  delegate          : ${throwaway ? `throwaway, needs ${xrp(delegateNeeds)} XRP` : `the real one, ${delegateWalletFromEnv!.classicAddress}`}`)
    console.log(`  TOTAL to send     : ${xrp(total)} XRP`)
    if (!REHEARSE) {
      const stays = BURN_AFTER ? res.baseDrops : orgNeeds - 500_000n
      console.log(`  swept back to     : ${RETURN_TO}`)
      console.log(`  stays locked      : about ${xrp(stays)} XRP${BURN_AFTER ? ' (the organizer\'s base reserve; the pages are freed by the burn)' : ''}`)
      console.log(`  fees              : ~${xrp(BigInt(TICKETS) * 12n * (BURN_AFTER ? 2n : 1n))} XRP in total at 12 drops a transaction, paid by the delegate`)
    }

    head('Is delegation usable on this ledger?')
    const available = await delegationAvailableOnLedger()
    console.log(`  delegationAvailableOnLedger(): ${available}`)
    if (!available) {
      console.error('  Refusing to continue.')
      return
    }
    if (delegateWalletFromEnv) {
      const d = await accountOf(client, delegateWalletFromEnv.classicAddress)
      const spendable = d ? d.balance - res.baseDrops : 0n
      console.log(`  delegate ${delegateWalletFromEnv.classicAddress}: ${d ? xrp(d.balance) : 'NOT FUNDED'} XRP (spendable ${xrp(spendable)})`)
      if (spendable < 100_000n) {
        console.error('  The delegate cannot pay the fees. Fund it first.')
        return
      }
    }

    if (!YES && !REHEARSE) {
      console.log('\nDry run: nothing generated or sent. Re-run with --yes to fund and execute.')
      return
    }

    const organizer = Wallet.generate()
    const delegate = throwaway ? Wallet.generate() : null

    // ---- escrow the organizer seed, so a crash does not strand the XRP --------
    let escrowed = false
    if (!REHEARSE) {
      if (keychainHas()) {
        console.error(`A Keychain item "${ESCROW_ITEM}" already exists: a previous run did not finish. Recover or remove it first:`)
        console.error(`  security find-generic-password -a hubworld -s ${ESCROW_ITEM} -w`)
        process.exit(1)
      }
      execFileSync('security', ['add-generic-password', '-a', 'hubworld', '-s', ESCROW_ITEM, '-w', organizer.seed!])
      escrowed = true
      console.log(`\n  organizer seed escrowed in the Keychain (item "${ESCROW_ITEM}") until the sweep succeeds`)
    }

    const targets: Array<{ label: string; wallet: Wallet; drops: bigint }> = [{ label: 'organizer', wallet: organizer, drops: orgNeeds }]
    if (delegate) targets.push({ label: 'delegate ', wallet: delegate, drops: delegateNeeds })

    if (REHEARSE) {
      head('Funding from the faucet')
      // The faucet pays a fixed amount per call; top up until the peak need is met.
      for (const t of targets) {
        await client.fundWallet(t.wallet)
        for (let i = 0; i < 6; i++) {
          const a = await accountOf(client, t.wallet.classicAddress)
          if (a && a.balance >= t.drops) break
          await client.fundWallet(t.wallet)
        }
      }
      console.log(`  funded ${targets.length} account(s)`)
    } else {
      head('Fund these accounts (keys are in memory and, for the organizer, escrowed in the Keychain)')
      for (const t of targets) console.log(`  ${t.label}: ${t.wallet.classicAddress}   send >= ${xrp(t.drops)} XRP`)
      console.log('\n  Waiting up to 20 minutes. Send the amount ONLY when you are ready to let this run.')
      const deadline = Date.now() + 20 * 60_000
      for (;;) {
        const bals = await Promise.all(targets.map((t) => accountOf(client, t.wallet.classicAddress)))
        if (targets.every((t, i) => (bals[i]?.balance ?? 0n) >= t.drops)) break
        if (Date.now() > deadline) {
          console.error('Timed out waiting for funding. Anything already sent is in the escrowed organizer account.')
          return
        }
        await sleep(5_000)
      }
      console.log('  Funded.')
    }

    head('Running the shipped code (child process)')
    const code = await new Promise<number>((resolve) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', path.resolve(import.meta.dirname, 'mainnet-1000-check.ts'), ...argv.filter((a) => a !== '--yes')],
        {
          stdio: 'inherit',
          env: {
            ...process.env,
            MAINNET_1000_CHILD: '1',
            DELEGATE_SEED: delegate ? delegate.seed! : process.env.DELEGATE_SEED!,
            CHECK_ORGANIZER_SEED: organizer.seed!,
          },
        },
      )
      child.on('exit', (c) => resolve(c ?? 1))
    })
    console.log(`\n  child exited with code ${code}`)

    // ---- sweep ---------------------------------------------------------------
    const dest = RETURN_TO
    let swept = true
    if (dest) {
      head('Sweeping back')
      const wallets = [{ label: 'organizer', w: organizer }, ...(delegate ? [{ label: 'delegate', w: delegate }] : [])]
      for (const t of wallets) {
        try {
          const a = await accountOf(client, t.w.classicAddress)
          if (!a) continue
          const reserve = res.baseDrops + BigInt(a.owners) * res.incDrops
          const amount = a.balance - reserve - 200n
          if (amount <= 0n) {
            console.log(`  ${t.label.padEnd(10)} nothing above reserve (${xrp(a.balance)} XRP held, ${a.owners} owned objects)`)
            continue
          }
          const prepared = await client.autofill({ TransactionType: 'Payment', Account: t.w.classicAddress, Destination: dest, Amount: String(amount) } as never)
          const sent = await client.submitAndWait(t.w.sign(prepared).tx_blob)
          const meta = sent.result.meta
          const result = typeof meta === 'object' ? meta.TransactionResult : String(meta)
          console.log(`  ${t.label.padEnd(10)} swept ${xrp(amount)} XRP: ${result}   tx ${sent.result.hash}`)
          if (result !== 'tesSUCCESS') swept = false
        } catch (e) {
          swept = false
          console.error(`  ${t.label} sweep failed: ${(e as Error).message.slice(0, 100)}`)
        }
      }
    }
    if (escrowed) {
      if (swept) {
        execFileSync('security', ['delete-generic-password', '-a', 'hubworld', '-s', ESCROW_ITEM], { stdio: 'ignore' })
        console.log('\n  Keychain escrow removed.')
      } else {
        console.log(`\n  The sweep did not fully succeed, so the organizer seed is STILL in the Keychain ("${ESCROW_ITEM}").`)
      }
    }
    process.exitCode = code
  } finally {
    await disconnectLedger()
  }
}

// ======================================================================== //
//  CHILD                                                                     //
// ======================================================================== //

type Check = { name: string; ok: boolean; detail?: string }

/** Every transaction touching an account, newest-agnostic, paged. */
async function* accountTransactions(client: Client, account: string) {
  let marker: unknown
  do {
    const r = (await client.request({
      command: 'account_tx',
      account,
      limit: 400,
      forward: true,
      ledger_index_min: -1,
      ledger_index_max: -1,
      ...(marker ? { marker } : {}),
    } as never)) as unknown as {
      result: { transactions: Array<Record<string, unknown>>; marker?: unknown }
    }
    for (const row of r.result.transactions) {
      const tx = (row.tx_json ?? row.tx ?? {}) as Record<string, unknown>
      yield { hash: String(row.hash ?? tx.hash ?? ''), tx, meta: (row.meta ?? {}) as Record<string, unknown> }
    }
    marker = r.result.marker
  } while (marker)
}

async function allNfts(client: Client, account: string) {
  const out: Array<{ NFTokenID: string; Issuer?: string; NFTokenTaxon: number; URI?: string; Flags: number }> = []
  let marker: unknown
  do {
    const r = (await client.request({ command: 'account_nfts', account, ledger_index: 'validated', limit: 400, ...(marker ? { marker } : {}) } as never)) as unknown as {
      result: { account_nfts: typeof out; marker?: unknown }
    }
    out.push(...r.result.account_nfts)
    marker = r.result.marker
  } while (marker)
  return out
}

async function child() {
  const [{ prisma }, { NETWORK }, { assertSafeDatabase }, { foreignNetworkRows }, ledgerMod, deleg, mintLedgerMod, { runMintJob }, amendments] = await Promise.all([
    import('../src/prisma.js'),
    import('../src/network.js'),
    import('../src/db-guard.js'),
    import('../src/network-guard.js'),
    import('../src/ledger.js'),
    import('../src/delegation.js'),
    import('../src/mint-ledger.js'),
    import('../src/bulk-mint.js'),
    import('../src/amendments.js'),
  ])
  const { ledger, delegateWallet, disconnectLedger } = ledgerMod
  const { buildDelegateSetTx, readPermissionSetOnLedger, delegationAvailableOnLedger, MINT_PERMISSION } = deleg
  const { realMintLedger } = mintLedgerMod

  assertSafeDatabase('mainnet-1000-check')
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, detail })
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`)
  }

  const foreign = await foreignNetworkRows()
  if (foreign.length > 0) {
    console.error(`Refusing to run: this database holds rows for another ledger (${foreign.map((f) => `${f.network} ${f.model}`).join(', ')}).`)
    process.exitCode = 1
    return
  }

  const client = await ledger()
  const res = await reserves(client)
  const organizer = Wallet.fromSeed(process.env.CHECK_ORGANIZER_SEED!)
  const delegate = delegateWallet()
  const pair = { organizerAddress: organizer.classicAddress, delegateAddress: delegate.classicAddress }
  const mintLedger = realMintLedger()
  const hashes: Record<string, string> = {}

  head('0. The amendment')
  const enabled = await delegationAvailableOnLedger()
  const watched = amendments.WATCHED.find((a) => a.name === 'PermissionDelegationV1_1')
  const state = watched ? amendments.classifyAmendment(watched.id, await amendments.readLedgerAmendments()) : null
  console.log(`  PermissionDelegationV1_1  id ${watched?.id ?? '(unknown)'}   state ${JSON.stringify(state)}`)
  const info = await client.request({ command: 'server_info' })
  console.log(`  server ${info.result.info.build_version ?? '?'}   validated ledger ${info.result.info.validated_ledger?.seq}`)
  check('PermissionDelegationV1_1 is enabled on this ledger', enabled)

  head('1. Pre-flight: can this finish?')
  const orgAccount = (await accountOf(client, organizer.classicAddress))!
  const delAccount = await accountOf(client, delegate.classicAddress)
  const need = organizerNeeds(res)
  console.log(`  organizer ${organizer.classicAddress}   holds ${xrp(orgAccount.balance)} XRP, needs ${xrp(need)} at the peak`)
  console.log(`  delegate  ${delegate.classicAddress}   holds ${delAccount ? xrp(delAccount.balance) : 'NOTHING'} XRP`)
  check('the organizer can carry the reserve for every ticket', orgAccount.balance >= need)
  check('the delegate can pay the fees', delAccount !== null && delAccount.balance - res.baseDrops >= 100_000n)
  if (checks.some((c) => !c.ok)) {
    console.error('\nA precondition failed. Nothing was minted.')
    process.exitCode = 1
    await disconnectLedger()
    return
  }
  const delegateBefore = delAccount!.balance

  const tag = Math.random().toString(36).slice(2, 7)
  const user = await prisma.user.create({ data: { username: `m1k_${tag}`, xrplAddress: organizer.classicAddress, role: 'ORGANIZER' } })
  const taxon = 77_000 + Math.floor(Math.random() * 900)
  const event = await prisma.event.create({
    data: {
      network: NETWORK,
      slug: `m1k-${tag}`,
      title: `Delegated Mint Proof ${tag}`,
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: user.id,
      nftTaxon: taxon,
      royaltyBps: 500,
      platformBps: env.PLATFORM_FEE_BPS,
      ticketCount: TICKETS,
      status: 'PUBLISHED',
    },
  })

  try {
    head('2. THE ONE SIGNATURE: the organizer grants minting')
    const permissions = BURN_AFTER ? [MINT_PERMISSION, BURN_PERMISSION].sort() : [MINT_PERMISSION]
    const grant = await client.autofill(buildDelegateSetTx(pair, permissions) as never)
    const granted = await client.submitAndWait(organizer.sign(grant).tx_blob)
    hashes.grant = granted.result.hash
    const set = await readPermissionSetOnLedger(pair)
    console.log(`  held on ledger: ${JSON.stringify(set)}`)
    console.log(`  ${explorer(hashes.grant)}`)
    check('grant visible on the ledger', Array.isArray(set) && permissions.every((p) => set.includes(p)))

    head(`3. The shipped worker mints ${TICKETS} tickets, unattended`)
    const job = await prisma.mintJob.create({
      data: { network: NETWORK, eventId: event.id, organizerId: user.id, organizerAddress: organizer.classicAddress, delegateAddress: delegate.classicAddress, total: TICKETS },
    })
    const started = Date.now()
    let passes = 0
    let waits = 0
    for (let pass = 1; pass <= 60; pass++) {
      passes = pass
      await runMintJob(job.id, { ledger: mintLedger })
      const j = await prisma.mintJob.findUniqueOrThrow({ where: { id: job.id } })
      console.log(`  pass ${pass}: ${j.status}  ${j.minted}/${j.total}  failedTxs=${j.failedTxs}  ${((Date.now() - started) / 1000).toFixed(0)}s${j.statusReason ? `  (${j.statusReason})` : ''}`)
      if (j.status !== 'RUNNING' && j.status !== 'QUEUED') break
      if (j.nextAttemptAt && j.nextAttemptAt.getTime() > Date.now()) {
        waits += 1
        await sleep(Math.min(20_000, j.nextAttemptAt.getTime() - Date.now()))
        await prisma.mintJob.update({ where: { id: job.id }, data: { nextAttemptAt: null } })
      }
    }
    const secs = (Date.now() - started) / 1000
    const done = await prisma.mintJob.findUniqueOrThrow({ where: { id: job.id } })
    const recorded = await prisma.ticket.count({ where: { eventId: event.id } })

    head('4. Verify, from the ledger')
    const nfts = (await allNfts(client, organizer.classicAddress)).filter((n) => n.NFTokenTaxon === taxon)
    const issuers = new Set(nfts.map((n) => n.Issuer ?? ''))
    const parsed = nfts.map((n) => parseNFTokenID(n.NFTokenID))
    const fees = new Set(parsed.map((p) => p.TransferFee))
    const flags = new Set(parsed.map((p) => p.Flags))
    const withUri = nfts.filter((n) => n.URI && n.URI.length > 0).length
    const after = (await accountOf(client, organizer.classicAddress))!
    const delegateAfter = (await accountOf(client, delegate.classicAddress))!.balance
    console.log(`  ${((secs)).toFixed(1)}s  (${(TICKETS / secs).toFixed(2)} tickets/s), ${passes} worker pass(es), ${waits} timed wait(s)`)
    console.log(`  delegate paid ${delegateBefore - delegateAfter} drops in fees (${(Number(delegateBefore - delegateAfter) / TICKETS).toFixed(2)} per ticket)`)
    console.log(`  organizer owns ${after.owners} objects = 1 Delegate + ${after.owners - 1} NFTokenPages  -> ${xrp(BigInt(after.owners - 1) * res.incDrops)} XRP of page reserve for ${TICKETS} tickets (${(TICKETS / Math.max(1, after.owners - 1)).toFixed(1)} per page)`)
    check('the worker finished', done.status === 'DONE', done.status)
    check(`database, ledger and job counter agree on ${TICKETS}`, recorded === TICKETS && nfts.length === TICKETS && done.minted === TICKETS, `db ${recorded}, ledger ${nfts.length}, job ${done.minted}`)
    check('every token is issued by the ORGANIZER', issuers.size === 1 && issuers.has(organizer.classicAddress))
    check('every token carries the 5% royalty (TransferFee 5000)', fees.size === 1 && fees.has(5000), `${[...fees].join(',')}`)
    check('every token is transferable and mutable', flags.size === 1 && (parsed[0]!.Flags & 8) === 8 && (parsed[0]!.Flags & 16) === 16, `flags ${[...flags].join(',')}`)
    check('every token has its metadata URI', withUri === TICKETS, `${withUri}/${TICKETS}`)
    check('no transaction was wasted', done.failedTxs === 0, `failedTxs ${done.failedTxs}`)
    check('the delegate, not the organizer, paid the fees', delegateBefore > delegateAfter)

    head('5. THE HEADLINE: how many transactions did the organizer sign?')
    let signedByOrganizer = 0
    let delegatedMints = 0
    const mintHashes: string[] = []
    const organizerKey = organizer.publicKey.toUpperCase()
    for await (const row of accountTransactions(client, organizer.classicAddress)) {
      const t = row.tx
      const key = String(t.SigningPubKey ?? '').toUpperCase()
      if (key === organizerKey) signedByOrganizer += 1
      if (t.TransactionType === 'NFTokenMint' && t.Delegate === delegate.classicAddress && t.Account === organizer.classicAddress) {
        delegatedMints += 1
        mintHashes.push(row.hash)
      }
    }
    console.log(`  signed by the organizer's own key : ${signedByOrganizer}`)
    console.log(`  NFTokenMint carrying Delegate     : ${delegatedMints}`)
    check('the organizer\'s key signed EXACTLY ONE transaction', signedByOrganizer === 1, `${signedByOrganizer}`)
    check(`${TICKETS} mints were signed by the delegate as the organizer`, delegatedMints === TICKETS, `${delegatedMints}`)

    head('EVIDENCE (captured BEFORE any burn; recheck from the organizer address alone)')
    console.log(`  network          : ${env.XRPL_NETWORK}`)
    console.log(`  organizer        : ${organizer.classicAddress}`)
    console.log(`  delegate         : ${delegate.classicAddress}`)
    console.log(`  grant (1 sig)    : ${explorer(hashes.grant)}`)
    if (mintHashes.length > 0) {
      const pick = [0, Math.floor(mintHashes.length / 2), mintHashes.length - 1]
      for (const i of pick) console.log(`  delegated mint ${String(i + 1).padStart(4)} : ${explorer(mintHashes[i]!)}`)
    }
    console.log(`  tokens           : ${nfts.length} (taxon ${taxon}), sample ${nfts[0]?.NFTokenID}`)

    // ---- burn pass -----------------------------------------------------------
    if (BURN_AFTER) {
      head('6. The delegate burns every ticket, unattended, to recover the reserve')
      let remaining = nfts.map((n) => n.NFTokenID)
      let stalled = 0
      const burnStart = Date.now()
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
        const batch = remaining.slice(0, size)
        const signed = mintLedger.sign(
          batch.map(
            (id, i) =>
              ({
                TransactionType: 'NFTokenBurn',
                Account: organizer.classicAddress,
                Delegate: delegate.classicAddress,
                NFTokenID: id,
                Sequence: firstSequence + i,
                Fee: String(fee.feeDrops),
                LastLedgerSequence: lastLedgerSequence,
              }) as unknown as Parameters<typeof mintLedger.sign>[0][number],
          ),
        )
        await Promise.all(signed.map((s) => mintLedger.submit(s.blob).catch(() => 'error')))

        const validated = new Set<string>()
        for (let wait = 0; wait < 60; wait++) {
          for (const s of signed) {
            if (validated.has(s.hash)) continue
            const l = await mintLedger.lookup(s.hash).catch(() => ({ state: 'unknown' as const }))
            if (l.state === 'validated') validated.add(s.hash)
          }
          const o = waveOutcome({ hashes: signed.map((s) => s.hash), validated, currentLedger: await mintLedger.validatedLedgerIndex(), lastLedgerSequence })
          if (o === 'settled') break
          await sleep(1_500)
        }
        // Truth comes from the ledger's own list, not from counting submissions.
        const left = new Set((await allNfts(client, organizer.classicAddress)).filter((n) => n.NFTokenTaxon === taxon).map((n) => n.NFTokenID))
        const next = remaining.filter((id) => left.has(id))
        stalled = next.length === remaining.length ? stalled + 1 : 0
        remaining = next
        if (remaining.length % 100 < size) console.log(`  ${remaining.length} left  ${((Date.now() - burnStart) / 1000).toFixed(0)}s`)
      }
      const leftNow = (await allNfts(client, organizer.classicAddress)).filter((n) => n.NFTokenTaxon === taxon).length
      const afterBurn = (await accountOf(client, organizer.classicAddress))!
      console.log(`  burned in ${((Date.now() - burnStart) / 1000).toFixed(1)}s; organizer now owns ${afterBurn.owners} object(s)`)
      check('every ticket was burned by the delegate', leftNow === 0, `${leftNow} left`)
      check('the page reserve was freed', afterBurn.owners <= 1, `${afterBurn.owners} owned objects`)

      head('7. The organizer revokes the grant (frees the Delegate object)')
      const revoke = await client.autofill(buildDelegateSetTx(pair, []) as never)
      const revoked = await client.submitAndWait(organizer.sign(revoke).tx_blob)
      hashes.revoke = revoked.result.hash
      const gone = await readPermissionSetOnLedger(pair)
      check('the grant is revoked', Array.isArray(gone) && gone.length === 0)
      const final = (await accountOf(client, organizer.classicAddress))!
      check('the organizer owns nothing again', final.owners === 0, `${final.owners}`)
    }

    head('RESULTS')
    const failed = checks.filter((c) => !c.ok)
    for (const [k, v] of Object.entries(hashes)) console.log(`  ${k.padEnd(8)} ${explorer(v)}`)
    console.log(`\n  ${checks.length - failed.length} of ${checks.length} checks passed`)
    process.exitCode = failed.length === 0 ? 0 : 1
  } finally {
    head('Cleaning up the database rows')
    await prisma.transfer.deleteMany({ where: { ticket: { eventId: event.id } } })
    await prisma.ticket.deleteMany({ where: { eventId: event.id } })
    await prisma.mintJob.deleteMany({ where: { eventId: event.id } })
    await prisma.event.delete({ where: { id: event.id } })
    await prisma.user.delete({ where: { id: user.id } })
    await prisma.$disconnect()
    await disconnectLedger()
  }
}

;(CHILD ? child() : parent()).catch((e) => {
  console.error('CHECK FAILED:', e)
  process.exitCode = 1
})
