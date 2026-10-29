/**
 * How a refused Xaman payload creation is classified.
 *
 * The real bodies below were copied from production logs (2026-10-30). Classification
 * decides whether the user sees a plain explanation or "Internal server error", so each
 * kind of refusal is pinned to its own error.
 */
import { describe, expect, it } from 'vitest'
import { XamanPayloadLimit, XamanPermissionNotGranted, createFailure } from '../src/xaman.js'

const REAL_MINT =
  '{"error":{"reference":"cd95fce9-2485-46a9-9cbf-1450edf044a2","code":1217,"message":"This application may not request DelegateSet permission NFTokenMint. Contact Xaman Support (in-app) to request access."}}'
const REAL_OFFERS =
  '{"error":{"reference":"303e92c0-5c8d-445b-97f9-3fe737019d4b","code":1217,"message":"This application may not request DelegateSet permission NFTokenCreateOffer. Contact Xaman Support (in-app) to request access."}}'

describe('createFailure', () => {
  it('recognises the real refusal for minting, and names the permission', () => {
    const err = createFailure(401, REAL_MINT)
    expect(err).toBeInstanceOf(XamanPermissionNotGranted)
    expect((err as XamanPermissionNotGranted).permission).toBe('NFTokenMint')
  })

  it('recognises the real refusal for selling, and names the permission', () => {
    const err = createFailure(401, REAL_OFFERS)
    expect(err).toBeInstanceOf(XamanPermissionNotGranted)
    expect((err as XamanPermissionNotGranted).permission).toBe('NFTokenCreateOffer')
  })

  it('recognises it by the message alone, should Xaman change the code', () => {
    const err = createFailure(400, 'This application may not request DelegateSet permission NFTokenMint.')
    expect(err).toBeInstanceOf(XamanPermissionNotGranted)
  })

  it('keeps the payload limit its own error, not a permission one', () => {
    const err = createFailure(400, '{"error":{"code":429,"message":"Max payloads exceeded (77)"}}')
    expect(err).toBeInstanceOf(XamanPayloadLimit)
    expect(err).not.toBeInstanceOf(XamanPermissionNotGranted)
  })

  it('leaves anything else a plain error that carries the status and Xaman\'s words', () => {
    const err = createFailure(500, 'upstream exploded')
    expect(err).not.toBeInstanceOf(XamanPermissionNotGranted)
    expect(err).not.toBeInstanceOf(XamanPayloadLimit)
    expect(err.message).toBe('Xaman payload create failed: 500 upstream exploded')
  })
})
