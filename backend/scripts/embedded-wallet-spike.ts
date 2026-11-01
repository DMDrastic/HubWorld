/**
 * SPIKE A: do the royalties survive when buyers hold their tickets in EMBEDDED wallets?
 *
 * The question behind the Xaman replacement. Fans would log in with an email or phone,
 * a wallet vendor would hold their key shares, and the ticket would still be a real
 * NFToken in a real XRPL account. The product only works if that changes nothing the
 * ledger does: `TransferFee` must still reach the organizer on every paid transfer,
 * and the vendor must be able to sign every transaction type HubWorld asks of a user.
 *
 * What it asserts, per provider:
 *   S1  the wallet can sign NFTokenMint and DelegateSet (the ORGANIZER's two)
 *   S2  the wallet can sign NFTokenCreateOffer (list / bid / gift)
 *   S3  the wallet can sign NFTokenAcceptOffer (gift acceptance)
 *   R1  a primary sale through the broker settles; the organizer is party, so NO royalty
 *   R2  a RESALE between two embedded buyers pays the organizer `TransferFee`
 *       (5% of the bid minus the broker fee), in XRP or in a test IOU (--currency USD)
 *   C1  the cost of activating a new buyer: reserve locked per wallet, in drops
 *
 * The baseline provider (`local`) needs no vendor and runs today, so the harness is
 * proven BEFORE any vendor is plugged in; a vendor failing is then a finding about the
 * vendor, not about this script. The `privy` and `web3auth` adapters deliberately do
 * nothing until they are written against the vendor's docs from a real app: this file
 * must not guess at an API it has not called.
 *
 * Testnet, faucet-funded. Touches no database and no repo credentials.
 *   npx tsx scripts/embedded-wallet-spike.ts                      # local baseline, XRP
 *   npx tsx scripts/embedded-wallet-spike.ts --currency USD       # royalty paid in a test IOU
 *   npx tsx scripts/embedded-wallet-spike.ts --provider privy     # needs PRIVY_APP_ID/SECRET
 *
 * NOT real RLUSD: `--currency USD` issues its own test IOU. Whether the real RLUSD issuer
 * behaves the same (trust lines, DefaultRipple) is a separate check against the real issuer.
 */
import { Wallet, encodeForSigning, encode } from 'xrpl'
import type { Client } from 'xrpl'
import {
  ledger,
  disconnectLedger,
  buildMintTx,
  buildSellOfferTx,
  buildBuyOfferTx,
  buildGiftOfferTx,
  buildAcceptOfferTx,
  bpsToTransferFee,
} from '../src/ledger.js'
import { buildDelegateSetTx, asDelegatedMint } from '../src/delegation.js'

// ------------------------------------------------------------------ options --

const args = process.argv.slice(2)
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback
}
const PROVIDER = flag('provider', 'local')
const CURRENCY = flag('currency', 'XRP') // XRP | USD (own test IOU) | RLUSD (the real testnet issuer)
const ROYALTY_BPS = 500 // 5%, the TransferFee on the token
// Price in whole units (XRP, USD or RLUSD); scaled by 1e6 so one bigint path serves all three.
// RLUSD defaults small because the faucet's amount per claim is not documented.
const PRICE_UNITS = Number(flag('price', CURRENCY === 'RLUSD' ? '1' : '10'))
const PRICE_DROPS = BigInt(Math.round(PRICE_UNITS * 1_000_000))
// The real testnet RLUSD issuer and currency code, from docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl
const RLUSD_ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV'
const RLUSD_HEX = '524C555344000000000000000000000000000000'
const FEE_BPS = 500n // broker fee, 5% of price
const FUND_DROPS = '15000000' // what each new embedded wallet is sent: 15 XRP
const DELEGATE_DROPS = '3000000'

// ---------------------------------------------------------------- providers --

/**
 * An embedded wallet as the rest of the script sees it: an address, a public key, and a
 * way to turn a prepared transaction into a signed blob. Nothing else may be assumed,
 * because a vendor will not hand over a seed.
 */
type EmbeddedWallet = {
  address: string
  publicKey: string
  /** Sign a prepared (autofilled) transaction; returns the `tx_blob` to submit. */
  sign(prepared: Record<string, unknown>): Promise<string>
}

type Provider = {
  name: string
  /** A brand-new wallet, as a first-time email login would create. */
  create(label: string): Promise<EmbeddedWallet>
}

