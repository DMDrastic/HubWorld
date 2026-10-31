/**
 * Granting and revoking what Hubworld's delegate account may do as an organizer.
 *
 * Two permissions exist, each its own consent:
 *
 *   mint   — `NFTokenMint`. Lets Hubworld mint the event's tickets unattended.
 *   offers — `NFTokenCreateOffer`. Lets Hubworld put ONE ticket up for sale at
 *            checkout (the lazy primary sale). Far more dangerous: it can list
 *            the organizer's existing tickets, so it is never bundled with mint.
 *
 * The organizer signs a `DelegateSet` in Xaman — Hubworld cannot, since it is the
 * organizer's account that grants — so this has the same two-step shape as
 * minting:
 *
 *   POST /api/delegation/grant   → build DelegateSet, create payload, return QR
 *   POST /api/delegation/revoke  → the inverse, equally easy
 *   GET  /api/delegation/:uuid   → poll until the LEDGER agrees
 *   GET  /api/delegation/me      → where things stand right now
 *
 * **`DelegateSet` REPLACES the whole permission set.** Granting `offers` by
 * sending only that would silently revoke `mint`, and a revoke of one permission
 * by sending an empty set would revoke both. So every request is built from the
 * set the ledger currently holds, and an unreadable ledger refuses rather than
 * guessing.
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
import { tryGetPayload, signing, SIGNIN_TTL_MINUTES, signingFor } from '../signing.js'
import { issuesOf } from '../schemas.js'
import { requireAuth, requireOrganizer } from '../session.js'
import { txSucceeded, XAMAN_NETWORK } from '../ledger.js'
import {
  buildDelegateSetTx,
  delegationAvailable,
  readPermissionSet,
  permissionsAfterGrant,
  permissionsAfterRevoke,
  samePermissions,
  MINT_PERMISSION,
  OFFER_PERMISSION,
} from '../delegation.js'
import { signedByOtherAccount } from '../signer.js'

export const delegationRouter = Router()

const TTL_MS = SIGNIN_TTL_MINUTES * 60 * 1000
const UuidParams = z.object({ uuid: z.string().uuid() })

const SCOPE = { mint: MINT_PERMISSION, offers: OFFER_PERMISSION } as const

const GrantBody = z.object({ permission: z.enum(['mint', 'offers']).default('mint') })
const RevokeBody = z.object({ permission: z.enum(['mint', 'offers', 'all']).default('all') })

async function organizerOf(userId: string) {
  return prisma.user.findUnique({ where: { id: userId } })
}

/**
 * The set a request carried, as a list of permission names.
 *
 * Rows from before the column existed are empty; a legacy GRANT was always the
 * mint permission alone, and a legacy REVOKE always the empty set.
 */
function targetPermissions(row: { kind: 'GRANT' | 'REVOKE'; permissions: string[] }): string[] {
  if (row.permissions.length > 0) return row.permissions
  return row.kind === 'GRANT' ? [MINT_PERMISSION] : []
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
 * POST /api/delegation/grant   { permission?: 'mint' | 'offers' }
 * Organizer-only. Returns a Xaman payload for the organizer to sign.
 */
delegationRouter.post('/delegation/grant', requireAuth, requireOrganizer, async (req, res) => {
  const body = GrantBody.safeParse(req.body ?? {})
  if (!body.success) {
    res.status(400).json({ error: 'Invalid request', details: issuesOf(body.error) })
    return
  }
  const wanted = SCOPE[body.data.permission]

  const delegate = await refuseUnavailable(res)
  if (!delegate) return

  const organizer = await organizerOf(req.userId!)
  if (!organizer) {
    res.status(401).json({ error: 'Not signed in' })
    return
  }
  const pair = { organizerAddress: organizer.xrplAddress, delegateAddress: delegate }

  // The current set is the base of the new one — see the header. If it cannot be
  // read, building a replacement would be a guess about what to keep.
  const current = await readPermissionSet(pair)
  if (current === 'unknown') {
    res.status(503).json({ error: 'Could not read your current access just now. Try again shortly.' })
    return
  }

  // Already granted: say so rather than spending a payload on a no-op. The quota
  // counts creations and cannot be reclaimed.
  if (current.includes(wanted)) {
    res.json({ state: 'granted' })
    return
  }

  const target = permissionsAfterGrant(current, wanted)
  const txjson = buildDelegateSetTx(pair, target)
  const payload = await (await signingFor(organizer.id, 'DELEGATE_GRANT')).createPayload(txjson as unknown as Record<string, unknown>, {
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
      permissions: target,
      payloadUuid: payload.uuid,
      expiresAt,
    },
  })

  res.status(201).json({
    uuid: payload.uuid,
    next: payload.next,
    qrPng: payload.qrPng,
    // Present only when the person signs in their own browser; the page shows what it asks.
    sign: payload.sign,
    expiresAt: expiresAt.toISOString(),
    mode: xamanMode,
  })
})

