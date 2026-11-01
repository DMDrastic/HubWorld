/**
 * Runs the holder actions through the SHIPPED Privy signing path against a real ledger.
 *
 * The unit tests fake the ledger. This shows that the real ledger accepts what the server builds, stores and submits for a
 * wallet it does not hold the key to: a listing (sell offer), a purchase (buy offer) and a withdrawal (cancel), each created by
 * `privySigner.createPayload`, signed here by a key the server never sees (as the browser does), and submitted by
 * `submitSignature`. A sale is then brokered with the real broker transaction and the money checked to the drop.
 *
 *   DOTENV_CONFIG_PATH=/nonexistent XRPL_NETWORK=testnet DATABASE_URL=<local scratch db> PLATFORM_SEED=<seed> \
 *     npx tsx scripts/privy-actions-check.ts
 *
 * Devnet/testnet only; refuses mainnet and a remote database.
 */
import { ECDSA, Wallet, decode, getNFTokenID } from 'xrpl'
import { prisma } from '../src/prisma.js'
import { env } from '../src/env.js'
import { assertSafeDatabase } from '../src/db-guard.js'
import { NETWORK } from '../src/network.js'
import { brokerSaleOnLedger, buildBuyOfferTx, buildCancelOfferTx, buildMintTx, buildSellOfferTx, disconnectLedger, ledger, platformWallet } from '../src/ledger.js'
import { privySigner, submitSignature } from '../src/privy-signing.js'
import { buildAcceptOfferTx } from '../src/ledger.js'

const head = (s: string) => console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`)
const xrp = (d: bigint) => (Number(d) / 1e6).toFixed(6)
const checks: Array<{ ok: boolean; what: string }> = []
const check = (ok: boolean, what: string) => {
  checks.push({ ok, what })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`)
}

