/**
 * Which XRPL wallet an account signs with.
 *
 * An account is the identity and a wallet is something attached to it, so a user can one day
 * exist with NO wallet (a card buyer who has not claimed their ticket yet). Everything new must
 * therefore treat "no address" as an ordinary answer: this returns `null`, and callers handle it
 * instead of assuming a string. `User.xrplAddress` is still required today, only to avoid
 * rewriting every existing read in the same change as everything else; it is not a design
 * assumption to build on.
 *
 * TRANSITIONAL FALLBACK: a user with no Wallet row is a legacy Xaman user (created before the
 * table, or by a script or fixture that predates it), and their address lives only on the
 * column. Reading the column then is correct, not a shortcut. Once nothing creates such users
 * the fallback can go.
 */
import type { PrismaClient } from '@prisma/client'
import { prisma } from './prisma.js'

type Db = Pick<PrismaClient, 'wallet' | 'user'>

/** The user's wallet address, or null when they have none (or do not exist). */
export async function getUserXrplAddress(userId: string, db: Db = prisma): Promise<string | null> {
  const wallet = await db.wallet.findUnique({ where: { userId }, select: { xrplAddress: true } })
  if (wallet) return wallet.xrplAddress
  const user = await db.user.findUnique({ where: { id: userId }, select: { xrplAddress: true } })
  return user?.xrplAddress ?? null
}
