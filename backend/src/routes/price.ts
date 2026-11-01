/**
 * GET /api/price/quote?drops=1000000,2500000&slug=<event> — the display estimate for amounts the page did not get
 * from a response: what a seller is typing, or what they would receive. Display only, like every estimate
 * (`fiat-display.ts`): the browser does no conversion, so it asks here.
 *
 * Answers `{ fiat: { "<drops>": { currency, minor } } }`, with nothing for an amount when the price is not fresh.
 * Public: it reveals nothing the health endpoint does not already say.
 */
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { issuesOf, slugSchema } from '../schemas.js'
import { currentDisplayRate, displayCurrency, toFiat, type Fiat } from '../fiat-display.js'

export const priceRouter = Router()

const Drops = z.string().regex(/^(0|[1-9][0-9]{0,17})$/, 'drops must be a non-negative integer string')
const Query = z.object({
  drops: z
    .string()
    .transform((s) => s.split(','))
    .pipe(z.array(Drops).min(1).max(10)),
  slug: slugSchema.optional(),
})

priceRouter.get('/price/quote', async (req, res) => {
  const parsed = Query.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid quote request', details: issuesOf(parsed.error) })
    return
  }
  const event = parsed.data.slug
    ? await prisma.event.findUnique({ where: { slug: parsed.data.slug }, select: { timeZone: true } })
    : null
  const currency = displayCurrency(event ?? { timeZone: 'UTC' })
  const rate = await currentDisplayRate()
  const fiat: Record<string, Fiat> = {}
  for (const d of parsed.data.drops) {
    const f = toFiat(d, rate, currency)
    if (f) fiat[d] = f
  }
  res.json({ fiat })
})
