/**
 * Input-boundary validation. Zod schemas are the source of truth for shapes,
 * so what they accept IS the API contract.
 */
import { describe, expect, it } from 'vitest'
import { slugSchema, usernameSchema, xrplAddressSchema } from '../src/schemas.js'

describe('usernameSchema', () => {
  it('strips a leading @ and lowercases', () => {
    // @handles are a display concern; storage is bare and lowercase, so
    // @Alice and alice must resolve to the same account.
    expect(usernameSchema.parse('@Alice')).toBe('alice')
    expect(usernameSchema.parse('  @StationSquare  ')).toBe('stationsquare')
    expect(usernameSchema.parse('dm_drastic')).toBe('dm_drastic')
  })

  it('enforces the 3–20 character range', () => {
    expect(() => usernameSchema.parse('ab')).toThrow()
    expect(usernameSchema.parse('abc')).toBe('abc')
    expect(usernameSchema.parse('a'.repeat(20))).toBe('a'.repeat(20))
    expect(() => usernameSchema.parse('a'.repeat(21))).toThrow()
  })

  it('rejects characters outside a-z 0-9 underscore', () => {
    for (const bad of ['has space', 'dash-es', 'dots.', 'emoji😀x', 'semi;colon']) {
      expect(() => usernameSchema.parse(bad), bad).toThrow()
    }
  })

  it('strips only one leading @', () => {
    // '@@alice' would otherwise become '@alice', which is not a legal handle.
    expect(() => usernameSchema.parse('@@alice')).toThrow()
  })
})

describe('xrplAddressSchema', () => {
  it('accepts real classic addresses', () => {
    for (const ok of [
      'r4wQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf',
      'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
      'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w',
    ]) {
      expect(xrplAddressSchema.parse(ok)).toBe(ok)
    }
  })

  it('requires a leading r', () => {
    expect(() => xrplAddressSchema.parse('x4wQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf')).toThrow()
  })

  it('rejects base58-ambiguous characters', () => {
    // 0, O, I and l are excluded from XRPL's alphabet precisely because they
    // are visually confusable — accepting them invites mistyped addresses.
    for (const bad of [
      'r0wQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf',
      'rOwQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf',
      'rIwQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf',
      'rlwQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf',
    ]) {
      expect(() => xrplAddressSchema.parse(bad), bad).toThrow()
    }
  })

  it('rejects lengths outside 25–35 characters', () => {
    expect(() => xrplAddressSchema.parse('r123')).toThrow()
    expect(() => xrplAddressSchema.parse(`r${'1'.repeat(40)}`)).toThrow()
  })
})

describe('slugSchema', () => {
  it('lowercases and trims', () => {
    expect(slugSchema.parse('  Neon-District  ')).toBe('neon-district')
  })

  it('rejects underscores and spaces', () => {
    expect(() => slugSchema.parse('neon_district')).toThrow()
    expect(() => slugSchema.parse('neon district')).toThrow()
  })

  it('rejects an empty slug', () => {
    expect(() => slugSchema.parse('')).toThrow()
  })
})
