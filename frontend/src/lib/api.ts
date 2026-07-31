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
  // Null is the normal state, not an error — an event nobody has uploaded art
  // for renders a generated fallback rather than a broken image.
  imageUrl: z.string().nullable().optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'SOLD_OUT', 'COMPLETED', 'CANCELLED']),
  ticketCount: z.number(),
  ticketsMinted: z.number(),
  organizer: z.object({
    username: z.string(),
    displayName: z.string().nullable(),
  }),
})

export const EventListSchema = z.object({ events: z.array(EventSummarySchema) })

export const RoleSchema = z.enum(['USER', 'ORGANIZER', 'ADMIN'])

export const UserSchema = z.object({
  username: z.string(),
  displayName: z.string().nullable(),
  xrplAddress: z.string(),
  createdAt: z.string(),
  role: RoleSchema,
  ticketsOwned: z.number(),
})

export type Role = z.infer<typeof RoleSchema>

/** Organizer features are hidden, not merely disabled, for regular users. */
export function isOrganizer(role: Role): boolean {
  return role === 'ORGANIZER' || role === 'ADMIN'
}

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
  /** Auctions are secondary-market only: sold-out events, non-organizer holders. */
  canAuction: z.boolean(),
  auctionBlockedReason: z.string().nullable(),
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

export const AuctionOpenedSchema = z.object({
  auctionId: z.string(),
  listingId: z.string(),
  uuid: z.string(),
  next: z.string(),
  qrPng: z.string(),
  mode: z.enum(['live', 'stub']),
  reserveDrops: z.string(),
  sellOfferDrops: z.string(),
  endsAt: z.string(),
})

export type AuctionOpened = z.infer<typeof AuctionOpenedSchema>

/**
 * Opening an auction creates the bidding rules AND the holder's sell offer in
 * one signature. The returned listingId is what to poll — the auction goes LIVE
 * when that offer reaches the ledger.
 */
export function openAuction(
  nfTokenId: string,
  reserveDrops: string,
  minutes: number,
): Promise<AuctionOpened> {
  return request(`/tickets/${encodeURIComponent(nfTokenId)}/auction`, AuctionOpenedSchema, {
    method: 'POST',
    body: { reserveDrops, minutes },
  })
}

export function pollBid(bidId: string): Promise<BidState> {
  return request(`/bids/${encodeURIComponent(bidId)}`, BidStateSchema)
}

// -------------------------------------------------------------- check-in --

export const CheckInCreatedSchema = z.object({
  checkInId: z.string(),
  uuid: z.string(),
  next: z.string(),
  qrPng: z.string(),
  expiresAt: z.string(),
  mode: z.enum(['live', 'stub']),
  event: z.object({ slug: z.string(), title: z.string() }),
})

export const CheckInStateSchema = z.object({
  checkInId: z.string(),
  state: z.enum(['pending', 'redeemed', 'rejected', 'expired', 'no_ticket', 'already_used']),
  holder: z.string().nullable(),
  ticket: z
    .object({ seat: z.string().nullable(), tier: z.string().nullable(), nfTokenId: z.string() })
    .nullable(),
  reason: z.string().optional(),
  redeemedAt: z.string().optional(),
})

export const DoorSchema = z.object({
  event: z.object({ slug: z.string(), title: z.string() }),
  admitted: z.number(),
  issued: z.number(),
  recent: z.array(
    z.object({
      holder: z.string().nullable(),
      seat: z.string().nullable(),
      tier: z.string().nullable(),
      redeemedAt: z.string().nullable(),
    }),
  ),
})

export type CheckInCreated = z.infer<typeof CheckInCreatedSchema>
export type CheckInState = z.infer<typeof CheckInStateSchema>
export type Door = z.infer<typeof DoorSchema>

export function startCheckIn(slug: string): Promise<CheckInCreated> {
  return request(`/events/${encodeURIComponent(slug)}/checkin`, CheckInCreatedSchema, {
    method: 'POST',
  })
}

export function pollCheckIn(uuid: string): Promise<CheckInState> {
  return request(`/checkin/${encodeURIComponent(uuid)}`, CheckInStateSchema)
}

export const StaffListSchema = z.object({
  staff: z.array(z.object({ username: z.string() })),
})

export const DoorEventsSchema = z.object({
  events: z.array(
    z.object({ slug: z.string(), title: z.string(), via: z.enum(['organizer', 'staff']) }),
  ),
})

export type DoorEvent = z.infer<typeof DoorEventsSchema>['events'][number]

/** Events this account may work the door for — organizer OR added staff. */
export function fetchDoorEvents(): Promise<DoorEvent[]> {
  return request('/door/events', DoorEventsSchema).then((r) => r.events)
}

