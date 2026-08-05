/**
 * Payload resolution, pushed rather than polled.
 *
 * Every signature flow used to ask Xaman on each poll — one request per 2.5s per
 * waiting user, which is exactly what produced a 429 during the first live gift.
 * With a webhook configured, Xaman tells us once when a payload resolves and this
 * store answers every subsequent read.
 *
 * ## The security property
 *
 * **The webhook body is never trusted.** It is treated purely as a nudge saying
 * "payload X may have changed"; the only field read from it is the uuid. The
 * actual state always comes from an authenticated fetch using our API secret.
 *
 * That matters enormously: a webhook that believed its own body would accept
 * `{ signed: true, account: "rSomeoneElse" }` from anyone on the internet, which
 * is a complete authentication bypass — a forged sign-in as any address, a forged
 * mint, a forged check-in. Treating the callback as a trigger rather than a
 * source removes that class of attack entirely, and it also means we do not
 * depend on getting Xaman's payload-signing scheme exactly right.
 *
 * ## Degradation
 *
 * Without `XAMAN_WEBHOOK_SECRET` this is a cache in front of the same polling as
 * before, so dev works unchanged with no public URL. Terminal states are cached
 * either way, because signed/cancelled/expired cannot change again.
 */
import { prisma } from './prisma.js'
import { webhookMode } from './env.js'
import { NETWORK } from './network.js'
import { XamanRateLimited, xaman, type PayloadStatus } from './xaman.js'

/**
 * What every create branch below has to supply, because both columns are
 * required and neither has a default.
 *
 * These branches are DEFENSIVE: the signer wrapper writes the row at creation,
 * so by the time anything here runs it normally exists and only the update
 * branch fires. A create firing means a payload we have no creation record of,
 * which is why `flow` is left null rather than guessed — an unattributed row is
 * a signal, and a fabricated one is noise in the exact figure this is for.
 */
function provenance() {
  return { network: NETWORK, signer: xaman.mode === 'live' ? 'xaman' : 'stub' }
}

/** A payload in a final state can never change, so it is safe to serve forever. */
function isTerminal(s: PayloadStatus): boolean {
  return s.signed || s.cancelled || s.expired
}

/**
 * Ask Xaman for the truth and record it.
 *
 * The ONLY place payload state enters the system. Called by the webhook (with a
 * uuid it was told about) and by reconciliation.
 */
export async function refreshPayload(
  uuid: string,
  source: 'webhook' | 'poll' | 'reconcile' = 'poll',
): Promise<PayloadStatus | null | 'unavailable'> {
  let status: PayloadStatus | null
  try {
    status = await xaman.getPayload(uuid)
  } catch (err) {
    if (err instanceof XamanRateLimited) return 'unavailable'
    throw err
  }

  if (!status) return null

  const data = {
    signed: status.signed,
    cancelled: status.cancelled,
    expired: status.expired,
    account: status.account,
    txid: status.txid,
    terminal: isTerminal(status),
    source,
    fetchedAt: new Date(),
  }
  await prisma.xamanPayload.upsert({
    where: { uuid },
    create: { uuid, ...provenance(), ...data },
    update: data,
  })

  return status
}

function toStatus(row: {
  signed: boolean
  cancelled: boolean
  expired: boolean
  account: string | null
  txid: string | null
}): PayloadStatus {
  return {
    signed: row.signed,
    cancelled: row.cancelled,
    expired: row.expired,
    account: row.account,
    txid: row.txid,
  }
}

/**
 * How often one payload may be re-fetched while waiting, in webhook mode.
 *
 * A pure webhook design is tempting and wrong: callbacks get lost, and a
 * signature that nobody notices is worse than a few extra requests. Throttling
 * per payload keeps the safety net while removing the hammering — many viewers
 * polling one payload still cost at most one Xaman request per interval, versus
 * one per poller per 2.5s.
 *
 * THE INTERVAL IS SHORT ON PURPOSE, and 10s was wrong.
 *
 * The saving here is per PAYLOAD, not per viewer: whatever the window, N people
 * watching one auction collapse to one request per window. Sign-in is the
 * opposite shape — one person, watching their own payload — so a long window
 * saves almost nothing and costs exactly what it is set to. Observed on
 * production with the webhook enabled but its URL never registered in the Xaman
 * console: signing took about five seconds to be noticed, which is the average
 * of a 10s window, and it had been roughly two before.
 *
 * At 1.5s a lone poller (the client polls every 2s) refreshes on essentially
 * every poll, so sign-in is as immediate as it was without a webhook, while a
 * crowded auction is still capped at one request per 1.5s no matter how many
 * people are watching. The 429 this was built to prevent stays prevented.
 *
 * Note this window is the ONLY thing standing between a lost callback and a
 * signature nobody notices, so it should not grow without someone measuring
 * what it costs a person waiting on it.
 */
const REFRESH_THROTTLE_MS = 1_500

/**
 * What a poll route sees.
 *
 * A terminal cached state is served without touching Xaman, since it can never
 * change again. Otherwise:
 *
 * - **webhook live** — serve the cached state, refreshing at most once per
 *   throttle window so a lost callback still resolves.
 * - **webhook off** — ask Xaman every time, exactly as before, so dev works with
 *   no public URL.
 */
