/**
 * Email on an organizer application: proving the address, and telling the applicant what
 * happened. Real Postgres; the only thing replaced is the outbound mail, which is forced to
 * the in-memory stub so no developer's provider key can ever make this suite send anything.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

vi.mock('../src/mailer.js', async () => {
  const actual = await vi.importActual<typeof import('../src/mailer.js')>('../src/mailer.js')
  return { ...actual, mailer: actual.stubSender }
})
// The stub prints the message outside production, which would spam the test output.
vi.spyOn(console, 'log').mockImplementation(() => {})

const { prisma } = await import('../src/prisma.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')
const { outbox, resendSender, stubSender } = await import('../src/mailer.js')
const { RESEND_COOLDOWN_MS, VERIFY_TTL_MS, sendVerification, verifyEmail } = await import(
  '../src/organizer-email.js'
)

const app = createApp()
const UTAG = 'em_'
let uniq = ''

type Actor = { id: string; token: string }
async function mkUser(name: string, role: 'USER' | 'ADMIN' = 'USER'): Promise<Actor> {
  const username = `${UTAG}${name}_${uniq}`.slice(0, 20)
  const user = await prisma.user.create({
    data: { username, xrplAddress: `r${UTAG}${name}${uniq}`.padEnd(28, 'x').slice(0, 33), role },
  })
  const { token } = await createSession(user.id)
  return { id: user.id, token }
}
const as = (a: Actor) => `Bearer ${a.token}`

/** The token in the most recent email's link. */
function lastToken(): string {
  const text = outbox.at(-1)!.text
  const m = /[?&]verify=([A-Za-z0-9_-]+)/.exec(text)
  if (!m) throw new Error(`no link in: ${text}`)
  return m[1]!
}

const apply = (a: Actor, body: Record<string, unknown> = {}) =>
  request(app)
    .post('/api/organizers/apply')
    .set('authorization', as(a))
    .send({ orgName: 'Late Set Collective', email: 'Host@Example.com', pitch: 'weekly league nights', ...body })

beforeEach(() => {
  uniq = Math.random().toString(36).slice(2, 8)
  outbox.length = 0
})

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { username: { startsWith: UTAG } },
    select: { id: true },
  })
  const ids = users.map((u) => u.id)
  // EmailVerification rows go with their application (ON DELETE CASCADE).
  await prisma.organizerApplication.deleteMany({ where: { userId: { in: ids } } })
  await prisma.session.deleteMany({ where: { userId: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
  await prisma.$disconnect()
})

describe('applying with an email', () => {
  it('requires an email, and rejects one that is not an address', async () => {
    const a = await mkUser('req')
    expect((await apply(a, { email: undefined })).status).toBe(400)
    expect((await apply(a, { email: 'not an email' })).status).toBe(400)
    expect(await prisma.organizerApplication.count({ where: { userId: a.id } })).toBe(0)
  })

  it('no longer requires the free-text contact', async () => {
    const a = await mkUser('nocontact')
    const res = await apply(a)
    expect(res.status).toBe(201)
  })

  it('stores the address lower-cased, unverified, and emails a link to it', async () => {
    const a = await mkUser('store')
    const res = await apply(a)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ emailVerified: false, emailSent: true })

    const row = await prisma.organizerApplication.findUniqueOrThrow({ where: { userId: a.id } })
    expect(row.email).toBe('host@example.com')
    expect(row.emailVerifiedAt).toBeNull()

    expect(outbox).toHaveLength(1)
    expect(outbox[0]!.to).toBe('host@example.com')
    expect(outbox[0]!.text).toContain('/organize?verify=')
  })

  it('never stores the token itself, only its hash', async () => {
    const a = await mkUser('hash')
    await apply(a)
    const token = lastToken()
    const rows = await prisma.emailVerification.findMany({
      where: { application: { userId: a.id } },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tokenHash).not.toBe(token)
    expect(JSON.stringify(rows)).not.toContain(token)
  })

  it('reports that no email went out when the provider fails, and still keeps the application', async () => {
    const a = await mkUser('fail')
    const failing = vi.spyOn(stubSender, 'send').mockResolvedValueOnce('failed')
    const res = await apply(a)
    failing.mockRestore()
    expect(res.status).toBe(201)
    expect(res.body.emailSent).toBe(false)
    expect(await prisma.organizerApplication.count({ where: { userId: a.id } })).toBe(1)
  })
})

