/**
 * Claiming a ticket the database says someone holds: the free, expiring, holder-only offer. Written before the code.
 *
 * Real Postgres; the ledger is the one seam, faked. What is pinned is everything that could hand a ticket to the wrong
 * account or leave two offers standing: the exact transaction the delegate signs, every refusal, a retried or racing
 * claim making ONE offer, and an unaccepted offer being cancelled when it lapses.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Wallet, rippleTimeToUnixTime } from 'xrpl'
import { makeNftId } from './nft-id.js'

const DELEGATE = Wallet.generate().classicAddress

vi.mock('../src/delegate-account.js', async () => {
  const actual = await vi.importActual<typeof import('../src/delegate-account.js')>('../src/delegate-account.js')
  return { ...actual, currentDelegate: () => DELEGATE }
})

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { startClaim, expireClaims } = await import('../src/claim.js')
const { CLAIM_GRACE_MS, CLAIM_TTL_SECONDS } = await import('../src/claim-policy.js')
type Ledger = import('../src/primary-sale-ledger.js').PrimarySaleLedger
type Offer = import('../src/primary-sale-ledger.js').DelegatedOffer

const UTAG = 'cl_'
let uniq = ''
let n = 0

const fake = {
  permission: 'granted' as 'granted' | 'absent' | 'unknown',
  holdsOrganizer: true as boolean | null,
  holderHoldsIt: false,
  submitted: [] as Offer[],
  cancelled: [] as string[][],
  cancelThrows: false,
  cancelDelayMs: 0,
  delayMs: 0,
  result: (): { ok: true } | { ok: false; code: string } => ({ ok: true }),
  awaitResult: (): { ok: true } | { ok: false; code: string } => ({ ok: true }),
}

const ledger: Ledger = {
  async readPermission() {
    return fake.permission
  },
  async holds(address) {
    // The organizer's side answers the pre-flight check; anyone else is the holder's wallet.
    return address === orgAddress ? fake.holdsOrganizer : fake.holderHoldsIt
  },
  async funding() {
    return { spendableDrops: 100_000_000_000n, reserveIncDrops: 200_000n }
  },
  async startSellOffer(tx) {
    if (fake.delayMs) await new Promise((r) => setTimeout(r, fake.delayMs))
    const r = fake.result()
    if (!r.ok) return r
    fake.submitted.push(tx)
    return { ok: true, hash: `TX${fake.submitted.length}`.padEnd(64, '0'), lastLedgerSequence: 0 }
  },
  async awaitSellOffer(started) {
    const r = fake.awaitResult()
    if (!r.ok) return r
    return { ok: true, txHash: started.hash, offerIndex: `OFFER${started.hash.slice(2, 4)}`.padEnd(64, 'F') }
  },
  async cancelOffers(indexes) {
    if (fake.cancelDelayMs) await new Promise((r) => setTimeout(r, fake.cancelDelayMs))
    if (fake.cancelThrows) throw new Error('ledger down')
    fake.cancelled.push(indexes)
  },
}

let orgAddress = ''

async function mkUser(name: string, role: 'USER' | 'ORGANIZER' = 'USER', wallet: 'yes' | 'no' | 'different' = 'yes') {
  const legacy = Wallet.generate().classicAddress
  // 'different': the verified wallet is not the address in the legacy column.
  const address = wallet === 'different' ? Wallet.generate().classicAddress : legacy
  const user = await prisma.user.create({ data: { username: `${UTAG}${name}_${uniq}`.slice(0, 20), xrplAddress: legacy, role } })
  if (wallet !== 'no') await prisma.wallet.create({ data: { userId: user.id, xrplAddress: address, signerKind: 'PRIVY', providerUserId: `did:${name}:${uniq}` } })
  return { id: user.id, address }
}

async function setup(over: { holderWallet?: 'yes' | 'no' | 'different'; ticket?: Record<string, unknown> } = {}) {
  const org = await mkUser('org', 'ORGANIZER')
  orgAddress = org.address
  const holder = await mkUser('holder', 'USER', over.holderWallet ?? 'yes')
  n += 1
  const event = await prisma.event.create({
    data: { network: NETWORK, slug: `cl-${uniq}`, title: 'Claim Test', startsAt: new Date(Date.now() + 864e5), organizerId: org.id, nftTaxon: 30_000 + n, royaltyBps: 500, platformBps: 250, ticketCount: 5, status: 'PUBLISHED' },
  })
  const nfTokenId = makeNftId(org.address, event.nftTaxon, n)
  const ticket = await prisma.ticket.create({
    // Held for the buyer in our records; the NFT is still in the organizer's account.
    data: { nfTokenId, network: NETWORK, eventId: event.id, ownerId: holder.id, ownerAddress: org.address, status: 'MINTED', ...over.ticket },
  })
  return { org, holder, event, ticket, nfTokenId }
}

async function cleanup() {
  const ev = { event: { slug: { startsWith: 'cl-' } } }
  await prisma.ticketClaim.deleteMany({ where: { ticket: ev } })
  await prisma.listing.deleteMany({ where: { ticket: ev } })
  await prisma.transfer.deleteMany({ where: { ticket: ev } })
  await prisma.ticket.deleteMany({ where: ev })
  await prisma.event.deleteMany({ where: { slug: { startsWith: 'cl-' } } })
  await prisma.wallet.deleteMany({ where: { user: { username: { startsWith: UTAG } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: UTAG } } })
}

beforeEach(async () => {
  uniq = Math.random().toString(36).slice(2, 7)
  await cleanup()
  Object.assign(fake, {
    permission: 'granted', holdsOrganizer: true, holderHoldsIt: false, submitted: [], cancelled: [], cancelThrows: false, cancelDelayMs: 0, delayMs: 0,
    result: () => ({ ok: true }), awaitResult: () => ({ ok: true }),
  })
})
afterEach(cleanup)
afterAll(async () => {
  await prisma.$disconnect()
})

const claim = (s: { nfTokenId: string; holder: { id: string } }, now = new Date()) =>
  startClaim({ nfTokenId: s.nfTokenId, holderId: s.holder.id, ledger, now })

describe('a successful claim', () => {
  it('creates ONE free offer, as the organizer, signed by the delegate, restricted to the holder, expiring soon', async () => {
    const s = await setup()
    const now = new Date()
    const out = await claim(s, now)

    expect(out.kind).toBe('ok')
    expect(fake.submitted).toHaveLength(1)
    const tx = fake.submitted[0]!
    expect(tx).toMatchObject({
      TransactionType: 'NFTokenCreateOffer',
      Account: s.org.address,
      Delegate: DELEGATE,
      NFTokenID: s.nfTokenId,
      Amount: '0',
      Destination: s.holder.address,
      Flags: 1,
    })
    const expiresMs = rippleTimeToUnixTime(tx.Expiration as number)
    expect(expiresMs).toBeGreaterThan(now.getTime())
    // Whole seconds on the ledger: up to one second past the exact figure.
    expect(expiresMs).toBeLessThanOrEqual(now.getTime() + CLAIM_TTL_SECONDS * 1000 + 1000)
    // The row records the very second the offer stops working.
    const row = await prisma.ticketClaim.findUniqueOrThrow({ where: { ticketId: s.ticket.id } })
    expect(row.expiresAt.getTime()).toBe(expiresMs)
  })

  it('records the claim: pending, the offer, the wallet it names, and when it lapses', async () => {
    const s = await setup()
    const out = await claim(s)
    const row = await prisma.ticketClaim.findUniqueOrThrow({ where: { ticketId: s.ticket.id } })
    expect(row).toMatchObject({ status: 'PENDING', holderId: s.holder.id, holderAddress: s.holder.address, network: NETWORK })
    expect(row.offerIndex).toBeTruthy()
    expect(out).toMatchObject({ kind: 'ok', claimId: row.id, offerIndex: row.offerIndex })
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })
})

describe('the destination is the VERIFIED wallet', () => {
  it('names the Wallet row\'s address, not whatever the legacy address column says', async () => {
    const s = await setup({ holderWallet: 'different' })
    expect((await claim(s)).kind).toBe('ok')
    expect(fake.submitted[0]!.Destination).toBe(s.holder.address)
  })
})

describe('the last check before signing', () => {
  it('stops an offer that would hand the ticket to the organizer\'s own account, and frees the claim', async () => {
    // The organizer holds a ticket "for themselves" in our records and has a wallet row: eligible on paper.
    const org = await mkUser('org', 'ORGANIZER')
    orgAddress = org.address
    n += 1
    const event = await prisma.event.create({
      data: { network: NETWORK, slug: `cl-${uniq}`, title: 'Self', startsAt: new Date(Date.now() + 864e5), organizerId: org.id, nftTaxon: 30_000 + n, royaltyBps: 500, platformBps: 250, ticketCount: 5, status: 'PUBLISHED' },
    })
    const nfTokenId = makeNftId(org.address, event.nftTaxon, n)
    const ticket = await prisma.ticket.create({ data: { nfTokenId, network: NETWORK, eventId: event.id, ownerId: org.id, ownerAddress: null, status: 'MINTED' } })
    const out = await startClaim({ nfTokenId, holderId: org.id, ledger, now: new Date() })
    expect(out).toMatchObject({ kind: 'refused', status: 500 })
    expect(fake.submitted).toHaveLength(0)
    expect((await prisma.ticketClaim.findUniqueOrThrow({ where: { ticketId: ticket.id } })).status).toBe('FAILED')
  })
})

describe('refusals (each leaves no offer and no live claim)', () => {
  const refused = async (s: Awaited<ReturnType<typeof setup>>, holderId = s.holder.id, code?: string) => {
    const out = await startClaim({ nfTokenId: s.nfTokenId, holderId, ledger, now: new Date() })
    expect(out.kind).toBe('refused')
    if (code && out.kind === 'refused') expect(out.code).toBe(code)
    expect(fake.submitted).toHaveLength(0)
    const row = await prisma.ticketClaim.findUnique({ where: { ticketId: s.ticket.id } })
    expect(row === null || row.status !== 'PENDING').toBe(true)
  }

  it('someone who is not the recorded holder', async () => {
    const s = await setup()
    const other = await mkUser('other')
    await refused(s, other.id, 'NOT_THE_HOLDER')
  })

  it('a ticket nobody holds in our records', async () => {
    const s = await setup({ ticket: { ownerId: null, ownerAddress: null } })
    await refused(s, s.holder.id, 'NO_HOLDER')
  })

  it('a holder with no verified wallet', async () => {
    const s = await setup({ holderWallet: 'no' })
    await refused(s, s.holder.id, 'NO_WALLET')
  })

  it('a ticket with an open listing', async () => {
    const s = await setup()
    await prisma.listing.create({
      data: { network: NETWORK, ticketId: s.ticket.id, sellerId: s.holder.id, sellerAddress: s.holder.address, priceDrops: 5_000_000n, platformFeeDrops: 0n, listPayloadUuid: `x:${uniq}`, status: 'ACTIVE', expiresAt: new Date(Date.now() + 1e6) },
    })
    await refused(s, s.holder.id, 'LISTED')
  })

  it('a ticket already claimed', async () => {
    const s = await setup()
    await prisma.ticketClaim.create({
      data: { network: NETWORK, ticketId: s.ticket.id, holderId: s.holder.id, holderAddress: s.holder.address, status: 'ACCEPTED', expiresAt: new Date() },
    })
    await refused(s, s.holder.id, 'ALREADY_CLAIMED')
  })

  it('a ticket already in the holder\'s own wallet', async () => {
    const s = await setup()
    await prisma.ticket.update({ where: { id: s.ticket.id }, data: { ownerAddress: s.holder.address } })
    await refused(s, s.holder.id, 'ALREADY_CLAIMED')
  })

  it('a ticket that has been admitted at the door', async () => {
    const s = await setup({ ticket: { status: 'REDEEMED' } })
    await refused(s, s.holder.id, 'NOT_CLAIMABLE')
  })

  it('an unknown ticket', async () => {
    const s = await setup()
    const out = await startClaim({ nfTokenId: 'AB'.repeat(32), holderId: s.holder.id, ledger, now: new Date() })
    expect(out).toMatchObject({ kind: 'refused', status: 404 })
  })

  it('when the organizer has not granted the offer permission', async () => {
    const s = await setup()
    fake.permission = 'absent'
    await refused(s, s.holder.id, 'NOT_GRANTED')
  })

  it('without calling an unreadable permission a refusal of the grant', async () => {
    const s = await setup()
    fake.permission = 'unknown'
    const out = await claim(s)
    expect(out).toMatchObject({ kind: 'refused', status: 503 })
    expect(fake.submitted).toHaveLength(0)
  })

  it('when the ledger says the organizer no longer holds it', async () => {
    const s = await setup()
    fake.holdsOrganizer = false
    await refused(s, s.holder.id, 'NOT_HELD')
  })

  it('but an unreadable ledger is not a "no": it carries on', async () => {
    const s = await setup()
    fake.holdsOrganizer = null
    expect((await claim(s)).kind).toBe('ok')
  })
})

describe('a failed offer', () => {
  it('marks the claim FAILED (so it can be tried again) and leaves nothing pending', async () => {
    const s = await setup()
    fake.awaitResult = () => ({ ok: false, code: 'tecINSUFFICIENT_RESERVE' })
    const out = await claim(s)
    expect(out.kind).toBe('refused')
    expect((await prisma.ticketClaim.findUniqueOrThrow({ where: { ticketId: s.ticket.id } })).status).toBe('FAILED')
    fake.awaitResult = () => ({ ok: true })
    expect((await claim(s)).kind).toBe('ok')
    expect((await prisma.ticketClaim.count({ where: { ticketId: s.ticket.id } }))).toBe(1)
  })

  it('a rejected submit also frees the claim', async () => {
    const s = await setup()
    fake.result = () => ({ ok: false, code: 'terNO_DELEGATE_PERMISSION' })
    const out = await claim(s)
    expect(out).toMatchObject({ kind: 'refused', code: 'NOT_GRANTED' })
    expect((await prisma.ticketClaim.findUniqueOrThrow({ where: { ticketId: s.ticket.id } })).status).toBe('FAILED')
  })
})

describe('a retried claim never makes a second offer', () => {
  it('asked again while the offer is live, it hands back the SAME offer', async () => {
    const s = await setup()
    const first = await claim(s)
    const second = await claim(s)
    expect(first.kind === 'ok' && second.kind === 'ok' && first.offerIndex === second.offerIndex).toBe(true)
    expect(second.kind === 'ok' && second.reused).toBe(true)
    expect(fake.submitted).toHaveLength(1)
    expect(await prisma.ticketClaim.count({ where: { ticketId: s.ticket.id } })).toBe(1)
  })

  it('two requests at once make ONE offer between them', async () => {
    const s = await setup()
    fake.delayMs = 40
    const [a, b] = await Promise.all([claim(s), claim(s)])
    expect(fake.submitted).toHaveLength(1)
    expect([a.kind, b.kind]).toContain('ok')
    expect(await prisma.ticketClaim.count({ where: { ticketId: s.ticket.id } })).toBe(1)
  })

  it('after the offer lapsed, cancels the old one FIRST and replaces it on the same row', async () => {
    const s = await setup()
    const t0 = new Date()
    const first = await claim(s, t0)
    const later = new Date(t0.getTime() + (CLAIM_TTL_SECONDS + 5) * 1000)
    const second = await claim(s, later)

    expect(second.kind).toBe('ok')
    expect(fake.cancelled).toEqual([[first.kind === 'ok' ? first.offerIndex : '']])
    expect(fake.submitted).toHaveLength(2)
    expect(second.kind === 'ok' && first.kind === 'ok' && second.offerIndex !== first.offerIndex).toBe(true)
    expect(await prisma.ticketClaim.count({ where: { ticketId: s.ticket.id } })).toBe(1)
    const row = await prisma.ticketClaim.findUniqueOrThrow({ where: { ticketId: s.ticket.id } })
    expect(row.status).toBe('PENDING')
    expect(row.expiresAt.getTime()).toBeGreaterThan(later.getTime())
  })

  it('two retries at once on a lapsed offer replace it ONCE', async () => {
    const s = await setup()
    const t0 = new Date()
    await claim(s, t0)
    const later = new Date(t0.getTime() + (CLAIM_TTL_SECONDS + 5) * 1000)
    // Slow the cancel so both requests have read the lapsed row before either replaces it.
    fake.cancelDelayMs = 60
    await Promise.all([claim(s, later), claim(s, later)])
    expect(fake.submitted).toHaveLength(2) // the original, and exactly one replacement
    expect(await prisma.ticketClaim.count({ where: { ticketId: s.ticket.id } })).toBe(1)
  })

  it('does not make a new offer if cancelling the lapsed one fails: the old one must be dealt with first', async () => {
    const s = await setup()
    const t0 = new Date()
    await claim(s, t0)
    fake.cancelThrows = true
    const out = await claim(s, new Date(t0.getTime() + (CLAIM_TTL_SECONDS + 5) * 1000))
    expect(out.kind).toBe('refused')
    expect(fake.submitted).toHaveLength(1)
  })
})

describe('expireClaims: an unaccepted offer is cancelled when it lapses', () => {
  const lapsed = async (s: Awaited<ReturnType<typeof setup>>) => {
    const t0 = new Date()
    await claim(s, t0)
    return new Date(t0.getTime() + CLAIM_TTL_SECONDS * 1000 + CLAIM_GRACE_MS + 1000)
  }

  it('cancels the offer and marks the claim EXPIRED', async () => {
    const s = await setup()
    const row0 = await lapsed(s)
    const offer = (await prisma.ticketClaim.findUniqueOrThrow({ where: { ticketId: s.ticket.id } })).offerIndex!
    expect(await expireClaims(ledger, row0)).toBe(1)
    expect(fake.cancelled).toEqual([[offer]])
    expect((await prisma.ticketClaim.findUniqueOrThrow({ where: { ticketId: s.ticket.id } })).status).toBe('EXPIRED')
  })

  it('leaves a claim alone before it lapses, and during the grace period', async () => {
    const s = await setup()
    const t0 = new Date()
    await claim(s, t0)
    expect(await expireClaims(ledger, new Date(t0.getTime() + 60_000))).toBe(0)
    expect(await expireClaims(ledger, new Date(t0.getTime() + CLAIM_TTL_SECONDS * 1000 + CLAIM_GRACE_MS - 1000))).toBe(0)
    expect(fake.cancelled).toHaveLength(0)
  })

  it('does not cancel a claim the holder accepted at the last moment: it records the handover instead', async () => {
    const s = await setup()
    const when = await lapsed(s)
    fake.holderHoldsIt = true
    await expireClaims(ledger, when)
    expect(fake.cancelled).toHaveLength(0)
    expect((await prisma.ticketClaim.findUniqueOrThrow({ where: { ticketId: s.ticket.id } })).status).toBe('ACCEPTED')
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: s.ticket.id } })).ownerAddress).toBe(s.holder.address)
  })

  it('keeps the claim pending to try again if the cancel fails', async () => {
    const s = await setup()
    const when = await lapsed(s)
    fake.cancelThrows = true
    expect(await expireClaims(ledger, when)).toBe(0)
    expect((await prisma.ticketClaim.findUniqueOrThrow({ where: { ticketId: s.ticket.id } })).status).toBe('PENDING')
    fake.cancelThrows = false
    expect(await expireClaims(ledger, when)).toBe(1)
  })

  it('expires a claim that never reached the ledger without cancelling anything', async () => {
    const s = await setup()
    await prisma.ticketClaim.create({
      data: { network: NETWORK, ticketId: s.ticket.id, holderId: s.holder.id, holderAddress: s.holder.address, status: 'PENDING', expiresAt: new Date(Date.now() - 3_600_000) },
    })
    expect(await expireClaims(ledger, new Date())).toBe(1)
    expect(fake.cancelled).toHaveLength(0)
  })

  it('never touches a claim that is already accepted', async () => {
    const s = await setup()
    await prisma.ticketClaim.create({
      data: { network: NETWORK, ticketId: s.ticket.id, holderId: s.holder.id, holderAddress: s.holder.address, status: 'ACCEPTED', offerIndex: 'AA'.repeat(32), expiresAt: new Date(Date.now() - 3_600_000) },
    })
    expect(await expireClaims(ledger, new Date())).toBe(0)
  })
})