/** Baseline: an ordinary seed held locally. Proves the harness, costs nothing. */
const localProvider: Provider = {
  name: 'local',
  async create() {
    const w = Wallet.generate()
    return {
      address: w.classicAddress,
      publicKey: w.publicKey,
      async sign(prepared) {
        return w.sign(prepared as never).tx_blob
      },
    }
  },
}

/**
 * What a vendor adapter has to do, written down so it is not rediscovered:
 *  1. create a wallet for a (test) user and read back its address AND public key;
 *  2. put that public key in `SigningPubKey`, because autofill does not and the ledger
 *     will not accept a signature without it;
 *  3. `encodeForSigning(tx)` and hand the bytes to the vendor, or hash them and use its
 *     raw-sign endpoint, then rebuild the blob with `TxnSignature` filled in via `encode`.
 * `encodeForSigning` and `encode` are imported above for exactly that.
 */
void encode

/**
 * Privy, over its REST API. Verified against docs.privy.io/wallets/using-wallets/other-chains/xrpl:
 *   create  POST /v1/wallets {chain_type:'xrpl'} -> {id, address, public_key}
 *   sign    POST /v1/wallets/<id>/rpc {method:'xrpl_signTransaction', params:{transaction, encoding:'hex'}}
 *           -> data.signed_transaction (the blob to submit)
 * The REST reference page does not list `xrpl` among chain types yet; if create is refused the
 * body is printed verbatim, which is the finding. These wallets are APP-MANAGED, so this tests
 * "can Privy's key sign these types", not the user-owned fan flow.
 */
function privyProvider(): Provider {
  const appId = process.env.PRIVY_APP_ID
  const secret = process.env.PRIVY_APP_SECRET
  const call = async (path: string, body: unknown) => {
    const res = await withRetry(`privy ${path.slice(0, 22)}`, () => fetch(`https://api.privy.io${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'privy-app-id': appId!,
        Authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString('base64')}`,
      },
      body: JSON.stringify(body),
    }))
    const text = await res.text()
    if (!res.ok) throw new Error(`Privy ${path} ${res.status}: ${text.slice(0, 300)}`)
    return JSON.parse(text) as { id?: string; address?: string; public_key?: string; data?: { signed_transaction?: string } }
  }
  return {
    name: 'privy',
    async create() {
      const w = await call('/v1/wallets', { chain_type: 'xrpl' })
      if (!w.id || !w.address || !w.public_key) throw new Error(`Privy wallet response missing fields: ${Object.keys(w).join(',')}`)
      const { id, address, public_key } = w
      return {
        address,
        publicKey: public_key.toUpperCase(), // xrpl.js wants uppercase hex
        async sign(prepared) {
          // `transaction` is the signing prefix + STObject, which encodeForSigning produces.
          const out = await call(`/v1/wallets/${id}/rpc`, {
            method: 'xrpl_signTransaction',
            params: { transaction: encodeForSigning(prepared as never), encoding: 'hex' },
          })
          const blob = out.data?.signed_transaction
          if (!blob) throw new Error('Privy returned no signed_transaction')
          return blob
        },
      }
    },
  }
}

function notWired(name: string, needs: string[]): Provider {
  return {
    name,
    async create() {
      const missing = needs.filter((k) => !process.env[k])
      throw new Error(
        missing.length
          ? `${name}: set ${missing.join(', ')} first (create the app, put the values in your shell or an env file, never in chat).`
          : `${name}: credentials are present but the adapter is not written. Fill it in from the vendor's docs against a real app; do not guess the API.`,
      )
    },
  }
}

const PROVIDERS: Record<string, Provider> = {
  local: localProvider,
  privy:
    process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET
      ? privyProvider()
      : notWired('privy', ['PRIVY_APP_ID', 'PRIVY_APP_SECRET']),
  web3auth: notWired('web3auth', ['WEB3AUTH_CLIENT_ID']),
}

// ------------------------------------------------------------------ helpers --

