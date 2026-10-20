import { ledger } from './ledger.js'
import type { LedgerOffer } from './orphan-offers.js'

/**
 * Every NFTokenOffer an account owns, paged, from the REAL ledger.
 *
 * A separate module from `orphan-offers.ts` so that one stays pure.
 */
export async function offersOwnedBy(address: string): Promise<LedgerOffer[]> {
  const c = await ledger()
  const out: LedgerOffer[] = []
  let marker: unknown
  do {
    const res = (await c.request({
      command: 'account_objects',
      account: address,
      type: 'nft_offer',
      limit: 400,
      ledger_index: 'validated',
      ...(marker === undefined ? {} : { marker }),
    } as never)) as unknown as {
      result: { account_objects: Array<Record<string, unknown>>; marker?: unknown }
    }
    for (const o of res.result.account_objects) {
      out.push({
        index: String(o.index),
        nfTokenId: String(o.NFTokenID),
        // lsfSellNFToken
        isSell: (Number(o.Flags ?? 0) & 1) === 1,
        amount: o.Amount,
        destination: typeof o.Destination === 'string' ? o.Destination : null,
        owner: address,
      })
    }
    marker = res.result.marker
  } while (marker !== undefined)
  return out
}

