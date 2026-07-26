/**
 * XRP Ledger access.
 *
 * Read-only plus transaction *construction*. Nothing here signs anything —
 * HubWorld holds no seeds. Every transaction is handed to Xaman for the owner
 * to sign on their own device.
 */
import { Client, getNFTokenID, convertStringToHex, type NFTokenMint } from 'xrpl'
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
