/**
 * Privy as the signer for every on-ledger action a ticket holder takes, not only an organizer's. Written before the code.
 *
 * The server half is the same one the organizer flow uses (the server builds and stores the transaction, the wallet
 * signs its hash, the server attaches the signature and submits), so what is new here is WHICH actions are allowed and
 * that each is held to its own shape: a buy must be a buy offer, a listing a sell offer, a withdrawal a cancel.
 *
 * Per action, as asked: allowed; refused when the signer is not the holder; refused when what was signed is not what
 * the server holds (the hash does not match).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.SIGNERS = 'xaman,privy'
  process.env.PRIVY_APP_ID = 'cmprivyact0000000000000000'
})

import request from 'supertest'
import { ECDSA, Wallet, decode } from 'xrpl'
import { makeNftId } from './nft-id.js'

const { prisma } = await import('../src/prisma.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')
const signingMod = await import('../src/signing.js')
const priv = await import('../src/privy-signing.js')
const { PRIVY_FLOW_RULES } = await import('../src/privy-flows.js')
const { buildAcceptOfferTx, buildBuyOfferTx, buildCancelOfferTx, buildGiftOfferTx, buildSellOfferTx } = await import('../src/ledger.js')

const app = createApp()
const P = 'privyact_'
const BROKER = Wallet.generate(ECDSA.secp256k1).classicAddress
const state = { ledger: 1_000, submits: [] as string[] }

beforeEach(() => {
  state.ledger = 1_000
  state.submits = []
  priv.setLedgerPortForTests({
    currentLedger: async () => state.ledger,
    autofill: async (tx) => ({ ...tx, Fee: '12', Sequence: 5, LastLedgerSequence: state.ledger + 20 }),
    submit: async (blob) => {
      state.submits.push(blob)
      return { engineResult: 'tesSUCCESS', hash: `HASH${state.submits.length}`.padEnd(64, '0') }
    },
  })
})

async function cleanup() {
  await prisma.xamanPayload.deleteMany({ where: { user: { username: { startsWith: P } } } })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: P } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: P } } })
}
beforeEach(cleanup)
afterEach(cleanup)
afterAll(async () => {
  priv.setLedgerPortForTests(null)
  await cleanup()
  await prisma.$disconnect()
})

type Person = { id: string; key: Wallet; cookie: string }
async function privyUser(name: string): Promise<Person> {
  const key = Wallet.generate(ECDSA.secp256k1)
  const user = await prisma.user.create({
    data: {
      username: `${P}${name}`,
      xrplAddress: key.classicAddress,
      wallet: { create: { xrplAddress: key.classicAddress, signerKind: 'PRIVY', providerUserId: `did:privy:${P}${name}`, publicKey: key.publicKey } },
    },
  })
  const { token } = await createSession(user.id)
  return { id: user.id, key, cookie: `hubworld_session=${token}` }
}

const ISSUER = Wallet.generate(ECDSA.secp256k1).classicAddress
const NFT = makeNftId(ISSUER, 4242, 1)
const OFFER = 'AB'.repeat(32)
const FRIEND = Wallet.generate(ECDSA.secp256k1).classicAddress

/** The transaction each action builds, with the REAL builders the routes use. */
const BUILD: Record<string, (who: Person) => Record<string, unknown>> = {
  LISTING_CREATE: (w) => buildSellOfferTx({ ownerAddress: w.key.classicAddress, nfTokenId: NFT, amountDrops: 9_500_000n, brokerAddress: BROKER }) as never,
  AUCTION_OPEN: (w) => buildSellOfferTx({ ownerAddress: w.key.classicAddress, nfTokenId: NFT, amountDrops: 19_000_000n, brokerAddress: BROKER }) as never,
  LISTING_BUY: (w) => buildBuyOfferTx({ buyerAddress: w.key.classicAddress, ownerAddress: ISSUER, nfTokenId: NFT, amountDrops: 10_000_000n, brokerAddress: BROKER }) as never,
  AUCTION_BID: (w) => buildBuyOfferTx({ buyerAddress: w.key.classicAddress, ownerAddress: ISSUER, nfTokenId: NFT, amountDrops: 30_000_000n, brokerAddress: BROKER }) as never,
  LISTING_CANCEL: (w) => buildCancelOfferTx({ ownerAddress: w.key.classicAddress, offerIndex: OFFER }) as never,
  GIFT_OFFER: (w) => buildGiftOfferTx({ ownerAddress: w.key.classicAddress, nfTokenId: NFT, destinationAddress: FRIEND }) as never,
  GIFT_ACCEPT: (w) => buildAcceptOfferTx({ accepterAddress: w.key.classicAddress, offerIndex: OFFER }) as never,
  GIFT_CANCEL: (w) => buildCancelOfferTx({ ownerAddress: w.key.classicAddress, offerIndex: OFFER }) as never,
}
const ACTIONS = Object.keys(BUILD) as Array<keyof typeof BUILD & string>

