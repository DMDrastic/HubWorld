import 'dotenv/config'
import { z } from 'zod'

/**
 * Every environment variable the backend reads passes through this schema.
 * Parsed once at startup so a misconfigured deploy fails loudly here rather
 * than as an undefined halfway through a request.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(4000),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),

  // Xaman credentials. Both optional: without them the app runs in stub mode
  // so the sign-in loop is developable before you have a developer account.
  // The SECRET is backend-only and must never be exposed to the frontend.
  XAMAN_API_KEY: z.string().min(1).optional(),
  XAMAN_API_SECRET: z.string().min(1).optional(),

  // XRPL network. Everything is testnet until explicitly told otherwise —
  // minting on mainnet costs real XRP and cannot be undone.
  XRPL_NETWORK: z.enum(['testnet', 'devnet', 'mainnet']).default('testnet'),

  // Hubworld's broker account seed. This is the ONE key Hubworld holds, and it
  // exists solely to sign the brokered NFTokenAcceptOffer that settles a sale.
  // It is never a user's key, it never custodies sale funds, and it must never
  // reach the frontend bundle. Optional: without it, listings can still be
  // created and browsed, but sales cannot settle.
  PLATFORM_SEED: z.string().min(1).optional(),

  // Hubworld's cut of every resale, in basis points. This is PLATFORM POLICY and
  // must never be organizer-supplied: an organizer choosing their own platform
  // fee would choose zero. Capped so a misconfigured deploy cannot quietly take
  // a punitive share of someone's sale.
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(1000).default(250),

  // Ceiling on the royalty an organizer may set for themselves. The royalty is
  // theirs to choose, but an unbounded one makes resale pointless and the ticket
  // effectively non-transferable — which defeats the product.
  MAX_ROYALTY_BPS: z.coerce.number().int().min(0).max(5000).default(2000),

  // Shared secret in the Xaman webhook URL. Its presence switches payload
  // resolution from polling Xaman to waiting for their callback, which is the
  // difference between one Xaman request per payload and one every 2.5s per
  // waiting user. Unset in dev, where there is no public URL to call back to.
  XAMAN_WEBHOOK_SECRET: z.string().min(16).optional(),

  // Supabase Storage, for event posters. Render's filesystem is ephemeral, so
  // uploads cannot live on disk. All optional: without them the upload route
  // answers 503 and everything else works, so dev needs no bucket.
  //
  // The SERVICE key bypasses row-level security, so it is backend-only and must
  // never reach the bundle — the same rule as XAMAN_API_SECRET.
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_KEY: z.string().min(1).optional(),
  SUPABASE_BUCKET: z.string().min(1).default('event-images'),

  // Directory holding the built frontend (`frontend/dist`). When set, this
  // process serves the app as well as the API, from ONE origin.
  //
  // That is not a convenience — it is what the frontend already requires. It
  // calls a relative `/api` and opens its socket with a bare `io()`, and the
  // session cookie is `SameSite=Lax`, which stops being sent on XHR the moment
  // the API is a different site from the app. Splitting them across two hosts
  // breaks auth; the fix is one origin, not `SameSite=None`.
  //
  // Unset in dev, where Vite serves the app on :5173 and proxies /api here.
  WEB_DIST: z.string().min(1).optional(),
})

const parsed = EnvSchema.safeParse(process.env)

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
  console.error(`Invalid environment configuration:\n${details}\n`)
  console.error('Copy .env.example to .env and fill in the missing values.')
  process.exit(1)
}

export const env = parsed.data
export type Env = typeof env

/**
 * 'live' only when both Xaman credentials are present. Everything downstream
 * branches on this rather than re-checking the individual keys.
 */
export const xamanMode: 'live' | 'stub' =
  env.XAMAN_API_KEY && env.XAMAN_API_SECRET ? 'live' : 'stub'

if (xamanMode === 'stub') {
  console.warn(
    'XAMAN_API_KEY/SECRET not set — sign-in running in STUB mode (no real signatures).',
  )
}

if (xamanMode === 'stub' && env.NODE_ENV === 'production') {
  console.error('Refusing to start: stub sign-in mode is not permitted in production.')
  process.exit(1)
}

/**
 * Whether Hubworld can broker a sale. Listings work without it; settlement does
 * not, because settlement requires our signature.
 */
export const brokerMode: 'live' | 'disabled' = env.PLATFORM_SEED ? 'live' : 'disabled'

/**
 * Whether Xaman calls us back when a payload resolves.
 *
 * Off means every poll asks Xaman directly — correct, but the shape that earned
 * us a 429. On means we wait to be told, and only ask Xaman when there is a
 * concrete reason to.
 */
export const webhookMode: 'live' | 'disabled' = env.XAMAN_WEBHOOK_SECRET ? 'live' : 'disabled'

/**
 * Whether an organizer can upload an event poster. Events work fine without it —
 * a missing image renders a generated fallback, which is the normal state for an
 * event nobody has uploaded art for yet.
 */
export const storageMode: 'live' | 'disabled' =
  env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY ? 'live' : 'disabled'

if (brokerMode === 'disabled') {
  console.warn(
    'PLATFORM_SEED not set — sales cannot settle. Run `npm run platform:setup` (testnet).',
  )
}

if (storageMode === 'disabled') {
  console.warn(
    'SUPABASE_URL/SERVICE_KEY not set — event poster upload disabled (events render a fallback).',
  )
}
