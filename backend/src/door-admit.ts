/**
 * Deciding whether an address may come in, and admitting them.
 *
 * This is everything that happens once WHO is at the door has been established,
 * by whatever means: a Xaman signature, or a code the holder displays. How the
 * address was proven is the caller's business; what it is entitled to is decided
 * here, once, so the two entry paths cannot drift apart.
 *
 * Three decisions worth keeping:
 *
 * **Signing is not enough on its own.** A proven address says who, not what they
 * hold, and our ownership column is a cache. The ledger is re-read before anyone
 * is admitted, so a stale row cannot let someone in on a ticket they sold.
 *
 * **An unreachable ledger is not a refusal.** Turning a real attendee away on a
 * network blip is worse than trusting the cached claim, which the audit trail
 * carries.
 *
 * **Admission is a conditional update, not a read followed by a write.** The
 * check "is this ticket unused?" and the write "mark it used" used to be two
 * steps with a gap between them, so two check-ins racing for one ticket could
 * both pass it: one ticket, two people through the door. The update now says
 * "mark it used IF it is not used yet", and whoever loses finds out in the same
 * statement.
 */
import { prisma } from './prisma.js'
import { holdsNft } from './ledger.js'

export type AdmitBody = {
  checkInId: string
  state: 'redeemed' | 'already_used' | 'no_ticket'
  holder: string | null
  ticket: { seat: string | null; tier: string | null; nfTokenId: string } | null
  reason?: string
  redeemedAt?: string
}

const ALREADY_USED = 'That ticket has already been checked in'
const NO_TICKET = 'No valid ticket for this event'

export async function admit(params: {
  redemptionId: string
  eventId: string
  /** The address whose ticket this is. */
  address: string
  /** Admit exactly this ticket (a displayed code names one), not any the address holds. */
  onlyNfTokenId?: string
}): Promise<AdmitBody> {
  const { redemptionId, eventId, address, onlyNfTokenId } = params

  const candidates = await prisma.ticket.findMany({
    where: { eventId, ownerAddress: address, ...(onlyNfTokenId ? { nfTokenId: onlyNfTokenId } : {}) },
    orderBy: { createdAt: 'asc' },
  })
  const holder = await prisma.user.findUnique({ where: { xrplAddress: address } })
  const holderName = holder ? `@${holder.username}` : null

  const refuse = async (state: 'already_used' | 'no_ticket', ticketId: string | null): Promise<AdmitBody> => {
    const reason = state === 'already_used' ? ALREADY_USED : NO_TICKET
    await prisma.redemption.update({
      where: { id: redemptionId },
      data: {
        status: state === 'already_used' ? 'ALREADY_USED' : 'NO_TICKET',
        resolvedAddress: address,
        holderId: holder?.id ?? null,
        ...(ticketId ? { ticketId } : {}),
        failureReason: reason,
      },
    })
    return { checkInId: redemptionId, state, holder: holderName, ticket: null, reason }
  }

  // Already-used tickets are reported distinctly from having none: "this ticket
  // was already scanned" and "you have no ticket" are different conversations at
  // a door.
  const unredeemed = candidates.filter((t) => t.status !== 'REDEEMED')
  if (candidates.length > 0 && unredeemed.length === 0) return refuse('already_used', candidates[0]!.id)

  let lostRace: string | null = null
  for (const candidate of unredeemed) {
    // Our ownership column is a cache, so confirm against the ledger first.
    try {
      if (!(await holdsNft(address, candidate.nfTokenId))) {
        // Cache disagreed with the ledger: record that we noticed.
        await prisma.ticket.update({
          where: { id: candidate.id },
          data: { ownerId: null, ownerAddress: null, syncedAt: new Date() },
        })
        continue
      }
    } catch {
      // Ledger unreachable: fall back to the cached claim.
    }

    // Admit. The ticket and the record change together, so a ticket can never be
    // marked used without an audit row naming who admitted them, and only ONE
    // caller can win the ticket.
    const admitted = await prisma.$transaction(async (tx) => {
      const { count } = await tx.ticket.updateMany({
        where: { id: candidate.id, status: { not: 'REDEEMED' } },
        data: { status: 'REDEEMED' },
      })
      if (count === 0) return null
      return tx.redemption.update({
        where: { id: redemptionId },
        data: {
          status: 'REDEEMED',
          resolvedAddress: address,
          holderId: holder?.id ?? null,
          ticketId: candidate.id,
          redeemedAt: new Date(),
        },
        include: {
          holder: { select: { username: true } },
          ticket: { select: { seat: true, tier: true, nfTokenId: true } },
        },
      })
    })
    if (!admitted) {
      // Someone else took this ticket between our read and our write.
      lostRace ??= candidate.id
      continue
    }

    return {
      checkInId: admitted.id,
      state: 'redeemed',
      holder: admitted.holder ? `@${admitted.holder.username}` : null,
      ticket: {
        seat: admitted.ticket?.seat ?? null,
        tier: admitted.ticket?.tier ?? null,
        nfTokenId: admitted.ticket?.nfTokenId ?? '',
      },
      redeemedAt: admitted.redeemedAt?.toISOString(),
    }
  }

  return lostRace ? refuse('already_used', lostRace) : refuse('no_ticket', null)
}
