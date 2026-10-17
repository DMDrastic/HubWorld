/**
 * A fake XRP Ledger, in memory, used only when `xamanMode === 'stub'`.
 *
 * Every poll route in this codebase reads a REAL, validated transaction hash
 * off a signed payload (`txSucceeded`, `offerIndexFromTx`, `nftokenIdFromTx`
 * in `ledger.ts`), and brokered settlement submits a REAL transaction
 * (`brokerSale`). A stub signature has no such hash, so without this module
 * every flow past sign-in freezes at "signed, pending" forever in stub mode —
 * only the sign-in payload has ever had a fake-signing story.
 *
 * `ledger.ts` branches its exports here when `xamanMode === 'stub'` (which
 * already refuses to boot in production — see `env.ts` — so this file can
 * never run against real money). Routes are untouched; the seam is the same
 * one `CountingSigner` already uses to decorate `xaman.ts` without touching
 * callers.
 *
 * `StubXamanClient.simulate()` calls `applyTransaction` at the moment a
 * payload is "signed", producing a fabricated tx hash the rest of this module
 * can then answer queries about. IDs are deliberately unrealistic — prefixed
 * `FEED...`, the same spirit as `demo-seed.ts`'s `DEEDDEED` fixtures — so a
 * database or a log makes it obvious nothing here was ever minted for real.
 */
import { randomBytes } from 'node:crypto'

// Mirrors ledger.ts's TF_SELL_NFTOKEN. Not imported from there — ledger.ts
// imports THIS module, and a cycle back would be a real problem, not a style
// nit.
const TF_SELL_NFTOKEN = 1

function fabricatedId(tag: string): string {
  const rand = randomBytes(28).toString('hex').toUpperCase()
  return (tag + rand).slice(0, 64).padEnd(64, '0')
}

type StubOffer = {
  nfTokenId: string
  isSell: boolean
  amountDrops: bigint
  destination: string | null
  /** Whoever the NFT belongs to for this offer — matches the real ledger's `Owner` field. */
  owner: string
  /** Who signed the CreateOffer transaction. */
  creator: string
}

type StubTx = {
  succeeded: boolean
  nftokenId?: string
  offerIndex?: string
}

const nftOwners = new Map<string, string>()
const offers = new Map<string, StubOffer>()
const transactions = new Map<string, StubTx>()

/** A flat, generous balance for any address — good enough for demo affordability checks. */
const STUB_SPENDABLE_DROPS = 10_000n * 1_000_000n
const STUB_RESERVE_INC_DROPS = 200_000n

/**
 * Apply the effect of a signed transaction and hand back a fabricated hash.
 *
 * Called by `StubXamanClient.simulate()` — never by a route directly. Only
 * the transaction types HubWorld ever builds are handled; anything else
 * (there is none today) records a no-op success rather than throwing, since
 * an unrecognised type here should not be able to break a demo mid-recording.
 */
