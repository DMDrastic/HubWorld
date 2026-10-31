/**
 * Dev-only simulate endpoint, generalised.
 *
 * `/api/auth/signin/simulate` already stands in for a human signing in Xaman,
 * but only for the SignIn payload — every other flow (mint, gift, list, buy,
 * auction, bid) had no equivalent, so driving them through stub mode left
 * each one frozen at "signed, pending" forever. `StubXamanClient.simulate()`
 * was never flow-specific to begin with — it resolves whatever payload uuid
 * it is given — so this is the same call, exposed once, generically, instead
 * of duplicated per flow. The sign-in route is left exactly as it is, for the
 * e2e suite that already depends on its exact shape.
 */
import { Router } from 'express'
import { z } from 'zod'
import { env } from '../env.js'
import { asStub, signing } from '../signing.js'
import { issuesOf, xrplAddressSchema } from '../schemas.js'

export const devRouter = Router()

const SimulateParams = z.object({ uuid: z.string().uuid() })
const SimulateBody = z.object({
  account: xrplAddressSchema.optional(),
  outcome: z.enum(['sign', 'reject']).default('sign'),
})

/**
 * POST /api/dev/payloads/:uuid/simulate
 *
 * Exists ONLY in stub mode outside production — double-guarded because an
 * endpoint that fakes an arbitrary signature is a total bypass of every
 * money and identity check in the product if it ever ships live.
 */
devRouter.post('/dev/payloads/:uuid/simulate', async (req, res) => {
  const stub = asStub(signing)
  if (!stub || env.NODE_ENV === 'production') {
    res.status(404).json({ error: 'Not found' })
    return
  }

  const params = SimulateParams.safeParse(req.params)
  if (!params.success) {
    res.status(400).json({ error: 'Invalid request', details: issuesOf(params.error) })
    return
  }
  const body = SimulateBody.safeParse(req.body)
  if (!body.success) {
    res.status(400).json({ error: 'Invalid request', details: issuesOf(body.error) })
    return
  }

  const account = body.data.account ?? 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w'
  const ok = stub.simulate(params.data.uuid, account, body.data.outcome)
  if (!ok) {
    res.status(404).json({ error: 'Unknown payload' })
    return
  }

  res.json({ simulated: body.data.outcome, account })
})
