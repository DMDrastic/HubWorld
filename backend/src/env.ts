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