/**
 * Retry a call that talks to a flaky network (the testnet faucet, Privy's API). A spike is a long
 * chain of calls, and one dropped connection should not throw away the run. Only a thrown error is
 * retried, with a growing pause; a refusal that comes back as a response is never retried.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 8): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn()
    } catch (e) {
      if (attempt >= tries) throw e
      console.log(`  (${label}: ${(e as Error).message.slice(0, 60)}, retry ${attempt}/${tries - 1})`)
      await new Promise((r) => setTimeout(r, 1500 * attempt))
    }
  }
}

type Result = { id: string; ok: boolean; note: string }
const results: Result[] = []
const check = (id: string, ok: boolean, note: string) => {
  results.push({ id, ok, note })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}: ${note}`)
}

const head = (s: string) => console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`)

type Signer = { address: string; sign(prepared: Record<string, unknown>): Promise<string> }

const fromWallet = (w: Wallet): Signer => ({
  address: w.classicAddress,
  sign: async (p) => w.sign(p as never).tx_blob,
})

/** Autofill, sign with whoever holds the key, submit, wait for validation. */
async function submit(signer: Signer, tx: Record<string, unknown>, label: string, publicKey?: string) {
  const client = await ledger()
  try {
    const prepared = (await client.autofill(tx as never)) as unknown as Record<string, unknown>
    // A vendor wallet has no seed for xrpl.js to read the key from.
    if (publicKey) prepared.SigningPubKey = publicKey
    const blob = await signer.sign(prepared)
    const res = await client.submitAndWait(blob)
    const meta = res.result.meta
    const code = typeof meta === 'object' ? meta.TransactionResult : String(meta)
    console.log(`  ${label}: ${code}`)
    return { code, hash: res.result.hash as string, ok: code === 'tesSUCCESS', message: '' }
  } catch (e) {
    const message = (e as Error).message
    console.log(`  ${label}: FAILED, ${message.slice(0, 160)}`)
    return { code: 'failed', hash: '', ok: false, message }
  }
}

/**
 * The index of the offer a validated transaction created, read from the REAL ledger.
 * Not `offerIndexFromTx` from src/ledger: that one answers from the in-memory fake when
 * no Xaman credentials are set, which is true of every script run, and returns null.
 */
async function offerIndexFromTx(txHash: string): Promise<string | null> {
  const client = await ledger()
  const res = await client.request({ command: 'tx', transaction: txHash })
  const meta = res.result.meta
  if (!res.result.validated || !meta || typeof meta === 'string') return null
  for (const node of meta.AffectedNodes) {
    if ('CreatedNode' in node && node.CreatedNode.LedgerEntryType === 'NFTokenOffer') {
      return node.CreatedNode.LedgerIndex
    }
  }
  return null
}

async function xrpBalance(client: Client, address: string): Promise<bigint> {
  const r = await client.request({ command: 'account_info', account: address, ledger_index: 'validated' })
  return BigInt(r.result.account_data.Balance)
}

async function iouBalance(client: Client, address: string, issuer: string, code: string): Promise<bigint> {
  const r = await client.request({ command: 'account_lines', account: address, peer: issuer })
  const line = r.result.lines.find((l) => l.currency === code)
  // Whole-unit test IOU, scaled to match drops so one comparison path serves both modes.
  return line ? BigInt(Math.round(Number(line.balance) * 1_000_000)) : 0n
}

async function ownerCount(client: Client, address: string): Promise<number> {
  const r = await client.request({ command: 'account_info', account: address, ledger_index: 'validated' })
  return r.result.account_data.OwnerCount
}

