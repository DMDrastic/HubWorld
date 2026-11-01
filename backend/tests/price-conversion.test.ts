/**
 * Moving events priced in XRP to a US$ price, once, at a recorded rate (item 1b-i). Written before the code.
 *
 * Dry run by default. Applying sets the US$ price, keeps the old XRP price as history, and writes one PriceConversion row
 * per event with the rate and when that rate was read, so a converted price can always be traced. Run twice, it does
 * nothing the second time. With no fresh price it converts nothing at all.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Wallet } from 'xrpl'

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { convertEventPricesToUsd } = await import('../src/price-conversion.js')

const TAG = 'pcv-'
const RATE = { microUsdPerXrp: 1_250_000n, at: new Date('2026-11-01T20:00:00Z') }
let uniq = ''

async function mkEvent(over: Record<string, unknown>) {
  const org = await prisma.user.create({ data: { username: `pcv_${uniq}_${Math.random().toString(36).slice(2, 6)}`, xrplAddress: Wallet.generate().classicAddress, role: 'ORGANIZER' } })
  return prisma.event.create({
    data: {
      network: NETWORK, slug: `${TAG}${uniq}-${Math.random().toString(36).slice(2, 6)}`, title: 'Convert me', startsAt: new Date(Date.now() + 864e5),
      organizerId: org.id, nftTaxon: 70_000 + Math.floor(Math.random() * 900), royaltyBps: 500, platformBps: 250, ticketCount: 5, status: 'PUBLISHED',
      ...over,
    },
  })
}
const mine = (id: string) => (r: { eventId: string }) => r.eventId === id

beforeEach(async () => {
  uniq = Math.random().toString(36).slice(2, 7)
  await prisma.priceConversion.deleteMany({ where: { subject: 'Event.primaryPrice', subjectId: { in: (await prisma.event.findMany({ where: { slug: { startsWith: TAG } }, select: { id: true } })).map((e) => e.id) } } })
  await prisma.event.deleteMany({ where: { slug: { startsWith: TAG } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: 'pcv_' } } })
})
afterAll(async () => {
  await prisma.$disconnect()
})

describe('converting XRP box-office prices to US$', () => {
  it('a dry run reports each conversion and changes nothing', async () => {
    const e = await mkEvent({ primaryPriceDrops: 10_000_000n })
    const plan = await convertEventPricesToUsd({ apply: false, rate: RATE })
    expect(plan.find(mine(e.id))).toMatchObject({ fromDrops: 10_000_000n, toCents: 1250n, applied: false })
    expect(await prisma.event.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ primaryPriceMinor: null, primaryPriceCurrency: null })
    expect(await prisma.priceConversion.count({ where: { subjectId: e.id } })).toBe(0)
  })

  it('applying sets the US$ price, keeps the XRP price as history, and logs the rate and its time', async () => {
    const e = await mkEvent({ primaryPriceDrops: 10_350_000n })
    await convertEventPricesToUsd({ apply: true, rate: RATE })
    // 10.35 XRP x 1.25 = 12.9375 -> US$12.94 (nearest cent)
    expect(await prisma.event.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ primaryPriceMinor: 1294n, primaryPriceCurrency: 'USD', primaryPriceDrops: 10_350_000n })
    const log = await prisma.priceConversion.findMany({ where: { subjectId: e.id } })
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ subject: 'Event.primaryPrice', fromCurrency: 'XRP', fromMinor: 10_350_000n, toCurrency: 'USD', toMinor: 1294n, microUsdPerXrp: 1_250_000n, rateAt: RATE.at })
  })

  it('run twice, it converts once', async () => {
    const e = await mkEvent({ primaryPriceDrops: 10_000_000n })
    await convertEventPricesToUsd({ apply: true, rate: RATE })
    const again = await convertEventPricesToUsd({ apply: true, rate: { ...RATE, microUsdPerXrp: 2_000_000n } })
    expect(again.find(mine(e.id))).toBeUndefined()
    expect(await prisma.priceConversion.count({ where: { subjectId: e.id } })).toBe(1)
    expect((await prisma.event.findUniqueOrThrow({ where: { id: e.id } })).primaryPriceMinor).toBe(1250n)
  })

  it('leaves alone events with no price, and events already in US$', async () => {
    const none = await mkEvent({})
    const usd = await mkEvent({ primaryPriceMinor: 900n, primaryPriceCurrency: 'USD' })
    const plan = await convertEventPricesToUsd({ apply: true, rate: RATE })
    expect(plan.find(mine(none.id))).toBeUndefined()
    expect(plan.find(mine(usd.id))).toBeUndefined()
    expect((await prisma.event.findUniqueOrThrow({ where: { id: usd.id } })).primaryPriceMinor).toBe(900n)
  })

  it('refuses a price that would round to nothing, rather than making a free event', async () => {
    const tiny = await mkEvent({ primaryPriceDrops: 1n })
    const plan = await convertEventPricesToUsd({ apply: true, rate: RATE })
    expect(plan.find(mine(tiny.id))).toMatchObject({ applied: false, skipped: 'rounds to US$0.00' })
    expect((await prisma.event.findUniqueOrThrow({ where: { id: tiny.id } })).primaryPriceCurrency).toBeNull()
  })
})
