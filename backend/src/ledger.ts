/**
 * XRP Ledger access.
 *
 * Read-only plus transaction *construction*. Nothing here signs anything —
 * HubWorld holds no seeds. Every transaction is handed to Xaman for the owner
 * to sign on their own device.
 */
import {
  Client,
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
