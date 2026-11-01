/**
 * Free test XRP for a wallet, on the test network only.
 *
 * A new wallet starts empty and nothing can be bought with an empty wallet, so on testnet the person can ask the public
 * test faucet to fill it. This is deliberately impossible anywhere else: on mainnet there is no faucet and nothing here
 * would work or be offered, and every refusal for that is decided on the SERVER from its own configured network, never
 * from anything the browser says.
 *
 * Limited per person per day. The slot is taken BEFORE the faucet is called, under a lock, so a burst of simultaneous
 * requests cannot all slip under the limit; if the faucet then does not deliver, the slot is given back.
 */
import { prisma } from './prisma.js'

export const FAUCET_PER_DAY = 3
const FAUCET_URL = 'https://faucet.altnet.rippletest.net/accounts'
const FAUCET_TIMEOUT_MS = 20_000

export type FaucetDeps = {
  network: 'testnet' | 'devnet' | 'mainnet'
  fetchImpl?: typeof fetch
  now?: Date
  timeoutMs?: number
}

export type FaucetResult =
  | { ok: true; amountXrp: number }
  | { ok: false; code: 'FAUCET_UNAVAILABLE' | 'FAUCET_LIMIT' | 'FAUCET_FAILED'; error: string }

export async function requestFaucet(input: { userId: string; address: string } & FaucetDeps): Promise<FaucetResult> {
  if (input.network !== 'testnet') {
    return { ok: false, code: 'FAUCET_UNAVAILABLE', error: 'Free test XRP is only available on the test network.' }
  }
  const now = input.now ?? new Date()
  const since = new Date(now.getTime() - 24 * 3_600_000)

  // Take a slot, atomically per person: the lock makes "count, then insert" one step.
  const slot = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'faucet:' + input.userId}))`
    const used = await tx.faucetGrant.count({ where: { userId: input.userId, createdAt: { gt: since } } })
    if (used >= FAUCET_PER_DAY) return null
    return tx.faucetGrant.create({ data: { userId: input.userId, address: input.address, createdAt: now } })
  })
  if (!slot) {
    return { ok: false, code: 'FAUCET_LIMIT', error: `You can request test XRP ${FAUCET_PER_DAY} times a day. Try again tomorrow.` }
  }

  const giveBack = () => prisma.faucetGrant.deleteMany({ where: { id: slot.id } }).then(() => undefined)
  try {
    const res = await (input.fetchImpl ?? fetch)(FAUCET_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(input.timeoutMs ?? FAUCET_TIMEOUT_MS),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ destination: input.address }),
    })
    if (!res.ok) {
      await giveBack()
      return { ok: false, code: 'FAUCET_FAILED', error: 'The test faucet could not fund your wallet just now. Try again in a moment.' }
    }
    const body = (await res.json().catch(() => ({}))) as { amount?: unknown }
    return { ok: true, amountXrp: typeof body.amount === 'number' ? body.amount : 0 }
  } catch {
    await giveBack()
    return { ok: false, code: 'FAUCET_FAILED', error: 'The test faucet could not fund your wallet just now. Try again in a moment.' }
  }
}