const signWith = (key: Wallet, tx: Record<string, unknown>) => (decode(key.sign(tx as never).tx_blob) as { TxnSignature: string }).TxnSignature
const post = (who: Person, uuid: string, signature: string) => request(app).post(`/api/signatures/${uuid}`).set('Cookie', who.cookie).send({ signature })
const create = (who: Person, flow: string, tx = BUILD[flow]!(who)) => priv.privySigner.createPayload(tx, { flow: flow as never, userId: who.id })

describe('the one list of what Privy may sign', () => {
  it('names exactly the organizer actions, the five holder actions and the three gift actions, and nothing else', () => {
    expect([...signingMod.PRIVY_FLOWS].sort()).toEqual(
      ['AUCTION_BID', 'AUCTION_OPEN', 'DELEGATE_GRANT', 'DELEGATE_REVOKE', 'GIFT_ACCEPT', 'GIFT_CANCEL', 'GIFT_OFFER', 'LISTING_BUY', 'LISTING_CANCEL', 'LISTING_CREATE', 'MINT'].sort(),
    )
  })

  it('is the same list the signer is chosen from (one place, not two that can drift)', () => {
    expect([...signingMod.PRIVY_FLOWS].sort()).toEqual([...PRIVY_FLOW_RULES.keys()].sort())
  })

  it('does not include actions that are not built for it (the door, sign-in)', async () => {
    const who = await privyUser('nodoor')
    for (const flow of ['DOOR_CHECKIN', 'SIGNIN'] as const) {
      await expect(signingMod.signingFor(who.id, flow)).rejects.toThrow(signingMod.SignerNotSupported)
    }
  })
})

