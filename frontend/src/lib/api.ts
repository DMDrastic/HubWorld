import { z } from 'zod'

/**
 * Responses are Zod-parsed at the boundary, same rule the backend applies to
 * its inputs — a shape change on the server surfaces here as a clear error
 * instead of an `undefined` deep in a component.
 */
export const HealthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  db: z.enum(['connected', 'unavailable']),
  uptime: z.number(),
  timestamp: z.string(),
})

export const EventSummarySchema = z.object({
  slug: z.string(),
  title: z.string(),
  venue: z.string().nullable(),
  startsAt: z.string(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'SOLD_OUT', 'COMPLETED', 'CANCELLED']),
  ticketCount: z.number(),
  ticketsMinted: z.number(),
  organizer: z.object({
    username: z.string(),
    displayName: z.string().nullable(),
  }),
})

export const EventListSchema = z.object({ events: z.array(EventSummarySchema) })

export const UserSchema = z.object({
  username: z.string(),
  displayName: z.string().nullable(),
  xrplAddress: z.string(),
  createdAt: z.string(),
  ticketsOwned: z.number(),
})

export type Health = z.infer<typeof HealthSchema>
export type EventSummary = z.infer<typeof EventSummarySchema>
export type User = z.infer<typeof UserSchema>

export class ApiError extends Error {
  // Written out longhand rather than as a constructor parameter property,
  // which `erasableSyntaxOnly` disallows.
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

// Relative path: Vite proxies /api to the backend in dev (see vite.config.ts).
const API_BASE = '/api'

type RequestOpts = {
  method?: 'GET' | 'POST'
  body?: unknown
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  opts: RequestOpts = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      // The session is an httpOnly cookie — no script can read it, so there is
      // no token to attach. The browser sends it because of this flag.
      credentials: 'same-origin',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
  } catch {
    throw new ApiError('Could not reach the backend. Is `npm run dev` running in backend/?')
  }

  if (!res.ok) {
    // The API reports failures as { error, details? } — surface that, not a bare code.
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(body?.error ?? `Backend returned ${res.status}`, res.status)
  }

  const parsed = schema.safeParse(await res.json())
  if (!parsed.success) {
    throw new ApiError(`Unexpected response shape from ${path}`)
  }

  return parsed.data
}

export function fetchHealth(): Promise<Health> {
  return request('/health', HealthSchema)
}

export async function fetchEvents(): Promise<EventSummary[]> {
  return (await request('/events', EventListSchema)).events
}

export function lookupUser(handle: string): Promise<User> {
  return request(`/users/${encodeURIComponent(handle.replace(/^@/, ''))}`, UserSchema)
}

// --------------------------------------------------------------- sign-in --

export const AuthUserSchema = z.object({
  username: z.string(),
  displayName: z.string().nullable(),
  xrplAddress: z.string(),
})

export const SignInCreatedSchema = z.object({
  uuid: z.string(),
  next: z.string(),
  qrPng: z.string(),
  expiresAt: z.string(),
  mode: z.enum(['live', 'stub']),
})

// No token field: the session arrives as an httpOnly cookie the page cannot
// read. Being authenticated is something the server tells us, not something we
// hold.
const AuthenticatedSchema = z.object({
  state: z.literal('authenticated'),
  expiresAt: z.string(),
  user: AuthUserSchema,
})

export const SignInPollSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending') }),
  z.object({ state: z.literal('rejected') }),
  z.object({ state: z.literal('expired') }),
  z.object({ state: z.literal('consumed') }),
  z.object({ state: z.literal('needs_username'), address: z.string() }),
  AuthenticatedSchema,
])

export type SignInCreated = z.infer<typeof SignInCreatedSchema>
export type SignInPoll = z.infer<typeof SignInPollSchema>
export type AuthUser = z.infer<typeof AuthUserSchema>

export function createSignIn(): Promise<SignInCreated> {
  return request('/auth/signin', SignInCreatedSchema, { method: 'POST' })
}

export function pollSignIn(uuid: string): Promise<SignInPoll> {
  return request(`/auth/signin/${encodeURIComponent(uuid)}`, SignInPollSchema)
}

export function claimUsername(uuid: string, username: string, displayName?: string) {
  return request('/auth/claim', AuthenticatedSchema, {
    method: 'POST',
    body: { uuid, username: username.replace(/^@/, ''), displayName: displayName || undefined },
  })
}

export function fetchMe(): Promise<User> {
  return request('/auth/me', UserSchema)
}

