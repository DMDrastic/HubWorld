/**
 * The code an attendee shows at the door, as pure functions.
 *
 * Every one of these is a way a code could be made to admit someone it should
 * not, or refuse someone it should admit, so each boundary is pinned exactly.
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DOOR_TOKEN_PREFIX, DOOR_TOKEN_TTL_MS, signDoorToken, verifyDoorToken } from '../src/door-token.js'

const SECRET = 'a-door-secret-that-is-at-least-32-chars-long'
const NF = 'A'.repeat(64)
const claims = { t: NF, e: 'event-1', u: 'user-1' }
const NOW = 1_800_000_000_000

describe('door tokens', () => {
  it('round-trips the claims, and says when it stops working', () => {
    const { token, expiresAt } = signDoorToken(claims, { secret: SECRET, now: NOW })

    expect(token.startsWith(`${DOOR_TOKEN_PREFIX}.`)).toBe(true)
    expect(expiresAt.getTime()).toBe(NOW + DOOR_TOKEN_TTL_MS)
    const out = verifyDoorToken(token, { secret: SECRET, now: NOW + 1000 })
    expect(out).toEqual({ ok: true, claims: { ...claims, exp: NOW + DOOR_TOKEN_TTL_MS } })
  })

  it('lives for 45 seconds and not a moment longer', () => {
    const { token } = signDoorToken(claims, { secret: SECRET, now: NOW })

    expect(verifyDoorToken(token, { secret: SECRET, now: NOW + DOOR_TOKEN_TTL_MS - 1 }).ok).toBe(true)
    expect(verifyDoorToken(token, { secret: SECRET, now: NOW + DOOR_TOKEN_TTL_MS })).toEqual({ ok: false, reason: 'expired' })
    expect(DOOR_TOKEN_TTL_MS).toBe(45_000)
  })

  it('rejects a code signed with a different secret', () => {
    const { token } = signDoorToken(claims, { secret: SECRET, now: NOW })

    expect(verifyDoorToken(token, { secret: 'another-secret-that-is-also-32-chars-long', now: NOW })).toEqual({ ok: false, reason: 'signature' })
  })

  it('rejects a payload that was edited, even to name a different ticket or a later expiry', () => {
    const { token } = signDoorToken(claims, { secret: SECRET, now: NOW })
    const [prefix, body, mac] = token.split('.') as [string, string, string]
    const edit = (change: Record<string, unknown>) => {
      const decoded = JSON.parse(Buffer.from(body, 'base64url').toString())
      return `${prefix}.${Buffer.from(JSON.stringify({ ...decoded, ...change })).toString('base64url')}.${mac}`
    }

    expect(verifyDoorToken(edit({ t: 'B'.repeat(64) }), { secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'signature' })
    expect(verifyDoorToken(edit({ exp: NOW + 86_400_000 }), { secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'signature' })
    expect(verifyDoorToken(edit({ u: 'someone-else' }), { secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'signature' })
  })

  it('rejects a flipped signature byte (positive control for the edits above)', () => {
    const { token } = signDoorToken(claims, { secret: SECRET, now: NOW })
    expect(verifyDoorToken(token, { secret: SECRET, now: NOW }).ok).toBe(true)

    const [prefix, body, mac] = token.split('.') as [string, string, string]
    const flipped = `${prefix}.${body}.${(mac[0] === 'A' ? 'B' : 'A') + mac.slice(1)}`
    expect(verifyDoorToken(flipped, { secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'signature' })
  })

  it('says malformed, not signature, for things that are not codes at all', () => {
    for (const junk of ['', 'hello', 'HWD1', 'HWD1.a', 'HWD1.a.b.c', 'XXX1.a.b', `${DOOR_TOKEN_PREFIX}..`]) {
      expect(verifyDoorToken(junk, { secret: SECRET, now: NOW }).ok).toBe(false)
    }
    expect(verifyDoorToken('https://example.com/ticket', { secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects a correctly signed payload that is not claims, rather than trusting its shape', () => {
    // Someone with the secret (or a bug) signing nonsense must still not pass.
    const body = Buffer.from(JSON.stringify({ t: 'not-hex', e: 'x', u: 'y', exp: NOW + 1000 })).toString('base64url')
    const mac = createHmac('sha256', SECRET).update(`${DOOR_TOKEN_PREFIX}.${body}`).digest('base64url')

    expect(verifyDoorToken(`${DOOR_TOKEN_PREFIX}.${body}.${mac}`, { secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'malformed' })
  })

  it('makes a different code each time it is asked in a different moment', () => {
    const a = signDoorToken(claims, { secret: SECRET, now: NOW }).token
    const b = signDoorToken(claims, { secret: SECRET, now: NOW + 30_000 }).token
    expect(a).not.toBe(b)
  })
})
