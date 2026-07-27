/**
 * Who may work an event's door.
 *
 * Checking people in and issuing tickets are very different powers, and until
 * now they were the same one. A door needs casual staff and volunteers, and
 * granting each of them ORGANIZER would hand over the entire supply side —
 * minting, event creation, auctions — so that someone can scan QRs for an
 * evening.
 *
 * So door access is **per event** and separate from the account role:
 *
 *   organizer  — always, for their own events
 *   staff      — anyone the organizer has added to THAT event
 *   admin      — any event, since they arbitrate disputes
 *
 * Deliberately scoped to one event and revocable. Staff for tonight's show
 * should not inherit next month's, and access should be withdrawable without
 * touching someone's account.
 *
 * Note what door access does NOT grant: no minting, no event creation, no
 * auctions, no listings. It is the ability to admit people to one event and
 * nothing else.
 */
import { prisma } from './prisma.js'
import type { UserRole } from '@prisma/client'

export type DoorAccess =
  | { allowed: true; via: 'organizer' | 'staff' | 'admin' }
  | { allowed: false; reason: string }

export async function checkDoorAccess(params: {
  eventId: string
  organizerId: string
  userId: string
  role: UserRole | undefined
}): Promise<DoorAccess> {
  if (params.userId === params.organizerId) return { allowed: true, via: 'organizer' }

  // Admins can work any door because they have to be able to investigate a
  // disputed check-in without the organizer's cooperation.
  if (params.role === 'ADMIN') return { allowed: true, via: 'admin' }

  const staff = await prisma.eventStaff.findUnique({
    where: { eventId_userId: { eventId: params.eventId, userId: params.userId } },
  })
  if (staff && !staff.revokedAt) return { allowed: true, via: 'staff' }

  return {
    allowed: false,
    reason: staff?.revokedAt
      ? 'Your door access for this event has been revoked'
      : 'You are not on the door for this event',
  }
}

/**
 * Add someone to an event's door.
 *
 * Re-adding a revoked member reinstates them rather than failing, since
 * "removed by mistake" is the common case.
 */
export async function addStaff(params: {
  eventId: string
  userId: string
  addedById: string
}): Promise<void> {
  await prisma.eventStaff.upsert({
    where: { eventId_userId: { eventId: params.eventId, userId: params.userId } },
    create: params,
    update: { revokedAt: null, addedById: params.addedById },
  })
}

/**
 * Withdraw door access.
 *
 * Revoked rather than deleted: a door dispute is exactly when someone needs to
 * know who had access and when it ended.
 */
export async function revokeStaff(eventId: string, userId: string): Promise<void> {
  await prisma.eventStaff.updateMany({
    where: { eventId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}
