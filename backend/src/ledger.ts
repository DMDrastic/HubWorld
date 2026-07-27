/**
 * XRP Ledger access.
 *
 * Read-only plus transaction *construction*. Hubworld holds no USER keys —
 * every transaction that moves someone's ticket or money is handed to Xaman for
 * that person to sign on their own device.
 *
 * There is exactly ONE exception: `brokerSale` signs with Hubworld's own
 * platform account (PLATFORM_SEED). Brokered mode requires the broker's
 * signature to match a seller's offer to a buyer's, and that is the only thing
 * this key can do — it never holds a user's NFT, and sale funds move
 * buyer -> seller/issuer atomically without resting here.
 */
import {
  Client,
  Wallet,
  getNFTokenID,
  convertStringToHex,
  type NFTokenMint,
  type NFTokenCreateOffer,
  type NFTokenAcceptOffer,
  type NFTokenCancelOffer,
} from 'xrpl'
import { env } from './env.js'

const ENDPOINTS = {
  testnet: 'wss://s.altnet.rippletest.net:51233',
  devnet: 'wss://s.devnet.rippletest.net:51233',
  mainnet: 'wss://xrplcluster.com',
} as const

export const XRPL_ENDPOINT = ENDPOINTS[env.XRPL_NETWORK]

/** Xaman's network identifier for `options.force_network`. */
export const XAMAN_NETWORK = env.XRPL_NETWORK.toUpperCase() as
  | 'TESTNET'
  | 'DEVNET'
  | 'MAINNET'

let client: Client | null = null

/** Lazily connected shared client. xrpl.js reconnects internally. */
export async function ledger(): Promise<Client> {
  if (client?.isConnected()) return client
  client = new Client(XRPL_ENDPOINT)
  await client.connect()
  return client
}

export async function disconnectLedger(): Promise<void> {
  if (client?.isConnected()) await client.disconnect()
  client = null
}

/**
 * XRPL `TransferFee` is expressed in units of 1/100_000 (50000 = 50%, the
 * maximum). Our royalties are basis points (100 bps = 1%), so bps * 10.
 */
export function bpsToTransferFee(bps: number): number {
  const fee = bps * 10
  if (fee < 0 || fee > 50000) {
    throw new Error(`royalty ${bps}bps is outside XRPL's 0–50% TransferFee range`)
  }
  return fee
}

// tfTransferable — without it the NFT can only ever move to/from the issuer,
// which would make gifting and resale impossible.
const TF_TRANSFERABLE = 8

/**
 * Build (do not sign) an NFTokenMint. The organizer is the issuer, so the
 * royalty rides on the token itself as TransferFee — see the brokered-mode
 * note in CLAUDE.md.
 */
export function buildMintTx(params: {
  issuerAddress: string
  taxon: number
  royaltyBps: number
  uri?: string
}): NFTokenMint {
  const tx: NFTokenMint = {
    TransactionType: 'NFTokenMint',
    Account: params.issuerAddress,
    NFTokenTaxon: params.taxon,
    Flags: TF_TRANSFERABLE,
  }

  const transferFee = bpsToTransferFee(params.royaltyBps)
  if (transferFee > 0) tx.TransferFee = transferFee

  // URI must be hex on-ledger; 256 bytes max.
  if (params.uri) {
    const hex = convertStringToHex(params.uri)
    if (hex.length > 512) throw new Error('ticket URI exceeds the 256-byte NFT limit')
    tx.URI = hex
  }

  return tx
}

/**
 * Pull a validated transaction and extract the NFTokenID it minted.
 * Returns null while the transaction is still unvalidated.
 */
export async function nftokenIdFromTx(txHash: string): Promise<string | null> {
  const c = await ledger()

  const res = await c.request({
    command: 'tx',
    transaction: txHash,
  })

  if (!res.result.validated) return null

  const meta = res.result.meta
  if (!meta || typeof meta === 'string') return null

  return getNFTokenID(meta) ?? null
}

export async function accountNfts(address: string) {
  const c = await ledger()
  const res = await c.request({ command: 'account_nfts', account: address })
  return res.result.account_nfts
}

// ------------------------------------------------------- brokered sales ----

/**
 * Hubworld's broker wallet, derived from PLATFORM_SEED.
 *
 * This is the only signing key Hubworld holds. It exists to submit the brokered
 * NFTokenAcceptOffer and nothing else — it never holds a user's NFT, and sale
 * funds move buyer -> seller/issuer atomically without resting here.
 */
let platform: Wallet | null = null

export function platformWallet(): Wallet {
  if (!env.PLATFORM_SEED) {
    throw new Error('PLATFORM_SEED is not set — cannot broker a sale')
  }
  platform ??= Wallet.fromSeed(env.PLATFORM_SEED)
  return platform
}

export function platformAddress(): string {
  return platformWallet().classicAddress
}

/**
 * Platform cut in drops, floored.
 *
 * BigInt throughout: drops are integers and a Number would lose precision above
 * 2^53. Flooring means Hubworld rounds against itself, never overcharging the
 * buyer by a drop.
 */