export async function signOut(): Promise<void> {
  await fetch(`${API_BASE}/auth/signout`, {
    method: 'POST',
    credentials: 'same-origin',
  }).catch(() => undefined)
}

/** Stub mode only — stands in for a human signing in the Xaman app. */
export function simulateSign(uuid: string, outcome: 'sign' | 'reject' = 'sign') {
  return request(
    '/auth/signin/simulate',
    z.object({ simulated: z.string(), account: z.string() }),
    { method: 'POST', body: { uuid, outcome } },
  )
}

// ------------------------------------------------------------------ mint --

export const MintCreatedSchema = z.object({
  uuid: z.string(),
  next: z.string(),
  qrPng: z.string(),
  expiresAt: z.string(),
  mode: z.enum(['live', 'stub']),
})

export const MintedTicketSchema = z.object({
  id: z.string(),
  nfTokenId: z.string(),
  seat: z.string().nullable(),
  tier: z.string().nullable(),
  status: z.string(),
  ownerAddress: z.string().nullable(),
  event: z.object({ slug: z.string(), title: z.string() }),
})

export const MintPollSchema = z.discriminatedUnion('state', [
  // `signed` marks the gap between a signature and ledger validation — the
  // NFTokenID does not exist until the transaction is in a validated ledger.
  z.object({ state: z.literal('pending'), signed: z.boolean().optional() }),
  z.object({ state: z.literal('rejected') }),
  z.object({ state: z.literal('expired') }),
  z.object({ state: z.literal('failed'), reason: z.string() }),
  z.object({ state: z.literal('minted'), ticket: MintedTicketSchema.nullable() }),
])

export type MintCreated = z.infer<typeof MintCreatedSchema>
export type MintPoll = z.infer<typeof MintPollSchema>
export type MintedTicket = z.infer<typeof MintedTicketSchema>

export function createMint(
  slug: string,
  body: { seat?: string; tier?: string } = {},
): Promise<MintCreated> {
  return request(`/events/${encodeURIComponent(slug)}/mint`, MintCreatedSchema, {
    method: 'POST',
    body,
  })
}

export function pollMint(uuid: string): Promise<MintPoll> {
  return request(`/mint/${encodeURIComponent(uuid)}`, MintPollSchema)
}

// -------------------------------------------------------------- inventory --

export const OwnedTicketSchema = z.object({
  nfTokenId: z.string(),
  seat: z.string().nullable(),
  tier: z.string().nullable(),
  status: z.string(),
  syncedAt: z.string().nullable(),
  // null when unverified; false means the ledger disagrees with our cache.
  onLedger: z.boolean().nullable(),
  event: z.object({ slug: z.string(), title: z.string(), startsAt: z.string() }),
})

export const InventorySchema = z.object({
  address: z.string(),
  verified: z.boolean(),
  tickets: z.array(OwnedTicketSchema),
})

export type OwnedTicket = z.infer<typeof OwnedTicketSchema>
export type Inventory = z.infer<typeof InventorySchema>

export function fetchInventory(verify = false): Promise<Inventory> {
  return request(`/tickets/mine?verify=${verify}`, InventorySchema)
}

// ------------------------------------------------------------------ gifts --

export const GiftCreatedSchema = z.object({
  giftId: z.string(),
  uuid: z.string(),
  next: z.string(),
  qrPng: z.string(),
  mode: z.enum(['live', 'stub']),
  to: z.object({ username: z.string(), xrplAddress: z.string() }).optional(),
})

const GiftTicketSchema = z.object({
  nfTokenId: z.string(),
  seat: z.string().nullable(),
  tier: z.string().nullable(),
  event: z.object({ slug: z.string(), title: z.string() }),
})

/**
 * Gift states mirror the two-signature reality: pending_offer (sender has not
 * signed) → offered (live on-ledger, recipient's turn) → accepting → accepted.
 */
export const GiftStateSchema = z.object({
  state: z.enum([
    'pending_offer',
    'offered',
    'accepting',
    'accepted',
    'declined',
    'cancelling',
    'cancelled',
    'expired',
    'failed',
  ]),
  giftId: z.string(),
  role: z.enum(['sender', 'recipient']),
  from: z.string(),
  to: z.string(),
  ticket: GiftTicketSchema,
  signed: z.boolean().optional(),
  awaitingRecipient: z.boolean().optional(),
  reason: z.string().optional(),
})

