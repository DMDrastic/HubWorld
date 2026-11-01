/**
 * Can this wallet pay? And what to tell the person when it cannot.
 *
 * A Privy wallet starts empty, and an XRPL account does not even exist until it holds the base reserve. Without this
 * check the first purchase fails deep in the ledger, after the person has approved it, with a code no one can read. So the
 * buy routes ask FIRST, before holding a ticket or building anything to sign, and answer in words with the address to fund
 * and how much.
 *
 * Only the wallet's own balance is read; nothing here moves money.
 */
import { prisma } from './prisma.js'
import { accountFunding } from './ledger.js'
import { isAccountNotFound } from './xrpl-errors.js'
import { env } from './env.js'

/** The network's base reserve: the least an account must hold to exist at all. The ledger is the authority; this is its current value. */
export const BASE_RESERVE_DROPS = 1_000_000n

/** Kept spendable beyond the price and the offer's own reserve, so the network fee cannot be what runs it dry. */
export const FEE_HEADROOM_DROPS = 100_000n

export type FundsGap = { neededDrops: bigint; haveDrops: bigint }

/**
 * What a wallet is short of to place an offer for `amountDrops`, or null if it can.
 *
 * The offer is an owned object, so it raises the wallet's reserve by one increment the moment it exists: the wallet needs
 * the amount PLUS that, plus a little for the fee. An account that does not exist yet also needs the base reserve to come
 * into being.
 */
export function fundsGap(input: {
  accountExists: boolean
  spendableDrops: bigint
  reserveIncDrops: bigint
  amountDrops: bigint
}): FundsGap | null {
  const needed =
    input.amountDrops + input.reserveIncDrops + FEE_HEADROOM_DROPS + (input.accountExists ? 0n : BASE_RESERVE_DROPS)
  const have = input.accountExists && input.spendableDrops > 0n ? input.spendableDrops : 0n
  return have >= needed ? null : { neededDrops: needed, haveDrops: have }
}

/** The reserve increment when the ledger cannot say (a wallet that does not exist has nothing to read it from). */
const DEFAULT_RESERVE_INC_DROPS = 200_000n

type Funding =
  | { accountExists: true; spendableDrops: bigint; reserveIncDrops: bigint }
  | { accountExists: false; spendableDrops: 0n; reserveIncDrops: bigint }

/** The wallet's funding; `null` when the ledger could not be read, which is not the same as "empty". */
export async function readWalletFunding(address: string): Promise<Funding | null> {
  try {
    const f = await accountFunding(address)
    return { accountExists: true, spendableDrops: f.spendableDrops, reserveIncDrops: f.reserveIncDrops }
  } catch (err) {
    if (isAccountNotFound(err)) return { accountExists: false, spendableDrops: 0n, reserveIncDrops: DEFAULT_RESERVE_INC_DROPS }
    return null
  }
}

export type WalletNeedsFunds = {
  code: 'WALLET_NEEDS_FUNDS'
  error: string
  address: string
  network: string
  neededDrops: string
  haveDrops: string
  /** Free test XRP is offered here (testnet only). On mainnet the person has to send real XRP to the address. */
  canFund: boolean
}

export const faucetOffered = (): boolean => env.XRPL_NETWORK === 'testnet'

/** Shape the answer a person is given when their wallet is short. */
export function needsFundsBody(address: string, gap: FundsGap): WalletNeedsFunds {
  return {
    code: 'WALLET_NEEDS_FUNDS',
    error: 'Your wallet needs more XRP before it can pay for this.',
    address,
    network: env.XRPL_NETWORK,
    neededDrops: gap.neededDrops.toString(),
    haveDrops: gap.haveDrops.toString(),
    canFund: faucetOffered(),
  }
}

/**
 * For a buyer whose wallet is a Privy one: how much short it is of `amountDrops`, as the body to answer with, or null to
 * carry on. A wallet that is not Privy is left alone (Xaman shows its own balance), and so is a ledger that could not be
 * read: a node that blinks must not stop a legitimate purchase.
 */
export async function privyBuyerShortfall(userId: string, amountDrops: bigint): Promise<WalletNeedsFunds | null> {
  const wallet = await prisma.wallet.findUnique({ where: { userId }, select: { signerKind: true, xrplAddress: true } })
  if (wallet?.signerKind !== 'PRIVY') return null
  const funding = await readWalletFunding(wallet.xrplAddress)
  if (!funding) return null
  const gap = fundsGap({ ...funding, amountDrops })
  return gap ? needsFundsBody(wallet.xrplAddress, gap) : null
}