export function platformFeeDrops(priceDrops: bigint, platformBps: number): bigint {
  if (platformBps < 0 || platformBps > 10000) {
    throw new Error(`platformBps ${platformBps} is outside 0–10000`)
  }
  return (priceDrops * BigInt(platformBps)) / 10000n
}

/**
 * Build the seller's side: a sell offer for real money.
 *
 * `Destination` is set to the broker deliberately. Without it, any buyer could
 * accept the sell offer directly and Hubworld's fee would be trivially
 * bypassable — the offer would be a public, free-to-take order.
 */
export function buildSellOfferTx(params: {
  ownerAddress: string
  nfTokenId: string
  amountDrops: bigint
  brokerAddress: string
}): NFTokenCreateOffer {
  if (params.amountDrops <= 0n) {
    throw new Error('a sale price must be greater than zero')
  }
  return {
    TransactionType: 'NFTokenCreateOffer',
    Account: params.ownerAddress,
    NFTokenID: params.nfTokenId,
    Amount: params.amountDrops.toString(),
    // Only the broker may match this offer.
    Destination: params.brokerAddress,
    Flags: TF_SELL_NFTOKEN,
  }
}

/**
 * Build the buyer's side: a buy offer naming the current owner.
 *
 * No tfSellNFToken flag — its absence is what makes this a bid. `Owner` is
 * required on a buy offer so the ledger knows whose token is being bid on.
 *
 * `Destination` is the broker for the same reason as the sell side, and the
 * threat here is the mirror image: the bid is for price + fee, so a seller who
 * could accept it directly would pocket Hubworld's cut. Both offers must be
 * broker-only for brokerage to actually be enforced rather than merely intended.
 */
export function buildBuyOfferTx(params: {
  buyerAddress: string
  ownerAddress: string
  nfTokenId: string
  amountDrops: bigint
  brokerAddress: string
}): NFTokenCreateOffer {
  if (params.buyerAddress === params.ownerAddress) {
    throw new Error('cannot buy your own ticket')
  }
  if (params.amountDrops <= 0n) {
    throw new Error('a bid must be greater than zero')
  }
  return {
    TransactionType: 'NFTokenCreateOffer',
    Account: params.buyerAddress,
    NFTokenID: params.nfTokenId,
    Amount: params.amountDrops.toString(),
    Owner: params.ownerAddress,
    Destination: params.brokerAddress,
  }
}

/**
 * Settle a sale: match both offers and take the platform cut, signed by
 * Hubworld's broker account.
 *
 * The ledger enforces `buyAmount >= sellAmount + brokerFee`, so the buy offer is
 * created for price + fee. The organizer's royalty is NOT handled here — the
 * native TransferFee on the NFToken deducts it automatically and pays the issuer,
 * which is exactly why minting sets it.
 */
export async function brokerSale(params: {
  sellOfferIndex: string
  buyOfferIndex: string
  brokerFeeDrops: bigint
}): Promise<{ hash: string; succeeded: boolean; result: string }> {
  const wallet = platformWallet()
  const c = await ledger()

  const tx: NFTokenAcceptOffer = {
    TransactionType: 'NFTokenAcceptOffer',
    Account: wallet.classicAddress,
    NFTokenSellOffer: params.sellOfferIndex,
    NFTokenBuyOffer: params.buyOfferIndex,
  }
  // Omit a zero fee rather than sending "0" — the field is optional and a zero
  // brokered fee is a valid configuration.
  if (params.brokerFeeDrops > 0n) {
    tx.NFTokenBrokerFee = params.brokerFeeDrops.toString()
  }

  const prepared = await c.autofill(tx)
  const signed = wallet.sign(prepared)
  const submitted = await c.submitAndWait(signed.tx_blob)

  const meta = submitted.result.meta
  const result =
    meta && typeof meta !== 'string' ? meta.TransactionResult : 'unknown'

  return {
    hash: submitted.result.hash,
    succeeded: result === 'tesSUCCESS',
    result,
  }
}

/**
 * How much XRP an account can actually spend, in drops.
 *
 * Not the same as its balance: XRPL locks a base reserve plus an owner reserve
 * for every object the account holds (offers, NFT pages, trust lines). Treating
 * the raw balance as spendable would accept bids the account cannot honour, which
 * is the failure this check exists to prevent.
 *
 * Reserve amounts are network parameters rather than constants, so they are read
 * from the ledger rather than hardcoded.
 */
export async function spendableDrops(address: string): Promise<bigint> {
  const c = await ledger()

  const [info, state] = await Promise.all([
    c.request({ command: 'account_info', account: address, ledger_index: 'validated' }),
    c.request({ command: 'server_info' }),
  ])

  const v = state.result.info.validated_ledger

  return spendableFrom({
    balanceDrops: BigInt(info.result.account_data.Balance),
    ownerCount: info.result.account_data.OwnerCount ?? 0,
    // server_info reports reserves in XRP. Defaults match the current network
    // values but are only a fallback — the ledger is the authority.
    reserveBaseXrp: v?.reserve_base_xrp ?? 1,
    reserveIncXrp: v?.reserve_inc_xrp ?? 0.2,
  })
}

