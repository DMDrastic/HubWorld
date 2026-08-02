/**
 * What happens to the session a browser is about to forget.
 *
 * Setting the session cookie replaces whatever token was there. If that token
 * still names a live session, nobody holds it any more — and revocation needs
 * the token, so nothing can ever revoke it again. It simply stays valid for its
 * full 7 days.
 *
 * That is the server half of the identity confusion observed 2026-08-02: the
 * header named one account while requests were attributed to another, and
 * "sign out" revoked no session. Signing in as a second account left the first
 * account's session live and unreachable, so sign-out could only ever end the
 * newest one, and `revokeSession` swallowed the difference between "revoked it"
 * and "there was nothing there".
 *
 * The frontend half — a page that asked who it was exactly twice — is pinned in
 * frontend/src/__tests__/AuthIdentity.test.tsx.
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
        const uuid = `00000000-0000-4000-9000-${String(created.length + 1).padStart(12, '0')}`
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

// Prefixed so cleanup can never reach a row this suite did not create.
const ALPHA = { username: 'sesstest_alpha', xrplAddress: 'rSessTestAlpha11111111111111111111' }
const BETA = { username: 'sesstest_beta', xrplAddress: 'rSessTestBeta222222222222222222222' }

const MINE = { payloadUuid: { startsWith: '00000000-0000-4000-9000-' } }

async function cleanup() {
  await prisma.signInRequest.deleteMany({ where: MINE })
  await prisma.session.deleteMany({
    where: { user: { username: { startsWith: 'sesstest_' } } },
  })
  await prisma.user.deleteMany({ where: { username: { startsWith: 'sesstest_' } } })
}

beforeEach(async () => {
  created.length = 0
  tryGetPayload.mockReset()
  await cleanup()
  await prisma.user.createMany({ data: [ALPHA, BETA] })
})

afterEach(cleanup)
afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

function sessionCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined
  const found = (raw ?? []).find((c) => c.startsWith('hubworld_session='))
  if (!found) throw new Error('no hubworld_session cookie was set')
  return found.split(';')[0]!
}

/**
 * Complete a sign-in as `who`, optionally from a browser already carrying
 * `cookie`. Returns the session cookie the response set.
 */
async function signInAs(who: typeof ALPHA, cookie?: string): Promise<string> {
  const start = await request(app).post('/api/auth/signin').send({})
  const uuid = start.body.uuid as string

  tryGetPayload.mockResolvedValue({
    signed: true,
    cancelled: false,
    expired: false,
    account: who.xrplAddress,
    txid: null,
  })

  const poll = request(app).get(`/api/auth/signin/${uuid}`)
  if (cookie) poll.set('cookie', cookie)
  const res = await poll

  expect(res.status).toBe(200)
  expect(res.body.state).toBe('authenticated')
  expect(res.body.user.username).toBe(who.username)
  return sessionCookie(res)
}

describe('replacing a session', () => {
  it('revokes the session the browser is dropping', async () => {
    const alphaCookie = await signInAs(ALPHA)

    // Same browser, second account — the cookie is about to be overwritten.
    const betaCookie = await signInAs(BETA, alphaCookie)
    expect(betaCookie).not.toBe(alphaCookie)

    // @alpha's session must not be left live-but-unreachable. Nobody holds that
    // token any more, so if it survives here nothing can ever end it.
    const alphaSessions = await prisma.session.findMany({
      where: { user: { username: ALPHA.username } },
    })
    expect(alphaSessions).toHaveLength(1)
    expect(alphaSessions[0]!.revokedAt).not.toBeNull()
  })

  it('stops honouring the replaced token', async () => {
    const alphaCookie = await signInAs(ALPHA)
    // Confirm it worked before the replacement, or the assertion below proves
    // nothing about the replacement.
    const before = await request(app).get('/api/auth/me').set('cookie', alphaCookie)
    expect(before.status).toBe(200)
    expect(before.body.username).toBe(ALPHA.username)

    await signInAs(BETA, alphaCookie)

    const after = await request(app).get('/api/auth/me').set('cookie', alphaCookie)
    expect(after.status).toBe(401)
  })

  it('answers as the account the new cookie names, not the old one', async () => {
    const alphaCookie = await signInAs(ALPHA)
    const betaCookie = await signInAs(BETA, alphaCookie)

    const me = await request(app).get('/api/auth/me').set('cookie', betaCookie)
    expect(me.status).toBe(200)
    expect(me.body.username).toBe(BETA.username)
  })
})

describe('signing out reports whether it revoked anything', () => {
  it('reports a live session as revoked', async () => {
    const cookie = await signInAs(ALPHA)

    const res = await request(app).post('/api/auth/signout').set('cookie', cookie)
    expect(res.status).toBe(200)
    expect(res.body.revoked).toBe(true)

    // And it is actually gone, not merely reported.
    expect((await request(app).get('/api/auth/me').set('cookie', cookie)).status).toBe(401)
  })

  it('reports revoking nothing when the session was already dead', async () => {
    // This is the case that used to look identical to success, which is how
    // "sign out did nothing" stayed invisible.
    const cookie = await signInAs(ALPHA)
    await request(app).post('/api/auth/signout').set('cookie', cookie)

    const again = await request(app).post('/api/auth/signout').set('cookie', cookie)
    expect(again.status).toBe(200)
    expect(again.body.revoked).toBe(false)
  })

  it('reports revoking nothing when no session was sent at all', async () => {
    const res = await request(app).post('/api/auth/signout')
    expect(res.status).toBe(200)
    expect(res.body.revoked).toBe(false)
  })
})