async function main() {
  if (env.XRPL_NETWORK === 'mainnet') throw new Error('Devnet/testnet only.')
  if (!env.PLATFORM_SEED) throw new Error('Set PLATFORM_SEED (a throwaway seed).')
  assertSafeDatabase('privy-actions-check')
  const c = await ledger()
  const broker = platformWallet()

  const send = async (w: Wallet, tx: Record<string, unknown>) => {
    const prepared = await c.autofill(tx as never)
    const res = await c.submitAndWait(w.sign(prepared as never).tx_blob)
    const meta = res.result.meta
    return { hash: res.result.hash, meta: typeof meta === 'object' ? meta : undefined }
  }
  const bal = async (a: string) => BigInt((await c.request({ command: 'account_info', account: a, ledger_index: 'validated' })).result.account_data.Balance)
  const offerIdx = (meta: unknown) => {
    for (const n of (meta as { AffectedNodes: Array<Record<string, { LedgerEntryType: string; LedgerIndex: string }>> }).AffectedNodes) {
      if ('CreatedNode' in n && n.CreatedNode!.LedgerEntryType === 'NFTokenOffer') return n.CreatedNode!.LedgerIndex
    }
    throw new Error('no offer created')
  }
  const offerExists = async (idx: string) => {
    try {
      await c.request({ command: 'ledger_entry', index: idx, ledger_index: 'validated' } as never)
      return true
    } catch {
      return false
    }
  }

  head('1. Wallets: an organizer, a holder and a buyer (secp256k1, like Privy), plus the broker')
  await c.fundWallet(broker)
  const fresh = async () => (await c.fundWallet(Wallet.generate('ecdsa-secp256k1' as never))).wallet
  const organizer = await fresh()
  const holder = await fresh()
  const buyer = await fresh()
  console.log(`  organizer ${organizer.classicAddress}\n  holder    ${holder.classicAddress}\n  buyer     ${buyer.classicAddress}\n  broker    ${broker.classicAddress}`)

  const tag = Math.random().toString(36).slice(2, 7)
  const mkUser = (name: string, w: Wallet) =>
    prisma.user.create({
      data: {
        username: `pa${name}_${tag}`.slice(0, 20),
        xrplAddress: w.classicAddress,
        wallet: { create: { xrplAddress: w.classicAddress, signerKind: 'PRIVY', providerUserId: `did:privy:pa${name}${tag}`, publicKey: w.publicKey } },
      },
    })
  const holderU = await mkUser('holder', holder)
  const buyerU = await mkUser('buyer', buyer)

  /** What the browser does: sign the hash of the transaction the server holds, and send back ONLY the signature. */
  const approve = async (userId: string, w: Wallet, flow: Parameters<typeof privySigner.createPayload>[1]['flow'], tx: Record<string, unknown>) => {
    const made = await privySigner.createPayload(tx, { flow, userId })
    const signature = (decode(w.sign(made.sign!.tx as never).tx_blob) as { TxnSignature: string }).TxnSignature
    const res = await submitSignature(made.uuid, userId, signature)
    if (!res.ok) throw new Error(`${flow} refused: ${res.error}`)
    // Wait for the ledger to validate it, and read the result.
    for (let i = 0; i < 60; i++) {
      try {
        const r = await c.request({ command: 'tx', transaction: res.txid })
        if (r.result.validated) return { txid: res.txid, meta: typeof r.result.meta === 'object' ? r.result.meta : undefined, code: typeof r.result.meta === 'object' ? r.result.meta.TransactionResult : 'unknown' }
      } catch {
        // not yet visible
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    throw new Error(`${flow} did not validate`)
  }

  head('2. Give the holder two tickets (the organizer mints and hands them over for free, signing for itself)')
  const nfts: string[] = []
  for (let i = 0; i < 2; i++) {
    const m = await send(organizer, buildMintTx({ issuerAddress: organizer.classicAddress, taxon: 4_242, royaltyBps: 500, uri: 'ABCD' }) as never)
    const id = getNFTokenID(m.meta as never)!
    nfts.push(id)
    const gift = await send(organizer, { TransactionType: 'NFTokenCreateOffer', Account: organizer.classicAddress, NFTokenID: id, Amount: '0', Destination: holder.classicAddress, Flags: 1 })
    await send(holder, buildAcceptOfferTx({ accepterAddress: holder.classicAddress, offerIndex: offerIdx(gift.meta) }) as never)
  }
  const [T1, T2] = nfts as [string, string]

  head('3. LISTING_CREATE: the holder\'s wallet signs a sell offer to the broker (ask 10, fee 0.5, so the offer is 9.5)')
  const PRICE = 10_000_000n
  const FEE = 500_000n
  const listed = await approve(holderU.id, holder, 'LISTING_CREATE', buildSellOfferTx({ ownerAddress: holder.classicAddress, nfTokenId: T1, amountDrops: PRICE - FEE, brokerAddress: broker.classicAddress }) as never)
  check(listed.code === 'tesSUCCESS', `the sell offer validates (${listed.code})`)
  const sellIdx = offerIdx(listed.meta)

  head('4. LISTING_BUY: the buyer\'s wallet signs a buy offer for exactly the price')
  const bought = await approve(buyerU.id, buyer, 'LISTING_BUY', buildBuyOfferTx({ buyerAddress: buyer.classicAddress, ownerAddress: holder.classicAddress, nfTokenId: T1, amountDrops: PRICE, brokerAddress: broker.classicAddress }) as never)
  check(bought.code === 'tesSUCCESS', `the buy offer validates (${bought.code})`)
  const buyIdx = offerIdx(bought.meta)

  head('5. The broker matches the pair: who receives what')
  const before = { buyer: await bal(buyer.classicAddress), holder: await bal(holder.classicAddress), organizer: await bal(organizer.classicAddress) }
  const matched = await brokerSaleOnLedger({ sellOfferIndex: sellIdx, buyOfferIndex: buyIdx, brokerFeeDrops: FEE })
  check(matched.succeeded, `the broker match succeeds (${matched.result})`)
  const after = { buyer: await bal(buyer.classicAddress), holder: await bal(holder.classicAddress), organizer: await bal(organizer.classicAddress) }
  const royalty = ((PRICE - FEE) * 500n) / 10_000n
  console.log(`\n  party       received            expected`)
  console.log(`  buyer      ${xrp(after.buyer - before.buyer).padStart(12)}      ${xrp(-PRICE)}`)
  console.log(`  seller     ${xrp(after.holder - before.holder).padStart(12)}      ${xrp(PRICE - FEE - royalty)}`)
  console.log(`  organizer  ${xrp(after.organizer - before.organizer).padStart(12)}      ${xrp(royalty)}`)
  check(after.buyer - before.buyer === -PRICE, 'the buyer paid exactly the price')
  check(after.holder - before.holder === PRICE - FEE - royalty, 'the seller received price - fee - royalty')
  check(after.organizer - before.organizer === royalty, 'the royalty landed')
  const nft = (a: string) => c.request({ command: 'account_nfts', account: a, ledger_index: 'validated', limit: 400 } as never) as unknown as Promise<{ result: { account_nfts: Array<{ NFTokenID: string }> } }>
  check((await nft(buyer.classicAddress)).result.account_nfts.some((n) => n.NFTokenID === T1), 'the ticket is in the buyer\'s wallet')

  head('6. LISTING_CANCEL: list the second ticket, then take it off sale with a signed withdrawal')
  const l2 = await approve(holderU.id, holder, 'LISTING_CREATE', buildSellOfferTx({ ownerAddress: holder.classicAddress, nfTokenId: T2, amountDrops: 9_500_000n, brokerAddress: broker.classicAddress }) as never)
  const idx2 = offerIdx(l2.meta)
  check(await offerExists(idx2), 'the second listing is on the ledger')
  const cancelled = await approve(holderU.id, holder, 'LISTING_CANCEL', buildCancelOfferTx({ ownerAddress: holder.classicAddress, offerIndex: idx2 }) as never)
  check(cancelled.code === 'tesSUCCESS', `the withdrawal validates (${cancelled.code})`)
  check(!(await offerExists(idx2)), 'the listing is gone from the ledger')
  check((await nft(holder.classicAddress)).result.account_nfts.some((n) => n.NFTokenID === T2), 'the ticket is still in the holder\'s wallet')

  head('7. The server refuses what it should, on the real path')
  const wrong = await privySigner.createPayload(buildSellOfferTx({ ownerAddress: holder.classicAddress, nfTokenId: T2, amountDrops: 1_000_000n, brokerAddress: broker.classicAddress }) as never, { flow: 'LISTING_BUY', userId: holderU.id }).then(() => 'built', (e: Error) => e.message)
  check(/buy offer/i.test(wrong), `a sell offer asked for as a purchase is refused (${wrong})`)
  const elsewhere = await privySigner.createPayload(buildBuyOfferTx({ buyerAddress: buyer.classicAddress, ownerAddress: holder.classicAddress, nfTokenId: T2, amountDrops: 1_000_000n, brokerAddress: broker.classicAddress }) as never, { flow: 'LISTING_BUY', userId: holderU.id }).then(() => 'built', (e: Error) => e.message)
  check(/not for your account/i.test(elsewhere), `a transaction for someone else\'s account is refused (${elsewhere})`)

  head('8. Clean up the database rows (the accounts stay on the test network)')
  const ids = [holderU.id, buyerU.id]
  await prisma.xamanPayload.deleteMany({ where: { userId: { in: ids } } })
  await prisma.wallet.deleteMany({ where: { userId: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
  void NETWORK

  head(`RESULT: ${checks.filter((x) => x.ok).length} of ${checks.length} checks passed`)
  for (const x of checks.filter((y) => !y.ok)) console.log(`  FAILED: ${x.what}`)
  if (checks.some((x) => !x.ok)) process.exitCode = 1
}

main()
  .catch((e) => {
    console.error('CHECK FAILED:', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    await disconnectLedger()
  })
