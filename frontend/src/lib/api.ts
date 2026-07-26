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
  token?: string | null
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  opts: RequestOpts = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers,
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

const AuthenticatedSchema = z.object({
  state: z.literal('authenticated'),
  token: z.string(),
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

export function fetchMe(token: string): Promise<User> {
  return request('/auth/me', UserSchema, { token })
}

export async function signOut(token: string): Promise<void> {
  await fetch(`${API_BASE}/auth/signout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
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

// Token storage. localStorage is readable by any script on the page, so an XSS
// bug leaks the session. Acceptable for local dev; before production, move to
// an httpOnly, SameSite cookie issued by the backend.
const TOKEN_KEY = 'hubworld.token'

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}