export async function resolvePayload(
  uuid: string,
): Promise<PayloadStatus | null | 'unavailable'> {
  const cached = await prisma.xamanPayload.findUnique({ where: { uuid } })

  if (cached?.terminal) return toStatus(cached)

  if (webhookMode === 'disabled') return refreshPayload(uuid, 'poll')

  const stale = !cached || cached.fetchedAt.getTime() < Date.now() - REFRESH_THROTTLE_MS
  if (stale) {
    const fresh = await refreshPayload(uuid, 'poll')
    // A rate limit is not an answer; fall through to whatever we already knew.
    if (fresh !== 'unavailable') return fresh
  }

  return cached
    ? toStatus(cached)
    : { signed: false, cancelled: false, expired: false, account: null, txid: null }
}

/**
 * Catch payloads whose webhook never arrived.
 *
 * Callbacks get lost — a deploy mid-flight, a network blip, a misconfigured URL.
 * Without this a signature would sit unrecognised until it expired, which for a
 * mint or a bid means real money stuck. Deliberately narrow: only non-terminal
 * payloads that something is still waiting on.
 */
export async function reconcileStalePayloads(olderThanMs = 60_000, limit = 25): Promise<number> {
  if (webhookMode === 'disabled') return 0

  const cutoff = new Date(Date.now() - olderThanMs)
  const stale = await prisma.xamanPayload.findMany({
    where: { terminal: false, fetchedAt: { lt: cutoff } },
    orderBy: { fetchedAt: 'asc' },
    take: limit,
    select: { uuid: true },
  })

  let refreshed = 0
  for (const { uuid } of stale) {
    const result = await refreshPayload(uuid, 'reconcile')
    // Back off the moment Xaman pushes back; the next sweep resumes.
    if (result === 'unavailable') break
    refreshed += 1
  }
  return refreshed
}

/**
 * Cancel payloads nobody is going to sign.
 *
 * Hygiene, not quota recovery. Measured: Xaman's limit counts payloads CREATED,
 * and cancelling does not give any of it back — see XamanPayloadLimit.
 *
 * It is still worth doing. An abandoned payload that a user later scans produces
 * a confusing signature for something they have moved on from, and cancelling
 * closes that. Only payloads past their own local deadline are touched, so
 * nothing anyone might still legitimately sign is taken away.
 */
export async function cancelAbandonedPayloads(limit = 50, force = false): Promise<number> {
  // `force` ignores deadlines and reclaims everything unresolved. Reserved for
  // the moment the account is actually full, where a stale QR someone might
  // still scan is a far smaller cost than nobody being able to sign in at all.
  const now = force ? new Date(Date.now() + 10 * 365 * 24 * 60 * 60_000) : new Date()

  // Every table that creates a payload knows when it stops being useful. A
  // payload is abandoned when its owner has already given up on it.
  const [signIns, mints, gifts, listings, bids, checkIns] = await Promise.all([
    prisma.signInRequest.findMany({
      where: { status: 'PENDING', expiresAt: { lt: now } },
      select: { payloadUuid: true },
      take: limit,
    }),
    prisma.mintRequest.findMany({
      where: { status: 'PENDING', expiresAt: { lt: now } },
      select: { payloadUuid: true },
      take: limit,
    }),
    prisma.gift.findMany({
      where: { status: 'PENDING_OFFER', expiresAt: { lt: now } },
      select: { offerPayloadUuid: true },
      take: limit,
    }),
    prisma.listing.findMany({
      where: { status: 'PENDING_OFFER', expiresAt: { lt: now } },
      select: { listPayloadUuid: true },
      take: limit,
    }),
    prisma.bid.findMany({
      where: { status: 'PENDING', expiresAt: { lt: now } },
      select: { bidPayloadUuid: true },
      take: limit,
    }),
    prisma.redemption.findMany({
      where: { status: 'PENDING', expiresAt: { lt: now } },
      select: { payloadUuid: true },
      take: limit,
    }),
  ])

  const uuids = [
    ...signIns.map((r) => r.payloadUuid),
    ...mints.map((r) => r.payloadUuid),
    ...gifts.map((r) => r.offerPayloadUuid),
    ...listings.map((r) => r.listPayloadUuid),
    ...bids.map((r) => r.bidPayloadUuid),
    ...checkIns.map((r) => r.payloadUuid),
  ].filter((u): u is string => typeof u === 'string')

  // Skip anything already known to be resolved — cancelling it would fail and
  // it is not holding a slot anyway.
  const known = await prisma.xamanPayload.findMany({
    where: { uuid: { in: uuids }, terminal: true },
    select: { uuid: true },
  })
  const resolved = new Set(known.map((k) => k.uuid))

  let cancelled = 0
  for (const uuid of uuids) {
    if (resolved.has(uuid)) continue
    try {
      if (await xaman.cancelPayload(uuid)) cancelled += 1
      // Record it as terminal either way: it is over, and a future poll should
      // not go asking Xaman about it.
      await prisma.xamanPayload.upsert({
        where: { uuid },
        create: { uuid, ...provenance(), expired: true, terminal: true, source: 'cancel' },
        update: { expired: true, terminal: true, source: 'cancel' },
      })
    } catch {
      // One stubborn payload must not stop the rest being freed.
    }
  }
  return cancelled
}
