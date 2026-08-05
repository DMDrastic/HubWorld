/**
 * What the Xaman quota is actually being spent on.
 *
 * ## Why this exists
 *
 * The developer application has a quota on payloads CREATED, and none of it can
 * be reclaimed — `DELETE` on a resolved payload returns 404 and it still counts.
 * So the quota scales with USERS doing things, not with tickets existing, and
 * the testnet application is already exhausted. That is not an inconvenience; it
 * is the failure mode at scale, arriving early.
 *
 * Until now every creation looked identical the moment it was made, which left
 * the most valuable missing measurement in the system unanswerable: **how many
 * payloads does one attendee cost us, end to end?** That number decides whether
 * the unit economics work, and no amount of reasoning substitutes for counting.
 *
 * ## Where the counting happens, and why there
 *
 * In the signer seam (`CountingSigner` in `xaman.ts`), not in the routes. A
 * route that forgets to count is a flow that silently costs nothing on the
 * dashboard while costing real quota, and there are eleven of them. Wrapping the
 * client means the only way to create a payload is to be counted, and the
 * required `flow` on `PayloadOptions` means the compiler — not a reviewer —
 * rejects a twelfth site that does not say what it is.
 *
 * ## Two things it deliberately does not do
 *
 * **It does not estimate remaining quota.** Xaman owns that number and we have
 * no endpoint for it; a local guess that drifts from the real limit is worse
 * than no guess, because it would be believed. This reports consumption, which
 * we can observe exactly.
 *
 * **It does not count stub payloads as spend.** They cost nothing, and the e2e
 * suite creates them by the dozen. Folding those in would inflate every figure
 * in the direction that hides a real problem, so `signer` is recorded and the
 * report filters on it.
 */
import type { PayloadFlow, XrplNetwork } from '@prisma/client'
import { prisma } from './prisma.js'
import { NETWORK } from './network.js'

/**
 * Register a payload the instant it exists.
 *
 * This also does the job `trackPayload` used to do at each call site — making
 * the payload visible to webhook reconciliation — because both wants are the
 * same want: a row per payload, written before it can possibly resolve. Doing it
 * in one place removes the ordering hazard where a payload resolved in the
 * window between creation and registration.
 *
 * **Recorded AFTER Xaman confirms creation, so it undercounts rather than
 * over.** A crash in the millisecond between the two loses one row. The reverse
 * ordering would count payloads that failed to create, and a figure that
 * overstates spend gets you rotating credentials you did not need to; this way
 * the number is a faithful count of payloads Xaman actually issued.
 *
 * Never throws. A metrics write must not be able to break signing — the person
 * holding the phone does not care that we failed to count them.
 */
export async function recordPayloadCreation(args: {
  uuid: string
  flow: PayloadFlow
  signer: string
  userId?: string | null
}): Promise<void> {
  try {
    await prisma.xamanPayload.upsert({
      where: { uuid: args.uuid },
      create: {
        uuid: args.uuid,
        flow: args.flow,
        network: NETWORK,
        signer: args.signer,
        userId: args.userId ?? null,
        source: 'create',
      },
      // A uuid can only be handed to us once, so this branch is defensive. Keep
      // the original attribution if it somehow fires twice — the first write is
      // the one that happened at creation.
      update: {},
    })
  } catch {
    // Intentionally swallowed. See above.
  }
}

export type FlowUsage = {
  /** Null means the row predates instrumentation, or resolution created it. */
  flow: PayloadFlow | null
  created: number
  signed: number
}

export type PayloadUsage = {
  network: XrplNetwork
  signer: string
  since: Date | null
  until: Date
  /** Payloads created — the number the quota actually counts. */
  created: number
  /** Of those, how many were signed. */
  signed: number
  /**
   * Created but resolved without a signature: expired QRs, rejections, and
   * anything cancelled as abandoned. This is pure waste against the quota, and
   * it is the one figure here that code can still improve.
   */
  wasted: number
  byFlow: FlowUsage[]
  /** People we can attribute payloads to. SIGNIN and DOOR_CHECKIN have none. */
  distinctUsers: number
  /**
   * Attributed payloads per identified user.
   *
   * A FLOOR on the true cost per person, not the cost itself: the two
   * unattributable flows are exactly the ones every attendee goes through. Read
   * it alongside `byFlow`, never alone.
   */
  perIdentifiedUser: number | null
}

/**
 * Summarise consumption.
 *
 * Defaults to real spend on the current network, because that is the question
 * being asked in every case where the answer matters.
 */
export async function payloadUsage(
  opts: { since?: Date; network?: XrplNetwork; signer?: string } = {},
): Promise<PayloadUsage> {
  const network = opts.network ?? NETWORK
  const signer = opts.signer ?? 'xaman'
  const where = {
    network,
    signer,
    ...(opts.since ? { createdAt: { gte: opts.since } } : {}),
  }

  const [grouped, distinct] = await Promise.all([
    prisma.xamanPayload.groupBy({
      by: ['flow', 'signed'],
      where,
      _count: { _all: true },
    }),
    prisma.xamanPayload.findMany({
      where: { ...where, userId: { not: null } },
      distinct: ['userId'],
      select: { userId: true },
    }),
  ])

  const byFlow = new Map<PayloadFlow | null, FlowUsage>()
  for (const row of grouped) {
    const entry = byFlow.get(row.flow) ?? { flow: row.flow, created: 0, signed: 0 }
    entry.created += row._count._all
    if (row.signed) entry.signed += row._count._all
    byFlow.set(row.flow, entry)
  }

  const rows = [...byFlow.values()].sort((a, b) => b.created - a.created)
  const created = rows.reduce((n, r) => n + r.created, 0)
  const signed = rows.reduce((n, r) => n + r.signed, 0)

  // Only payloads that are OVER count as waste. One still waiting to be signed
  // is not wasted, it is in flight, and counting it would make the figure swing
  // with however many people happen to be mid-flow when the report is run.
  const wasted = await prisma.xamanPayload.count({
    where: { ...where, signed: false, terminal: true },
  })

  const attributed = await prisma.xamanPayload.count({
    where: { ...where, userId: { not: null } },
  })

  return {
    network,
    signer,
    since: opts.since ?? null,
    until: new Date(),
    created,
    signed,
    wasted,
    byFlow: rows,
    distinctUsers: distinct.length,
    perIdentifiedUser: distinct.length > 0 ? attributed / distinct.length : null,
  }
}
