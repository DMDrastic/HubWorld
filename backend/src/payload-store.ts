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
import { XamanRateLimited, xaman, type PayloadStatus } from './xaman.js'

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
  await prisma.xamanPayload.upsert({ where: { uuid }, create: { uuid, ...data }, update: data })

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
 */
const REFRESH_THROTTLE_MS = 10_000

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

/** Register a payload as soon as it is created, so reconciliation can find it. */
export async function trackPayload(uuid: string): Promise<void> {
  await prisma.xamanPayload.upsert({
    where: { uuid },
    create: { uuid, source: 'poll' },
    update: {},
  })
}
