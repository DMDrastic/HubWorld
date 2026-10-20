/**
 * The short-lived code an attendee shows at the door.
 *
 * A code names one ticket, one event and one person, and stops working 45
 * seconds after it was made. The page showing it makes a fresh one before then.
 *
 * What makes this safe to display on a phone, where a static QR would not be:
 *
 * **It expires.** A screenshot is dead within a minute, which is the failure a
 * static code has.
 *
 * **It is signed, not looked up.** The server keeps nothing: it checks an HMAC,
 * so there is no table of live codes to grow, leak or race.
 *
 * **Single use is the ticket's job, not the code's.** Admitting someone flips the
 * ticket to REDEEMED in one conditional update (`door-admit.ts`), so a code
 * shown to two scanners admits the first and tells the second "already checked
 * in". The code needs no memory of having been used.
 *
 * What it does NOT prove: that the person holding the phone is the account
 * owner. It proves possession of a logged-in session, which the Xaman signature
 * flow does better. That is the trade the organizer is choosing when they pick
 * this door mode, and why the signature mode remains.
 *
 * Format: `HWD1.<payload>.<mac>`, both base64url. The prefix lets a scanner
 * refuse a foreign QR code without calling the server.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export const DOOR_TOKEN_TTL_MS = 45_000
export const DOOR_TOKEN_PREFIX = 'HWD1'

const ClaimsSchema = z.object({
  /** The ticket (NFTokenID, 64 hex). */
  t: z.string().regex(/^[0-9A-F]{64}$/),
  /** The event's id. */
  e: z.string().min(1),
  /** The user the code was made for. */
  u: z.string().min(1),
  /** Expiry, ms since the epoch. */
  exp: z.number().int(),
})

export type DoorClaims = z.infer<typeof ClaimsSchema>

export type DoorTokenCheck =
  | { ok: true; claims: DoorClaims }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' }

const b64 = (buf: Buffer | string) => Buffer.from(buf).toString('base64url')

function mac(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(`${DOOR_TOKEN_PREFIX}.${body}`).digest()
}

export function signDoorToken(
  claims: Omit<DoorClaims, 'exp'>,
  opts: { secret: string; now?: number },
): { token: string; expiresAt: Date } {
  const exp = (opts.now ?? Date.now()) + DOOR_TOKEN_TTL_MS
  const body = b64(JSON.stringify({ ...claims, exp } satisfies DoorClaims))
  return { token: `${DOOR_TOKEN_PREFIX}.${body}.${b64(mac(opts.secret, body))}`, expiresAt: new Date(exp) }
}

export function verifyDoorToken(token: string, opts: { secret: string; now?: number }): DoorTokenCheck {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== DOOR_TOKEN_PREFIX || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'malformed' }
  }
  const [, body, given] = parts as [string, string, string]

  // The signature before anything is parsed: an unauthenticated payload is never trusted.
  const expected = mac(opts.secret, body)
  const presented = Buffer.from(given, 'base64url')
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: 'signature' }
  }

  let json: unknown
  try {
    json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const parsed = ClaimsSchema.safeParse(json)
  if (!parsed.success) return { ok: false, reason: 'malformed' }

  // `>=`: a code is valid for [issue, exp), so at exactly `exp` it is already dead.
  if ((opts.now ?? Date.now()) >= parsed.data.exp) return { ok: false, reason: 'expired' }
  return { ok: true, claims: parsed.data }
}