describe.each(ACTIONS)('%s', (flow) => {
  it('is chosen for a Privy wallet, and leaves a Xaman user on Xaman', async () => {
    const who = await privyUser(`pick${flow.slice(0, 6)}`)
    expect(await signingMod.signingFor(who.id, flow as never)).toBe(priv.privySigner)
    expect(await signingMod.signingFor(null, flow as never)).toBe(signingMod.signing)
  })

  it('ALLOWED: the server stores its own copy, the holder signs it, and exactly that is submitted', async () => {
    const who = await privyUser(`ok${flow.slice(0, 6)}`)
    const made = await create(who, flow)
    const row = await prisma.xamanPayload.findUniqueOrThrow({ where: { uuid: made.uuid } })
    expect(row).toMatchObject({ signer: 'privy', flow, expectedAccount: who.key.classicAddress })
    expect(made.sign?.tx.LastLedgerSequence).toBe(state.ledger + priv.SIGN_WINDOW_LEDGERS)

    const res = await post(who, made.uuid, signWith(who.key, made.sign!.tx))
    expect(res.status).toBe(202)
    expect(state.submits).toHaveLength(1)
    const sent = decode(state.submits[0]!) as Record<string, unknown>
    expect(sent).toMatchObject({ Account: who.key.classicAddress, TransactionType: PRIVY_FLOW_RULES.get(flow as never)!.types[0] })
  })

  it('REFUSED when the signer is not the holder: a transaction for someone else\'s account is never even built', async () => {
    const holder = await privyUser(`h${flow.slice(0, 6)}`)
    const other = await privyUser(`o${flow.slice(0, 6)}`)
    await expect(create(other, flow, BUILD[flow]!(holder))).rejects.toThrow(/not for your account/)
    expect(await prisma.xamanPayload.count({ where: { userId: other.id } })).toBe(0)
  })

  it('REFUSED when the signature is another wallet\'s: nothing is submitted', async () => {
    const holder = await privyUser(`s${flow.slice(0, 6)}`)
    const thief = Wallet.generate(ECDSA.secp256k1)
    const made = await create(holder, flow)
    const res = await post(holder, made.uuid, signWith(thief, { ...made.sign!.tx, SigningPubKey: thief.publicKey }))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(state.submits).toHaveLength(0)
  })

  it('REFUSED when what was signed is not what the server holds (the hash does not match): nothing is submitted', async () => {
    const holder = await privyUser(`m${flow.slice(0, 6)}`)
    const made = await create(holder, flow)
    // The browser (or anything between) signs a transaction with one field changed.
    const tampered = { ...made.sign!.tx, Fee: '13' }
    const res = await post(holder, made.uuid, signWith(holder.key, tampered))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/does not match/)
    expect(state.submits).toHaveLength(0)
  })

  it('REFUSED when it is another person\'s request: it looks like one that does not exist', async () => {
    const holder = await privyUser(`r${flow.slice(0, 6)}`)
    const other = await privyUser(`q${flow.slice(0, 6)}`)
    const made = await create(holder, flow)
    expect((await post(other, made.uuid, signWith(other.key, made.sign!.tx))).status).toBe(404)
    expect(state.submits).toHaveLength(0)
  })

  it('REFUSED when it is the wrong KIND of transaction for the action', async () => {
    const who = await privyUser(`k${flow.slice(0, 6)}`)
    const payment = { TransactionType: 'Payment', Account: who.key.classicAddress, Destination: BROKER, Amount: '1000000' }
    await expect(create(who, flow, payment)).rejects.toThrow(/not .*(kind|allowed)/i)
  })
})

describe('an action that is not on the list is refused outright', () => {
  it('even with a perfectly good offer: only listed actions can ask a wallet to sign', async () => {
    const who = await privyUser('unlisted')
    for (const flow of ['DOOR_CHECKIN', 'SIGNIN']) {
      await expect(create(who, flow, BUILD.LISTING_CREATE!(who))).rejects.toThrow(/not an action/i)
    }
    expect(await prisma.xamanPayload.count({ where: { userId: who.id } })).toBe(0)
  })
})

