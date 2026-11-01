/**
 * Signing with a wallet the USER owns (Privy), where the server never sees a key.
 *
 * The shape, and why each step is the way round it is:
 *
 *   1. SERVER builds the transaction, fills in sequence and fee, and stores that exact copy.
 *   2. BROWSER is given the hash of it, and its owner signs the hash in their own wallet.
 *   3. SERVER receives ONLY the signature, attaches it to ITS OWN stored copy, checks it, submits.
 *
 * What comes back from the browser is never a transaction, only a signature. So a tampered
 * browser, a malicious extension or a stolen session cannot change what gets submitted: at worst
 * it produces a signature that does not verify against the server's copy, and nothing is sent.
 *
 * A request lives in the `XamanPayload` table with `signer = 'privy'` (the table name predates
 * a second signer; renaming it would be churn with no value). Every poll route already reads
 * payload state through `payload-store`, so a Privy request needs no change to any of them.
 */
import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { deriveAddress, encode, encodeForSigning, verifySignature } from 'xrpl'
import { prisma } from './prisma.js'
import { NETWORK } from './network.js'
import { ledger } from './ledger.js'
import { checkFlowTx } from './privy-flows.js'
import type { CreatedPayload, PayloadAttribution, PayloadOptions, PayloadStatus, SigningProvider } from './signing.js'

/**
 * How long a request can be signed, in ledgers (about 3-4 seconds each, so roughly five
 * minutes). A person reads and approves this, so the default of 20 ledgers would expire under
 * them; but it is still BOUNDED, because an approval that never expires could be submitted long
 * after the person stopped meaning it.
 */
export const SIGN_WINDOW_LEDGERS = 100
export const REQUEST_TTL_MS = 5 * 60_000

// ------------------------------------------------------------------ ledger --

/** The three things this module needs from a ledger, so tests can supply a fake. */
export type LedgerPort = {
  currentLedger(): Promise<number>
  autofill(tx: Record<string, unknown>): Promise<Record<string, unknown>>
  submit(blob: string): Promise<{ engineResult: string; hash: string }>
}

const realLedger: LedgerPort = {
  async currentLedger() {
    return (await ledger()).getLedgerIndex()
  },
  async autofill(tx) {
    return (await (await ledger()).autofill(tx as never)) as unknown as Record<string, unknown>
  },
  async submit(blob) {
    const res = await (await ledger()).submit(blob)
    return { engineResult: res.result.engine_result, hash: res.result.tx_json.hash as string }
  },
}

let port: LedgerPort = realLedger
export function setLedgerPortForTests(p: LedgerPort | null): void {
  port = p ?? realLedger
}

// ------------------------------------------------------------------- hash --

/** SHA-512Half of the signing-prefixed bytes: what the wallet is asked to sign, uppercase hex. */
export function signingHash(tx: Record<string, unknown>): string {
  const bytes = Buffer.from(encodeForSigning(tx as never), 'hex')
  return createHash('sha512').update(bytes).digest().subarray(0, 32).toString('hex').toUpperCase()
}

// -------------------------------------------------------------- signature --

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/**
 * Turn what a wallet returned into the one encoding the ledger accepts: DER, low-S, uppercase.
 *
 * Wallets return either a compact 64-byte r||s (Privy's raw signing does) or DER. The ledger
 * wants DER, and rejects a signature whose S is in the upper half of the curve order as
 * non-canonical, so S is folded down. Anything else is refused rather than guessed at.
 */
export function toCanonicalDer(signature: string): string {
  const h = signature.trim().replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]+$/.test(h)) throw new Error('signature is not hex')
  let r: bigint
  let s: bigint
  if (h.length === 128) {
    r = BigInt(`0x${h.slice(0, 64)}`)
    s = BigInt(`0x${h.slice(64)}`)
  } else if (h.startsWith('30')) {
    // 30 <len> 02 <rlen> <r> 02 <slen> <s>
    const b = Buffer.from(h, 'hex')
    if (b[0] !== 0x30 || b[2] !== 0x02) throw new Error('malformed DER signature')
    const rl = b[3]!
    if (b[4 + rl] !== 0x02) throw new Error('malformed DER signature')
    const sl = b[5 + rl]!
    r = BigInt(`0x${b.subarray(4, 4 + rl).toString('hex')}`)
    s = BigInt(`0x${b.subarray(6 + rl, 6 + rl + sl).toString('hex')}`)
  } else {
    throw new Error('unrecognised signature format')
  }
  if (r <= 0n || r >= N || s <= 0n || s >= N) throw new Error('signature out of range')
  if (s > N / 2n) s = N - s
  const int = (v: bigint) => {
    let x = v.toString(16)
    if (x.length % 2) x = `0${x}`
    if (parseInt(x.slice(0, 2), 16) >= 0x80) x = `00${x}`
    return x
  }
  const R = int(r)
  const S = int(s)
  const len = (x: string) => (x.length / 2).toString(16).padStart(2, '0')
  const body = `02${len(R)}${R}02${len(S)}${S}`
  return `30${len(body)}${body}`.toUpperCase()
}