/**
 * POST /api/delegation/revoke   { permission?: 'mint' | 'offers' | 'all' }
 * Organizer-only. Revocation is one transaction and takes effect on the next
 * ledger — it must stay as easy as granting, or "revocable" is a claim rather
 * than a property.
 */
delegationRouter.post('/delegation/revoke', requireAuth, requireOrganizer, async (req, res) => {
  const body = RevokeBody.safeParse(req.body ?? {})
  if (!body.success) {
    res.status(400).json({ error: 'Invalid request', details: issuesOf(body.error) })
    return
  }

  const organizer = await organizerOf(req.userId!)
  if (!organizer) {
    res.status(401).json({ error: 'Not signed in' })
    return
  }

  // Revoke the delegate the grant NAMED, not whichever is configured now. After a
  // key rotation the old grant still names the old account, and revoking the new
  // one would leave it in force.
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

  const current = await readPermissionSet(pair)
  const which = body.data.permission

  let target: string[]
  if (which === 'all') {
    // Taking everything away needs no knowledge of what is held, so an
    // unreadable ledger must not block someone trying to take access away.
    if (current !== 'unknown' && current.length === 0) {
      res.json({ state: 'revoked' })
      return
    }
    target = []
  } else {
    // A partial revoke keeps the rest, which means knowing the rest. Sending a
    // set built from a failed read could remove a permission they meant to keep.
    if (current === 'unknown') {
      res.status(503).json({ error: 'Could not read your current access just now. Try again shortly.' })
      return
    }
    if (!current.includes(SCOPE[which])) {
      res.json({ state: 'revoked' })
      return
    }
    target = permissionsAfterRevoke(current, SCOPE[which])
  }

  const txjson = buildDelegateSetTx(pair, target)
  const payload = await (await signingFor(organizer.id, 'DELEGATE_REVOKE')).createPayload(txjson as unknown as Record<string, unknown>, {
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
      permissions: target,
      payloadUuid: payload.uuid,
      expiresAt,
    },
  })

  res.status(201).json({
    uuid: payload.uuid,
    next: payload.next,
    qrPng: payload.qrPng,
    // Present only when the person signs in their own browser; the page shows what it asks.
    sign: payload.sign,
    expiresAt: expiresAt.toISOString(),
    mode: xamanMode,
  })
})

type Reading = 'granted' | 'absent' | 'unknown'

/**
 * GET /api/delegation/me
 *
 * Each permission is read from the ledger on every call. `unknown` means the
 * ledger could not be read — it is NOT "revoked", and must not be rendered as
 * such: an organizer would be told their grant vanished every time a public node
 * blinked.
 *
 * `state` is the mint permission, kept so a client written before there were two
 * still reads the same thing.
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

  const set = await readPermissionSet({ organizerAddress: organizer.xrplAddress, delegateAddress: delegate })
  const read = (p: string): Reading => (set === 'unknown' ? 'unknown' : set.includes(p) ? 'granted' : 'absent')
  const mint = read(MINT_PERMISSION)
  const offers = read(OFFER_PERMISSION)

  // A grant that names an OLD delegate keeps working for that account only. Say
  // so, because the organizer is then "granted" in our table and not in effect.
  const lastGrant = await prisma.delegation.findFirst({
    where: { organizerId: organizer.id, network: NETWORK, kind: 'GRANT', status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
  })

  const label = (r: Reading) => (r === 'granted' ? 'granted' : r === 'absent' ? 'not_granted' : 'unknown')

  res.json({
    available: true,
    state: label(mint),
    permissions: { mint: label(mint), offers: label(offers) },
    delegateAddress: delegate,
    // Only meaningful while it is in force; after a revoke it would read as if
    // access were still held.
    grantedAt: mint === 'granted' ? (lastGrant?.resolvedAt?.toISOString() ?? null) : null,
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

  // Validated. Confirm against the Delegate object itself before saying so — the
  // row is a cache, and this is the one place it is allowed to be written.
  //
  // Compared as sets against what the request CARRIED. A grant is confirmed when
  // everything it asked for is held; a revoke when nothing beyond what it kept
  // remains. (Exact equality would hang forever if the organizer touched another
  // permission between the request and the signature.)
  const target = targetPermissions(row)
  const held = await readPermissionSet({
    organizerAddress: row.organizerAddress,
    delegateAddress: row.delegateAddress,
  })
  const confirmed =
    held !== 'unknown' &&
    (row.kind === 'GRANT'
      ? target.every((p) => held.includes(p))
      : held.every((p) => target.includes(p)) || samePermissions(held, target))
  if (!confirmed) {
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
