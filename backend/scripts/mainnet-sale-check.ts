/**
 * Runs the SHIPPED bulk-mint worker and lazy primary sale against MAINNET, with
 * real XRP and throwaway accounts.
 *
 * Everything so far was measured on devnet. Mainnet fees, node limits and
 * validation timing can differ, and a sale moves real money, so before anything
 * depends on this it should be seen working once on the real ledger with a few
 * XRP at stake rather than a customer's event.
 *
 * THIS SPENDS REAL XRP, and the NFTs it mints are permanent. It is dry-run by
 * default. With the defaults roughly 10 XRP is sent in and about 4 XRP of it
 * comes back; the rest (about 5.6 XRP) stays locked as base reserves on the
 * throwaway accounts and NFT pages, and the burn in network fees is a fraction
 * of a cent. The dry run prints the exact figures for the current reserves.
 *
 *   DOTENV_CONFIG_PATH=/nonexistent XRPL_NETWORK=mainnet \
 *   DATABASE_URL=<LOCAL hubworld_mainnet> \
 *     npx tsx scripts/mainnet-sale-check.ts --return-to r...            # dry run
 *     npx tsx scripts/mainnet-sale-check.ts --return-to r... --yes      # for real
 *
 * HOW THE KEYS ARE HANDLED
 *
 * The code under test reads its signing keys from the environment
 * (`DELEGATE_SEED`, `PLATFORM_SEED`) exactly as production does, so this process
 * cannot simply generate wallets in memory and hand them over. Instead it is two
 * processes: this PARENT generates every key in memory, prints only addresses,
 * waits for you to fund them, then starts a CHILD with the seeds in ITS
 * environment and nowhere else. Seeds are never written to disk or printed. If
 * the parent dies after you fund the accounts, the keys die with it — so send
 * funds only when you are about to let it run.
 *
 * The broker is a THROWAWAY, not the real one: the real broker's seed should not
 * be loaded into a script, and the topology under test is identical.
 *
 * --resale adds a SECOND-hand sale of a delegate-minted ticket: the first buyer
 * resells to the second through the brokered flow, and the organizer's royalty is
 * read from that transaction's own metadata. A primary sale cannot show it (XRPL
 * skips the transfer fee when the issuer is a party), so this is the only way to
 * see the royalty survive delegation. Needs --buyers 2 or more; adds about one
 * price of funding to the second buyer.
 *
 * --rehearse runs the identical flow on devnet/testnet, funding from the
 * faucet, so the process handling and every check can be seen to work for free
 * before any real XRP is involved.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { Wallet, isValidClassicAddress, type Client } from 'xrpl'
import { env } from '../src/env.js'

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(`--${name}`)
const value = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}

const CHILD = process.env.MAINNET_SALE_CHECK_CHILD === '1'
const REHEARSE = flag('rehearse')
const YES = flag('yes')
const RETURN_TO = value('return-to')
const RESALE = flag('resale')

const BUYERS = Math.min(4, Math.max(1, Number(value('buyers') ?? 2)))
const PRICE_DROPS = BigInt(Math.round(Number(value('price-xrp') ?? 1) * 1_000_000))
if (RESALE && BUYERS < 2) throw new Error('--resale needs --buyers 2 or more: one to sell, one to buy')
const TICKETS = BUYERS + 1 // one spare, so the post-revoke refusal is "closed", not "sold out"

const head = (s: string) => console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`)
const xrp = (d: bigint | number) => (Number(d) / 1e6).toFixed(6)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type Reserves = { baseDrops: bigint; incDrops: bigint }

async function reserves(client: Client): Promise<Reserves> {
  const r = await client.request({ command: 'server_info' })
  const v = r.result.info.validated_ledger
  if (!v) throw new Error('server_info carried no validated_ledger; cannot read reserves')
  return { baseDrops: BigInt(Math.round(v.reserve_base_xrp * 1e6)), incDrops: BigInt(Math.round(v.reserve_inc_xrp * 1e6)) }
}

async function balanceOf(client: Client, address: string): Promise<bigint | null> {
  try {
    const r = await client.request({ command: 'account_info', account: address, ledger_index: 'validated' })
    return BigInt(r.result.account_data.Balance)
  } catch {
    return null
  }
}

/** What each throwaway account must hold, from the live reserves. */
function needs(res: Reserves, owedDrops: bigint) {
  const slack = 200_000n
  return {
    // Base + the Delegate object + the NFT page + one open offer per concurrent buyer.
    organizer: res.baseDrops + (2n + BigInt(BUYERS)) * res.incDrops + 300_000n,
    // Pays the fee of every delegated mint and offer; holds nothing.
    delegate: res.baseDrops + slack,
    // Pays the fee of every brokered match; holds nothing.
    broker: res.baseDrops + slack,
    // Base + its bid offer + the NFT page it receives + what it pays.
    buyer: res.baseDrops + 2n * res.incDrops + owedDrops + slack,
  }
}