// ---------------------------------------------------------------- creation --

/** A request the server will not even build, with a reason a person can read. */
export class SigningRequestRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SigningRequestRefused'
  }
}

async function createRequest(txjson: Record<string, unknown>, opts: PayloadOptions): Promise<CreatedPayload> {
  if (!opts.userId) throw new SigningRequestRefused('A signature request needs a signed-in user.')
  const wallet = await prisma.wallet.findUnique({ where: { userId: opts.userId } })
  if (!wallet || wallet.signerKind !== 'PRIVY' || !wallet.publicKey) {
    throw new SigningRequestRefused('This account has no wallet that can sign here.')
  }
  // It must be THEIR transaction, as them. A request to sign as some other account could only be
  // a mistake or an attack, and either way their wallet should never be asked.
  if (txjson.Account !== wallet.xrplAddress) {
    throw new SigningRequestRefused('That transaction is not for your account.')
  }
  // And it must be the kind of transaction THIS action is for, on the right side of an offer: a bid that is secretly a
  // sell offer would give a ticket away for the amount. The routes build these correctly; this is the second lock.
  const wrong = checkFlowTx(opts.flow, txjson)
  if (wrong) throw new SigningRequestRefused(wrong)
  for (const forbidden of ['TxnSignature', 'Signers', 'Delegate'] as const) {
    if (forbidden in txjson) throw new SigningRequestRefused(`A transaction to sign cannot already contain ${forbidden}.`)
  }

  const prepared = await port.autofill({ ...txjson, SigningPubKey: wallet.publicKey })
  // Set explicitly, always: this is what makes a stale approval expire rather than wait.
  // A shorter deadline when the caller has one (a quoted XRP price stands for two minutes): about three seconds a ledger,
  // never longer than the usual window. The request's own expiry below ends with it too.
  const window = opts.expireMinutes ? Math.min(SIGN_WINDOW_LEDGERS, Math.ceil((opts.expireMinutes * 60) / 3)) : SIGN_WINDOW_LEDGERS
  prepared.LastLedgerSequence = (await port.currentLedger()) + window
  const hash = signingHash(prepared)

  const uuid = randomUUID()
  await prisma.xamanPayload.create({
    data: {
      uuid,
      flow: opts.flow,
      network: NETWORK,
      signer: 'privy',
      userId: opts.userId,
      unsignedTx: prepared as Prisma.InputJsonValue,
      expectedAccount: wallet.xrplAddress,
      expiresAt: new Date(Date.now() + Math.min(REQUEST_TTL_MS, (opts.expireMinutes ?? Infinity) * 60_000)),
      source: 'create',
    },
  })
  return { uuid, next: '', qrPng: '', sign: { tx: prepared, hash, account: wallet.xrplAddress } }
}

// ------------------------------------------------------------------ status --

type Row = {
  signed: boolean
  cancelled: boolean
  expired: boolean
  expectedAccount: string | null
  txid: string | null
  expiresAt: Date | null
}

/** What the poll routes see for a Privy request. */
export function privyStatus(row: Row, now = new Date()): PayloadStatus {
  const lapsed = !row.signed && !row.cancelled && row.expiresAt !== null && row.expiresAt < now
  return {
    signed: row.signed,
    cancelled: row.cancelled,
    expired: row.expired || lapsed,
    account: row.signed ? row.expectedAccount : null,
    txid: row.txid,
  }
}

// -------------------------------------------------------------- submission --

export type SubmitOutcome =
  | { ok: true; txid: string; replay: boolean }
  | { ok: false; status: number; error: string }

const accepted = (code: string) => code.startsWith('tes') || code.startsWith('ter')

/**
 * Take a signature for a request, check it every way that matters, and submit.
 *
 * Every refusal here is a refusal to submit: nothing is "logged and carried on". The checks, in
 * the order that costs least:
 *   - it is this user's own request, and it is still open (not expired, not past its ledger);
 *   - the signing key is the logged-in user's own wallet key, derives to the account the
 *     transaction is FROM, and is the key written into the transaction;
 *   - the signature verifies against the server's stored copy (a signature over anything else,
 *     including a changed amount or destination, fails here).
 * The submit itself happens at most once per request (`submittedAt` is claimed atomically).
 */
