/**
 * The person's own wallet: what it is, what it holds, and (on testnet only) a way to fill it.
 *
 *   GET  /api/wallet/status → address, network, whether the account exists, balance, what brings it into being
 *   POST /api/wallet/fund   → free test XRP to THIS wallet. Testnet only; on any other network the route does not exist.
 *
 * The address is the session's own and nothing in a request can change it: a faucet that funded whatever address it was
 * given would be a way to drain it with other people's names.
 */
import { Router } from 'express'
import { prisma } from '../prisma.js'
import { env } from '../env.js'
import { requireAuth } from '../session.js'
import { accountBalanceDrops, accountFunding } from '../ledger.js'
import { isAccountNotFound } from '../xrpl-errors.js'
import { BASE_RESERVE_DROPS, faucetOffered } from '../wallet-funds.js'
import { requestFaucet } from '../faucet.js'
import { getUserXrplAddress } from '../wallet.js'

export const walletRouter = Router()

walletRouter.get('/wallet/status', requireAuth, async (req, res) => {
  const [wallet, address] = await Promise.all([
    prisma.wallet.findUnique({ where: { userId: req.userId! }, select: { signerKind: true } }),
    getUserXrplAddress(req.userId!),
  ])
  if (!address) {
    res.status(404).json({ error: 'You have no wallet yet.' })
    return
  }

  // Three answers, not two: the account exists, it does not (yet), or the ledger could not be read. "Could not read" must
  // never be shown as "empty".
  let exists: boolean | null = null
  let balanceDrops: bigint | undefined
  let spendableDrops: bigint | undefined
  try {
    const [balance, funding] = await Promise.all([accountBalanceDrops(address), accountFunding(address)])
    exists = true
    balanceDrops = balance
    spendableDrops = funding.spendableDrops
  } catch (err) {
    if (isAccountNotFound(err)) exists = false
  }

  res.json({
    address,
    network: env.XRPL_NETWORK,
    exists,
    ...(balanceDrops !== undefined ? { balanceDrops: balanceDrops.toString() } : {}),
    ...(spendableDrops !== undefined ? { spendableDrops: spendableDrops.toString() } : {}),
    // The least a wallet must hold for its account to exist at all.
    activationDrops: BASE_RESERVE_DROPS.toString(),
    canFund: faucetOffered(),
    signer: wallet?.signerKind ?? 'XAMAN',
  })
})

walletRouter.post('/wallet/fund', requireAuth, async (req, res) => {
  // Not "forbidden": on any network but testnet this simply is not a thing.
  if (!faucetOffered()) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  const address = await getUserXrplAddress(req.userId!)
  if (!address) {
    res.status(404).json({ error: 'You have no wallet yet.' })
    return
  }
  const result = await requestFaucet({ userId: req.userId!, address, network: env.XRPL_NETWORK })
  if (result.ok) {
    res.json({ ok: true, amountXrp: result.amountXrp })
    return
  }
  const status = result.code === 'FAUCET_LIMIT' ? 429 : result.code === 'FAUCET_UNAVAILABLE' ? 404 : 502
  res.status(status).json({ code: result.code, error: result.error })
})
