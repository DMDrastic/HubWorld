/**
 * Xaman webhook receiver.
 *
 * Xaman calls this when a payload resolves, which is what lets every signature
 * flow stop polling.
 *
 * **The body is not trusted.** Only the payload uuid is read from it; the actual
 * state is then fetched from Xaman with our API secret. If this endpoint believed
 * what it was sent, anyone could POST
 * `{ signed: true, account: "rSomeoneElse" }` and forge a sign-in as any address,
 * a mint, or a door check-in. Treating the callback as a nudge rather than a
 * source removes that entirely — and means we do not have to get Xaman's payload
 * signing scheme exactly right to be safe.
 *
 * The secret in the path is a doorbell, not the security boundary. It keeps
 * random internet traffic and scanners from making us call Xaman; the real
 * protection is that a forged call can achieve nothing beyond causing one
 * authenticated refresh of a uuid that has to exist already.
 *
 * Configure the URL in the Xaman developer console as:
 *   https://<host>/api/webhooks/xaman/<XAMAN_WEBHOOK_SECRET>
 */
import { Router } from 'express'
import { z } from 'zod'
import { timingSafeEqual } from 'node:crypto'
import { env, webhookMode } from '../env.js'
import { prisma } from '../prisma.js'
import { refreshPayload } from '../payload-store.js'

export const webhooksRouter = Router()

/**
 * Xaman has used more than one body shape over time, so accept the uuid wherever
 * it appears and ignore everything else. Nothing else is read, so a shape change
 * cannot smuggle state in.
 */
const WebhookBody = z.object({
  meta: z.object({ payload_uuidv4: z.string().uuid() }).partial().optional(),
  payloadResponse: z.object({ payload_uuidv4: z.string().uuid() }).partial().optional(),
  payload_uuidv4: z.string().uuid().optional(),
  uuid: z.string().uuid().optional(),
})

function uuidFrom(body: unknown): string | null {
  const parsed = WebhookBody.safeParse(body)
  if (!parsed.success) return null
  const d = parsed.data
  return (
    d.meta?.payload_uuidv4 ?? d.payloadResponse?.payload_uuidv4 ?? d.payload_uuidv4 ?? d.uuid ?? null
  )
}

/** Constant-time, so the secret cannot be recovered by timing the comparison. */
function secretMatches(given: string): boolean {
  const expected = env.XAMAN_WEBHOOK_SECRET
  if (!expected) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

webhooksRouter.post('/webhooks/xaman/:secret', async (req, res) => {
  if (webhookMode === 'disabled' || !secretMatches(String(req.params.secret ?? ''))) {
    // 404 rather than 403: an unconfigured or wrongly-addressed webhook should
    // look like nothing is here, not like a door with the wrong key.
    res.status(404).json({ error: 'Not found' })
    return
  }

  const uuid = uuidFrom(req.body)
  if (!uuid) {
    // Acknowledge anyway. Xaman retries on failure, and retrying a body we could
    // never parse would just repeat forever.
    res.status(200).json({ ok: true, ignored: 'no payload uuid' })
    return
  }

  // Only act on payloads we actually created. Otherwise this is an unauthenticated
  // way to make us call Xaman for arbitrary uuids.
  const known = await prisma.xamanPayload.findUnique({ where: { uuid }, select: { uuid: true } })
  if (!known) {
    res.status(200).json({ ok: true, ignored: 'unknown payload' })
    return
  }

  // The uuid was the only thing taken from the body. Everything else comes from
  // an authenticated fetch.
  try {
    await refreshPayload(uuid, 'webhook')
  } catch {
    // Never fail the callback on our own error — Xaman would retry, and
    // reconciliation will pick this up regardless.
  }

  res.status(200).json({ ok: true })
})
