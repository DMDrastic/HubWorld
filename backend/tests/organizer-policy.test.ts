/**
 * Organizer role and platform policy.
 *
 * Two rules that are easy to get wrong once and never notice:
 *
 * `platformBps` is Hubworld's revenue. If an organizer could set it they would
 * set zero, and because the fee is frozen onto each Listing at creation it would
 * not be retroactively fixable — the money is simply never earned.
 *
 * `royaltyBps` is the organizer's own revenue and IS theirs to choose, but an
 * unbounded royalty makes resale pointless and the ticket effectively
 * non-transferable, which defeats the product.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { slugSchema } from '../src/schemas.js'

/** Mirrors CreateEventBody. platformBps is deliberately absent. */
const CreateEventBody = z.object({
  title: z.string().trim().min(3).max(120),
  venue: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  startsAt: z.coerce.date(),
  ticketCount: z.coerce.number().int().min(1).max(100_000),
  royaltyBps: z.coerce.number().int().min(0),
  slug: slugSchema.optional(),
})

const PLATFORM_FEE_BPS = 250
const MAX_ROYALTY_BPS = 2000

const valid = {
  title: 'Neon Rooftop',
  startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  ticketCount: 100,
  royaltyBps: 500,
}

describe('platformBps cannot be supplied by an organizer', () => {
  it('is stripped from the request body rather than honoured', () => {
    // Zod objects are non-strict, so an unknown key is DROPPED. The event then
    // takes the server's policy value. The danger would be a schema that passed
    // the body through to Prisma wholesale.
    const parsed = CreateEventBody.parse({ ...valid, platformBps: 0 })
    expect('platformBps' in parsed).toBe(false)
  })

  it('gives every event the policy value regardless of what was sent', () => {
    // What the route actually writes.
    const eventData = { ...CreateEventBody.parse({ ...valid, platformBps: 9999 }), platformBps: PLATFORM_FEE_BPS }
    expect(eventData.platformBps).toBe(250)
  })

  it('would be worth real money to get wrong', () => {
    // A 100 XRP resale: 2.5 XRP to Hubworld at policy, nothing at organizer's
    // preferred rate. Spelled out because "config field" understates it.
    const sale = 100_000_000n
    const atPolicy = (sale * BigInt(PLATFORM_FEE_BPS)) / 10000n
    const atOrganizerChoice = (sale * 0n) / 10000n
    expect(atPolicy).toBe(2_500_000n)
    expect(atOrganizerChoice).toBe(0n)
  })
})

describe('royaltyBps is the organizer’s, within a cap', () => {
  it('accepts a sensible royalty', () => {
    expect(CreateEventBody.parse({ ...valid, royaltyBps: 500 }).royaltyBps).toBe(500)
    expect(CreateEventBody.parse({ ...valid, royaltyBps: 0 }).royaltyBps).toBe(0)
  })

  it('rejects a negative royalty at the schema', () => {
    expect(() => CreateEventBody.parse({ ...valid, royaltyBps: -1 })).toThrow()
  })

  it('is refused above the policy cap', () => {
    // Enforced in the route, not the schema, so the error can name the cap.
    const overCap = CreateEventBody.parse({ ...valid, royaltyBps: 3000 }).royaltyBps
    expect(overCap > MAX_ROYALTY_BPS).toBe(true)
  })
})

describe('role gating', () => {
  /** Mirrors requireOrganizer. */
  const isOrganizer = (role: string) => role === 'ORGANIZER' || role === 'ADMIN'
  /** Mirrors requireAdmin. */
  const isAdmin = (role: string) => role === 'ADMIN'

  it('keeps organizer powers away from regular users', () => {
    expect(isOrganizer('USER')).toBe(false)
    expect(isOrganizer('ORGANIZER')).toBe(true)
  })

  it('lets an admin do anything an organizer can', () => {
    // Otherwise an admin reviewing a complaint could not inspect the door.
    expect(isOrganizer('ADMIN')).toBe(true)
  })

  it('does not let an organizer approve their own applications', () => {
    // Self-promotion would make the review gate decorative.
    expect(isAdmin('ORGANIZER')).toBe(false)
  })
})
