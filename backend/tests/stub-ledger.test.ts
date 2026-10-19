/**
 * The fake ledger stub mode runs on. Pure bookkeeping — no Postgres, no
 * socket — so this pins the bookkeeping itself: a mint is held by its
 * issuer, an offer transfers ownership on accept and disappears on cancel,
 * and a brokered sale matches two offers the way `brokerSale` really does.
 */
import { describe, expect, it } from 'vitest'
import {
  applyTransaction,
  holdsNft,
  txSucceeded,
  offerIndexFromTx,
  nftokenIdFromTx,
  readNftOffer,
  accountFunding,
  brokerSale,
  brokerCancelOffers,
  hasDelegation,
} from '../src/stub-ledger.js'

const ISSUER = 'rISSUERADDR1111111111111111111111'
const BROKER = 'rBROKERADDR111111111111111111111'
const BUYER = 'rBUYERADDR11111111111111111111111'

describe('applyTransaction: NFTokenMint', () => {
  it('mints a token held by the signer, and the tx reports it', async () => {
    const { txHash } = applyTransaction({ TransactionType: 'NFTokenMint' }, ISSUER)
    expect(await txSucceeded(txHash)).toBe(true)
    const nfTokenId = await nftokenIdFromTx(txHash)
    expect(nfTokenId).toBeTruthy()
    expect(await holdsNft(ISSUER, nfTokenId!)).toBe(true)
    expect(await holdsNft(BUYER, nfTokenId!)).toBe(false)
  })

  it('mint-and-list (Amount + Destination) also creates a sell offer', async () => {
    const { txHash } = applyTransaction(
      { TransactionType: 'NFTokenMint', Amount: '5000000', Destination: BROKER },
      ISSUER,
    )
    const offerIndex = await offerIndexFromTx(txHash)
    expect(offerIndex).toBeTruthy()
    const offer = await readNftOffer(offerIndex!)
    expect(offer).toEqual({ amountDrops: 5_000_000n, destination: BROKER, owner: ISSUER })
  })

  it('a plain mint (no Amount/Destination) creates no offer', async () => {
    const { txHash } = applyTransaction({ TransactionType: 'NFTokenMint' }, ISSUER)
    expect(await offerIndexFromTx(txHash)).toBeNull()
  })
})

describe('applyTransaction: offer create / accept / cancel', () => {
  it('a sell offer accepted by someone else transfers ownership and consumes the offer', async () => {
    const mint = applyTransaction({ TransactionType: 'NFTokenMint' }, ISSUER)
    const nfTokenId = (await nftokenIdFromTx(mint.txHash))!

    const create = applyTransaction(
      { TransactionType: 'NFTokenCreateOffer', NFTokenID: nfTokenId, Amount: '0', Destination: BUYER, Flags: 1 },
      ISSUER,
    )
    const offerIndex = (await offerIndexFromTx(create.txHash))!
    expect((await readNftOffer(offerIndex))?.owner).toBe(ISSUER)

    const accept = applyTransaction({ TransactionType: 'NFTokenAcceptOffer', NFTokenSellOffer: offerIndex }, BUYER)
    expect(await txSucceeded(accept.txHash)).toBe(true)
    expect(await holdsNft(BUYER, nfTokenId)).toBe(true)
    expect(await holdsNft(ISSUER, nfTokenId)).toBe(false)
    // Consumed — reading it back reports what the real ledger reports for a
    // spent offer index: nothing.
    expect(await readNftOffer(offerIndex)).toBeNull()
  })

  it('accepting an unknown offer index fails rather than silently transferring anything', async () => {
    const { txHash } = applyTransaction(
      { TransactionType: 'NFTokenAcceptOffer', NFTokenSellOffer: 'NOTREAL' },
      BUYER,
    )
    expect(await txSucceeded(txHash)).toBe(false)
  })

  it('cancelling an offer removes it', async () => {
    const mint = applyTransaction({ TransactionType: 'NFTokenMint' }, ISSUER)
    const nfTokenId = (await nftokenIdFromTx(mint.txHash))!
    const create = applyTransaction(
      { TransactionType: 'NFTokenCreateOffer', NFTokenID: nfTokenId, Amount: '0', Destination: BUYER, Flags: 1 },
      ISSUER,
    )
    const offerIndex = (await offerIndexFromTx(create.txHash))!

    applyTransaction({ TransactionType: 'NFTokenCancelOffer', NFTokenOffers: [offerIndex] }, ISSUER)
    expect(await readNftOffer(offerIndex)).toBeNull()
  })

  it('a buy offer records the current owner from the Owner field, not the bidder', async () => {
    const mint = applyTransaction({ TransactionType: 'NFTokenMint' }, ISSUER)
    const nfTokenId = (await nftokenIdFromTx(mint.txHash))!
    const bid = applyTransaction(
      { TransactionType: 'NFTokenCreateOffer', NFTokenID: nfTokenId, Amount: '1000000', Owner: ISSUER, Destination: BROKER },
      BUYER,
    )
    const offerIndex = (await offerIndexFromTx(bid.txHash))!
    expect((await readNftOffer(offerIndex))?.owner).toBe(ISSUER)
  })
})