/**
 * The reserve arithmetic, split out so it is testable without a network.
 *
 * Reserve is a base plus an increment per owned object, and an account holding an
 * NFT and open offers can therefore have a healthy balance and very little it can
 * actually spend. Clamped at zero: an account below its reserve has nothing
 * spendable, not a negative amount.
 */
export function spendableFrom(params: {
  balanceDrops: bigint
  ownerCount: number
  reserveBaseXrp: number
  reserveIncXrp: number
}): bigint {
  const toDrops = (xrp: number) => BigInt(Math.round(xrp * 1_000_000))
  const reserve =
    toDrops(params.reserveBaseXrp) + BigInt(params.ownerCount) * toDrops(params.reserveIncXrp)
  const spendable = params.balanceDrops - reserve
  return spendable > 0n ? spendable : 0n
}

// ------------------------------------------------------------------ gifting --

// tfSellNFToken — marks the offer as "I am selling", as opposed to a bid.
const TF_SELL_NFTOKEN = 1

/**
 * Build a gift offer: a sell offer for zero drops, restricted to one
 * destination.
 *
 * XRPL has no single "transfer" transaction. A gift is therefore two
 * signatures: the owner creates this offer, and the recipient must then accept
 * it. Setting Destination means nobody else can take it, so a gift in flight
 * cannot be intercepted.
 */
export function buildGiftOfferTx(params: {
  ownerAddress: string
  nfTokenId: string
  destinationAddress: string
}): NFTokenCreateOffer {
  if (params.ownerAddress === params.destinationAddress) {
    throw new Error('cannot gift a ticket to yourself')
  }

  return {
    TransactionType: 'NFTokenCreateOffer',
    Account: params.ownerAddress,
    NFTokenID: params.nfTokenId,
    Amount: '0', // free — this is a gift, not a sale
    Destination: params.destinationAddress,
    Flags: TF_SELL_NFTOKEN,
  }
}

/** The recipient's half: accept a sell offer someone directed at them. */
export function buildAcceptOfferTx(params: {
  accepterAddress: string
  offerIndex: string
}): NFTokenAcceptOffer {
  return {
    TransactionType: 'NFTokenAcceptOffer',
    Account: params.accepterAddress,
    NFTokenSellOffer: params.offerIndex,
  }
}

/** Withdraw an unaccepted gift offer. Only the offer's creator may do this. */
export function buildCancelOfferTx(params: {
  ownerAddress: string
  offerIndex: string
}): NFTokenCancelOffer {
  return {
    TransactionType: 'NFTokenCancelOffer',
    Account: params.ownerAddress,
    NFTokenOffers: [params.offerIndex],
  }
}

/**
 * Pull the NFTokenOffer object created by a validated transaction.
 * Returns null while the transaction is still unvalidated.
 *
 * The offer index is not in the transaction we submitted — the ledger assigns
 * it — so it has to be read back out of the metadata.
 */
export async function offerIndexFromTx(txHash: string): Promise<string | null> {
  const c = await ledger()
  const res = await c.request({ command: 'tx', transaction: txHash })

  if (!res.result.validated) return null

  const meta = res.result.meta
  if (!meta || typeof meta === 'string') return null

  for (const node of meta.AffectedNodes) {
    if ('CreatedNode' in node && node.CreatedNode.LedgerEntryType === 'NFTokenOffer') {
      return node.CreatedNode.LedgerIndex
    }
  }
  return null
}

/** Whether a validated transaction succeeded. Null while unvalidated. */
export async function txSucceeded(txHash: string): Promise<boolean | null> {
  const c = await ledger()
  const res = await c.request({ command: 'tx', transaction: txHash })

  if (!res.result.validated) return null

  const meta = res.result.meta
  if (!meta || typeof meta === 'string') return null

  return meta.TransactionResult === 'tesSUCCESS'
}

/**
 * Who holds an NFToken right now, according to the ledger.
 *
 * This is the authority — `Ticket.ownerAddress` is only a cache, and a holder
 * can move a ticket in Xaman without ever touching Hubworld. Anything that
 * depends on ownership must call this rather than trusting Postgres.
 *
 * Returns null if the address does not hold it (which includes the case where
 * they never did).
 */
export async function holdsNft(address: string, nfTokenId: string): Promise<boolean> {
  const c = await ledger()
  try {
    // account_nfts paginates; a large collection needs every page before
    // concluding "not held".
    let marker: unknown = undefined
    do {
      const res = await c.request({
        command: 'account_nfts',
        account: address,
        limit: 400,
        ...(marker === undefined ? {} : { marker }),
      })
      if (res.result.account_nfts.some((n) => n.NFTokenID === nfTokenId)) return true
      marker = (res.result as { marker?: unknown }).marker
    } while (marker !== undefined)
    return false
  } catch (err) {
    // actNotFound — an unfunded account holds nothing.
    if (err instanceof Error && err.message.includes('actNotFound')) return false
    throw err
  }
}
