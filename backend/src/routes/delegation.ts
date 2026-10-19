/**
 * Granting and revoking delegated minting.
 *
 * An organizer authorises Hubworld's DELEGATE account to submit `NFTokenMint`
 * as them, and nothing else. They sign that once in Xaman instead of once per
 * ticket. Hubworld never signs the grant — it is the organizer's account that
 * is granting — so this has the same two-step shape as minting:
 *
 *   POST /api/delegation/grant   → build DelegateSet, create payload, return QR
 *   POST /api/delegation/revoke  → the inverse, equally easy
 *   GET  /api/delegation/:uuid   → poll until the LEDGER agrees
 *   GET  /api/delegation/me      → where things stand right now
 *
 * The ledger is the authority throughout, not the `Delegation` row. A signature
 * is not a grant (it still has to validate), and an organizer can revoke in
 * Xaman without ever telling us — so "granted" is only ever reported after a
 * read of the organizer's `Delegate` object, and anything that ACTS on the
 * permission must read it again.
 */
import { Router, type Response } from 'express'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { NETWORK } from '../network.js'
import { xamanMode } from '../env.js'
import { currentDelegate } from '../delegate-account.js'
import { tryGetPayload, xaman, SIGNIN_TTL_MINUTES } from '../xaman.js'
import { issuesOf } from '../schemas.js'
import { requireAuth, requireOrganizer } from '../session.js'
import { txSucceeded, XAMAN_NETWORK } from '../ledger.js'
import {
  buildDelegateMintTx,
  buildRevokeMintTx,
  delegationAvailable,
  readPermission,
  MINT_PERMISSION,
} from '../delegation.js'
import { signedByOtherAccount } from '../signer.js'

export const delegationRouter = Router()

const TTL_MS = SIGNIN_TTL_MINUTES * 60 * 1000
const UuidParams = z.object({ uuid: z.string().uuid() })

async function organizerOf(userId: string) {
  return prisma.user.findUnique({ where: { id: userId } })
}

/**
 * Common refusals for creating a grant payload. Returns the delegate to
 * authorise, or null after having already answered the request.
 */
async function refuseUnavailable(res: Response): Promise<string | null> {
  const delegate = currentDelegate()
  if (!delegate) {
    res.status(503).json({ error: 'Delegated minting is not configured on this server' })
    return null
  }
  if (!(await delegationAvailable())) {
    res.status(503).json({ error: 'Delegated minting is not available on this network yet' })
    return null
  }
  return delegate
}

/**
 * POST /api/delegation/grant
 * Organizer-only. Returns a Xaman payload for the organizer to sign.
 */
delegationRouter.post('/delegation/grant', requireAuth, requireOrganizer, async (req, res) => {
  const delegate = await refuseUnavailable(res)
  if (!delegate) return

  const organizer = await organizerOf(req.userId!)
  if (!organizer) {
    res.status(401).json({ error: 'Not signed in' })
    return
  }
  const pair = { organizerAddress: organizer.xrplAddress, delegateAddress: delegate }

  // Already granted: say so rather than spending a payload on a no-op. The
  // quota counts creations and cannot be reclaimed.
  if ((await readPermission(pair, MINT_PERMISSION)) === 'granted') {
    res.json({ state: 'granted' })
    return
  }

  const txjson = buildDelegateMintTx(pair)
  const payload = await xaman.createPayload(txjson as unknown as Record<string, unknown>, {
    flow: 'DELEGATE_GRANT',
    userId: organizer.id,
    expireMinutes: SIGNIN_TTL_MINUTES,
    // A wallet set to mainnet must not sign a testnet-intended grant against a
    // real account.
    forceNetwork: XAMAN_NETWORK,
  })

  const expiresAt = new Date(Date.now() + TTL_MS)
  await prisma.delegation.create({
    data: {
      network: NETWORK,
      organizerId: organizer.id,
      organizerAddress: organizer.xrplAddress,
      // Frozen: see the column comment.
      delegateAddress: delegate,
      kind: 'GRANT',
      payloadUuid: payload.uuid,
      expiresAt,
    },
  })

  res.status(201).json({
    uuid: payload.uuid,
    next: payload.next,
    qrPng: payload.qrPng,
    expiresAt: expiresAt.toISOString(),
    mode: xamanMode,
  })
})