describe('each action is held to its own SIDE of an offer', () => {
  it('a withdrawal cancels exactly one listing: none, or several, is refused', async () => {
    const who = await privyUser('cancelcount')
    for (const offers of [[], [OFFER, 'CD'.repeat(32)]]) {
      await expect(create(who, 'LISTING_CANCEL', { ...BUILD.LISTING_CANCEL!(who), NFTokenOffers: offers })).rejects.toThrow(/exactly one listing/i)
    }
  })

  it('a listing or an auction opening must be a SELL offer; a buy offer is refused', async () => {
    const who = await privyUser('side1')
    for (const flow of ['LISTING_CREATE', 'AUCTION_OPEN']) {
      await expect(create(who, flow, BUILD.LISTING_BUY!(who))).rejects.toThrow(/sell offer/i)
    }
  })

  it('a purchase or a bid must be a BUY offer; a sell offer is refused (it would give the ticket away for the amount)', async () => {
    const who = await privyUser('side2')
    for (const flow of ['LISTING_BUY', 'AUCTION_BID']) {
      await expect(create(who, flow, BUILD.LISTING_CREATE!(who))).rejects.toThrow(/buy offer/i)
    }
  })

  it('a withdrawal is a cancel, never an offer', async () => {
    const who = await privyUser('side3')
    await expect(create(who, 'LISTING_CANCEL', BUILD.LISTING_CREATE!(who))).rejects.toThrow(/not .*(kind|allowed)/i)
  })

  it('a free transfer is refused wherever it is attempted: a sell offer for zero is a gift, not a listing', async () => {
    const who = await privyUser('side4')
    const free = { ...BUILD.LISTING_CREATE!(who), Amount: '0' }
    await expect(create(who, 'LISTING_CREATE', free)).rejects.toThrow(/amount/i)
    await expect(create(who, 'AUCTION_OPEN', free)).rejects.toThrow(/amount/i)
  })

  it('every offer must name the broker as its only taker: an open offer (no Destination) is refused', async () => {
    const who = await privyUser('side5')
    for (const flow of ['LISTING_CREATE', 'AUCTION_OPEN', 'LISTING_BUY', 'AUCTION_BID']) {
      const open = { ...BUILD[flow]!(who) }
      delete open.Destination
      await expect(create(who, flow, open)).rejects.toThrow(/broker|destination/i)
    }
  })
})

describe('gifts are held to their own shape', () => {
  it('a gift is FREE: an offer for any money is refused (that would be a sale with nobody to collect the fee)', async () => {
    const who = await privyUser('giftfree')
    await expect(create(who, 'GIFT_OFFER', { ...BUILD.GIFT_OFFER!(who), Amount: '1' })).rejects.toThrow(/free/i)
    await expect(create(who, 'GIFT_OFFER', { ...BUILD.GIFT_OFFER!(who), Amount: '25000000' })).rejects.toThrow(/free/i)
  })

  it('a gift names one person: an open offer (anyone could take it) is refused', async () => {
    const who = await privyUser('giftopen')
    const open = { ...BUILD.GIFT_OFFER!(who) }
    delete open.Destination
    await expect(create(who, 'GIFT_OFFER', open)).rejects.toThrow(/person|destination/i)
  })

  it('a gift to oneself is refused', async () => {
    const who = await privyUser('giftself')
    await expect(create(who, 'GIFT_OFFER', { ...BUILD.GIFT_OFFER!(who), Destination: who.key.classicAddress })).rejects.toThrow(/yourself/i)
  })

  it('a gift must be a sell offer: a "gift" that is a buy offer is refused', async () => {
    const who = await privyUser('giftside')
    await expect(create(who, 'GIFT_OFFER', { ...BUILD.GIFT_OFFER!(who), Flags: 0 })).rejects.toThrow(/sell offer/i)
  })

  it('accepting a gift takes exactly one SELL offer; a buy offer or a brokered accept is refused', async () => {
    const who = await privyUser('giftaccept')
    await expect(create(who, 'GIFT_ACCEPT', { ...BUILD.GIFT_ACCEPT!(who), NFTokenBuyOffer: OFFER })).rejects.toThrow(/gift/i)
    await expect(create(who, 'GIFT_ACCEPT', { ...BUILD.GIFT_ACCEPT!(who), NFTokenBrokerFee: '1' })).rejects.toThrow(/gift/i)
    const none = { ...BUILD.GIFT_ACCEPT!(who) }
    delete none.NFTokenSellOffer
    await expect(create(who, 'GIFT_ACCEPT', none)).rejects.toThrow(/gift/i)
  })

  it('taking a gift back cancels exactly one offer', async () => {
    const who = await privyUser('giftcancel')
    await expect(create(who, 'GIFT_CANCEL', { ...BUILD.GIFT_CANCEL!(who), NFTokenOffers: [OFFER, 'CD'.repeat(32)] })).rejects.toThrow(/exactly one/i)
  })

})
