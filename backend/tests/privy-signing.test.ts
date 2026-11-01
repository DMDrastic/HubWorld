/**
 * Signing with a wallet the person owns: the server keeps the transaction, the browser returns
 * only a signature, and the server decides whether to submit.
 *
 * The ledger is the only thing faked (a port that records what would be submitted). The wallet is
 * a real key that signs for real, so "does this signature verify against the server's copy" is
 * answered by the real cryptography, not by a mock agreeing with itself.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.SIGNERS = 'xaman,privy'
  process.env.PRIVY_APP_ID = 'cmprivysign000000000000000'
})

import request from 'supertest'
import { ECDSA, Wallet, decode } from 'xrpl'

const { prisma } = await import('../src/prisma.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')
const signingMod = await import('../src/signing.js')
const priv = await import('../src/privy-signing.js')
const { buildDelegateSetTx } = await import('../src/delegation.js')
const { resolvePayload, reconcileStalePayloads } = await import('../src/payload-store.js')

const { signingFor, SignerNotSupported } = signingMod
const app = createApp()
const P = 'privysign_'
const DELEGATE = Wallet.generate(ECDSA.secp256k1).classicAddress

// ------------------------------------------------------------ fake ledger --

const state = {
  ledger: 1_000,
  submits: [] as string[],
  result: 'tesSUCCESS',
  throwOnSubmit: false,
  /** When set, a submit waits here: lets a test hold one submission mid-flight. */
  gate: null as Promise<void> | null,
  entered: 0,
}
beforeEach(() => {
  state.ledger = 1_000
  state.submits = []
  state.result = 'tesSUCCESS'
  state.throwOnSubmit = false
  state.gate = null
  state.entered = 0
  priv.setLedgerPortForTests({
    currentLedger: async () => state.ledger,
    autofill: async (tx) => ({ ...tx, Fee: '12', Sequence: 5, LastLedgerSequence: state.ledger + 20 }),
    submit: async (blob) => {
      state.entered += 1
      if (state.gate) await state.gate
      if (state.throwOnSubmit) throw new Error('node down')
      state.submits.push(blob)
      return { engineResult: state.result, hash: `HASH${state.submits.length}`.padEnd(64, '0') }
    },
  })
})

// ---------------------------------------------------------------- helpers --

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
async function privyUser(name: string, over: { keyOnFile?: string } = {}): Promise<Person> {
  const key = Wallet.generate(ECDSA.secp256k1)
  const user = await prisma.user.create({
    data: {
      username: `${P}${name}`,
      xrplAddress: key.classicAddress,
      role: 'ORGANIZER',
      wallet: {
        create: {
          xrplAddress: key.classicAddress,
          signerKind: 'PRIVY',
          providerUserId: `did:privy:${P}${name}`,
          publicKey: over.keyOnFile ?? key.publicKey,
        },
      },
    },
  })
  const { token } = await createSession(user.id)
  return { id: user.id, key, cookie: `hubworld_session=${token}` }
}

const grantTx = (who: Person) =>
  buildDelegateSetTx({ organizerAddress: who.key.classicAddress, delegateAddress: DELEGATE }, ['NFTokenMint', 'NFTokenCreateOffer']) as unknown as Record<string, unknown>

async function start(who: Person) {
  const made = await priv.privySigner.createPayload(grantTx(who), { flow: 'DELEGATE_GRANT', userId: who.id })
  return made
}

/** What a wallet returns when asked to sign `tx`: a signature over the server's transaction. */
function signWith(key: Wallet, tx: Record<string, unknown>): string {
  const blob = key.sign(tx as never).tx_blob
  return (decode(blob) as { TxnSignature: string }).TxnSignature
}

const post = (who: Person | null, uuid: string, signature: string, extra: object = {}) => {
  const r = request(app).post(`/api/signatures/${uuid}`)
  return (who ? r.set('Cookie', who.cookie) : r).send({ signature, ...extra })
}