export const GiftListSchema = z.object({
  gifts: z.array(
    z.object({
      giftId: z.string(),
      state: z.string(),
      from: z.string(),
      to: z.string(),
      expiresAt: z.string(),
      ticket: GiftTicketSchema,
    }),
  ),
})

export type GiftCreated = z.infer<typeof GiftCreatedSchema>
export type GiftState = z.infer<typeof GiftStateSchema>
export type GiftListItem = z.infer<typeof GiftListSchema>['gifts'][number]

export function createGift(nfTokenId: string, to: string): Promise<GiftCreated> {
  return request(`/tickets/${encodeURIComponent(nfTokenId)}/gift`, GiftCreatedSchema, {
    method: 'POST',
    body: { to: to.replace(/^@/, '') },
  })
}

export function acceptGift(giftId: string): Promise<GiftCreated> {
  return request(`/gifts/${encodeURIComponent(giftId)}/accept`, GiftCreatedSchema, {
    method: 'POST',
  })
}

/**
 * Withdraw a gift. Returns a Xaman payload when the offer is already live
 * on-ledger (it takes a signed NFTokenCancelOffer to remove), or just the
 * settled state when nothing was ever signed.
 */
export const GiftCancelSchema = z.union([
  GiftCreatedSchema,
  z.object({ state: z.literal('cancelled'), giftId: z.string() }),
])

export type GiftCancel = z.infer<typeof GiftCancelSchema>

export function cancelGift(giftId: string): Promise<GiftCancel> {
  return request(`/gifts/${encodeURIComponent(giftId)}/cancel`, GiftCancelSchema, {
    method: 'POST',
  })
}

export function pollGift(giftId: string): Promise<GiftState> {
  return request(`/gifts/${encodeURIComponent(giftId)}`, GiftStateSchema)
}

export function fetchGifts(role: 'incoming' | 'outgoing' = 'incoming'): Promise<GiftListItem[]> {
  return request(`/gifts?role=${role}`, GiftListSchema).then((r) => r.gifts)
}

// --------------------------------------------------------------- listings --

/**
 * Drops are strings end to end. The backend serialises BigInt as strings and the
 * client must not parse them into JS numbers — above 2^53 that silently loses
 * precision, and this is money.
 */
export const ListingSchema = z.object({
  listingId: z.string(),
  state: z.enum([
    'pending_offer',
    'active',
    'buyer_pending',
    'settling',
    'sold',
    'cancelling',
    'cancelled',
    'expired',
    'failed',
  ]),
  priceDrops: z.string(),
  platformFeeDrops: z.string(),
  buyerPaysDrops: z.string(),
  seller: z.string(),
  buyer: z.string().nullable(),
  ticket: z.object({
    nfTokenId: z.string(),
    seat: z.string().nullable(),
    tier: z.string().nullable(),
    event: z.object({ slug: z.string(), title: z.string() }),
  }),
  signed: z.boolean().optional(),
  reason: z.string().optional(),
  brokerTxHash: z.string().optional(),
  role: z.enum(['seller', 'buyer']).optional(),
})

export const ListingCreatedSchema = z.object({
  listingId: z.string(),
  uuid: z.string(),
  next: z.string(),
  qrPng: z.string(),
  mode: z.enum(['live', 'stub']),
  priceDrops: z.string().optional(),
  platformFeeDrops: z.string().optional(),
  paysDrops: z.string().optional(),
})

export type Listing = z.infer<typeof ListingSchema>
export type ListingCreated = z.infer<typeof ListingCreatedSchema>

