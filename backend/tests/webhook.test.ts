/**
 * Webhook trust boundary.
 *
 * The rule these exist for: **only the uuid is read from a webhook body.**
 *
 * A callback that believed itself would accept
 * `{ payload_uuidv4: "...", signed: true, account: "rAttacker" }` from anyone on
 * the internet — a forged sign-in as any address, a forged mint, a forged door
 * check-in. Treating the callback as a nudge and fetching the real state with our
 * API secret removes that whole class of attack, and means we do not depend on
 * reproducing Xaman's payload-signing scheme correctly.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { timingSafeEqual } from 'node:crypto'

/** Mirrors the receiver's parser. Note what it does NOT extract. */
const WebhookBody = z.object({
  meta: z.object({ payload_uuidv4: z.string().uuid() }).partial().optional(),
  payloadResponse: z.object({ payload_uuidv4: z.string().uuid() }).partial().optional(),
  payload_uuidv4: z.string().uuid().optional(),
  uuid: z.string().uuid().optional(),
})

function uuidFrom(body: unknown): string | null {
  const parsed = WebhookBody.safeParse(body)
  if (!parsed.success) return null
  const d = parsed.data
  return (
    d.meta?.payload_uuidv4 ?? d.payloadResponse?.payload_uuidv4 ?? d.payload_uuidv4 ?? d.uuid ?? null
  )
}

function secretMatches(given: string, expected: string | undefined): boolean {
  if (!expected) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const UUID = '11111111-2222-4333-8444-555555555555'

describe('only the uuid is taken from the body', () => {
  it('ignores a forged signature claim entirely', () => {
    // The attack. Everything except the uuid must be dropped.
    const hostile = {
      payload_uuidv4: UUID,
      signed: true,
      account: 'rAttackerAAAAAAAAAAAAAAAAAAAAAAAAA',
      response: { account: 'rAttackerAAAAAAAAAAAAAAAAAAAAAAAAA', txid: 'DEADBEEF' },
    }
    const parsed = WebhookBody.parse(hostile)

    expect(uuidFrom(hostile)).toBe(UUID)
    expect('signed' in parsed).toBe(false)
    expect('account' in parsed).toBe(false)
    expect('response' in parsed).toBe(false)
  })

  it('reads the uuid from any shape Xaman has used', () => {
    expect(uuidFrom({ meta: { payload_uuidv4: UUID } })).toBe(UUID)
    expect(uuidFrom({ payloadResponse: { payload_uuidv4: UUID } })).toBe(UUID)
    expect(uuidFrom({ payload_uuidv4: UUID })).toBe(UUID)
    expect(uuidFrom({ uuid: UUID })).toBe(UUID)
  })

  it('returns nothing for a body with no usable uuid', () => {
    // Acknowledged and ignored rather than retried forever.
    expect(uuidFrom({})).toBeNull()
    expect(uuidFrom({ signed: true })).toBeNull()
    expect(uuidFrom({ payload_uuidv4: 'not-a-uuid' })).toBeNull()
    expect(uuidFrom(null)).toBeNull()
    expect(uuidFrom('nonsense')).toBeNull()
  })
})

describe('the path secret', () => {
  const SECRET = 'a-sufficiently-long-secret'

  it('accepts only an exact match', () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true)
    expect(secretMatches('wrong', SECRET)).toBe(false)
    expect(secretMatches(SECRET + 'x', SECRET)).toBe(false)
    expect(secretMatches('', SECRET)).toBe(false)
  })

  it('refuses everything when no secret is configured', () => {
    // Otherwise an unconfigured deploy would expose an open endpoint.
    expect(secretMatches('anything', undefined)).toBe(false)
    expect(secretMatches('', undefined)).toBe(false)
  })

  it('compares without leaking length via early exit', () => {
    // timingSafeEqual throws on length mismatch, so the length check must come
    // first — a crash here would be a 500 that also confirms the length.
    expect(() => secretMatches('short', SECRET)).not.toThrow()
  })
})

describe('terminal states', () => {
  const terminal = (s: { signed: boolean; cancelled: boolean; expired: boolean }) =>
    s.signed || s.cancelled || s.expired

  it('treats signed, cancelled and expired as final', () => {
    expect(terminal({ signed: true, cancelled: false, expired: false })).toBe(true)
    expect(terminal({ signed: false, cancelled: true, expired: false })).toBe(true)
    expect(terminal({ signed: false, cancelled: false, expired: true })).toBe(true)
  })

  it('keeps an untouched payload non-terminal', () => {
    // A pending payload must stay refreshable, or a signature would never land.
    expect(terminal({ signed: false, cancelled: false, expired: false })).toBe(false)
  })
})