// ======================================================================== //
//  PARENT: plan, generate keys, wait for funding, run the child, sweep back  //
// ======================================================================== //

async function parent() {
  if (!REHEARSE && env.XRPL_NETWORK !== 'mainnet') {
    console.error(`XRPL_NETWORK is "${env.XRPL_NETWORK}". This is the MAINNET check; use --rehearse for devnet/testnet.`)
    process.exit(1)
  }
  if (REHEARSE && env.XRPL_NETWORK === 'mainnet') {
    console.error('--rehearse is for devnet/testnet only. It would fund nothing on mainnet and is not a dry run; omit --yes for that.')
    process.exit(1)
  }
  if (!REHEARSE && (!RETURN_TO || !isValidClassicAddress(RETURN_TO))) {
    console.error('Pass --return-to <rAddress>: where leftover XRP goes. It must be an account you control.')
    process.exit(1)
  }

  const { ledger, disconnectLedger } = await import('../src/ledger.js')
  const { delegationAvailableOnLedger } = await import('../src/delegation.js')
  const client = await ledger()
  try {
    const res = await reserves(client)
    const feeDrops = (PRICE_DROPS * BigInt(env.PLATFORM_FEE_BPS)) / 10_000n
    const owed = PRICE_DROPS + feeDrops
    const n = needs(res, owed)
    const total = n.organizer + n.delegate + n.broker + n.buyer * BigInt(BUYERS) + (RESALE ? owed + 100_000n : 0n)

    head('Plan')
    console.log(`  network            : ${env.XRPL_NETWORK}${REHEARSE ? '  (REHEARSAL: faucet-funded)' : '  (REAL XRP)'}`)
    console.log(`  reserves           : base ${xrp(res.baseDrops)} XRP, per object ${xrp(res.incDrops)} XRP`)
    console.log(`  tickets / buyers   : ${TICKETS} minted, ${BUYERS} buy; price ${xrp(PRICE_DROPS)} XRP + ${xrp(feeDrops)} platform fee`)
    console.log(`  organizer needs    : ${xrp(n.organizer)} XRP`)
    console.log(`  delegate needs     : ${xrp(n.delegate)} XRP`)
    console.log(`  broker needs       : ${xrp(n.broker)} XRP`)
    console.log(`  each buyer needs   : ${xrp(n.buyer)} XRP   (x ${BUYERS})`)
    if (RESALE) console.log(`  + resale           : buyer 2 also needs ${xrp(owed + 100_000n)} XRP to buy the ticket back from buyer 1`)
    console.log(`  TOTAL to send      : ${xrp(total)} XRP`)
    if (!REHEARSE) {
      const stranded = BigInt(3 + BUYERS) * res.baseDrops + (1n + BigInt(BUYERS)) * res.incDrops
      console.log(`  swept back to      : ${RETURN_TO}`)
      console.log(`  stays locked       : about ${xrp(stranded)} XRP (base reserves + NFT pages; the NFTs block account deletion)`)
      console.log('  the NFTs          : permanent; their URIs point at hubworld.app for a throwaway event slug')
    }

    head('Is delegation usable on this ledger?')
    const available = await delegationAvailableOnLedger()
    console.log(`  delegationAvailableOnLedger(): ${available}`)
    if (!available) {
      console.error('  Refusing to continue.')
      return
    }

    if (!YES && !REHEARSE) {
      console.log('\nDry run: nothing generated or sent. Re-run with --yes to fund and execute.')
      return
    }

    const wallets = {
      organizer: Wallet.generate(),
      delegate: Wallet.generate(),
      broker: Wallet.generate(),
      buyers: Array.from({ length: BUYERS }, () => Wallet.generate()),
    }
    // With --resale the SECOND buyer buys again, so it also holds one more price.
    const resaleExtra = RESALE ? owed + 100_000n : 0n
    const targets: Array<{ label: string; wallet: Wallet; drops: bigint }> = [
      { label: 'organizer', wallet: wallets.organizer, drops: n.organizer },
      { label: 'delegate ', wallet: wallets.delegate, drops: n.delegate },
      { label: 'broker   ', wallet: wallets.broker, drops: n.broker },
      ...wallets.buyers.map((w, i) => ({ label: `buyer ${i + 1} `, wallet: w, drops: n.buyer + (i === 1 ? resaleExtra : 0n) })),
    ]

    if (REHEARSE) {
      head('Funding from the faucet')
      for (const t of targets) await client.fundWallet(t.wallet)
      console.log(`  funded ${targets.length} accounts`)
    } else {
      head('Fund these throwaway accounts (keys are held in memory only)')
      for (const t of targets) console.log(`  ${t.label}: ${t.wallet.classicAddress}   send >= ${xrp(t.drops)} XRP`)
      console.log('\n  Waiting up to 20 minutes for ALL of them. If this process dies after you fund them,')
      console.log('  the keys die with it and the XRP is stranded.')
      const deadline = Date.now() + 20 * 60_000
      for (;;) {
        const bals = await Promise.all(targets.map((t) => balanceOf(client, t.wallet.classicAddress)))
        if (targets.every((t, i) => (bals[i] ?? 0n) >= t.drops)) break
        if (Date.now() > deadline) {
          console.error('Timed out waiting for funding. Anything already sent is not recoverable.')
          return
        }
        await sleep(5_000)
      }
      console.log('  All funded.')
    }

    head('Running the shipped code (child process)')
    const code = await new Promise<number>((resolve) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', path.resolve(import.meta.dirname, 'mainnet-sale-check.ts'), ...argv.filter((a) => a !== '--yes')],
        {
          stdio: 'inherit',
          env: {
            ...process.env,
            MAINNET_SALE_CHECK_CHILD: '1',
            // The signers the shipped code reads, exactly as production does.
            DELEGATE_SEED: wallets.delegate.seed!,
            PLATFORM_SEED: wallets.broker.seed!,
            // The accounts the check itself signs as: the organizer's grant and the buyers' bids.
            CHECK_ORGANIZER_SEED: wallets.organizer.seed!,
            CHECK_BUYER_SEEDS: wallets.buyers.map((w) => w.seed!).join(','),
          },
        },
      )
      child.on('exit', (c) => resolve(c ?? 1))
    })
    console.log(`\n  child exited with code ${code}`)

    // ---- sweep what can be recovered back to the return address -------------
    const dest = RETURN_TO
    if (!dest) {
      console.log('  (rehearsal: no --return-to given, nothing swept)')
      return
    }
    head('Sweeping leftovers back')
    for (const t of [...wallets.buyers.map((w, i) => ({ label: `buyer ${i + 1}`, w })), { label: 'organizer', w: wallets.organizer }, { label: 'broker', w: wallets.broker }, { label: 'delegate', w: wallets.delegate }]) {
      try {
        const bal = await balanceOf(client, t.w.classicAddress)
        if (bal === null) continue
        const info = await client.request({ command: 'account_info', account: t.w.classicAddress, ledger_index: 'validated' })
        const reserve = res.baseDrops + BigInt(info.result.account_data.OwnerCount ?? 0) * res.incDrops
        const amount = bal - reserve - 200n
        if (amount <= 0n) {
          console.log(`  ${t.label.padEnd(10)} nothing above reserve (${xrp(bal)} XRP held)`)
          continue
        }
        const prepared = await client.autofill({ TransactionType: 'Payment', Account: t.w.classicAddress, Destination: dest, Amount: String(amount) } as never)
        const sent = await client.submitAndWait(t.w.sign(prepared).tx_blob)
        const meta = sent.result.meta
        console.log(`  ${t.label.padEnd(10)} swept ${xrp(amount)} XRP: ${typeof meta === 'object' ? meta.TransactionResult : meta}   tx ${sent.result.hash}`)
      } catch (e) {
        console.error(`  ${t.label} sweep failed: ${(e as Error).message.slice(0, 100)}`)
      }
    }
    process.exitCode = code
  } finally {
    await disconnectLedger()
  }
}