// ------------------------------------------------------------------ tests --

describe('starting a request', () => {
  it('stores the server\'s own copy with a bounded deadline, and hands back its hash', async () => {
    const who = await privyUser('a')
    const made = await start(who)
    const row = await prisma.xamanPayload.findUniqueOrThrow({ where: { uuid: made.uuid } })
    const tx = row.unsignedTx as Record<string, unknown>
    expect(row).toMatchObject({ signer: 'privy', flow: 'DELEGATE_GRANT', expectedAccount: who.key.classicAddress, signed: false })
    expect(tx.LastLedgerSequence).toBe(state.ledger + priv.SIGN_WINDOW_LEDGERS)
    expect(tx.SigningPubKey).toBe(who.key.publicKey)
    expect(made.sign?.hash).toBe(priv.signingHash(tx))
    expect(made.next).toBe('')
  })

  it('refuses to build a transaction for some other account', async () => {
    const who = await privyUser('b')
    const other = Wallet.generate(ECDSA.secp256k1)
    await expect(
      priv.privySigner.createPayload(
        buildDelegateSetTx({ organizerAddress: other.classicAddress, delegateAddress: DELEGATE }, ['NFTokenMint']) as never,
        { flow: 'DELEGATE_GRANT', userId: who.id },
      ),
    ).rejects.toThrow(/not for your account/)
  })

  it('refuses a transaction that already carries a signature or a delegate', async () => {
    const who = await privyUser('c')
    for (const bad of ['TxnSignature', 'Delegate', 'Signers']) {
      await expect(
        priv.privySigner.createPayload({ ...grantTx(who), [bad]: 'x' }, { flow: 'DELEGATE_GRANT', userId: who.id }),
      ).rejects.toThrow(/cannot already contain/)
    }
  })
})