export function applyTransaction(
  txjson: Record<string, unknown>,
  signerAddress: string,
): { txHash: string } {
  const txHash = fabricatedId('FEEDCAFE')

  switch (txjson.TransactionType) {
    case 'NFTokenMint': {
      const nfTokenId = fabricatedId('FEEDC0DE')
      nftOwners.set(nfTokenId, signerAddress)

      // Mint-and-list in one signature (NFTokenMintOffer) — Amount+Destination
      // ride on the mint itself.
      let offerIndex: string | undefined
      if (typeof txjson.Amount === 'string' && typeof txjson.Destination === 'string') {
        offerIndex = fabricatedId('FEED0FFE')
        offers.set(offerIndex, {
          nfTokenId,
          isSell: true,
          amountDrops: BigInt(txjson.Amount),
          destination: txjson.Destination,
          owner: signerAddress,
          creator: signerAddress,
        })
      }
      transactions.set(txHash, { succeeded: true, nftokenId: nfTokenId, offerIndex })
      break
    }

    case 'NFTokenCreateOffer': {
      const isSell = (Number(txjson.Flags ?? 0) & TF_SELL_NFTOKEN) === TF_SELL_NFTOKEN
      const offerIndex = fabricatedId('FEED0FFE')
      offers.set(offerIndex, {
        nfTokenId: String(txjson.NFTokenID),
        isSell,
        amountDrops: BigInt(String(txjson.Amount ?? '0')),
        destination: typeof txjson.Destination === 'string' ? txjson.Destination : null,
        // A sell offer's owner is its creator; a buy offer names the current
        // owner explicitly, same as the real ledger.
        owner: isSell ? signerAddress : String(txjson.Owner),
        creator: signerAddress,
      })
      transactions.set(txHash, { succeeded: true, offerIndex })
      break
    }

    case 'NFTokenAcceptOffer': {
      // Self-accept only — a gift recipient accepting a zero-amount offer
      // directed at them. Brokered accepts (fixed-price sale, auction
      // settlement) are signed by the PLATFORM wallet directly, never
      // through Xaman, so they never reach this method — see brokerSale().
      const offerIndex = txjson.NFTokenSellOffer as string | undefined
      const offer = offerIndex ? offers.get(offerIndex) : undefined
      if (offer) {
        nftOwners.set(offer.nfTokenId, signerAddress)
        offers.delete(offerIndex!)
      }
      transactions.set(txHash, { succeeded: Boolean(offer) })
      break
    }

    case 'NFTokenCancelOffer': {
      const indexes = Array.isArray(txjson.NFTokenOffers) ? (txjson.NFTokenOffers as string[]) : []
      for (const idx of indexes) offers.delete(idx)
      transactions.set(txHash, { succeeded: true })
      break
    }

    default:
      transactions.set(txHash, { succeeded: true })
  }

  return { txHash }
}

export async function holdsNft(address: string, nfTokenId: string): Promise<boolean> {
  return nftOwners.get(nfTokenId) === address
}

export async function txSucceeded(txHash: string): Promise<boolean | null> {
  const tx = transactions.get(txHash)
  return tx ? tx.succeeded : null
}

export async function offerIndexFromTx(txHash: string): Promise<string | null> {
  return transactions.get(txHash)?.offerIndex ?? null
}

export async function nftokenIdFromTx(txHash: string): Promise<string | null> {
  return transactions.get(txHash)?.nftokenId ?? null
}

export async function readNftOffer(
  offerIndex: string,
): Promise<{ amountDrops: bigint; destination: string | null; owner: string } | null> {
  const offer = offers.get(offerIndex)
  if (!offer) return null
  return { amountDrops: offer.amountDrops, destination: offer.destination, owner: offer.owner }
}

export async function accountFunding(
  _address: string,
): Promise<{ spendableDrops: bigint; reserveIncDrops: bigint }> {
  return { spendableDrops: STUB_SPENDABLE_DROPS, reserveIncDrops: STUB_RESERVE_INC_DROPS }
}

export async function brokerSale(params: {
  sellOfferIndex: string
  buyOfferIndex: string
  brokerFeeDrops: bigint
}): Promise<{ hash: string; succeeded: boolean; result: string }> {
  const hash = fabricatedId('FEEDCAFE')
  const sell = offers.get(params.sellOfferIndex)
  const buy = offers.get(params.buyOfferIndex)
  // Mirrors the real ledger's tecNO_ENTRY: an offer that was never created (or
  // was already consumed) cannot be matched.
  if (!sell || !buy) return { hash, succeeded: false, result: 'tecNO_ENTRY' }

  nftOwners.set(sell.nfTokenId, buy.creator)
  offers.delete(params.sellOfferIndex)
  offers.delete(params.buyOfferIndex)
  return { hash, succeeded: true, result: 'tesSUCCESS' }
}

export async function brokerCancelOffers(
  offerIndexes: string[],
): Promise<{ hash: string; succeeded: boolean; result: string } | null> {
  if (offerIndexes.length === 0) return null
  for (const idx of offerIndexes) offers.delete(idx)
  return { hash: fabricatedId('FEEDCAFE'), succeeded: true, result: 'tesSUCCESS' }
}
