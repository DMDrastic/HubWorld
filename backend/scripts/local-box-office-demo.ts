/**
 * Sets up ONE event you can actually buy a ticket to on a local stack, on the real test network.
 *
 * Creates a throwaway organizer (funded from the test faucet), has it allow a throwaway delegate to mint and sell for it, mints a
 * few real tickets, and records the event and tickets in the LOCAL database at a box-office price. Buying one then runs the real
 * thing end to end: a wallet that has to be funded, an approval, the delegate's sell offer, the brokered match.
 *
 * Normally run through `scripts/local-stack.sh event`, which supplies the environment. By hand:
 *
 *   DOTENV_CONFIG_PATH=<local .env> XRPL_NETWORK=testnet DELEGATE_ENV_FILE=<path> \
 *     npx tsx scripts/local-box-office-demo.ts [--tickets 5] [--price 10]
 *
 * The delegate's seed lives in DELEGATE_ENV_FILE (default ~/.hubworld-local-delegate.env, mode 600, outside the repo). It is created
 * and funded on the first run and reused after, because the local stack signs as that delegate. It is never printed. Test network
 * only; refuses a database that is not local.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getNFTokenID, Wallet } from 'xrpl'
import { prisma } from '../src/prisma.js'
import { env } from '../src/env.js'
import { NETWORK } from '../src/network.js'
import { assertSafeDatabase } from '../src/db-guard.js'
import { buildMintTx, disconnectLedger, ledger } from '../src/ledger.js'
import { buildDelegateSetTx, MINT_PERMISSION, OFFER_PERMISSION } from '../src/delegation.js'
import { ticketMetadataUri } from '../src/nft-metadata.js'

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : Number(process.argv[i + 1])
}

async function main() {
  if (env.XRPL_NETWORK !== 'testnet') throw new Error('Test network only.')
  assertSafeDatabase('local-box-office-demo')
  const file = process.env.DELEGATE_ENV_FILE || join(homedir(), '.hubworld-local-delegate.env')
  const tickets = arg('tickets', 5)
  const priceDrops = BigInt(Math.round(arg('price', 10) * 1_000_000))

  const c = await ledger()

  // The delegate: reuse the one from an earlier run, so the grant below names an account the stack will really run as.
  let delegate: Wallet
  if (existsSync(file) && /DELEGATE_SEED=(\S+)/.test(readFileSync(file, 'utf8'))) {
    delegate = Wallet.fromSeed(/DELEGATE_SEED=(\S+)/.exec(readFileSync(file, 'utf8'))![1]!)
    console.log(`delegate (existing) ${delegate.classicAddress}`)
  } else {
    delegate = Wallet.generate()
    writeFileSync(file, `DELEGATE_SEED=${delegate.seed}\n`, { mode: 0o600 })
    chmodSync(file, 0o600)
    await c.fundWallet(delegate)
    console.log(`delegate (new, funded) ${delegate.classicAddress}`)
  }

  const { wallet: organizer } = await c.fundWallet(Wallet.generate('ecdsa-secp256k1' as never))
  console.log(`organizer ${organizer.classicAddress}`)

  const send = async (tx: Record<string, unknown>) => {
    const prepared = await c.autofill(tx as never)
    const res = await c.submitAndWait(organizer.sign(prepared as never).tx_blob)
    const meta = res.result.meta
    if (typeof meta !== 'object' || meta.TransactionResult !== 'tesSUCCESS') throw new Error(`transaction failed: ${typeof meta === 'object' ? meta.TransactionResult : 'unknown'}`)
    return meta
  }

  await send(buildDelegateSetTx({ organizerAddress: organizer.classicAddress, delegateAddress: delegate.classicAddress }, [MINT_PERMISSION, OFFER_PERMISSION].sort()) as never)
  console.log('organizer allowed the delegate to mint and sell')

  const tag = Math.random().toString(36).slice(2, 6)
  const slug = `privy-demo-${tag}`
  const taxon = 60_000 + Math.floor(Math.random() * 900)
  const user = await prisma.user.create({ data: { username: `demo_org_${tag}`, xrplAddress: organizer.classicAddress, role: 'ORGANIZER' } })
  const event = await prisma.event.create({
    data: {
      network: NETWORK, slug, title: `Privy Demo Night ${tag}`, venue: 'The Demo Hub',
      startsAt: new Date(Date.now() + 7 * 86_400_000), organizerId: user.id, nftTaxon: taxon, royaltyBps: 500,
      platformBps: env.PLATFORM_FEE_BPS, ticketCount: tickets, status: 'PUBLISHED', primaryPriceDrops: priceDrops,
      // The code door, as the create form now defaults to, when this stack can sign codes (local-stack.sh makes the secret).
      doorMode: process.env.DOOR_TOKEN_SECRET ? 'QR' : 'SIGNATURE',
    },
  })
  for (let i = 0; i < tickets; i++) {
    const meta = await send(buildMintTx({ issuerAddress: organizer.classicAddress, taxon, royaltyBps: 500, uri: ticketMetadataUri(slug) }) as never)
    const nfTokenId = getNFTokenID(meta as never)
    if (!nfTokenId) throw new Error('mint produced no NFTokenID')
    await prisma.ticket.create({ data: { nfTokenId, network: NETWORK, eventId: event.id, ownerId: user.id, ownerAddress: organizer.classicAddress, status: 'MINTED' } })
    console.log(`  minted ${i + 1}/${tickets}`)
  }
  console.log(`\nReady: "${event.title}" at ${Number(priceDrops) / 1e6} XRP, ${tickets} tickets, slug ${slug}`)
}

main()
  .catch((e) => {
    console.error('SETUP FAILED:', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    await disconnectLedger()
  })