describe('submitting a signature', () => {
  it('submits the server\'s copy with the signature attached, once, and reports it signed', async () => {
    const who = await privyUser('d')
    const made = await start(who)
    const res = await post(who, made.uuid, signWith(who.key, made.sign!.tx))
    expect(res.status).toBe(202)
    expect(res.body.replay).toBe(false)
    expect(state.submits).toHaveLength(1)
    const sent = decode(state.submits[0]!) as Record<string, unknown>
    expect(sent).toMatchObject({ Account: who.key.classicAddress, TransactionType: 'DelegateSet', LastLedgerSequence: made.sign!.tx.LastLedgerSequence })

    const status = await resolvePayload(made.uuid)
    expect(status).toMatchObject({ signed: true, expired: false, account: who.key.classicAddress, txid: res.body.txid })
  })

  it('accepts a compact r||s signature too, and folds it to the canonical form', async () => {
    const who = await privyUser('e')
    const made = await start(who)
    const der = signWith(who.key, made.sign!.tx)
    // Compact form of the same signature, as Privy's raw signing returns it.
    const b = Buffer.from(der, 'hex')
    const rl = b[3]!
    const r = b.subarray(4, 4 + rl).toString('hex').replace(/^00/, '').padStart(64, '0')
    const sl = b[5 + rl]!
    const s = b.subarray(6 + rl, 6 + rl + sl).toString('hex').replace(/^00/, '').padStart(64, '0')
    expect(priv.toCanonicalDer(`0x${r}${s}`)).toBe(der.toUpperCase())
    expect((await post(who, made.uuid, `${r}${s}`)).status).toBe(202)
  })

  it('submits nothing the second time, and says what the first did', async () => {
    const who = await privyUser('f')
    const made = await start(who)
    const sig = signWith(who.key, made.sign!.tx)
    const first = await post(who, made.uuid, sig)
    const second = await post(who, made.uuid, sig)
    expect(second.status).toBe(200)
    expect(second.body).toEqual({ txid: first.body.txid, replay: true })
    expect(state.submits).toHaveLength(1)
  })

  it('submits once when the same signature arrives twice at the same moment', async () => {
    const who = await privyUser('g')
    const made = await start(who)
    const sig = signWith(who.key, made.sign!.tx)
    // Called directly, not over HTTP, so both calls read "not yet submitted" before either claims:
    // only the atomic claim stands between them and two submissions.
    const [a, b] = await Promise.all([
      priv.submitSignature(made.uuid, who.id, sig),
      priv.submitSignature(made.uuid, who.id, sig),
    ])
    expect(state.submits).toHaveLength(1)
    expect([a.ok, b.ok]).toContain(true)
  })

  it('lets a second signature through to nothing while the first is still being submitted', async () => {
    const who = await privyUser('g2')
    const made = await start(who)
    const sig = signWith(who.key, made.sign!.tx)
    let release!: () => void
    state.gate = new Promise<void>((r) => (release = r))

    // supertest requests are lazy: nothing is sent until something awaits them.
    const first = post(who, made.uuid, sig).then((r) => r)
    while (state.entered === 0) await new Promise((r) => setTimeout(r, 5)) // first is now mid-submit
    const second = await Promise.race([
      post(who, made.uuid, sig).then((r) => r.status),
      new Promise<string>((r) => setTimeout(() => r('hung: the second request reached the ledger'), 600)),
    ])
    release()
    expect(second).toBe(409)
    expect((await first).status).toBe(202)
    expect(state.submits).toHaveLength(1)
  })

  it('folds a high-S signature to the canonical one before it reaches the ledger', async () => {
    const who = await privyUser('g3')
    const made = await start(who)
    const der = signWith(who.key, made.sign!.tx)
    const b = Buffer.from(der, 'hex')
    const rl = b[3]!
    const sl = b[5 + rl]!
    const r = BigInt('0x' + b.subarray(4, 4 + rl).toString('hex'))
    const s = BigInt('0x' + b.subarray(6 + rl, 6 + rl + sl).toString('hex'))
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
    const highS = (N - s).toString(16).padStart(64, '0')
    const compactHigh = r.toString(16).padStart(64, '0') + highS
    expect((await post(who, made.uuid, compactHigh)).status).toBe(202)
    // What was submitted carries the LOW-S form, identical to the wallet's own canonical signature.
    expect((decode(state.submits[0]!) as { TxnSignature: string }).TxnSignature).toBe(der.toUpperCase())
  })

  it('ignores any transaction the browser sends along with the signature', async () => {
    const who = await privyUser('h')
    const made = await start(who)
    const evil = { ...made.sign!.tx, Authorize: Wallet.generate(ECDSA.secp256k1).classicAddress }
    const res = await post(who, made.uuid, signWith(who.key, made.sign!.tx), { tx: evil, transaction: evil })
    expect(res.status).toBe(202)
    expect((decode(state.submits[0]!) as Record<string, unknown>).Authorize).toBe(DELEGATE)
  })
})

