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
const EVENT = '11111111-2222-4333-8444-555555555555'
const USER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const claims = { t: NF, e: EVENT, u: USER }
const NOW = 1_800_000_000_000

describe('door tokens', () => {
  it('round-trips the claims, and says when it stops working', () => {
    const { token, expiresAt } = signDoorToken(claims, { secret: SECRET, now: NOW })

    expect(token.startsWith(`${DOOR_TOKEN_PREFIX}.`)).toBe(true)
    expect(expiresAt.getTime()).toBe(NOW + DOOR_TOKEN_TTL_MS)
    const out = verifyDoorToken(token, { secret: SECRET, now: NOW + 1000 })
    expect(out).toEqual({ ok: true, claims: { ...claims, exp: NOW + DOOR_TOKEN_TTL_MS } })
  })

  it('lives for 30 seconds and not a moment longer', () => {
    const { token } = signDoorToken(claims, { secret: SECRET, now: NOW })

    expect(verifyDoorToken(token, { secret: SECRET, now: NOW + DOOR_TOKEN_TTL_MS - 1 }).ok).toBe(true)
    expect(verifyDoorToken(token, { secret: SECRET, now: NOW + DOOR_TOKEN_TTL_MS })).toEqual({ ok: false, reason: 'expired' })
    expect(DOOR_TOKEN_TTL_MS).toBe(30_000)
  })

  it('rejects a code signed with a different secret', () => {
    const { token } = signDoorToken(claims, { secret: SECRET, now: NOW })

    expect(verifyDoorToken(token, { secret: 'another-secret-that-is-also-32-chars-long', now: NOW })).toEqual({ ok: false, reason: 'signature' })
  })

  it('rejects a payload that was edited, even to name a different ticket or a later expiry', () => {
    const { token } = signDoorToken(claims, { secret: SECRET, now: NOW })
    const [prefix, body, mac] = token.split('.') as [string, string, string]
    const edit = (change: (b: Buffer) => void) => {
      const bytes = Buffer.from(body, 'base64url')
      change(bytes)
      return `${prefix}.${bytes.toString('base64url')}.${mac}`
    }

    // A different ticket, a different holder, a later expiry.
    expect(verifyDoorToken(edit((b) => void (b[0] = b[0]! ^ 0xff)), { secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'signature' })
    expect(verifyDoorToken(edit((b) => void (b[60] = b[60]! ^ 0xff)), { secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'signature' })
    expect(verifyDoorToken(edit((b) => b.writeUIntBE(NOW + 86_400_000, 64, 6)), { secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'signature' })
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

  it('rejects a correctly signed payload of the wrong size, rather than trusting its shape', () => {
    const body = Buffer.alloc(10, 1).toString('base64url')
    const mac = createHmac('sha256', SECRET).update(`${DOOR_TOKEN_PREFIX}.${body}`).digest().subarray(0, 16).toString('base64url')

    expect(verifyDoorToken(`${DOOR_TOKEN_PREFIX}.${body}.${mac}`, { secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'malformed' })
  })

  it('will not make a code for ids it could not read back', () => {
    expect(() => signDoorToken({ t: 'not-hex', e: EVENT, u: USER }, { secret: SECRET })).toThrow()
    expect(() => signDoorToken({ t: NF, e: 'event-1', u: USER }, { secret: SECRET })).toThrow()
  })

  it('is short enough to be a QR a phone can read in a queue', () => {
    const { token } = signDoorToken(claims, { secret: SECRET, now: NOW })
    // About 120 characters; as JSON it was about 300, a code too dense for a camera at arm's length.
    expect(token.length).toBeLessThan(130)
  })

  it('makes a different code each time it is asked in a different moment', () => {
    const a = signDoorToken(claims, { secret: SECRET, now: NOW }).token
    const b = signDoorToken(claims, { secret: SECRET, now: NOW + 30_000 }).token
    expect(a).not.toBe(b)
  })
})