describe('verifying the address', () => {
  it('marks the application verified from the emailed token, without a session', async () => {
    const a = await mkUser('ok')
    await apply(a)
    const res = await request(app).post('/api/organizers/email/verify').send({ token: lastToken() })
    expect(res.status).toBe(200)
    const row = await prisma.organizerApplication.findUniqueOrThrow({ where: { userId: a.id } })
    expect(row.emailVerifiedAt).not.toBeNull()
  })

  it('works once: a second click, or a replay, is refused', async () => {
    const a = await mkUser('once')
    await apply(a)
    const token = lastToken()
    expect((await request(app).post('/api/organizers/email/verify').send({ token })).status).toBe(200)
    expect((await request(app).post('/api/organizers/email/verify').send({ token })).status).toBe(400)
  })

  it('verifies exactly once when clicks race', async () => {
    const a = await mkUser('race')
    await apply(a)
    const token = lastToken()
    const results = await Promise.all([verifyEmail(token), verifyEmail(token), verifyEmail(token)])
    expect(results.filter((r) => r === 'verified')).toHaveLength(1)
  })

  it('refuses an expired link', async () => {
    const a = await mkUser('exp')
    await apply(a)
    const token = lastToken()
    await prisma.emailVerification.updateMany({
      where: { application: { userId: a.id } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    expect(await verifyEmail(token)).toBe('invalid')
  })

  it('gives a link a 24 hour life', async () => {
    const a = await mkUser('ttl')
    await apply(a)
    const row = await prisma.emailVerification.findFirstOrThrow({ where: { application: { userId: a.id } } })
    const life = row.expiresAt.getTime() - row.createdAt.getTime()
    expect(Math.abs(life - VERIFY_TTL_MS)).toBeLessThan(5000)
  })

  it('refuses a link sent to an address the applicant has since replaced', async () => {
    // Request a link for the first address, switch to a second, then use the old link: it
    // must not vouch for an address it was never sent to.
    const a = await mkUser('swap')
    await apply(a)
    const oldToken = lastToken()
    await prisma.organizerApplication.update({
      where: { userId: a.id },
      data: { email: 'other@example.com', status: 'REJECTED' },
    })
    expect(await verifyEmail(oldToken)).toBe('invalid')
    const row = await prisma.organizerApplication.findUniqueOrThrow({ where: { userId: a.id } })
    expect(row.emailVerifiedAt).toBeNull()
  })

  it('answers every kind of bad token identically', async () => {
    const unknown = await request(app).post('/api/organizers/email/verify').send({ token: 'x'.repeat(43) })
    const malformed = await request(app).post('/api/organizers/email/verify').send({ token: 'short' })
    const missing = await request(app).post('/api/organizers/email/verify').send({})
    for (const res of [unknown, malformed, missing]) {
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'This link is invalid or has expired' })
    }
  })

  it('is not triggered by a GET, so a mail scanner fetching the link cannot burn it', async () => {
    const a = await mkUser('get')
    await apply(a)
    const token = lastToken()
    const res = await request(app).get(`/api/organizers/email/verify?token=${token}`)
    expect(res.status).toBe(404)
    expect(await verifyEmail(token)).toBe('verified')
  })
})

describe('resubmitting', () => {
  it('keeps a verified address verified when the same email is sent again, and sends nothing', async () => {
    const a = await mkUser('same')
    await apply(a)
    await verifyEmail(lastToken())
    await prisma.organizerApplication.update({ where: { userId: a.id }, data: { status: 'REJECTED' } })
    outbox.length = 0

    const res = await apply(a)
    expect(res.body).toMatchObject({ emailVerified: true, emailSent: null })
    expect(outbox).toHaveLength(0)
  })

  it('starts a different address unverified and mails the new one', async () => {
    const a = await mkUser('diff')
    await apply(a)
    await verifyEmail(lastToken())
    await prisma.organizerApplication.update({ where: { userId: a.id }, data: { status: 'REJECTED' } })
    outbox.length = 0

    const res = await apply(a, { email: 'new@example.com' })
    expect(res.body).toMatchObject({ emailVerified: false, emailSent: true })
    expect(outbox.map((m) => m.to)).toEqual(['new@example.com'])
  })
})

describe('resending', () => {
  it('sends another link, then holds a cooldown against flooding an inbox', async () => {
    const a = await mkUser('resend')
    await apply(a)
    // The apply just made one, so an immediate resend is inside the cooldown.
    const tooSoon = await request(app).post('/api/organizers/email/resend').set('authorization', as(a))
    expect(tooSoon.status).toBe(429)
    expect(Number(tooSoon.headers['retry-after'])).toBeGreaterThan(0)
    expect(outbox).toHaveLength(1)

    await prisma.emailVerification.updateMany({
      where: { application: { userId: a.id } },
      data: { createdAt: new Date(Date.now() - RESEND_COOLDOWN_MS - 1000) },
    })
    const ok = await request(app).post('/api/organizers/email/resend').set('authorization', as(a))
    expect(ok.status).toBe(200)
    expect(ok.body.emailSent).toBe(true)
    expect(outbox).toHaveLength(2)
  })

  it('refuses once the address is confirmed', async () => {
    const a = await mkUser('conf')
    await apply(a)
    await verifyEmail(lastToken())
    const res = await request(app).post('/api/organizers/email/resend').set('authorization', as(a))
    expect(res.status).toBe(409)
  })

  it('needs a session and an application', async () => {
    expect((await request(app).post('/api/organizers/email/resend')).status).toBe(401)
    const a = await mkUser('none')
    expect((await request(app).post('/api/organizers/email/resend').set('authorization', as(a))).status).toBe(404)
  })
})

describe('what the review says, and to whom', () => {
  async function pending(name: string, verified: boolean) {
    const applicant = await mkUser(name)
    await apply(applicant)
    if (verified) await verifyEmail(lastToken())
    outbox.length = 0
    const admin = await mkUser(`a${name}`, 'ADMIN')
    const row = await prisma.organizerApplication.findUniqueOrThrow({ where: { userId: applicant.id } })
    return { applicant, admin, row }
  }
  const review = (admin: Actor, id: string, body: object) =>
    request(app).post(`/api/admin/organizer-applications/${id}/review`).set('authorization', as(admin)).send(body)

  it('emails a verified applicant their approval', async () => {
    const { admin, row } = await pending('apv', true)
    const res = await review(admin, row.id, { decision: 'approve' })
    expect(res.body).toMatchObject({ state: 'approved', notified: true })
    expect(outbox).toHaveLength(1)
    expect(outbox[0]!.subject).toMatch(/approved/i)
    expect(outbox[0]!.to).toBe('host@example.com')
  })

  it("includes the reviewer's note in a rejection", async () => {
    const { admin, row } = await pending('rej', true)
    await review(admin, row.id, { decision: 'reject', note: 'Tell us your venue.' })
    expect(outbox[0]!.text).toContain('Tell us your venue.')
  })

  it('sends nothing to an address nobody confirmed, but still records the decision', async () => {
    // Anyone can type anyone's address; a decision mailed to a stranger is spam from us.
    const { admin, row } = await pending('unv', false)
    const res = await review(admin, row.id, { decision: 'approve' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ state: 'approved', notified: false })
    expect(outbox).toHaveLength(0)
    const after = await prisma.organizerApplication.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.status).toBe('APPROVED')
  })

  it('does not let a mail outage undo or fail the review', async () => {
    const { admin, row } = await pending('out', true)
    const failing = vi.spyOn(stubSender, 'send').mockResolvedValueOnce('failed')
    const res = await review(admin, row.id, { decision: 'approve' })
    failing.mockRestore()
    expect(res.status).toBe(200)
    expect(res.body.notified).toBe(false)
    expect((await prisma.organizerApplication.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('APPROVED')
  })

  it('shows the reviewer the address and whether it is confirmed', async () => {
    const { admin, row } = await pending('queue', true)
    const res = await request(app).get('/api/admin/organizer-applications').set('authorization', as(admin))
    const mine = res.body.applications.find((x: { id: string }) => x.id === row.id)
    expect(mine).toMatchObject({ email: 'host@example.com', emailVerified: true })
  })

  it('gives an applicant their own email and confirmation state', async () => {
    const a = await mkUser('me')
    await apply(a)
    const res = await request(app).get('/api/organizers/me').set('authorization', as(a))
    expect(res.body.application).toMatchObject({ email: 'host@example.com', emailVerified: false })
  })
})

describe('the sender', () => {
  const mail = { to: 'a@b.co', subject: 's', text: 't' }

  it('posts to the provider with the key and From, and reports sent on 2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    const sender = resendSender('key_12345678', 'HubWorld <noreply@hubworld.app>', fetchImpl as unknown as typeof fetch)
    expect(await sender.send(mail)).toBe('sent')
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.headers.authorization).toBe('Bearer key_12345678')
    expect(JSON.parse(init.body)).toMatchObject({ from: 'HubWorld <noreply@hubworld.app>', to: ['a@b.co'] })
  })

  it('reports failed, without throwing, on a refusal or a network error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refused = resendSender('k_12345678', 'f@x.co', (async () => ({ ok: false, status: 403 })) as unknown as typeof fetch)
    const down = resendSender('k_12345678', 'f@x.co', (async () => {
      throw new TypeError('offline')
    }) as typeof fetch)
    expect(await refused.send(mail)).toBe('failed')
    expect(await down.send(mail)).toBe('failed')
    warn.mockRestore()
  })

  it('never writes the recipient or the body to the log when a send fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await resendSender('k_12345678', 'f@x.co', (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch).send({
      to: 'secret@person.co',
      subject: 'subj',
      text: 'private-body',
    })
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).not.toContain('secret@person.co')
    expect(logged).not.toContain('private-body')
    warn.mockRestore()
  })

  it('has no link to send when there is no address', async () => {
    expect(await sendVerification({ id: 'x', email: null, orgName: 'Org' })).toBe('failed')
  })
})