describe('refusing to submit', () => {
  it('refuses a signature over a different transaction (a changed delegate account)', async () => {
    const who = await privyUser('i')
    const made = await start(who)
    const tampered = { ...made.sign!.tx, Authorize: Wallet.generate(ECDSA.secp256k1).classicAddress }
    const res = await post(who, made.uuid, signWith(who.key, tampered))
    expect(res.status).toBe(400)
    expect(state.submits).toHaveLength(0)
  })

  it('refuses a signature made by a key that is not the wallet\'s', async () => {
    const who = await privyUser('j')
    const made = await start(who)
    const res = await post(who, made.uuid, signWith(Wallet.generate(ECDSA.secp256k1), made.sign!.tx))
    expect(res.status).toBe(400)
    expect(state.submits).toHaveLength(0)
  })

  it('refuses when the wallet\'s key on file is no longer the key in the request', async () => {
    const who = await privyUser('k')
    const made = await start(who)
    await prisma.wallet.update({ where: { userId: who.id }, data: { publicKey: Wallet.generate(ECDSA.secp256k1).publicKey } })
    const res = await post(who, made.uuid, signWith(who.key, made.sign!.tx))
    expect(res.status).toBe(403)
    expect(state.submits).toHaveLength(0)
  })


  it('refuses if the wallet on file now has a different address than the request was for', async () => {
    const who = await privyUser('k2')
    const made = await start(who)
    await prisma.wallet.update({ where: { userId: who.id }, data: { xrplAddress: Wallet.generate(ECDSA.secp256k1).classicAddress } })
    expect((await post(who, made.uuid, signWith(who.key, made.sign!.tx))).status).toBe(403)
    expect(state.submits).toHaveLength(0)
  })

  it('refuses if the request is recorded as for a different account than the wallet', async () => {
    const who = await privyUser('k3')
    const made = await start(who)
    await prisma.xamanPayload.update({ where: { uuid: made.uuid }, data: { expectedAccount: Wallet.generate(ECDSA.secp256k1).classicAddress } })
    expect((await post(who, made.uuid, signWith(who.key, made.sign!.tx))).status).toBe(403)
    expect(state.submits).toHaveLength(0)
  })

  it('refuses a key that is on file and in the request but is not the account\'s own key', async () => {
    const who = await privyUser('k4')
    const made = await start(who)
    // Corrupt BOTH records to the same stranger key and sign with it: it verifies perfectly, so
    // only "does this key derive to the account the transaction is from" stands in the way.
    const stranger = Wallet.generate(ECDSA.secp256k1)
    const row = await prisma.xamanPayload.findUniqueOrThrow({ where: { uuid: made.uuid } })
    const swapped = { ...(row.unsignedTx as Record<string, unknown>), SigningPubKey: stranger.publicKey }
    await prisma.xamanPayload.update({ where: { uuid: made.uuid }, data: { unsignedTx: swapped as never } })
    await prisma.wallet.update({ where: { userId: who.id }, data: { publicKey: stranger.publicKey } })
    expect((await post(who, made.uuid, signWith(stranger, swapped))).status).toBe(403)
    expect(state.submits).toHaveLength(0)
  })


  it('refuses when the wallet is no longer a Privy wallet', async () => {
    const who = await privyUser('k5')
    const made = await start(who)
    await prisma.wallet.update({ where: { userId: who.id }, data: { signerKind: 'XAMAN', providerUserId: null } })
    expect((await post(who, made.uuid, signWith(who.key, made.sign!.tx))).status).toBe(403)
    expect(state.submits).toHaveLength(0)
  })

  it('treats someone else\'s request as nonexistent, and requires a login', async () => {
    const a = await privyUser('l1')
    const b = await privyUser('l2')
    const made = await start(a)
    const sig = signWith(a.key, made.sign!.tx)
    expect((await post(b, made.uuid, sig)).status).toBe(404)
    expect((await post(null, made.uuid, sig)).status).toBe(401)
    expect(state.submits).toHaveLength(0)
  })

  it('refuses once the request has timed out', async () => {
    const who = await privyUser('m')
    const made = await start(who)
    await prisma.xamanPayload.update({ where: { uuid: made.uuid }, data: { expiresAt: new Date(Date.now() - 1_000) } })
    expect((await post(who, made.uuid, signWith(who.key, made.sign!.tx))).status).toBe(410)
    expect(state.submits).toHaveLength(0)
    expect((await resolvePayload(made.uuid))).toMatchObject({ signed: false, expired: true })
  })

  it('refuses once the ledger has moved past the deadline, so a stale approval never goes out', async () => {
    const who = await privyUser('n')
    const made = await start(who)
    state.ledger += priv.SIGN_WINDOW_LEDGERS + 1
    expect((await post(who, made.uuid, signWith(who.key, made.sign!.tx))).status).toBe(410)
    expect(state.submits).toHaveLength(0)
  })

  it('refuses a stored transaction that has no deadline at all', async () => {
    const who = await privyUser('o')
    const made = await start(who)
    const row = await prisma.xamanPayload.findUniqueOrThrow({ where: { uuid: made.uuid } })
    const { LastLedgerSequence: _drop, ...without } = row.unsignedTx as Record<string, unknown>
    await prisma.xamanPayload.update({ where: { uuid: made.uuid }, data: { unsignedTx: without as never } })
    expect((await post(who, made.uuid, signWith(who.key, without))).status).toBe(409)
    expect(state.submits).toHaveLength(0)
  })

  it('records a refusal by the ledger, and does not call the request signed', async () => {
    const who = await privyUser('p')
    const made = await start(who)
    state.result = 'tefPAST_SEQ'
    const sig = signWith(who.key, made.sign!.tx)
    const res = await post(who, made.uuid, sig)
    expect(res.status).toBe(422)
    expect((await resolvePayload(made.uuid))).toMatchObject({ signed: false })
    // And it is not resubmittable: the answer is the same, not a second attempt.
    expect((await post(who, made.uuid, sig)).status).toBe(409)
    expect(state.submits).toHaveLength(1)
  })

  it('lets the person retry when the ledger could not be reached', async () => {
    const who = await privyUser('q')
    const made = await start(who)
    const sig = signWith(who.key, made.sign!.tx)
    state.throwOnSubmit = true
    expect((await post(who, made.uuid, sig)).status).toBe(503)
    state.throwOnSubmit = false
    expect((await post(who, made.uuid, sig)).status).toBe(202)
    expect(state.submits).toHaveLength(1)
  })
})

