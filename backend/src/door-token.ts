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
 *
 * The payload is BINARY (ticket 32 bytes, event 16, user 16, expiry 6) and the
 * MAC is truncated to 16 bytes, which comes to about 120 characters. That is not
 * tidiness: a QR's density grows with its length, and a dense code is slow to
 * read off a phone held up in a queue. As JSON this was about 300 characters and
 * a code too fine for a camera at arm's length; 128 bits of MAC is ample for
 * something that lives 45 seconds.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export const DOOR_TOKEN_TTL_MS = 45_000
export const DOOR_TOKEN_PREFIX = 'HWD1'

/** Bytes of HMAC kept. 128 bits: far beyond guessable inside a 45 second life. */
const MAC_BYTES = 16
const PAYLOAD_BYTES = 32 + 16 + 16 + 6

export type DoorClaims = {
  /** The ticket (NFTokenID, 64 upper-case hex). */
  t: string
  /** The event's id (a UUID). */
  e: string
  /** The user the code was made for (a UUID). */
  u: string
  /** Expiry, ms since the epoch. */
  exp: number
}

export type DoorTokenCheck =
  | { ok: true; claims: DoorClaims }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' }

const HEX64 = /^[0-9A-F]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const uuidToBytes = (id: string) => Buffer.from(id.replace(/-/g, ''), 'hex')
const bytesToUuid = (b: Buffer) => {
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function mac(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(`${DOOR_TOKEN_PREFIX}.${body}`).digest().subarray(0, MAC_BYTES)
}

export function signDoorToken(
  claims: Omit<DoorClaims, 'exp'>,
  opts: { secret: string; now?: number },
): { token: string; expiresAt: Date } {
  if (!HEX64.test(claims.t) || !UUID.test(claims.e) || !UUID.test(claims.u)) {
    throw new Error('A door code needs a 64-hex ticket id and UUID event and user ids')
  }
  const exp = (opts.now ?? Date.now()) + DOOR_TOKEN_TTL_MS
  const payload = Buffer.alloc(PAYLOAD_BYTES)
  Buffer.from(claims.t, 'hex').copy(payload, 0)
  uuidToBytes(claims.e).copy(payload, 32)
  uuidToBytes(claims.u).copy(payload, 48)
  payload.writeUIntBE(exp, 64, 6)
  const body = payload.toString('base64url')
  return { token: `${DOOR_TOKEN_PREFIX}.${body}.${mac(opts.secret, body).toString('base64url')}`, expiresAt: new Date(exp) }
}

export function verifyDoorToken(token: string, opts: { secret: string; now?: number }): DoorTokenCheck {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== DOOR_TOKEN_PREFIX || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'malformed' }
  }
  const [, body, given] = parts as [string, string, string]

  // The signature before anything is read: an unauthenticated payload is never trusted.
  const expected = mac(opts.secret, body)
  const presented = Buffer.from(given, 'base64url')
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: 'signature' }
  }

  const payload = Buffer.from(body, 'base64url')
  if (payload.length !== PAYLOAD_BYTES) return { ok: false, reason: 'malformed' }
  const claims: DoorClaims = {
    t: payload.subarray(0, 32).toString('hex').toUpperCase(),
    e: bytesToUuid(payload.subarray(32, 48)),
    u: bytesToUuid(payload.subarray(48, 64)),
    exp: payload.readUIntBE(64, 6),
  }

  // `>=`: a code is valid for [issue, exp), so at exactly `exp` it is already dead.
  if ((opts.now ?? Date.now()) >= claims.exp) return { ok: false, reason: 'expired' }
  return { ok: true, claims }
}