/** 1 XRP = 1_000_000 drops. Formats for display only — never for arithmetic. */
export function dropsToXrp(drops: string): string {
  const d = BigInt(drops)
  const whole = d / 1_000_000n
  const frac = (d % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

export function xrpToDrops(xrp: string): string {
  const [whole = '0', frac = ''] = xrp.trim().split('.')
  const padded = (frac + '000000').slice(0, 6)
  return (BigInt(whole || '0') * 1_000_000n + BigInt(padded || '0')).toString()
}

export function createListing(nfTokenId: string, priceDrops: string): Promise<ListingCreated> {
  return request(`/tickets/${encodeURIComponent(nfTokenId)}/list`, ListingCreatedSchema, {
    method: 'POST',
    body: { priceDrops },
  })
}

export function buyListing(listingId: string): Promise<ListingCreated> {
  return request(`/listings/${encodeURIComponent(listingId)}/buy`, ListingCreatedSchema, {
    method: 'POST',
  })
}

export const ListingCancelSchema = z.union([
  ListingCreatedSchema,
  z.object({ state: z.literal('cancelled'), listingId: z.string() }),
])

export function cancelListing(listingId: string): Promise<z.infer<typeof ListingCancelSchema>> {
  return request(`/listings/${encodeURIComponent(listingId)}/cancel`, ListingCancelSchema, {
    method: 'POST',
  })
}

export function pollListing(listingId: string): Promise<Listing> {
  return request(`/listings/${encodeURIComponent(listingId)}`, ListingSchema)
}

export function fetchMarket(): Promise<Listing[]> {
  return request('/listings', z.object({ listings: z.array(ListingSchema) })).then((r) => r.listings)
}

export function fetchMyListings(): Promise<Listing[]> {
  return request('/listings/mine', z.object({ listings: z.array(ListingSchema) })).then(
    (r) => r.listings,
  )
}

// --------------------------------------------------------------- auctions --

/** Mirrors Prisma's BidStatus. Only funded statuses may set the price. */
export const BidStatusSchema = z.enum([
  'PENDING',
  'COMMITTED',
  'OUTBID',
  'WON',
  'LOST',
  'CANCELLED',
  'FAILED',
])

export const BidSchema = z.object({
  id: z.string(),
  /** Drops as a string — never parse into a JS number. */
  amountDrops: z.string(),
  placedAt: z.string(),
  bidder: z.string(),
  status: BidStatusSchema,
})

export const AuctionSchema = z.object({
  id: z.string(),
  eventTitle: z.string(),
  eventSlug: z.string(),
  state: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  reserveDrops: z.string(),
  ticket: z.object({
    nfTokenId: z.string(),
    seat: z.string().nullable(),
    tier: z.string().nullable(),
  }),
  bids: z.array(BidSchema),
})

export const AuctionSummarySchema = z.object({
  id: z.string(),
  eventSlug: z.string(),
  eventTitle: z.string(),
  state: z.string(),
  endsAt: z.string(),
  reserveDrops: z.string(),
  topBidDrops: z.string(),
  bidCount: z.number(),
})

export type Bid = z.infer<typeof BidSchema>
export type Auction = z.infer<typeof AuctionSchema>
export type AuctionSummary = z.infer<typeof AuctionSummarySchema>

export function fetchAuction(slug: string): Promise<Auction> {
  return request(`/events/${encodeURIComponent(slug)}/auction`, AuctionSchema)
}

/** Which events have a live auction, so a list can mark them in one request. */
export function fetchAuctions(): Promise<AuctionSummary[]> {
  return request('/auctions', z.object({ auctions: z.array(AuctionSummarySchema) })).then(
    (r) => r.auctions,
  )
}

export const BidCreatedSchema = z.object({
  bidId: z.string(),
  uuid: z.string(),
  next: z.string(),
  qrPng: z.string(),
  mode: z.enum(['live', 'stub']),
  amountDrops: z.string(),
})

export const BidStateSchema = z.object({
  bidId: z.string(),
  state: z.enum([
    'pending',
    'committed',
    'outbid',
    'won',
    'lost',
    'cancelled',
    'failed',
  ]),
  amountDrops: z.string(),
  bidder: z.string(),
  signed: z.boolean().optional(),
  reason: z.string().optional(),
})

export type BidCreated = z.infer<typeof BidCreatedSchema>
export type BidState = z.infer<typeof BidStateSchema>

export function placeBid(auctionId: string, amountDrops: string): Promise<BidCreated> {
  return request(`/auctions/${encodeURIComponent(auctionId)}/bid`, BidCreatedSchema, {
    method: 'POST',
    body: { amountDrops },
  })
}

export function pollBid(bidId: string): Promise<BidState> {
  return request(`/bids/${encodeURIComponent(bidId)}`, BidStateSchema)
}

// There is deliberately no token storage here.
//
// The session lives in an httpOnly SameSite=Lax cookie set by the backend, so
// this page cannot read it and an XSS bug cannot exfiltrate it. "Am I signed
// in?" is answered by calling /auth/me and seeing whether it succeeds — not by
// inspecting anything the page holds.
export const LEGACY_TOKEN_KEY = 'hubworld.token'

/** One-time cleanup of tokens left in localStorage by the old scheme. */
export function purgeLegacyToken(): void {
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY)
  } catch {
    // Private-mode browsers can throw on storage access; nothing to do.
  }
}
