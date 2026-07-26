/**
 * Create the Hubworld platform (broker) account and record its seed in .env.
 *
 * Brokered mode needs an account Hubworld itself can sign with: the broker
 * submits the NFTokenAcceptOffer that matches a seller's offer to a buyer's and
 * takes platformBps as NFTokenBrokerFee. Funds still never rest with Hubworld —
 * the ledger moves them buyer -> seller/issuer atomically — but the signature is
 * ours, so this is a hot key.
 *
 * The seed is generated in-process, written directly to .env, and NEVER printed.
 * Only the address is shown. Anything that echoes a seed to a terminal puts it in
 * shell history and scrollback.
 *
 *   npm run platform:setup
 */
import { appendFileSync, chmodSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client, Wallet } from 'xrpl'
import { env } from '../src/env.js'
import { XRPL_ENDPOINT } from '../src/ledger.js'

const ENV_PATH = resolve(import.meta.dirname, '../.env')

async function main() {
  // Guardrails. A mainnet platform account is a deliberate act with real money
  // behind it; it must not be conjured by a dev convenience script.
  if (env.NODE_ENV === 'production') {
    console.error('Refusing to run in production.')
    process.exit(1)
  }
  if (env.XRPL_NETWORK === 'mainnet') {
    console.error(
      'Refusing to generate a mainnet platform account. Create it deliberately,\n' +
        'store the seed in a real secret manager, and set PLATFORM_SEED yourself.',
    )
    process.exit(1)
  }

  const current = readFileSync(ENV_PATH, 'utf8')
  if (/^\s*PLATFORM_SEED\s*=\s*\S/m.test(current)) {
    console.error('PLATFORM_SEED is already set in .env. Refusing to overwrite it.')
    console.error('Remove the existing line by hand if you really want a new account.')
    process.exit(1)
  }

  // Generated locally, so the seed never crosses the network.
  const wallet = Wallet.generate()

  const res = await fetch('https://faucet.altnet.rippletest.net/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destination: wallet.classicAddress }),
  })
  if (!res.ok) {
    console.error(`Faucet funding failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }

  appendFileSync(
    ENV_PATH,
    `\n# Hubworld broker account (${env.XRPL_NETWORK}). Backend-only, never in the bundle.\n` +
      `PLATFORM_SEED=${wallet.seed}\n`,
  )
  // .env is gitignored, but tighten permissions anyway now that it holds a key.
  chmodSync(ENV_PATH, 0o600)

  // Wait for activation so the address is usable immediately.
  const client = new Client(XRPL_ENDPOINT)
  await client.connect()
  let balance = '0'
  for (let i = 0; i < 8; i++) {
    try {
      const info = await client.request({
        command: 'account_info',
        account: wallet.classicAddress,
        ledger_index: 'validated',
      })
      balance = info.result.account_data.Balance
      break
    } catch {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  await client.disconnect()

  console.log('Platform broker account created.')
  console.log(`  network  ${env.XRPL_NETWORK}`)
  console.log(`  address  ${wallet.classicAddress}`)
  console.log(`  balance  ${Number(balance) / 1_000_000} XRP`)
  console.log('  seed     written to backend/.env (not printed)')
  console.log('\nRestart the backend so it picks up PLATFORM_SEED.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
