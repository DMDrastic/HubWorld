/**
 * The ledger operations a checkout needs, behind a seam.
 *
 * The checkout's job is deciding what to do — which ticket, whether the offer is
 * the one asked for, what a failure means — and none of it needs a network. This
 * is also where "which ledger answers" is decided, by which implementation the
 * caller builds rather than by a global mode: `xamanMode === 'stub'` only means
 * "no Xaman credentials", which is equally true of a script driving devnet, and
 * letting a mode switch pick the ledger answered the first real devnet run of the
 * mint worker with the fake one.
 */
import type { NFTokenCreateOffer } from 'xrpl'
import { xamanMode } from './env.js'
import {
  accountFundingOnLedger,
  brokerCancelOffersOnLedger,
  delegateWallet,
  holdsNftOnLedger,
  ledger,
} from './ledger.js'
import { OFFER_PERMISSION, readPermissionOnLedger } from './delegation.js'
import * as stubLedger from './stub-ledger.js'
import { isTxNotFound } from './xrpl-errors.js'

export type DelegatedOffer = NFTokenCreateOffer & { Delegate: string }

export type OfferResult =
  | { ok: true; txHash: string; offerIndex: string }
  /** `code` is the ledger's own result where there is one, else a short tag. */
  | { ok: false; code: string }

export type StartedOffer =
  | { ok: true; hash: string; lastLedgerSequence: number }
  | { ok: false; code: string }

export type PermissionReading = 'granted' | 'absent' | 'unknown'

export interface PrimarySaleLedger {
  /** Does the organizer's offer grant to this delegate still stand? */
  readPermission(organizerAddress: string, delegateAddress: string): Promise<PermissionReading>
  /** Does the organizer still hold the ticket ON THE LEDGER? Null when it cannot be read. */
  holds(organizerAddress: string, nfTokenId: string): Promise<boolean | null>
  funding(address: string): Promise<{ spendableDrops: bigint; reserveIncDrops: bigint }>
  /**
   * Sign and SUBMIT the sell offer as the organizer. Call under the organizer's
   * lease: this is the moment a sequence number is read and consumed, so it is the
   * only part that has to be one-at-a-time.
   */
  startSellOffer(tx: DelegatedOffer): Promise<StartedOffer>
  /**
   * Wait for a submitted offer to validate. Needs no lease: the sequence is
   * already spent, so any number of these can wait at once. Holding the lease
   * through this wait is what limited a single organizer to one checkout per
   * ledger close (measured: ~6s each, ten a minute).
   */
  awaitSellOffer(started: Extract<StartedOffer, { ok: true }>): Promise<OfferResult>
  /** Best effort: an uncancelled offer is inert (only the broker can match it). */
  cancelOffers(offerIndexes: string[]): Promise<void>
}

// ------------------------------------------------------------------- real --

const VALIDATE_TIMEOUT_MS = 30_000
const POLL_MS = 1_000

/** How long the organizer's account is held for its new sequence to become visible. */
const SEQUENCE_VISIBLE_TIMEOUT_MS = 6_000
const SEQUENCE_POLL_MS = 150

/**
 * Wait until the organizer's `current` sequence is past `used`.
 *
 * Gives up quietly at the timeout rather than failing: the offer HAS been
 * submitted, so reporting an error would invite a retry that creates a second one.
 * A caller that races the stale view anyway meets the retry on `tefPAST_SEQ`.
 */
