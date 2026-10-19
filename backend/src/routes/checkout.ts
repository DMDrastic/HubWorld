/**
 * Buying a ticket from the box office.
 *
 *   POST /api/events/:slug/checkout → hold a ticket, list it, return the buyer's
 *                                     signing payload
 *
 * After this the buyer polls `GET /api/listings/:id` exactly as they would for a
 * resale: the three-phase sale (offer, bid, brokered match) is the existing one,
 * unchanged. All this adds is a ticket that was not listed until the moment the
 * buyer arrived. See `primary-sale.ts` for why.
 */
import { Router } from 'express'
import { z } from 'zod'
import { issuesOf, slugSchema } from '../schemas.js'
import { requireAuth } from '../session.js'
import { startCheckout } from '../primary-sale.js'
import { defaultPrimarySaleLedger } from '../primary-sale-ledger.js'

export const checkoutRouter = Router()

const SlugParams = z.object({ slug: slugSchema })

const ledger = defaultPrimarySaleLedger()

checkoutRouter.post('/events/:slug/checkout', requireAuth, async (req, res) => {
  const params = SlugParams.safeParse(req.params)
  if (!params.success) {
    res.status(400).json({ error: 'Invalid event slug', details: issuesOf(params.error) })
    return
  }

  const outcome = await startCheckout({ slug: params.data.slug, buyerId: req.userId!, ledger })
  if (outcome.kind === 'refused') {
    res.status(outcome.status).json({
      error: outcome.error,
      ...(outcome.code ? { code: outcome.code } : {}),
      ...(outcome.listingId ? { listingId: outcome.listingId } : {}),
    })
    return
  }

  const { kind: _kind, ...body } = outcome
  void _kind
  res.status(201).json(body)
})
