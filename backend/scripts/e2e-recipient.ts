/**
 * A stand-in gift RECIPIENT for the Privy end-to-end test on the local stack (real test network, Xaman pretended).
 *
 *   local-stack.sh recipient create   a throwaway test-network account and a HubWorld user for it; prints the handle
 *   local-stack.sh recipient accept   accept the newest gift waiting for it, signed for real on the test network
 *
 * Privy has one test account per app, and a gift needs two people, so the second is this script. It accepts the way a
 * Xaman user does (`POST /gifts/:id/accept`, then the payload is "signed"), except that the signature is a real
 * NFTokenAcceptOffer signed here with the throwaway key, and the pretend Xaman is told its REAL hash
 * (`/dev/payloads/:uuid/simulate`). The gift poll then confirms that transaction on the real ledger, exactly as it
 * would for a person.
 *
 * The throwaway seed and session live in ~/.hubworld-local/e2e-recipient.env (mode 600) and are never printed.
 * Refuses a database that is not local and any network but testnet.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'xrpl'
import { prisma } from '../src/prisma.js'
import { env } from '../src/env.js'
import { assertSafeDatabase } from '../src/db-guard.js'
import { createSession } from '../src/session.js'
import { buildAcceptOfferTx, disconnectLedger, ledger } from '../src/ledger.js'

const FILE = join(homedir(), '.hubworld-local', 'e2e-recipient.env')
const API = process.env.E2E_API ?? `http://localhost:${env.PORT}/api`

type Saved = { seed: string; token: string; username: string }

function load(): Saved {
  if (!existsSync(FILE)) throw new Error('no recipient yet: run `local-stack.sh recipient create` first')
  const get = (k: string) => new RegExp(`^${k}=(\\S+)$`, 'm').exec(readFileSync(FILE, 'utf8'))?.[1]
  const seed = get('SEED'), token = get('TOKEN'), username = get('USERNAME')
  if (!seed || !token || !username) throw new Error(`${FILE} is incomplete: run \`local-stack.sh recipient create\` again`)
  return { seed, token, username }
}

async function api<T>(path: string, token: string | null, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const body = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} answered ${res.status}: ${body.error ?? JSON.stringify(body)}`)
  return body
}

async function create() {
  const c = await ledger()
  // Reuse an existing recipient: its account is funded already, and the faucet is not ours to spend.
  if (existsSync(FILE)) {
    const saved = load()
    const user = await prisma.user.findUnique({ where: { username: saved.username } })
    if (user) {
      const { token } = await createSession(user.id)
      writeFileSync(FILE, `SEED=${saved.seed}\nTOKEN=${token}\nUSERNAME=${saved.username}\n`, { mode: 0o600 })
      console.log(JSON.stringify({ username: saved.username, address: user.xrplAddress, reused: true }))
      return
    }
  }
  const { wallet } = await c.fundWallet(Wallet.generate())
  const username = `e2e_rcpt_${Math.random().toString(36).slice(2, 7)}`
  const user = await prisma.user.create({ data: { username, xrplAddress: wallet.classicAddress } })
  const { token } = await createSession(user.id)
  writeFileSync(FILE, `SEED=${wallet.seed}\nTOKEN=${token}\nUSERNAME=${username}\n`, { mode: 0o600 })
  chmodSync(FILE, 0o600)
  console.log(JSON.stringify({ username, address: wallet.classicAddress, reused: false }))
}

async function accept() {
  const saved = load()
  const wallet = Wallet.fromSeed(saved.seed)
  const { gifts } = await api<{ gifts: Array<{ giftId: string; state: string }> }>('/gifts?role=incoming', saved.token)
  const gift = gifts.find((g) => g.state === 'offered')
  if (!gift) throw new Error('no gift is waiting for the recipient')

  const created = await api<{ uuid: string }>(`/gifts/${gift.giftId}/accept`, saved.token, { method: 'POST' })
  const row = await prisma.gift.findUniqueOrThrow({ where: { id: gift.giftId }, select: { offerIndex: true } })

  // The real signature: the same transaction the route built, signed with the throwaway key.
  const c = await ledger()
  const prepared = await c.autofill(buildAcceptOfferTx({ accepterAddress: wallet.classicAddress, offerIndex: row.offerIndex! }) as never)
  const signed = wallet.sign(prepared)
  const result = await c.submitAndWait(signed.tx_blob)
  const code = (result.result.meta as { TransactionResult?: string } | undefined)?.TransactionResult
  if (code !== 'tesSUCCESS') throw new Error(`the accept was refused by the ledger (${code})`)

  await api(`/dev/payloads/${created.uuid}/simulate`, null, { method: 'POST', body: { account: wallet.classicAddress, txid: signed.hash } })

  // Poll as the recipient's page would, until HubWorld confirms it on the ledger.
  for (let i = 0; i < 30; i++) {
    const state = await api<{ state: string; reason?: string }>(`/gifts/${gift.giftId}`, saved.token)
    if (state.state === 'accepted') {
      console.log(JSON.stringify({ giftId: gift.giftId, state: 'accepted', hash: signed.hash }))
      return
    }
    if (state.state === 'failed') throw new Error(`the gift failed: ${state.reason ?? 'no reason given'}`)
    await new Promise((r) => setTimeout(r, 2_000))
  }
  throw new Error('the gift did not reach "accepted" within a minute')
}

async function main() {
  assertSafeDatabase('e2e-recipient')
  if (env.XRPL_NETWORK !== 'testnet') throw new Error(`refusing: this runs on testnet only, not ${env.XRPL_NETWORK}`)
  const cmd = process.argv[2]
  if (cmd === 'create') await create()
  else if (cmd === 'accept') await accept()
  else throw new Error('usage: e2e-recipient.ts create | accept')
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(async () => {
    await disconnectLedger()
    await prisma.$disconnect()
  })