async function waitForSequenceToAdvance(c: Awaited<ReturnType<typeof ledger>>, account: string, used: number): Promise<void> {
  if (!(used > 0)) return
  const begun = Date.now()
  while (Date.now() - begun < SEQUENCE_VISIBLE_TIMEOUT_MS) {
    try {
      const r = await c.request({ command: 'account_info', account, ledger_index: 'current' })
      if (r.result.account_data.Sequence > used) return
    } catch {
      // A failed read says nothing; keep looking until the timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, SEQUENCE_POLL_MS))
  }
}

export function realPrimarySaleLedger(): PrimarySaleLedger {
  return {
    readPermission(organizerAddress, delegateAddress) {
      return readPermissionOnLedger({ organizerAddress, delegateAddress }, OFFER_PERMISSION)
    },

    async holds(organizerAddress, nfTokenId) {
      try {
        return await holdsNftOnLedger(organizerAddress, nfTokenId)
      } catch {
        return null
      }
    },

    funding: accountFundingOnLedger,

    async startSellOffer(tx) {
      const c = await ledger()
      try {
        // Autofill reads the ORGANIZER's current sequence — which is why this runs
        // under their lease: two reading at once would take the same number.
        const prepared = await c.autofill(tx as never)
        const signed = delegateWallet().sign(prepared as never)
        const submitted = (await c.request({ command: 'submit', tx_blob: signed.tx_blob } as never)) as {
          result: { engine_result?: string }
        }
        const prelim = String(submitted.result.engine_result)
        // Only these can still become a validated success.
        if (prelim !== 'tesSUCCESS' && prelim !== 'terQUEUED') return { ok: false, code: prelim }

        // Do not hand the account to the next checkout until THIS offer's sequence
        // is visible to it. The next one reads the organizer's sequence the moment
        // the lease is released, and on mainnet that read can be served from a view
        // that has not yet seen this submission: it then reuses the same number and
        // comes back `tefPAST_SEQ`. Devnet is one node and never showed it; the
        // first real mainnet run lost one of two simultaneous buyers to it.
        await waitForSequenceToAdvance(c, tx.Account, Number((prepared as { Sequence?: number }).Sequence ?? 0))

        return {
          ok: true,
          hash: signed.hash,
          lastLedgerSequence: Number((prepared as { LastLedgerSequence?: number }).LastLedgerSequence ?? 0),
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, code: /terNO_DELEGATE/.test(message) ? 'terNO_DELEGATE_PERMISSION' : 'error' }
      }
    },

    async awaitSellOffer(started) {
      const c = await ledger()
      const begun = Date.now()
      try {
        while (Date.now() - begun < VALIDATE_TIMEOUT_MS) {
          try {
            const r = await c.request({ command: 'tx', transaction: started.hash })
            if (r.result.validated) {
              const meta = r.result.meta
              const code = meta && typeof meta !== 'string' ? meta.TransactionResult : 'unknown'
              if (code !== 'tesSUCCESS') return { ok: false, code }
              if (meta && typeof meta !== 'string') {
                for (const node of meta.AffectedNodes) {
                  if ('CreatedNode' in node && node.CreatedNode.LedgerEntryType === 'NFTokenOffer') {
                    return { ok: true, txHash: started.hash, offerIndex: node.CreatedNode.LedgerIndex }
                  }
                }
              }
              return { ok: false, code: 'noOfferCreated' }
            }
          } catch (err) {
            if (!isTxNotFound(err)) throw err
          }
          // Past LastLedgerSequence in a VALIDATED ledger, it can never apply.
          if (started.lastLedgerSequence > 0) {
            const idx = Number((await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index)
            if (idx > started.lastLedgerSequence) return { ok: false, code: 'expired' }
          }
          await new Promise((r) => setTimeout(r, POLL_MS))
        }
        return { ok: false, code: 'timeout' }
      } catch {
        return { ok: false, code: 'error' }
      }
    },

    async cancelOffers(offerIndexes) {
      if (offerIndexes.length === 0) return
      await brokerCancelOffersOnLedger(offerIndexes)
    },
  }
}

// ------------------------------------------------------------------- stub --

/**
 * In-memory, for stub mode only (which refuses to boot in production). The offer
 * is created as the organizer, exactly as delegation does it, so what the buyer
 * flow later reads back is shaped like the real thing.
 */
export function stubPrimarySaleLedger(): PrimarySaleLedger {
  return {
    async readPermission(organizerAddress, delegateAddress) {
      return stubLedger.hasDelegation(organizerAddress, delegateAddress, OFFER_PERMISSION) ? 'granted' : 'absent'
    },
    async holds(organizerAddress, nfTokenId) {
      return stubLedger.holdsNft(organizerAddress, nfTokenId)
    },
    funding: (address) => stubLedger.accountFunding(address),
    async startSellOffer(tx) {
      const { txHash } = stubLedger.applyTransaction(tx as unknown as Record<string, unknown>, tx.Account)
      return { ok: true, hash: txHash, lastLedgerSequence: 0 }
    },
    async awaitSellOffer(started) {
      const offerIndex = await stubLedger.offerIndexFromTx(started.hash)
      return offerIndex ? { ok: true, txHash: started.hash, offerIndex } : { ok: false, code: 'noOfferCreated' }
    },
    async cancelOffers(offerIndexes) {
      await stubLedger.brokerCancelOffers(offerIndexes)
    },
  }
}

/** The ledger the app should use: the fake one only when Xaman itself is faked. */
export function defaultPrimarySaleLedger(): PrimarySaleLedger {
  return xamanMode === 'stub' ? stubPrimarySaleLedger() : realPrimarySaleLedger()
}
