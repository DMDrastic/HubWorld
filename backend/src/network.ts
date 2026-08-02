import { XrplNetwork } from '@prisma/client'
import { env } from './env.js'

/**
 * Which ledger this process writes rows for.
 *
 * `env.XRPL_NETWORK` is lowercase because it is also the key into the endpoint
 * table and Xaman's `force_network` value; the Prisma enum is uppercase by the
 * schema's convention. This is the one place the two are reconciled, so a
 * mismatch is a compile error here rather than a mislabelled row everywhere.
 *
 * Every create on a ledger-bound model must pass this. The column has no
 * database default on purpose — see the `XrplNetwork` note in schema.prisma.
 */
const BY_ENV = {
  testnet: XrplNetwork.TESTNET,
  devnet: XrplNetwork.DEVNET,
  mainnet: XrplNetwork.MAINNET,
} as const satisfies Record<typeof env.XRPL_NETWORK, XrplNetwork>

export const NETWORK: XrplNetwork = BY_ENV[env.XRPL_NETWORK]

/**
 * Scope a query to this process's ledger.
 *
 * Spelled as a helper so the intent is greppable: a read that touches on-ledger
 * identifiers and does NOT carry this is a bug, because rows from another
 * network are indistinguishable once loaded.
 */
export const onThisNetwork = { network: NETWORK } as const