describe('choosing the signer', () => {
  it('sends a Privy organizer\'s grant, revoke and mint to Privy', async () => {
    const who = await privyUser('r')
    for (const flow of ['DELEGATE_GRANT', 'DELEGATE_REVOKE', 'MINT'] as const) {
      expect(await signingFor(who.id, flow)).toBe(priv.privySigner)
    }
  })

  it('refuses, in words, what a Privy user cannot do yet, rather than asking Xaman', async () => {
    const who = await privyUser('s')
    // Listing, buying and bidding are built now (see privy-actions.test.ts); gifts are not.
    for (const flow of ['GIFT_OFFER', 'GIFT_ACCEPT', 'GIFT_CANCEL'] as const) {
      await expect(signingFor(who.id, flow)).rejects.toBeInstanceOf(SignerNotSupported)
    }
  })

  it('leaves everyone else on Xaman, exactly as before', async () => {
    const xamanUser = await prisma.user.create({ data: { username: `${P}x`, xrplAddress: Wallet.generate(ECDSA.secp256k1).classicAddress } })
    expect(await signingFor(xamanUser.id, 'MINT')).not.toBe(priv.privySigner)
    expect(await signingFor(null, 'SIGNIN')).not.toBe(priv.privySigner)
    expect(await signingFor('00000000-0000-4000-8000-00000000dead', 'MINT')).not.toBe(priv.privySigner)
  })
})

describe('the rest of the system', () => {
  it('never asks Xaman about a Privy request', async () => {
    const who = await privyUser('t')
    const made = await start(who)
    await prisma.xamanPayload.update({ where: { uuid: made.uuid }, data: { fetchedAt: new Date(Date.now() - 3_600_000) } })
    const before = await prisma.xamanPayload.findUniqueOrThrow({ where: { uuid: made.uuid } })
    await reconcileStalePayloads(0, 100)
    const after = await prisma.xamanPayload.findUniqueOrThrow({ where: { uuid: made.uuid } })
    // Reconciliation leaves it alone (a refresh would have rewritten fetchedAt and its source).
    expect(after.fetchedAt.getTime()).toBe(before.fetchedAt.getTime())
    expect(after.source).toBe('create')
  })
})
