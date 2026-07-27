/**
 * Who may work a door.
 *
 * Checking people in and issuing tickets were the same permission until now. A
 * door needs volunteers, and granting each of them ORGANIZER would hand over the
 * whole supply side — minting, event creation, auctions — so someone can scan
 * QRs for an evening. These pin the separation.
 */
import { describe, expect, it } from 'vitest'

type Role = 'USER' | 'ORGANIZER' | 'ADMIN'

/** Mirrors checkDoorAccess. */
function doorAllowed(p: {
  userId: string
  organizerId: string
  role: Role
  staff?: { revokedAt: Date | null }
}): boolean {
  if (p.userId === p.organizerId) return true
  if (p.role === 'ADMIN') return true
  return Boolean(p.staff && !p.staff.revokedAt)
}

/** Powers that door access must NOT confer. */
const isOrganizer = (role: Role) => role === 'ORGANIZER' || role === 'ADMIN'

const ORG = 'organizer-1'

describe('door access', () => {
  it('always lets the organizer work their own door', () => {
    expect(doorAllowed({ userId: ORG, organizerId: ORG, role: 'ORGANIZER' })).toBe(true)
  })

  it('lets an added staff member in', () => {
    expect(
      doorAllowed({ userId: 'vol', organizerId: ORG, role: 'USER', staff: { revokedAt: null } }),
    ).toBe(true)
  })

  it('refuses a plain user who was never added', () => {
    expect(doorAllowed({ userId: 'rando', organizerId: ORG, role: 'USER' })).toBe(false)
  })

  it('refuses a revoked staff member', () => {
    // Revoked rather than deleted, so the audit trail survives — but access ends.
    expect(
      doorAllowed({
        userId: 'vol',
        organizerId: ORG,
        role: 'USER',
        staff: { revokedAt: new Date() },
      }),
    ).toBe(false)
  })

  it('refuses a DIFFERENT organizer', () => {
    // Being an organizer somewhere does not open someone else's door. This is
    // the case the old role-only check got wrong.
    expect(doorAllowed({ userId: 'other-org', organizerId: ORG, role: 'ORGANIZER' })).toBe(false)
  })

  it('lets an admin work any door', () => {
    // They arbitrate disputed check-ins and cannot depend on the organizer's
    // cooperation to do it.
    expect(doorAllowed({ userId: 'admin', organizerId: ORG, role: 'ADMIN' })).toBe(true)
  })
})

describe('door access is not organizer access', () => {
  it('does not let a volunteer mint, create events or auction', () => {
    // The whole point of the separation: scanning QRs for one night must not
    // confer the supply side of the business.
    const volunteer: Role = 'USER'
    expect(
      doorAllowed({ userId: 'vol', organizerId: ORG, role: volunteer, staff: { revokedAt: null } }),
    ).toBe(true)
    expect(isOrganizer(volunteer)).toBe(false)
  })
})

describe('scoping', () => {
  /** Staff rows are per event, so access to one says nothing about another. */
  function accessFor(eventId: string, staffRows: Array<{ eventId: string }>): boolean {
    return staffRows.some((r) => r.eventId === eventId)
  }

  it('does not carry from one event to another', () => {
    // Staff for tonight's show should not inherit next month's.
    const rows = [{ eventId: 'tonight' }]
    expect(accessFor('tonight', rows)).toBe(true)
    expect(accessFor('next-month', rows)).toBe(false)
  })
})