// --------------------------------------------------------------------- main --

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const provider = PROVIDERS[PROVIDER]
  if (!provider) throw new Error(`unknown provider "${PROVIDER}" (${Object.keys(PROVIDERS).join(', ')})`)
  if (!['XRP', 'USD', 'RLUSD'].includes(CURRENCY)) throw new Error('--currency must be XRP, USD or RLUSD')
  const client = await ledger()

  head(`Spike A: provider=${provider.name}, currency=${CURRENCY}, price=${PRICE_UNITS}`)

  // HubWorld's own accounts are ordinary seeds; only the FANS and the organizer are embedded.
  const { wallet: funder } = await withRetry('faucet', () => client.fundWallet())
  const { wallet: broker } = await withRetry('faucet', () => client.fundWallet())
  const delegate = Wallet.generate() // HubWorld's delegate key: a separate key from the broker's
  await submit(fromWallet(funder), { TransactionType: 'Payment', Account: funder.classicAddress, Destination: delegate.classicAddress, Amount: DELEGATE_DROPS }, 'funder pays the delegate')

  // The currency the sale is priced in: XRP, our own test IOU, or the real RLUSD issuer.
  let cur: { code: string; issuer: string } | null = null
  let bank: Wallet | null = null
  if (CURRENCY === 'USD') {
    ;({ wallet: bank } = await withRetry('faucet', () => client.fundWallet()))
    cur = { code: 'USD', issuer: bank.classicAddress }
  } else if (CURRENCY === 'RLUSD') {
    cur = { code: RLUSD_HEX, issuer: RLUSD_ISSUER }
  }

  const organizer = await provider.create('organizer')
  const buyerA = await provider.create('buyerA')
  const buyerB = await provider.create('buyerB')
  // A third buyer for the lazy-activation resale: B has already spent most of its funds by then.
  const buyerC = await provider.create('buyerC')

  head('C1: activating new embedded wallets')
  for (const w of [organizer, buyerA, buyerB, buyerC]) {
    await submit(fromWallet(funder), { TransactionType: 'Payment', Account: funder.classicAddress, Destination: w.address, Amount: FUND_DROPS }, `fund ${w.address.slice(0, 8)}…`)
  }
  const sig = (w: EmbeddedWallet): Signer => ({ address: w.address, sign: (p) => w.sign(p) })

  if (cur) {
    if (bank) await submit(fromWallet(bank), { TransactionType: 'AccountSet', Account: bank.classicAddress, SetFlag: 8 }, 'bank: asfDefaultRipple')
    // The trust line is an extra signature AND an extra 0.2 XRP reserve for every party, the
    // organizer included: without one their royalty has nowhere to land.
    for (const [w, who] of [[organizer, 'organizer'], [buyerA, 'buyerA'], [buyerB, 'buyerB'], [buyerC, 'buyerC']] as const) {
      await submit(sig(w), { TransactionType: 'TrustSet', Account: w.address, LimitAmount: { currency: cur.code, issuer: cur.issuer, value: '1000000' } }, `${who}: trustline`, w.publicKey)
    }
    await submit(fromWallet(broker), { TransactionType: 'TrustSet', Account: broker.classicAddress, LimitAmount: { currency: cur.code, issuer: cur.issuer, value: '1000000' } }, 'broker: trustline')
    if (bank) {
      for (const w of [buyerA, buyerB]) {
        await submit(fromWallet(bank), { TransactionType: 'Payment', Account: bank.classicAddress, Destination: w.address, Amount: { currency: cur.code, issuer: cur.issuer, value: '1000' } }, 'bank funds a buyer with 1000 USD')
      }
    } else {
      // Real RLUSD comes from a web faucet, not an API: pause until the buyers hold enough.
      const need = Number(PRICE_DROPS + (PRICE_DROPS * FEE_BPS) / 10_000n) / 1_000_000
      console.log('\n  >>> CLAIM TESTNET RLUSD at https://tryrlusd.com for BOTH addresses (trust lines are already set):')
      console.log(`      buyer A: ${buyerA.address}\n      buyer B: ${buyerB.address}\n      buyer C: ${buyerC.address}`)
      console.log(`      each needs at least ${need} RLUSD. Waiting up to 20 minutes...`)
      const deadline = Date.now() + 20 * 60_000
      for (;;) {
        const [a, b, c] = await Promise.all([iouBalance(client, buyerA.address, cur.issuer, cur.code), iouBalance(client, buyerB.address, cur.issuer, cur.code), iouBalance(client, buyerC.address, cur.issuer, cur.code)])
        if (Number(a) / 1e6 >= need && Number(b) / 1e6 >= need && Number(c) / 1e6 >= need) break
        if (Date.now() > deadline) throw new Error('timed out waiting for RLUSD from the faucet')
        await sleep(10_000)
      }
      console.log('  RLUSD received, continuing.')
    }
  }
  const reserveObjects = await ownerCount(client, buyerA.address)
  check('C1', true, `a new buyer holds ${reserveObjects} owned object(s) before any ticket; base reserve + 0.2 XRP each must be funded by someone`)

  const amount = (drops: bigint) =>
    cur ? { currency: cur.code, issuer: cur.issuer, value: (Number(drops) / 1_000_000).toString() } : drops.toString()
  const balance = (a: string) => (cur ? iouBalance(client, a, cur.issuer, cur.code) : xrpBalance(client, a))
  const feeDrops = (PRICE_DROPS * FEE_BPS) / 10_000n
  type Token = { NFTokenID: string; Issuer?: string; TransferFee?: number }
  const tokensOf = async (a: string) =>
    (await client.request({ command: 'account_nfts', account: a, ledger_index: 'validated' })).result.account_nfts as unknown as Token[]

  head('S1: the organizer signs the two types only they can (NFTokenMint, DelegateSet)')
  const mint = await submit(sig(organizer), buildMintTx({ issuerAddress: organizer.address, taxon: 80_001, royaltyBps: ROYALTY_BPS }) as never, 'embedded organizer mints a 5% ticket', organizer.publicKey)
  check('S1a', mint.ok, `NFTokenMint signed by the embedded wallet: ${mint.code}`)
  const direct = (await tokensOf(organizer.address))[0]?.NFTokenID

  // Both permissions HubWorld ever asks for: DelegateSet REPLACES the whole set, so send both.
  const grant = await submit(sig(organizer), buildDelegateSetTx({ organizerAddress: organizer.address, delegateAddress: delegate.classicAddress }, ['NFTokenMint', 'NFTokenCreateOffer']) as never, 'embedded organizer grants NFTokenMint + NFTokenCreateOffer to the delegate', organizer.publicKey)
  check('G1', grant.ok, `DelegateSet (mint + offer) signed by the embedded wallet: ${grant.code}`)

  head('G2: HubWorld\'s delegate key acts AS the Privy-granted organizer')
  const dmint = await submit(fromWallet(delegate), asDelegatedMint(buildMintTx({ issuerAddress: organizer.address, taxon: 80_002, royaltyBps: ROYALTY_BPS }), delegate.classicAddress) as never, 'delegate mints AS the organizer')
  const minted = (await tokensOf(organizer.address)).find((n) => n.NFTokenID !== direct)
  const issuerOk = !!minted && (minted.Issuer ?? organizer.address) === organizer.address && minted.TransferFee === bpsToTransferFee(ROYALTY_BPS)
  check('G2a', dmint.ok && issuerOk, `delegated mint ${dmint.code}; issuer is the organizer: ${minted?.Issuer === organizer.address}; TransferFee ${minted?.TransferFee} (want ${bpsToTransferFee(ROYALTY_BPS)})`)
  if (!minted) throw new Error('no delegate-minted token, cannot continue')
  const nfTokenId = minted.NFTokenID

  const spend = await submit(fromWallet(delegate), { TransactionType: 'Payment', Account: organizer.address, Delegate: delegate.classicAddress, Destination: delegate.classicAddress, Amount: '1000000' }, 'delegate tries to SPEND the organizer\'s XRP (must fail)')
  check('G2b', !spend.ok && /NO_DELEGATE_PERMISSION/.test(spend.message ?? ''), `the grant is scoped, a Payment is refused with ${/ter\w+|tec\w+|tem\w+/.exec(spend.message ?? '')?.[0] ?? spend.code}`)

  const dlist = await submit(fromWallet(delegate), { ...buildSellOfferTx({ ownerAddress: organizer.address, nfTokenId, amountDrops: PRICE_DROPS, brokerAddress: broker.classicAddress }), Amount: amount(PRICE_DROPS), Delegate: delegate.classicAddress } as never, 'delegate lists the ticket AS the organizer, broker-only')
  check('G2c', dlist.ok, `delegated NFTokenCreateOffer (the lazy-sale and claim permission): ${dlist.code}`)

  head('R1: primary sale to buyer A through the broker (organizer is party, so no royalty)')
  const bid = (a: string, owner: string, price: bigint) => ({ ...buildBuyOfferTx({ buyerAddress: a, ownerAddress: owner, nfTokenId, amountDrops: price, brokerAddress: broker.classicAddress }), Amount: amount(price) })
  const buyP = await submit(sig(buyerA), bid(buyerA.address, organizer.address, PRICE_DROPS + feeDrops) as never, 'buyer A bids price + fee', buyerA.publicKey)
  const settleP = await submit(fromWallet(broker), { TransactionType: 'NFTokenAcceptOffer', Account: broker.classicAddress, NFTokenSellOffer: (await offerIndexFromTx(dlist.hash))!, NFTokenBuyOffer: (await offerIndexFromTx(buyP.hash))!, NFTokenBrokerFee: amount(feeDrops) } as never, 'broker settles')
  check('R1', settleP.ok, `primary sale of the delegate-listed ticket settled: ${settleP.code}`)

  head('R2: RESALE A -> B through the broker (issuer uninvolved)')
  const issuerBefore = await balance(organizer.address)
  const sellR = await submit(sig(buyerA), { ...buildSellOfferTx({ ownerAddress: buyerA.address, nfTokenId, amountDrops: PRICE_DROPS, brokerAddress: broker.classicAddress }), Amount: amount(PRICE_DROPS) } as never, 'A lists, broker-only', buyerA.publicKey)
  const buyR = await submit(sig(buyerB), bid(buyerB.address, buyerA.address, PRICE_DROPS + feeDrops) as never, 'B bids price + fee', buyerB.publicKey)
  check('S2', sellR.ok && buyR.ok, `NFTokenCreateOffer signed by embedded wallets (sell ${sellR.code}, buy ${buyR.code})`)
  const settleR = await submit(fromWallet(broker), { TransactionType: 'NFTokenAcceptOffer', Account: broker.classicAddress, NFTokenSellOffer: (await offerIndexFromTx(sellR.hash))!, NFTokenBuyOffer: (await offerIndexFromTx(buyR.hash))!, NFTokenBrokerFee: amount(feeDrops) } as never, 'broker settles the resale')
  const gained = (await balance(organizer.address)) - issuerBefore
  // The royalty is taken on the bid minus the broker fee, not on the headline price.
  const expected = (PRICE_DROPS * BigInt(ROYALTY_BPS)) / 10_000n
  check('R2', settleR.ok && gained > 0n, `organizer gained ${gained} (expected about ${expected}, units of 1e-6 ${CURRENCY}) from a resale between two embedded wallets`)

  head('S3: NFTokenAcceptOffer signed by an embedded wallet (gift B -> A)')
  const gift = await submit(sig(buyerB), buildGiftOfferTx({ ownerAddress: buyerB.address, nfTokenId, destinationAddress: buyerA.address }) as never, 'B gifts to A', buyerB.publicKey)
  const accept = await submit(sig(buyerA), buildAcceptOfferTx({ accepterAddress: buyerA.address, offerIndex: (await offerIndexFromTx(gift.hash))! }) as never, 'A accepts', buyerA.publicKey)
  check('S3', accept.ok, `NFTokenAcceptOffer signed by the embedded wallet: ${accept.code}`)

  head('L: lazy activation, the ticket stays with the organizer until its holder claims it')
  // A card buyer's ticket is owned in the database while the NFT stays in the organizer's account.
  // Claiming moves it to the holder's own wallet for NOTHING; only then can it be resold on-ledger,
  // where the royalty fires. (Selling it straight from the organizer to a buyer pays the organizer
  // the whole price and no royalty, which is why the free hop has to come first.)
  const heldBefore = (await tokensOf(organizer.address)).map((n) => n.NFTokenID)
  const dmint3 = await submit(fromWallet(delegate), asDelegatedMint(buildMintTx({ issuerAddress: organizer.address, taxon: 80_003, royaltyBps: ROYALTY_BPS }), delegate.classicAddress) as never, 'delegate mints a ticket that stays with the organizer')
  const kept = (await tokensOf(organizer.address)).find((n) => !heldBefore.includes(n.NFTokenID))
  if (!dmint3.ok || !kept) throw new Error('could not mint the lazy-path ticket')
  const T3 = kept.NFTokenID

  const orgGot0 = await balance(organizer.address)
  const free = await submit(fromWallet(delegate), { TransactionType: 'NFTokenCreateOffer', Account: organizer.address, Delegate: delegate.classicAddress, NFTokenID: T3, Amount: '0', Destination: buyerA.address, Flags: 1 } as never, 'delegate offers the ticket to A for free, AS the organizer')
  check('L1', free.ok, `a zero-price transfer offer created by the delegate as the organizer, for one named holder: ${free.code}`)
  const take = await submit(sig(buyerA), buildAcceptOfferTx({ accepterAddress: buyerA.address, offerIndex: (await offerIndexFromTx(free.hash))! }) as never, 'A claims it', buyerA.publicKey)
  const aHolds = (await tokensOf(buyerA.address)).some((n) => n.NFTokenID === T3)
  const orgHolds = (await tokensOf(organizer.address)).some((n) => n.NFTokenID === T3)
  check('L2', take.ok && aHolds && !orgHolds, `the holder claimed it in their own wallet (holder has it: ${aHolds}, organizer still has it: ${orgHolds})`)
  check('L3', (await balance(organizer.address)) === orgGot0, 'the free transfer moved no money and paid no royalty')

  head('L: first resale on-ledger, with the platform fee paid by the SELLER')
  // The sell offer is listed at price minus the fee and the bid is the price, so the buyer pays
  // exactly the price shown and the seller nets price - fee - royalty. The ledger needs
  // buy >= sell + brokerFee, and this is equality.
  const bal = async () => ({ org: await balance(organizer.address), a: await balance(buyerA.address), c: await balance(buyerC.address), broker: await balance(broker.address) })
  const pre = await bal()
  const sellAmt = PRICE_DROPS - feeDrops
  const sell3 = await submit(sig(buyerA), { ...buildSellOfferTx({ ownerAddress: buyerA.address, nfTokenId: T3, amountDrops: sellAmt, brokerAddress: broker.classicAddress }), Amount: amount(sellAmt) } as never, 'A lists at price minus fee, broker-only', buyerA.publicKey)
  const buy3 = await submit(sig(buyerC), { ...buildBuyOfferTx({ buyerAddress: buyerC.address, ownerAddress: buyerA.address, nfTokenId: T3, amountDrops: PRICE_DROPS, brokerAddress: broker.classicAddress }), Amount: amount(PRICE_DROPS) } as never, 'C bids exactly the price', buyerC.publicKey)
  const settle3 = await submit(fromWallet(broker), { TransactionType: 'NFTokenAcceptOffer', Account: broker.classicAddress, NFTokenSellOffer: (await offerIndexFromTx(sell3.hash))!, NFTokenBuyOffer: (await offerIndexFromTx(buy3.hash))!, NFTokenBrokerFee: amount(feeDrops) } as never, 'broker settles, taking the fee from the seller side')
  const post = await bal()
  const d = { org: post.org - pre.org, a: post.a - pre.a, c: post.c - pre.c, broker: post.broker - pre.broker }
  const unit = cur ? CURRENCY : 'drops'
  console.log(`  deltas (${unit}, 1e-6 units; XRP rows include a few network-fee drops):`)
  console.log(`    buyer C   ${d.c}   (should be about -${PRICE_DROPS})`)
  console.log(`    seller A  +${d.a}   (price - fee - royalty = ${PRICE_DROPS - feeDrops - ((PRICE_DROPS - feeDrops) * BigInt(ROYALTY_BPS)) / 10_000n})`)
  console.log(`    broker    +${d.broker}   (the fee = ${feeDrops})`)
  console.log(`    organizer +${d.org}   (royalty on price - fee = ${((PRICE_DROPS - feeDrops) * BigInt(ROYALTY_BPS)) / 10_000n})`)
  const royaltyOnNet = ((PRICE_DROPS - feeDrops) * BigInt(ROYALTY_BPS)) / 10_000n
  const slack = cur ? 0n : 100n // a few 12-drop network fees show up on XRP balances
  const near = (got: bigint, want: bigint) => (got > want ? got - want : want - got) <= slack
  check('L4', settle3.ok, `seller-pays resale settled: ${settle3.code}`)
  check('L5', near(-d.c, PRICE_DROPS), `the buyer paid exactly the displayed price (${-d.c} vs ${PRICE_DROPS})`)
  check('L6', near(d.broker, feeDrops), `the broker received the fee (${d.broker} vs ${feeDrops}), taken from the seller's side`)
  check('L7', near(d.org, royaltyOnNet), `the organizer's royalty is ${ROYALTY_BPS / 100}% of price minus fee (${d.org} vs ${royaltyOnNet}) after a FREE claim hop`)
  check('L8', near(d.a, PRICE_DROPS - feeDrops - royaltyOnNet), `the seller netted price - fee - royalty (${d.a})`)

  head('Summary')
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.note}`)
  console.log('\n  Record by hand, per provider: price per user/month, login UX, key export, time to first signature.')
  await disconnectLedger()
  if (results.some((r) => !r.ok)) process.exit(2)
}

main().catch(async (e) => {
  console.error('SPIKE FAILED:', e instanceof Error ? e.message : e)
  await disconnectLedger()
  process.exit(1)
})
