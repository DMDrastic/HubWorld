/**
 * POST /api/signatures/:uuid   { signature }
 *
 * The second half of signing with a wallet the person owns. The first half (the route that
 * started the action) returned the transaction and its hash; the browser had the person's wallet
 * sign that hash and sends back ONLY the signature. Everything that matters is decided in
 * `submitSignature`: whose request it is, that it is still open, that the key is theirs, that the
 * signature verifies against the server's own stored copy, and that it is submitted at most once.
 *
 * It answers with the transaction id and nothing else. The action's own poll route (the grant, the
 * mint) then reports the outcome exactly as it does for Xaman, because a Privy request is read
 * through the same payload store.
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../session.js'
import { privyMode } from '../env.js'
import { issuesOf } from '../schemas.js'
import { submitSignature } from '../privy-signing.js'

export const signaturesRouter = Router()

const Body = z.object({
  // Compact (128 hex) or DER; the server normalises either. Bounded so it cannot be a payload dump.
  signature: z.string().min(120).max(200),
})

signaturesRouter.post('/signatures/:uuid', requireAuth, async (req, res) => {
  if (privyMode !== 'live') return void res.status(404).json({ error: 'Not found' })
  const uuid = z.string().uuid().safeParse(req.params.uuid)
  const body = Body.safeParse(req.body)
  if (!uuid.success || !body.success) {
    return void res
      .status(400)
      .json({ error: 'Invalid request', details: body.success ? undefined : issuesOf(body.error) })
  }

  const outcome = await submitSignature(uuid.data, req.userId!, body.data.signature)
  if (!outcome.ok) return void res.status(outcome.status).json({ error: outcome.error })
  res.status(outcome.replay ? 200 : 202).json({ txid: outcome.txid, replay: outcome.replay })
})