// ======================================================================== //
//  CHILD: the shipped code, signing as the keys in its environment          //
// ======================================================================== //

type Check = { name: string; ok: boolean; detail?: string }

async function child() {
  const [{ prisma }, { NETWORK }, { assertSafeDatabase }, { foreignNetworkRows }, ledgerMod, deleg, { realMintLedger }, { runMintJob }, { startCheckout }, { realPrimarySaleLedger }] = await Promise.all([
    import('../src/prisma.js'),
    import('../src/network.js'),
    import('../src/db-guard.js'),
    import('../src/network-guard.js'),
    import('../src/ledger.js'),
    import('../src/delegation.js'),
    import('../src/mint-ledger.js'),
    import('../src/bulk-mint.js'),
    import('../src/primary-sale.js'),
    import('../src/primary-sale-ledger.js'),
  ])
  const { ledger, delegateWallet, platformWallet, brokerSaleOnLedger, buildBuyOfferTx, platformFeeDrops, disconnectLedger } = ledgerMod
  const { buildDelegateSetTx, readPermissionSetOnLedger, MINT_PERMISSION, OFFER_PERMISSION } = deleg
  const { buildSellOfferTx } = ledgerMod
  const { isTxNotFound } = await import('../src/xrpl-errors.js')

  assertSafeDatabase('mainnet-sale-check')
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, detail })
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`)
  }

  // The same refusal the server makes at boot: a database holding another ledger's rows.
  const foreign = await foreignNetworkRows()
  if (foreign.length > 0) {
    console.error(`Refusing to run: this database holds rows for another ledger (${foreign.map((f) => `${f.network} ${f.model}`).join(', ')}).`)
    process.exitCode = 1
    return
  }

  const client = await ledger()
  const organizer = Wallet.fromSeed(process.env.CHECK_ORGANIZER_SEED!)
  const buyers = process.env.CHECK_BUYER_SEEDS!.split(',').map((s) => Wallet.fromSeed(s))
  const delegate = delegateWallet()
  const broker = platformWallet()
  const hashes: Record<string, string> = {}

  const tag = Math.random().toString(36).slice(2, 7)
  const user = await prisma.user.create({ data: { username: `msc_${tag}`, xrplAddress: organizer.classicAddress, role: 'ORGANIZER' } })
  const buyerUsers = await Promise.all(
    buyers.map((w, i) => prisma.user.create({ data: { username: `mscb${i}_${tag}`.slice(0, 20), xrplAddress: w.classicAddress } })),
  )
  const taxon = 76_000 + Math.floor(Math.random() * 900)
  const event = await prisma.event.create({
    data: {
      network: NETWORK,
      slug: `msc-${tag}`,
      title: 'Mainnet Sale Check',
      startsAt: new Date(Date.now() + 86_400_000),
      organizerId: user.id,
      nftTaxon: taxon,
      royaltyBps: 500,
      platformBps: env.PLATFORM_FEE_BPS,
      ticketCount: TICKETS,
      status: 'PUBLISHED',
      primaryPriceDrops: PRICE_DROPS,
    },
  })

  const ids = [user.id, ...buyerUsers.map((u) => u.id)]

  try {
    head('1. The organizer grants mint AND offers: one signature')
    const pair = { organizerAddress: organizer.classicAddress, delegateAddress: delegate.classicAddress }
    const grant = await client.autofill(buildDelegateSetTx(pair, [MINT_PERMISSION, OFFER_PERMISSION].sort()) as never)
    const granted = await client.submitAndWait(organizer.sign(grant).tx_blob)
    hashes.grant = granted.result.hash
    const set = await readPermissionSetOnLedger(pair)
    console.log(`  held on ledger: ${JSON.stringify(set)}   tx ${hashes.grant}`)
    check('grant visible on the ledger', Array.isArray(set) && set.includes(MINT_PERMISSION) && set.includes(OFFER_PERMISSION))

    head(`2. The shipped worker mints ${TICKETS} tickets, unattended`)
    const delegateBefore = (await balanceOf(client, delegate.classicAddress))!
    const job = await prisma.mintJob.create({
      data: { network: NETWORK, eventId: event.id, organizerId: user.id, organizerAddress: organizer.classicAddress, delegateAddress: delegate.classicAddress, total: TICKETS },
    })
    const started = Date.now()
    for (let pass = 1; pass <= 20; pass++) {
      await runMintJob(job.id, { ledger: realMintLedger() })
      const j = await prisma.mintJob.findUniqueOrThrow({ where: { id: job.id } })
      console.log(`  pass ${pass}: ${j.status}  ${j.minted}/${j.total}  failedTxs=${j.failedTxs}${j.statusReason ? `  (${j.statusReason})` : ''}`)
      if (j.status !== 'RUNNING' && j.status !== 'QUEUED') break
      if (j.nextAttemptAt && j.nextAttemptAt.getTime() > Date.now()) {
        await sleep(Math.min(15_000, j.nextAttemptAt.getTime() - Date.now()))
        await prisma.mintJob.update({ where: { id: job.id }, data: { nextAttemptAt: null } })
      }
    }
    const done = await prisma.mintJob.findUniqueOrThrow({ where: { id: job.id } })
    const recorded = await prisma.ticket.count({ where: { eventId: event.id } })
    let onLedger = 0
    const issuers = new Set<string>()
    let marker: unknown
    do {
      const r = (await client.request({ command: 'account_nfts', account: organizer.classicAddress, ledger_index: 'validated', limit: 400, ...(marker ? { marker } : {}) } as never)) as unknown as {
        result: { account_nfts: Array<{ Issuer?: string; NFTokenTaxon: number }>; marker?: unknown }
      }
      for (const n of r.result.account_nfts) if (n.NFTokenTaxon === taxon) (onLedger++, issuers.add(n.Issuer ?? ''))
      marker = r.result.marker
    } while (marker)
    const delegateAfter = (await balanceOf(client, delegate.classicAddress))!
    console.log(`  ${((Date.now() - started) / 1000).toFixed(1)}s; delegate paid ${delegateBefore - delegateAfter} drops (${Number(delegateBefore - delegateAfter) / TICKETS} per ticket)`)
    check('worker finished', done.status === 'DONE', done.status)
    check(`database, ledger and job agree on ${TICKETS}`, recorded === TICKETS && onLedger === TICKETS && done.minted === TICKETS, `db ${recorded}, ledger ${onLedger}, job ${done.minted}`)
    check('every ticket is issued by the ORGANIZER', issuers.size === 1 && issuers.has(organizer.classicAddress))
    check('no transaction was wasted', done.failedTxs === 0, `failedTxs ${done.failedTxs}`)
    check('the delegate, not the organizer, paid the mint fees', delegateBefore > delegateAfter)

    head(`3. ${buyers.length} buyers check out at once`)
    const sale = realPrimarySaleLedger()
    const t0 = Date.now()
    const outcomes = await Promise.all(
      buyerUsers.map(async (b) => {
        const s = Date.now()
        const o = await startCheckout({ slug: event.slug, buyerId: b.id, ledger: sale })
        return { o, ms: Date.now() - s, b }
      }),
    )
    for (const { o, ms, b } of outcomes) {
      console.log(`  ${b.username.padEnd(20)} ${o.kind === 'ok' ? 'ok' : `REFUSED ${o.status} ${o.code ?? ''} ${o.error}`}  (${(ms / 1000).toFixed(1)}s)`)
    }
    console.log(`  all returned after ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    check('every checkout succeeded', outcomes.every((x) => x.o.kind === 'ok'))

    head('4. Each buyer signs a bid; the broker matches each pair')
    const orgBefore = (await balanceOf(client, organizer.classicAddress))!
    const brokerBefore = (await balanceOf(client, broker.classicAddress))!
    let sold = 0
    let settled = true
    for (const { o, b } of outcomes) {
      if (o.kind !== 'ok') continue
      const listing = await prisma.listing.findUniqueOrThrow({ where: { id: o.listingId }, include: { ticket: true } })
      const wallet = buyers[buyerUsers.findIndex((u) => u.id === b.id)]!
      const prepared = await client.autofill(
        buildBuyOfferTx({
          buyerAddress: wallet.classicAddress,
          ownerAddress: organizer.classicAddress,
          nfTokenId: listing.ticket.nfTokenId,
          amountDrops: listing.priceDrops + listing.platformFeeDrops,
          brokerAddress: broker.classicAddress,
        }) as never,
      )
      const bid = await client.submitAndWait(wallet.sign(prepared).tx_blob)
      let buyIndex: string | undefined
      if (typeof bid.result.meta === 'object') {
        for (const node of bid.result.meta.AffectedNodes) if ('CreatedNode' in node && node.CreatedNode.LedgerEntryType === 'NFTokenOffer') buyIndex = node.CreatedNode.LedgerIndex
      }
      if (!buyIndex || !listing.offerIndex) throw new Error('missing an offer index')
      const matched = await brokerSaleOnLedger({ sellOfferIndex: listing.offerIndex, buyOfferIndex: buyIndex, brokerFeeDrops: listing.platformFeeDrops })
      hashes[`match-${b.username}`] = matched.hash
      console.log(`  ${b.username.padEnd(20)} ${matched.result}   tx ${matched.hash}`)
      if (matched.succeeded) sold++
      else settled = false
    }
    const orgAfter = (await balanceOf(client, organizer.classicAddress))!
    const brokerAfter = (await balanceOf(client, broker.classicAddress))!
    const expectedFee = platformFeeDrops(PRICE_DROPS, env.PLATFORM_FEE_BPS)
    const offers = (await client.request({ command: 'account_objects', account: organizer.classicAddress, type: 'nft_offer', ledger_index: 'validated' } as never)) as unknown as { result: { account_objects: unknown[] } }
    check('every sale settled', settled && sold === buyers.length)
    check('the organizer received EXACTLY the price (a primary sale skips the royalty)', orgAfter - orgBefore === PRICE_DROPS * BigInt(sold), `${xrp(orgAfter - orgBefore)} XRP vs ${xrp(PRICE_DROPS * BigInt(sold))}`)
    check('the broker took the platform fee, less its network fees', brokerAfter - brokerBefore > expectedFee * BigInt(sold) - BigInt(sold) * 100n && brokerAfter - brokerBefore <= expectedFee * BigInt(sold), `net ${xrp(brokerAfter - brokerBefore)} XRP vs fee ${xrp(expectedFee * BigInt(sold))}`)
    check('no offers left standing on the organizer', offers.result.account_objects.length === 0, `${offers.result.account_objects.length} open`)
    // Read from the LEDGER: each buyer must now hold exactly one ticket, issued by
    // the organizer. (The poll/sweep records ownership in the database; this
    // script matches directly, so the ledger is the honest witness.)
    const held = await Promise.all(
      buyers.map(async (w) => {
        const r = (await client.request({ command: 'account_nfts', account: w.classicAddress, ledger_index: 'validated' } as never)) as unknown as {
          result: { account_nfts: Array<{ Issuer?: string; NFTokenTaxon: number }> }
        }
        return r.result.account_nfts.filter((n) => n.NFTokenTaxon === taxon && n.Issuer === organizer.classicAddress).length
      }),
    )
    check('each buyer now holds exactly one of the organizer\'s tickets', held.every((c) => c === 1), `holdings: ${held.join(', ')}`)


    if (RESALE) {
      head('4b. RESALE: buyer 1 resells a delegate-minted ticket to buyer 2; the organizer must be paid its royalty')
      const seller = buyers[0]!
      const buyer2 = buyers[1]!
      const ticketOf = async (w: Wallet) => {
        const r = (await client.request({ command: 'account_nfts', account: w.classicAddress, ledger_index: 'validated', limit: 400 } as never)) as unknown as {
          result: { account_nfts: Array<{ NFTokenID: string; Issuer?: string; NFTokenTaxon: number }> }
        }
        return r.result.account_nfts.filter((n) => n.NFTokenTaxon === taxon && n.Issuer === organizer.classicAddress)
      }
      const offerIndexOf = (res: unknown): string | undefined => {
        const meta = (res as { result: { meta?: unknown } }).result.meta
        if (!meta || typeof meta !== 'object') return undefined
        for (const node of (meta as { AffectedNodes: Array<Record<string, { LedgerEntryType: string; LedgerIndex: string }>> }).AffectedNodes) {
          if (node.CreatedNode?.LedgerEntryType === 'NFTokenOffer') return node.CreatedNode.LedgerIndex
        }
        return undefined
      }
      const sellerTickets = await ticketOf(seller)
      check('buyer 1 holds a delegate-minted ticket to resell', sellerTickets.length === 1, `${sellerTickets.length}`)
      const nfTokenId = sellerTickets[0]!.NFTokenID
      const resalePrice = PRICE_DROPS
      const resaleFee = platformFeeDrops(resalePrice, env.PLATFORM_FEE_BPS)

      const sellTx = await client.submitAndWait(
        seller.sign(await client.autofill(buildSellOfferTx({ ownerAddress: seller.classicAddress, nfTokenId, amountDrops: resalePrice, brokerAddress: broker.classicAddress }) as never)).tx_blob,
      )
      const sellIndex = offerIndexOf(sellTx)
      const bidTx = await client.submitAndWait(
        buyer2.sign(
          await client.autofill(
            buildBuyOfferTx({ buyerAddress: buyer2.classicAddress, ownerAddress: seller.classicAddress, nfTokenId, amountDrops: resalePrice + resaleFee, brokerAddress: broker.classicAddress }) as never,
          ),
        ).tx_blob,
      )
      const buyIndex = offerIndexOf(bidTx)
      if (!sellIndex || !buyIndex) throw new Error('missing a resale offer index')
      hashes['resale-sell'] = sellTx.result.hash
      hashes['resale-bid'] = bidTx.result.hash
      const match = await brokerSaleOnLedger({ sellOfferIndex: sellIndex, buyOfferIndex: buyIndex, brokerFeeDrops: resaleFee })
      hashes['resale-match'] = match.hash
      console.log(`  resale match ${match.result}   tx ${match.hash}`)
      check('the resale settled', match.succeeded, match.result)

      // The payouts, read from the match transaction's OWN metadata: exact, and
      // immune to a node that has not yet caught up on balances.
      let metaNodes: Array<Record<string, { LedgerEntryType: string; FinalFields?: { Account?: string; Balance?: string }; PreviousFields?: { Balance?: string } }>> = []
      let txFee = 0n
      for (let i = 0; i < 20; i++) {
        try {
          const t = (await client.request({ command: 'tx', transaction: match.hash } as never)) as unknown as {
            result: { validated?: boolean; Fee?: string; tx_json?: { Fee?: string }; meta?: { AffectedNodes: typeof metaNodes } }
          }
          if (t.result.validated && t.result.meta) {
            metaNodes = t.result.meta.AffectedNodes
            txFee = BigInt(t.result.Fee ?? t.result.tx_json?.Fee ?? '0')
            break
          }
        } catch (e) {
          if (!isTxNotFound(e)) throw e
        }
        await sleep(2_000)
      }
      const deltaOf = (address: string): bigint => {
        for (const node of metaNodes) {
          const m = node.ModifiedNode
          if (m?.LedgerEntryType === 'AccountRoot' && m.FinalFields?.Account === address && m.PreviousFields?.Balance !== undefined) {
            return BigInt(m.FinalFields.Balance!) - BigInt(m.PreviousFields.Balance)
          }
        }
        return 0n
      }
      const royaltyBps = 500n
      const expectedRoyalty = (resalePrice * royaltyBps) / 10_000n
      const orgDelta = deltaOf(organizer.classicAddress)
      const sellerDelta = deltaOf(seller.classicAddress)
      const buyerDelta = deltaOf(buyer2.classicAddress)
      const brokerDelta = deltaOf(broker.classicAddress)
      console.log(`  bid ${xrp(resalePrice + resaleFee)} XRP = price ${xrp(resalePrice)} + platform fee ${xrp(resaleFee)}`)
      console.log(`  organizer (issuer) ${xrp(orgDelta).padStart(10)}   seller ${xrp(sellerDelta).padStart(10)}   broker ${xrp(brokerDelta).padStart(10)}   buyer 2 ${xrp(buyerDelta).padStart(11)}`)
      console.log(`  royalty = ${((Number(orgDelta) / Number(resalePrice)) * 100).toFixed(3)}% of the price (the token's TransferFee is 5%)`)
      check('the organizer was paid its 5% royalty on a resale of a DELEGATE-MINTED ticket', metaNodes.length > 0 && orgDelta === expectedRoyalty, `${xrp(orgDelta)} XRP vs ${xrp(expectedRoyalty)}`)
      check('the seller received the price less the royalty', sellerDelta === resalePrice - expectedRoyalty, `${xrp(sellerDelta)} XRP vs ${xrp(resalePrice - expectedRoyalty)}`)
      check('the broker took the platform fee, less its network fee', brokerDelta === resaleFee - txFee, `${xrp(brokerDelta)} XRP vs ${xrp(resaleFee - txFee)}`)
      check('the buyer paid exactly price + fee', buyerDelta === -(resalePrice + resaleFee), `${xrp(buyerDelta)} XRP`)
      const movedTo = await ticketOf(buyer2)
      check('the ticket moved to buyer 2 and is still issued by the organizer', movedTo.some((n) => n.NFTokenID === nfTokenId))
      const leftover = await Promise.all(
        [seller, buyer2].map(async (w) => ((await client.request({ command: 'account_objects', account: w.classicAddress, type: 'nft_offer', ledger_index: 'validated' } as never)) as unknown as { result: { account_objects: unknown[] } }).result.account_objects.length),
      )
      check('no resale offers left standing', leftover.every((c) => c === 0), `${leftover.join(', ')} open`)
    }

    head('5. Revoking SELLING closes sales and leaves minting alone')
    const current = (await readPermissionSetOnLedger(pair)) as string[]
    const keep = current.filter((p) => p !== OFFER_PERMISSION)
    const revoke = await client.autofill(buildDelegateSetTx(pair, keep) as never)
    const revoked = await client.submitAndWait(organizer.sign(revoke).tx_blob)
    hashes.revoke = revoked.result.hash
    const after = await readPermissionSetOnLedger(pair)
    console.log(`  held on ledger: ${JSON.stringify(after)}   tx ${hashes.revoke}`)
    check('offers revoked, mint kept', Array.isArray(after) && after.length === 1 && after[0] === MINT_PERMISSION)
    // A FRESH buyer: the ones above still have a purchase in progress in the
    // database (this script matches sales directly on the ledger rather than
    // letting the poll record them), and "you already have one" is checked
    // before "sales are closed". The refusal needs no funds, so no wallet.
    const spareUser = await prisma.user.create({
      data: { username: `mscs_${tag}`, xrplAddress: Wallet.generate().classicAddress },
    })
    ids.push(spareUser.id)
    const spare = await startCheckout({ slug: event.slug, buyerId: spareUser.id, ledger: sale })
    check('a checkout is now refused as "closed"', spare.kind === 'refused' && spare.code === 'SALES_CLOSED', spare.kind === 'refused' ? `${spare.status} ${spare.code}` : 'it SUCCEEDED')

    head('RESULTS')
    const failed = checks.filter((c) => !c.ok)
    for (const [k, v] of Object.entries(hashes)) console.log(`  tx ${k.padEnd(28)} ${v}`)
    console.log(`\n  ${checks.length - failed.length} of ${checks.length} checks passed`)
    process.exitCode = failed.length === 0 ? 0 : 1
  } finally {
    head('Cleaning up the database rows (the tickets stay on the ledger)')
    await prisma.xamanPayload.deleteMany({ where: { userId: { in: ids } } })
    await prisma.transfer.deleteMany({ where: { ticket: { eventId: event.id } } })
    await prisma.listing.deleteMany({ where: { ticket: { eventId: event.id } } })
    await prisma.ticket.deleteMany({ where: { eventId: event.id } })
    await prisma.mintJob.deleteMany({ where: { eventId: event.id } })
    await prisma.event.delete({ where: { id: event.id } })
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
    await prisma.$disconnect()
    await disconnectLedger()
  }

}

;(CHILD ? child() : parent()).catch((e) => {
  console.error('CHECK FAILED:', e)
  process.exitCode = 1
})
