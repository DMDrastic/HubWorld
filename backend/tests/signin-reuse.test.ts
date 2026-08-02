/**
 * Reusing an outstanding sign-in payload.
 *
 * The feature exists for quota: every unresolved payload holds a slot against
 * the application cap, and clicking "Sign in" six times used to cost six slots.
 * So a client that already has one open gets the same one back.
 *
 * The bug it grew: reuse was decided from `SignInRequest.status`, which is OUR
 * record and only becomes SIGNED when a poll happens to observe it. Sign in,
 * close the tab before the next poll, and the row still reads PENDING — so the
 * next attempt handed back a payload Xaman had already resolved, which it then
 * refused. Sign-in stayed broken until the 3-minute TTL expired, and switching
 * between accounts hit it every time.
 *
 * The rule under test is therefore: reuse requires positive evidence FROM XAMAN
 * that the payload is still unsigned. Anything else — signed, cancelled,
 * expired, or unknown — mints a fresh one. Spending a slot is a bounded cost;
 * handing back a dead payload is a sign-in the user cannot complete or diagnose.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

const tryGetPayload = vi.fn()
const created: string[] = []

vi.mock('../src/xaman.js', async () => {
  const actual = await vi.importActual<typeof import('../src/xaman.js')>('../src/xaman.js')
  return {
    ...actual,
    tryGetPayload: (...a: unknown[]) => tryGetPayload(...a),
    xaman: {
      mode: 'stub' as const,
      createPayload: async () => ({ uuid: 'unused', next: 'n', qrPng: 'q' }),
      createSignInPayload: async () => {
        // Distinct per call, so "did it mint a new one?" is answerable.
        const uuid = `00000000-0000-4000-8000-${String(created.length + 1).padStart(12, '0')}`
        created.push(uuid)
        return { uuid, next: `https://xumm.app/sign/${uuid}`, qrPng: `${uuid}_q.png` }
      },
      getPayload: async () => null,
      cancelPayload: async () => true,
    },
  }
})

const { prisma } = await import('../src/prisma.js')
const { createApp } = await import('../src/app.js')

const app = createApp()

/** Every payload this suite mints, so cleanup touches nothing else. */
const MINE = { payloadUuid: { startsWith: '00000000-0000-4000-8000-' } }

/** An unsigned, unresolved payload — the only state that may be reused. */
const OPEN = { signed: false, cancelled: false, expired: false, account: null, txid: null }

async function cleanup() {
  await prisma.signInRequest.deleteMany({ where: MINE })
}

beforeEach(async () => {
  created.length = 0
  tryGetPayload.mockReset()
  await cleanup()
})

afterEach(cleanup)
afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

/** The `hubworld_signin` cookie a response sets, ready to send back. */
function signinCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined
  const found = (raw ?? []).find((c) => c.startsWith('hubworld_signin='))
  if (!found) throw new Error('no hubworld_signin cookie was set')
  return found.split(';')[0]!
}

describe('sign-in payload reuse', () => {
  /**
   * The feature itself: a second click while the payload is genuinely still
   * open costs no extra slot.
   */
  it('hands back the same payload while it is still unsigned', async () => {
    const first = await request(app).post('/api/auth/signin').send({})
    expect(first.status).toBe(201)
    expect(created).toHaveLength(1)

    tryGetPayload.mockResolvedValue(OPEN)
    const second = await request(app)
      .post('/api/auth/signin')
      .set('cookie', signinCookie(first))
      .send({})

    expect(second.status).toBe(200)
    expect(second.body.reused).toBe(true)
    expect(second.body.uuid).toBe(first.body.uuid)
    expect(created).toHaveLength(1) // no new slot spent
  })

  /**
   * The regression. Our row still says PENDING because nothing polled it, but
   * Xaman has already resolved the payload — so it must not be handed back.
   */
  it('mints a fresh payload when the prior one was already signed', async () => {
    const first = await request(app).post('/api/auth/signin').send({})
    const priorUuid = first.body.uuid

    // Exactly the stale state: signed on the phone, never polled by this client.
    const row = await prisma.signInRequest.findUniqueOrThrow({
      where: { payloadUuid: priorUuid },
    })
    expect(row.status).toBe('PENDING')

    tryGetPayload.mockResolvedValue({
      ...OPEN,
      signed: true,
      account: 'r4wQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf',
    })

    const second = await request(app)
      .post('/api/auth/signin')
      .set('cookie', signinCookie(first))
      .send({})

    expect(second.status).toBe(201)
    expect(second.body.reused).toBeUndefined()
    expect(second.body.uuid).not.toBe(priorUuid)
    expect(created).toHaveLength(2)
  })

  it.each([
    ['cancelled', { ...OPEN, cancelled: true }],
    ['expired', { ...OPEN, expired: true }],
    // Xaman has no record of it at all — reusing would be handing back nothing.
    ['unknown to Xaman', null],
  ])('mints a fresh payload when the prior one is %s', async (_label, live) => {
    const first = await request(app).post('/api/auth/signin').send({})
    tryGetPayload.mockResolvedValue(live)

    const second = await request(app)
      .post('/api/auth/signin')
      .set('cookie', signinCookie(first))
      .send({})

    expect(second.status).toBe(201)
    expect(second.body.uuid).not.toBe(first.body.uuid)
    expect(created).toHaveLength(2)
  })

  /**
   * A 429 says nothing about the payload. Reusing on no evidence is exactly the
   * gamble that produced the original bug, so an unknown state mints instead —
   * the quota cost is bounded, a broken sign-in is not.
   */
  it('does not gamble on reuse when Xaman is unavailable', async () => {
    const first = await request(app).post('/api/auth/signin').send({})
    tryGetPayload.mockResolvedValue('unavailable')

    const second = await request(app)
      .post('/api/auth/signin')
      .set('cookie', signinCookie(first))
      .send({})

    expect(second.status).toBe(201)
    expect(second.body.uuid).not.toBe(first.body.uuid)
  })

  /**
   * Xaman is not asked about a payload our own record has already finished with
   * — that check is free and correct, and spending a call on it would undo the
   * rate-limit saving this whole path exists for.
   */
  it('does not ask Xaman about a payload already consumed locally', async () => {
    const first = await request(app).post('/api/auth/signin').send({})
    await prisma.signInRequest.update({
      where: { payloadUuid: first.body.uuid },
      data: { status: 'SIGNED', consumedAt: new Date() },
    })

    const second = await request(app)
      .post('/api/auth/signin')
      .set('cookie', signinCookie(first))
      .send({})

    expect(second.status).toBe(201)
    expect(tryGetPayload).not.toHaveBeenCalled()
  })
})