export async function submitSignature(uuid: string, userId: string, signature: string): Promise<SubmitOutcome> {
  const row = await prisma.xamanPayload.findUnique({ where: { uuid } })
  // A request that is not theirs looks exactly like one that does not exist.
  if (!row || row.signer !== 'privy' || row.userId !== userId || !row.unsignedTx) {
    return { ok: false, status: 404, error: 'No such signature request.' }
  }
  // Replay: the first submit already happened. Say what it did; do nothing again.
  if (row.submittedAt) {
    return row.txid
      ? { ok: true, txid: row.txid, replay: true }
      : { ok: false, status: 409, error: row.submitError ?? 'That request has already been used.' }
  }
  if (row.cancelled) return { ok: false, status: 409, error: 'That request was cancelled.' }
  if (row.expired || (row.expiresAt && row.expiresAt < new Date())) {
    await prisma.xamanPayload.updateMany({ where: { uuid, terminal: false }, data: { expired: true, terminal: true } })
    return { ok: false, status: 410, error: 'That request has expired. Start again.' }
  }

  const tx = row.unsignedTx as Record<string, unknown>
  const lastLedger = tx.LastLedgerSequence
  if (typeof lastLedger !== 'number') {
    // A stored request without a deadline must never become submittable.
    return { ok: false, status: 409, error: 'That request has no deadline and cannot be signed.' }
  }
  if ((await port.currentLedger()) > lastLedger) {
    await prisma.xamanPayload.updateMany({ where: { uuid, terminal: false }, data: { expired: true, terminal: true } })
    return { ok: false, status: 410, error: 'That request has expired. Start again.' }
  }

  // These clauses overlap on purpose. Each is one way the three records (the wallet, the stored
  // transaction and the request row) could disagree, and a signature must satisfy ALL of them: this
  // is the check that decides whether someone's key is allowed to move their account, so a clause
  // that happens to be implied by the others today is not worth removing.
  const wallet = await prisma.wallet.findUnique({ where: { userId } })
  const key = typeof tx.SigningPubKey === 'string' ? tx.SigningPubKey.toUpperCase() : ''
  if (
    !wallet ||
    wallet.signerKind !== 'PRIVY' ||
    !wallet.publicKey ||
    wallet.publicKey.toUpperCase() !== key ||
    wallet.xrplAddress !== tx.Account ||
    wallet.xrplAddress !== row.expectedAccount ||
    deriveAddress(key) !== tx.Account
  ) {
    return { ok: false, status: 403, error: 'That signature is not from your wallet.' }
  }

  let blob: string
  try {
    blob = encode({ ...tx, TxnSignature: toCanonicalDer(signature) } as never)
    if (!verifySignature(blob)) throw new Error('does not verify')
  } catch {
    return { ok: false, status: 400, error: 'That signature does not match the request.' }
  }

  // The idempotency key: of any number of simultaneous submissions, exactly one gets to proceed.
  const claim = await prisma.xamanPayload.updateMany({
    where: { uuid, submittedAt: null },
    data: { submittedAt: new Date() },
  })
  if (claim.count !== 1) {
    const now = await prisma.xamanPayload.findUnique({ where: { uuid } })
    return now?.txid
      ? { ok: true, txid: now.txid, replay: true }
      : { ok: false, status: 409, error: 'That request is already being submitted.' }
  }

  try {
    const res = await port.submit(blob)
    if (!accepted(res.engineResult)) {
      await prisma.xamanPayload.update({
        where: { uuid },
        data: { submitError: `The ledger refused it (${res.engineResult}).`, terminal: true },
      })
      return { ok: false, status: 422, error: `The ledger refused it (${res.engineResult}).` }
    }
    await prisma.xamanPayload.update({
      where: { uuid },
      data: { signed: true, account: row.expectedAccount, txid: res.hash, terminal: true },
    })
    return { ok: true, txid: res.hash, replay: false }
  } catch {
    // We could not reach the ledger, so nothing is known to have been submitted. Release the
    // claim so the person can try again; resubmitting the same signed blob is harmless anyway,
    // since the ledger deduplicates by hash.
    await prisma.xamanPayload.updateMany({ where: { uuid, txid: null }, data: { submittedAt: null } })
    return { ok: false, status: 503, error: 'Could not reach the ledger just now. Try again.' }
  }
}

// ---------------------------------------------------------------- provider --

export const privySigner: SigningProvider = {
  mode: 'live',
  createPayload: createRequest,
  async createSignInPayload(_attribution: PayloadAttribution): Promise<CreatedPayload> {
    // A Privy sign-in is the login tokens (routes/privy-auth.ts), not a payload.
    throw new SigningRequestRefused('Privy sign-in does not use a signature request.')
  },
  async getPayload(uuid) {
    const row = await prisma.xamanPayload.findUnique({ where: { uuid } })
    return row && row.signer === 'privy' ? privyStatus(row) : null
  },
  async cancelPayload(uuid) {
    const done = await prisma.xamanPayload.updateMany({
      where: { uuid, signer: 'privy', signed: false },
      data: { cancelled: true, terminal: true },
    })
    return done.count === 1
  },
}