describe('brokerSale', () => {
  it('matches a sell and buy offer, moving the NFT to the buyer', async () => {
    const mint = applyTransaction({ TransactionType: 'NFTokenMint' }, ISSUER)
    const nfTokenId = (await nftokenIdFromTx(mint.txHash))!

    const sell = applyTransaction(
      { TransactionType: 'NFTokenCreateOffer', NFTokenID: nfTokenId, Amount: '10000000', Destination: BROKER, Flags: 1 },
      ISSUER,
    )
    const sellOfferIndex = (await offerIndexFromTx(sell.txHash))!

    const buy = applyTransaction(
      { TransactionType: 'NFTokenCreateOffer', NFTokenID: nfTokenId, Amount: '10250000', Owner: ISSUER, Destination: BROKER },
      BUYER,
    )
    const buyOfferIndex = (await offerIndexFromTx(buy.txHash))!

    const result = await brokerSale({ sellOfferIndex, buyOfferIndex, brokerFeeDrops: 250_000n })
    expect(result.succeeded).toBe(true)
    expect(result.result).toBe('tesSUCCESS')
    expect(await holdsNft(BUYER, nfTokenId)).toBe(true)
    // Both offers are consumed by settlement, same as the real ledger.
    expect(await readNftOffer(sellOfferIndex)).toBeNull()
    expect(await readNftOffer(buyOfferIndex)).toBeNull()
  })

  it('fails like a real tecNO_ENTRY when an offer index does not exist', async () => {
    const result = await brokerSale({
      sellOfferIndex: 'MISSING1',
      buyOfferIndex: 'MISSING2',
      brokerFeeDrops: 0n,
    })
    expect(result.succeeded).toBe(false)
    expect(result.result).toBe('tecNO_ENTRY')
  })
})

describe('brokerCancelOffers', () => {
  it('removes every listed offer and reports success', async () => {
    const mint = applyTransaction({ TransactionType: 'NFTokenMint' }, ISSUER)
    const nfTokenId = (await nftokenIdFromTx(mint.txHash))!
    const create = applyTransaction(
      { TransactionType: 'NFTokenCreateOffer', NFTokenID: nfTokenId, Amount: '1', Owner: ISSUER, Destination: BROKER },
      BUYER,
    )
    const offerIndex = (await offerIndexFromTx(create.txHash))!

    const result = await brokerCancelOffers([offerIndex])
    expect(result?.succeeded).toBe(true)
    expect(await readNftOffer(offerIndex)).toBeNull()
  })

  it('returns null for an empty list, matching the real signature', async () => {
    expect(await brokerCancelOffers([])).toBeNull()
  })
})

describe('accountFunding', () => {
  it('reports a flat, generous balance for any address', async () => {
    const funding = await accountFunding('rANYTHING1111111111111111111111')
    expect(funding.spendableDrops).toBeGreaterThan(1_000n * 1_000_000n)
    expect(funding.reserveIncDrops).toBe(200_000n)
  })
})

describe('applyTransaction: DelegateSet', () => {
  const grant = (permissions: string[], organizer = ISSUER, delegate = BROKER) =>
    applyTransaction(
      {
        TransactionType: 'DelegateSet',
        Account: organizer,
        Authorize: delegate,
        Permissions: permissions.map((PermissionValue) => ({ Permission: { PermissionValue } })),
      },
      organizer,
    )

  it('records a grant for exactly the named delegate', async () => {
    const { txHash } = grant(['NFTokenMint'], 'rGRANTORAAAAAAAAAAAAAAAAAAAAAAAAA')
    expect(await txSucceeded(txHash)).toBe(true)
    expect(hasDelegation('rGRANTORAAAAAAAAAAAAAAAAAAAAAAAAA', BROKER, 'NFTokenMint')).toBe(true)
    // Not another delegate, and not another permission.
    expect(hasDelegation('rGRANTORAAAAAAAAAAAAAAAAAAAAAAAAA', BUYER, 'NFTokenMint')).toBe(false)
    expect(hasDelegation('rGRANTORAAAAAAAAAAAAAAAAAAAAAAAAA', BROKER, 'Payment')).toBe(false)
  })

  it('REPLACES the permission set rather than adding to it, like the real ledger', () => {
    const org = 'rGRANTORBBBBBBBBBBBBBBBBBBBBBBBBB'
    grant(['NFTokenMint'], org)
    grant(['NFTokenCreateOffer'], org)
    // Sending only the new permission silently revoked the first.
    expect(hasDelegation(org, BROKER, 'NFTokenCreateOffer')).toBe(true)
    expect(hasDelegation(org, BROKER, 'NFTokenMint')).toBe(false)
  })

  it('treats an empty permission set as revocation', () => {
    const org = 'rGRANTORCCCCCCCCCCCCCCCCCCCCCCCCC'
    grant(['NFTokenMint'], org)
    expect(hasDelegation(org, BROKER, 'NFTokenMint')).toBe(true)
    grant([], org)
    expect(hasDelegation(org, BROKER, 'NFTokenMint')).toBe(false)
  })
})
