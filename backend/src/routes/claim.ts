/**
 * Claiming a ticket held for you.
 *
 *   POST /api/tickets/:nfTokenId/claim → the free, expiring offer that moves the ticket into your wallet
 *
 * The holder is the signed-in user. Nothing in the body is read: who is claiming, and to which wallet, is decided by
 * the session and the Wallet table, never by the client. See `claim.ts`.
 */
import { Router } from 'express'
import { z } from 'zod'
import { issuesOf } from '../schemas.js'
import { requireAuth } from '../session.js'
import { startClaim } from '../claim.js'
import { defaultPrimarySaleLedger } from '../primary-sale-ledger.js'

export const claimRouter = Router()

const Params = z.object({ nfTokenId: z.string().regex(/^[0-9A-Fa-f]{64}$/, 'a 64-character NFTokenID') })

const ledger = defaultPrimarySaleLedger()

claimRouter.post('/tickets/:nfTokenId/claim', requireAuth, async (req, res) => {
  const params = Params.safeParse(req.params)
  if (!params.success) {
    res.status(400).json({ error: 'Invalid ticket id', details: issuesOf(params.error) })
    return
  }

  const outcome = await startClaim({ nfTokenId: params.data.nfTokenId.toUpperCase(), holderId: req.userId!, ledger })
  if (outcome.kind === 'refused') {
    res.status(outcome.status).json({ error: outcome.error, ...(outcome.code ? { code: outcome.code } : {}) })
    return
  }

  const { kind: _kind, ...body } = outcome
  void _kind
  res.status(outcome.reused ? 200 : 201).json(body)
})