export function fetchStaff(slug: string): Promise<Array<{ username: string }>> {
  return request(`/events/${encodeURIComponent(slug)}/staff`, StaffListSchema).then((r) => r.staff)
}

export function addStaff(slug: string, username: string) {
  return request(
    `/events/${encodeURIComponent(slug)}/staff`,
    z.object({ staff: z.string(), event: z.string() }),
    { method: 'POST', body: { username: username.replace(/^@/, '') } },
  )
}

export function removeStaff(slug: string, username: string) {
  return request(
    `/events/${encodeURIComponent(slug)}/staff/remove`,
    z.object({ removed: z.string() }),
    { method: 'POST', body: { username: username.replace(/^@/, '') } },
  )
}

export function fetchDoor(slug: string): Promise<Door> {
  return request(`/events/${encodeURIComponent(slug)}/door`, DoorSchema)
}

// ------------------------------------------------------------ organizers --

export const PolicySchema = z.object({
  platformBps: z.number(),
  maxRoyaltyBps: z.number(),
})

export const OrganizerStatusSchema = z.object({
  role: RoleSchema,
  application: z
    .object({
      state: z.enum(['pending', 'approved', 'rejected']),
      orgName: z.string(),
      submittedAt: z.string(),
      reviewNote: z.string().nullable(),
    })
    .nullable(),
})

export const ApplicationListSchema = z.object({
  applications: z.array(
    z.object({
      id: z.string(),
      applicant: z.string(),
      orgName: z.string(),
      contact: z.string(),
      pitch: z.string(),
      state: z.string(),
      submittedAt: z.string(),
    }),
  ),
})

export const CreatedEventSchema = z.object({
  slug: z.string(),
  title: z.string(),
  startsAt: z.string(),
  ticketCount: z.number(),
  royaltyBps: z.number(),
  platformBps: z.number(),
  nftTaxon: z.number(),
})

export type Policy = z.infer<typeof PolicySchema>
export type OrganizerStatus = z.infer<typeof OrganizerStatusSchema>
export type PendingApplication = z.infer<typeof ApplicationListSchema>['applications'][number]

export function fetchPolicy(): Promise<Policy> {
  return request('/policy', PolicySchema)
}

export function fetchOrganizerStatus(): Promise<OrganizerStatus> {
  return request('/organizers/me', OrganizerStatusSchema)
}

export function applyToOrganize(body: {
  orgName: string
  contact: string
  pitch: string
}): Promise<{ state: string }> {
  return request('/organizers/apply', z.object({ state: z.string() }), {
    method: 'POST',
    body,
  })
}

export function fetchApplications(): Promise<PendingApplication[]> {
  return request('/admin/organizer-applications?state=pending', ApplicationListSchema).then(
    (r) => r.applications,
  )
}

export function reviewApplication(
  id: string,
  decision: 'approve' | 'reject',
  note?: string,
): Promise<{ state: string }> {
  return request(
    `/admin/organizer-applications/${encodeURIComponent(id)}/review`,
    z.object({ state: z.string() }),
    { method: 'POST', body: { decision, note } },
  )
}

/** Note the absence of platformBps: it is policy, so the form cannot set it. */
export function createEvent(body: {
  title: string
  venue?: string
  startsAt: string
  ticketCount: number
  royaltyBps: number
}): Promise<z.infer<typeof CreatedEventSchema>> {
  return request('/events', CreatedEventSchema, { method: 'POST', body })
}

const UploadedImageSchema = z.object({ slug: z.string(), imageUrl: z.string().nullable() })

/**
 * Upload an event poster.
 *
 * Sends the file as the raw body rather than multipart, matching what the API
 * expects — no FormData, and nothing to parse server-side. It cannot go through
 * `request`, which JSON-encodes everything.
 *
 * The browser sets `Content-Type` from the File itself, but the server does not
 * trust it: it reads the magic bytes and refuses a file that disagrees with its
 * own declared type. So a wrong type here is a clear 400, not a corrupt bucket.
 */
export async function uploadEventImage(
  slug: string,
  file: File,
): Promise<z.infer<typeof UploadedImageSchema>> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}/events/${encodeURIComponent(slug)}/image`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': file.type },
      credentials: 'same-origin',
      body: file,
    })
  } catch {
    throw new ApiError('Could not reach the backend.')
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(body?.error ?? `Upload failed (${res.status})`, res.status)
  }
  const parsed = UploadedImageSchema.safeParse(await res.json())
  if (!parsed.success) throw new ApiError('Unexpected response shape from image upload')
  return parsed.data
}

/** What the server accepts. Mirrored here only to fail fast in the picker. */
export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp'
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024

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