/**
 * POST /api/delegation/revoke
 * Organizer-only. Revocation is one transaction and takes effect on the next
 * ledger — it must stay as easy as granting, or "revocable" is a claim rather
 * than a property.
 */
delegationRouter.post('/delegation/revoke', requireAuth, requireOrganizer, async (req, res) => {
  const organizer = await organizerOf(req.userId!)
  if (!organizer) {
    res.status(401).json({ error: 'Not signed in' })
    return
  }

  // Revoke the delegate the grant NAMED, not whichever is configured now. After
  // a key rotation the old grant still names the old account, and revoking the
  // new one would leave it in force.
  const lastGrant = await prisma.delegation.findFirst({
    where: { organizerId: organizer.id, network: NETWORK, kind: 'GRANT', status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
  })
  const delegate = lastGrant?.delegateAddress ?? currentDelegate()
  if (!delegate) {
    res.status(503).json({ error: 'Delegated minting is not configured on this server' })
    return
  }
  const pair = { organizerAddress: organizer.xrplAddress, delegateAddress: delegate }

  if ((await readPermission(pair, MINT_PERMISSION)) === 'absent') {
    res.json({ state: 'revoked' })
    return
  }

  const txjson = buildRevokeMintTx(pair)
  const payload = await xaman.createPayload(txjson as unknown as Record<string, unknown>, {
    flow: 'DELEGATE_REVOKE',
    userId: organizer.id,
    expireMinutes: SIGNIN_TTL_MINUTES,
    forceNetwork: XAMAN_NETWORK,
  })

  const expiresAt = new Date(Date.now() + TTL_MS)
  await prisma.delegation.create({
    data: {
      network: NETWORK,
      organizerId: organizer.id,
      organizerAddress: organizer.xrplAddress,
      delegateAddress: delegate,
      kind: 'REVOKE',
      payloadUuid: payload.uuid,
      expiresAt,
    },
  })

  res.status(201).json({
    uuid: payload.uuid,
    next: payload.next,
    qrPng: payload.qrPng,
    expiresAt: expiresAt.toISOString(),
    mode: xamanMode,
  })
})

/**
 * GET /api/delegation/me
 *
 * `state` is read from the ledger on every call. `unknown` means the ledger
 * could not be read — it is NOT "revoked", and must not be rendered as such: an
 * organizer would be told their grant vanished every time a public node blinked.
 */
delegationRouter.get('/delegation/me', requireAuth, requireOrganizer, async (req, res) => {
  const organizer = await organizerOf(req.userId!)
  if (!organizer) {
    res.status(401).json({ error: 'Not signed in' })
    return
  }

  const delegate = currentDelegate()
  const available = delegate ? await delegationAvailable() : false
  if (!delegate || !available) {
    res.json({ available: false, state: 'unavailable' })
    return
  }

  const state = await readPermission(
    { organizerAddress: organizer.xrplAddress, delegateAddress: delegate },
    MINT_PERMISSION,
  )

  // A grant that names an OLD delegate keeps working for that account only. Say
  // so, because the organizer is then "granted" in our table and not in effect.
  const lastGrant = await prisma.delegation.findFirst({
    where: { organizerId: organizer.id, network: NETWORK, kind: 'GRANT', status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
  })

  res.json({
    available: true,
    state: state === 'granted' ? 'granted' : state === 'absent' ? 'not_granted' : 'unknown',
    delegateAddress: delegate,
    // Only meaningful while it is in force; after a revoke it would read as if
    // access were still held.
    grantedAt: state === 'granted' ? (lastGrant?.resolvedAt?.toISOString() ?? null) : null,
    staleGrant: Boolean(lastGrant && lastGrant.delegateAddress !== delegate),
  })
})

/**
 * GET /api/delegation/:uuid
 *
 * Poll target for both grant and revoke. States:
 *   pending  — not yet signed, or signed but the ledger does not agree yet
 *   granted / revoked — the ledger confirms it
 *   rejected / expired / failed
 */
delegationRouter.get('/delegation/:uuid', requireAuth, async (req, res) => {
  const parsed = UuidParams.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid payload id', details: issuesOf(parsed.error) })
    return
  }

  const row = await prisma.delegation.findUnique({
    where: { payloadUuid: parsed.data.uuid },
    include: { organizer: true },
  })
  if (!row) {
    res.status(404).json({ error: 'Unknown delegation request' })
    return
  }
  if (row.organizerId !== req.userId) {
    res.status(403).json({ error: 'Not your delegation request' })
    return
  }

  // Terminal states short-circuit — no need to ask Xaman or the ledger again.
  if (row.status === 'ACTIVE') {
    res.json({ state: 'granted' })
    return
  }
  if (row.status === 'REVOKED') {
    res.json({ state: 'revoked' })
    return
  }
  if (row.status === 'REJECTED') {
    res.json({ state: 'rejected' })
    return
  }
  if (row.status === 'FAILED') {
    res.json({ state: 'failed', reason: row.failureReason ?? 'The ledger rejected the request' })
    return
  }

  const status = await tryGetPayload(parsed.data.uuid)
  if (status === 'unavailable') {
    res.json({ state: 'pending' })
    return
  }

  // Xaman first, our clock second: deciding "expired" locally throws away
  // signatures that landed inside the window.
  if (!status || (!status.signed && !status.cancelled)) {
    if ((status?.expired ?? false) || row.expiresAt < new Date()) {
      if (row.status !== 'EXPIRED') {
        await prisma.delegation.update({ where: { id: row.id }, data: { status: 'EXPIRED' } })
      }
      res.json({ state: 'expired' })
      return
    }
    res.json({ state: 'pending' })
    return
  }

  if (status.cancelled) {
    await prisma.delegation.update({
      where: { id: row.id },
      data: { status: 'REJECTED', resolvedAt: new Date() },
    })
    res.json({ state: 'rejected' })
    return
  }

  // Signed by WHOM. A grant signed by some other account would authorise our
  // delegate on THAT account while our row claimed it was the organizer's.
  if (signedByOtherAccount(row.organizerAddress, status.account)) {
    const reason = 'Signed by a different account than the organizer'
    await prisma.delegation.update({
      where: { id: row.id },
      data: { status: 'FAILED', txHash: status.txid ?? null, failureReason: reason, resolvedAt: new Date() },
    })
    res.json({ state: 'failed', reason })
    return
  }

  if (!status.txid) {
    await prisma.delegation.update({ where: { id: row.id }, data: { status: 'SIGNED' } })
    res.json({ state: 'pending', signed: true })
    return
  }

  // A signature is not a grant: the transaction has to validate first.
  const applied = await txSucceeded(status.txid)
  if (applied === false) {
    const reason = 'The ledger rejected the transaction'
    await prisma.delegation.update({
      where: { id: row.id },
      data: { status: 'FAILED', txHash: status.txid, failureReason: reason, resolvedAt: new Date() },
    })
    res.json({ state: 'failed', reason })
    return
  }
  if (applied === null) {
    await prisma.delegation.update({
      where: { id: row.id },
      data: { status: 'SIGNED', txHash: status.txid },
    })
    res.json({ state: 'pending', signed: true })
    return
  }

  // Validated. Confirm against the Delegate object itself before saying so —
  // the row is a cache, and this is the one place it is allowed to be written.
  const now = await readPermission(
    { organizerAddress: row.organizerAddress, delegateAddress: row.delegateAddress },
    MINT_PERMISSION,
  )
  const wanted = row.kind === 'GRANT' ? 'granted' : 'absent'
  if (now !== wanted) {
    // 'unknown' is a transport problem and a mismatch is most likely a read that
    // is a ledger behind. Neither is evidence the request failed, so stay pending
    // rather than writing a failure that would hide a good signature.
    await prisma.delegation.update({
      where: { id: row.id },
      data: { status: 'SIGNED', txHash: status.txid },
    })
    res.json({ state: 'pending', signed: true })
    return
  }

  await prisma.delegation.update({
    where: { id: row.id },
    data: {
      status: row.kind === 'GRANT' ? 'ACTIVE' : 'REVOKED',
      txHash: status.txid,
      resolvedAt: new Date(),
    },
  })
  res.json({ state: row.kind === 'GRANT' ? 'granted' : 'revoked' })
})
