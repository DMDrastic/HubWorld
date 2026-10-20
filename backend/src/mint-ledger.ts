/**
 * The ledger operations a bulk mint needs, behind a seam.
 *
 * The worker's job is deciding WHAT to do — which wave, at what fee, whether the
 * grant still stands, what the outcome means — and none of that needs a network.
 * Putting the network behind this interface is what lets the worker's decisions
 * be tested against a ledger that drops transactions, reorders them and revokes
 * permission mid-run, which a live devnet cannot be made to do on demand.
 */
import { randomBytes } from 'node:crypto'
import { getNFTokenID } from 'xrpl'
import type { NFTokenMint } from 'xrpl'
import { xamanMode } from './env.js'
import { delegateWallet, ledger } from './ledger.js'
import { MINT_PERMISSION, readPermissionOnLedger } from './delegation.js'
import * as stubLedger from './stub-ledger.js'
import { isTxNotFound, withBackoff } from './xrpl-errors.js'
import type { FeeQuote } from './bulk-mint-policy.js'

/** A mint with everything the ledger needs to place it. */
export type MintToSign = NFTokenMint & { Sequence: number; Fee: string; LastLedgerSequence: number }

export type SignedMint = { blob: string; hash: string }

export type TxLookup =
  /** In a validated ledger, with the code it was applied with. */
  | { state: 'validated'; result: string; nfTokenId: string | null }
  /** Known to the server but not yet in a validated ledger. */
  | { state: 'pending' }
  /** The server has never heard of it (dropped, or never reached it). */
  | { state: 'unknown' }

/** The node refused the submission for load reasons: back off, do not count a failure. */
export class MintSubmitThrottled extends Error {
  constructor(detail: string) {
    super(`submission throttled: ${detail}`)
    this.name = 'MintSubmitThrottled'
  }
}

export type PermissionReading = 'granted' | 'absent' | 'unknown'

export interface MintLedger {
  /**
   * Does the organizer's grant to this delegate still stand, right now?
   *
   * On the seam rather than read from a global mode: `xamanMode === 'stub'` only
   * means "no Xaman credentials", which is equally true of a script driving a
   * real devnet. Which ledger answers is decided by which MintLedger the caller
   * built, so a real ledger can never be answered by the fake one.
   */
  readPermission(organizerAddress: string, delegateAddress: string): Promise<PermissionReading>
  /** The organizer's NEXT sequence — it belongs to `Account`, not to the signer. */
  organizerSequence(organizerAddress: string): Promise<number>
  /** Index of the latest VALIDATED ledger: only that proves a transaction can no longer land. */
  validatedLedgerIndex(): Promise<number>
  feeQuote(): Promise<FeeQuote>
  sign(txs: MintToSign[]): SignedMint[]
  /** Preliminary result only. The truth is `lookup`. */
  submit(blob: string): Promise<string>
  lookup(hash: string): Promise<TxLookup>
}

// ------------------------------------------------------------------- real --

const THROTTLE_HINTS = /slowDown|too busy|rate|noNetwork|noCurrent|overloaded/i

export function realMintLedger(): MintLedger {
  return {
    readPermission(organizerAddress, delegateAddress) {
      return readPermissionOnLedger({ organizerAddress, delegateAddress }, MINT_PERMISSION)
    },

    async organizerSequence(organizerAddress) {
      const c = await ledger()
      // `current`, not `validated`: validated lags by several closes and would
      // add dead time to every wave, or make a healthy wave look stalled.
      const r = await withBackoff(() => c.request({ command: 'account_info', account: organizerAddress, ledger_index: 'current' }))
      return r.result.account_data.Sequence
    },

    async validatedLedgerIndex() {
      const c = await ledger()
      const r = await withBackoff(() => c.request({ command: 'ledger', ledger_index: 'validated' }))
      return Number(r.result.ledger_index)
    },

    async feeQuote() {
      const c = await ledger()
      const r = await withBackoff(() => c.request({ command: 'fee' }))
      const drops = r.result.drops
      return {
        minimumFee: Number(drops.minimum_fee),
        openLedgerFee: Number(drops.open_ledger_fee),
      }
    },

    sign(txs) {
      const wallet = delegateWallet()
      return txs.map((tx) => {
        const signed = wallet.sign(tx as never)
        return { blob: signed.tx_blob, hash: signed.hash }
      })
    },

    async submit(blob) {
      const c = await ledger()
      try {
        const r = (await c.request({ command: 'submit', tx_blob: blob })) as {
          result: { engine_result?: string }
        }
        return String(r.result.engine_result)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (THROTTLE_HINTS.test(message)) throw new MintSubmitThrottled(message.slice(0, 80))
        throw err
      }
    },

    async lookup(hash) {
      const c = await ledger()
      try {
        const r = await withBackoff(() => c.request({ command: 'tx', transaction: hash }))
        if (!r.result.validated) return { state: 'pending' }
        const meta = r.result.meta
        if (!meta || typeof meta === 'string') return { state: 'validated', result: 'unknown', nfTokenId: null }
        return {
          state: 'validated',
          result: meta.TransactionResult,
          nfTokenId: meta.TransactionResult === 'tesSUCCESS' ? (getNFTokenID(meta) ?? null) : null,
        }
      } catch (err) {
        if (isTxNotFound(err)) return { state: 'unknown' }
        throw err
      }
    },
  }
}

// ------------------------------------------------------------------- stub --

/**
 * An in-memory ledger for stub mode: every submitted mint lands at once, as the
 * organizer's token, so a bulk mint can be driven end to end with no credentials.
 * Stub mode refuses to boot in production, so this never touches real money.
 */
export function stubMintLedger(): MintLedger {
  const sequences = new Map<string, number>()
  const pending = new Map<string, { account: string; taxon: number }>()
  const done = new Map<string, TxLookup>()
  let ledgerIndex = 1_000

  return {
    async readPermission(organizerAddress, delegateAddress) {
      return stubLedger.hasDelegation(organizerAddress, delegateAddress, MINT_PERMISSION)
        ? 'granted'
        : 'absent'
    },
    async organizerSequence(address) {
      if (!sequences.has(address)) sequences.set(address, 100)
      return sequences.get(address)!
    },
    async validatedLedgerIndex() {
      ledgerIndex += 1
      return ledgerIndex
    },
    async feeQuote() {
      return { minimumFee: 10, openLedgerFee: 10 }
    },
    sign(txs) {
      return txs.map((tx) => {
        const hash = randomBytes(32).toString('hex').toUpperCase()
        pending.set(hash, { account: tx.Account, taxon: tx.NFTokenTaxon })
        return { blob: `stub:${hash}`, hash }
      })
    },
    async submit(blob) {
      const hash = blob.replace('stub:', '')
      const tx = pending.get(hash)
      if (!tx) return 'tefFAILURE'
      pending.delete(hash)
      sequences.set(tx.account, (sequences.get(tx.account) ?? 100) + 1)
      const minted = stubLedger.applyDelegatedMint(tx.account, tx.taxon)
      done.set(hash, { state: 'validated', result: 'tesSUCCESS', nfTokenId: minted.nfTokenId })
      return 'tesSUCCESS'
    },
    async lookup(hash) {
      return done.get(hash) ?? { state: 'unknown' }
    },
  }
}

/** The ledger the app should use: the fake one only when Xaman itself is faked. */
export function defaultMintLedger(): MintLedger {
  return xamanMode === 'stub' ? stubMintLedger() : realMintLedger()
}
