/**
 * Granting and revoking delegated minting, over HTTP — a real Express app, a
 * real session and a real database, with only the network faked (the ledger
 * reads and Xaman). Nothing here submits a transaction.
 *
 * The assertions that matter most are about what the ledger says, not what we
 * stored: a grant is only "granted" once the organizer's Delegate object
 * confirms it, and an unreadable ledger is never reported as a revocation.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

const DELEGATE = 'rDelegateFixtureAddress00000000'
const OLD_DELEGATE = 'rOldDelegateFixtureAddress00000'

type PayloadStatus = {
  signed: boolean
  cancelled: boolean
  expired: boolean
  account: string | null
  txid: string | null
}

const createPayload =
  vi.fn<(txjson: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown>>()
const tryGetPayload = vi.fn<(uuid: string) => Promise<PayloadStatus | null | 'unavailable'>>()
const readPermission = vi.fn<() => Promise<'granted' | 'absent' | 'unknown'>>()
const delegationAvailable = vi.fn<() => Promise<boolean>>()
const txSucceeded = vi.fn<(hash: string) => Promise<boolean | null>>()
let delegateOverride: (() => string) | null = null

vi.mock('../src/ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ledger.js')>('../src/ledger.js')
  return {
    ...actual,
    txSucceeded: (...a: Parameters<typeof txSucceeded>) => txSucceeded(...a),
    delegateAddress: () => (delegateOverride ? delegateOverride() : DELEGATE),
  }
})

vi.mock('../src/delegation.js', async () => {
  const actual = await vi.importActual<typeof import('../src/delegation.js')>('../src/delegation.js')
  return {
    ...actual,
    delegationAvailable: () => delegationAvailable(),
    readPermission: (...a: unknown[]) => readPermission(...(a as [])),
  }
})

vi.mock('../src/xaman.js', async () => {
  const actual = await vi.importActual<typeof import('../src/xaman.js')>('../src/xaman.js')
  return {
    ...actual,
    tryGetPayload: (...a: Parameters<typeof tryGetPayload>) => tryGetPayload(...a),
    xaman: {
      mode: 'stub' as const,
      createPayload: (...a: Parameters<typeof createPayload>) => createPayload(...a),
      createSignInPayload: async () => ({ uuid: '', next: '', qrPng: '' }),
      getPayload: async () => null,
      cancelPayload: async () => true,
    },
  }
})

// `delegateMode` is read from DELEGATE_SEED, which CI does not have.
vi.mock('../src/env.js', async () => {
  const actual = await vi.importActual<typeof import('../src/env.js')>('../src/env.js')
  return { ...actual, delegateMode: 'live' as const }
})

const { prisma } = await import('../src/prisma.js')
const { NETWORK } = await import('../src/network.js')
const { createApp } = await import('../src/app.js')
const { createSession } = await import('../src/session.js')

const app = createApp()
const UTAG = 'dg_'

type Actor = { id: string; username: string; address: string; token: string }
let uniq = ''
// UUIDs need hex digits; `uniq` is base-36.
let hex = ''
let n = 0

async function mkUser(name: string, role: 'USER' | 'ORGANIZER' = 'ORGANIZER'): Promise<Actor> {
  const username = `${UTAG}${name}_${uniq}`.slice(0, 20)
  const user = await prisma.user.create({
    data: {
      username,
      xrplAddress: `r${UTAG}${name}${uniq}`.padEnd(28, 'x').slice(0, 33),
      role,
    },
  })
  const { token } = await createSession(user.id)
  return { id: user.id, username: user.username, address: user.xrplAddress, token }
}

const as = (a: Actor) => `Bearer ${a.token}`

async function mkRow(
  organizer: Actor,
  opts: {
    kind?: 'GRANT' | 'REVOKE'
    status?: 'PENDING' | 'ACTIVE'
    delegate?: string
    expiresInMs?: number
  } = {},
) {
  n += 1
  return prisma.delegation.create({
    data: {
      network: NETWORK,
      organizerId: organizer.id,
      organizerAddress: organizer.address,
      delegateAddress: opts.delegate ?? DELEGATE,
      kind: opts.kind ?? 'GRANT',
      status: opts.status ?? 'PENDING',
      payloadUuid: `00000000-0000-4000-8000-${hex}${String(n).padStart(6, '0')}`,
      expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 180_000)),
      resolvedAt: opts.status === 'ACTIVE' ? new Date() : null,
    },
  })
}

async function cleanup() {
  await prisma.delegation.deleteMany({ where: { organizer: { username: { startsWith: UTAG } } } })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: UTAG } } } })
  await prisma.user.deleteMany({ where: { username: { startsWith: UTAG } } })
}

beforeEach(async () => {
  uniq = Math.random().toString(36).slice(2, 8)
  hex = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')
  n = 0
  delegateOverride = null
  await cleanup()
  let c = 0
  createPayload.mockReset()
  createPayload.mockImplementation(async () => {
    c += 1
    return {
      uuid: `00000000-0000-4000-9000-${hex}${String(c).padStart(6, '0')}`,
      next: 'https://xumm.app/sign/stub',
      qrPng: 'data:image/png;base64,AA==',
    }
  })
  tryGetPayload.mockReset()
  readPermission.mockReset()
  readPermission.mockResolvedValue('absent')
  delegationAvailable.mockReset()
  delegationAvailable.mockResolvedValue(true)
  txSucceeded.mockReset()
  txSucceeded.mockResolvedValue(true)
})

afterEach(cleanup)
afterAll(async () => {
  await prisma.$disconnect()
})

// ----------------------------------------------------------------- grant --

describe('POST /delegation/grant', () => {
  it('requires a session', async () => {
    const res = await request(app).post('/api/delegation/grant')
    expect(res.status).toBe(401)
  })

  it('is for organizers only', async () => {
    const user = await mkUser('plain', 'USER')
    const res = await request(app).post('/api/delegation/grant').set('Authorization', as(user))
    expect(res.status).toBe(403)
    expect(createPayload).not.toHaveBeenCalled()
  })

  it('builds a grant that authorises the delegate for NFTokenMint and nothing else', async () => {
    const org = await mkUser('org')
    const res = await request(app).post('/api/delegation/grant').set('Authorization', as(org))

    expect(res.status).toBe(201)
    expect(res.body.uuid).toMatch(/^[0-9a-f-]{36}$/)
    const [txjson, opts] = createPayload.mock.calls[0]!
    expect(txjson).toMatchObject({
      TransactionType: 'DelegateSet',
      Account: org.address, // the organizer grants
      Authorize: DELEGATE, // ...to the delegate, never to the broker
      Permissions: [{ Permission: { PermissionValue: 'NFTokenMint' } }],
    })
    // Counted against the quota under its own flow, and pinned to the network.
    expect(opts).toMatchObject({ flow: 'DELEGATE_GRANT', userId: org.id })
    expect(opts.forceNetwork).toBeDefined()
  })

  it('freezes the delegate address on the row', async () => {
    const org = await mkUser('org')
    await request(app).post('/api/delegation/grant').set('Authorization', as(org))

    const row = await prisma.delegation.findFirstOrThrow({ where: { organizerId: org.id } })
    expect(row).toMatchObject({
      kind: 'GRANT',
      status: 'PENDING',
      delegateAddress: DELEGATE,
      organizerAddress: org.address,
      network: NETWORK,
    })
  })

  it('does not spend a payload when the ledger already says granted', async () => {
    const org = await mkUser('org')
    readPermission.mockResolvedValue('granted')

    const res = await request(app).post('/api/delegation/grant').set('Authorization', as(org))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ state: 'granted' })
    expect(createPayload).not.toHaveBeenCalled()
  })

  it('answers 503 before creating anything when the amendment is not usable', async () => {
    const org = await mkUser('org')
    delegationAvailable.mockResolvedValue(false)

    const res = await request(app).post('/api/delegation/grant').set('Authorization', as(org))

    expect(res.status).toBe(503)
    expect(createPayload).not.toHaveBeenCalled()
    expect(await prisma.delegation.count({ where: { organizerId: org.id } })).toBe(0)
  })

  it('answers 503 when there is no usable delegate key', async () => {
    const org = await mkUser('org')
    delegateOverride = () => {
      throw new Error('bad seed')
    }

    const res = await request(app).post('/api/delegation/grant').set('Authorization', as(org))

    expect(res.status).toBe(503)
    expect(createPayload).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- revoke --

describe('POST /delegation/revoke', () => {
  it('sends an empty permission set to the delegate the grant NAMED', async () => {
    const org = await mkUser('org')
    // The grant was made to a delegate that has since been rotated out.
    await mkRow(org, { kind: 'GRANT', status: 'ACTIVE', delegate: OLD_DELEGATE })
    readPermission.mockResolvedValue('granted')

    const res = await request(app).post('/api/delegation/revoke').set('Authorization', as(org))

    expect(res.status).toBe(201)
    const [txjson, opts] = createPayload.mock.calls[0]!
    expect(txjson).toMatchObject({
      TransactionType: 'DelegateSet',
      Account: org.address,
      Authorize: OLD_DELEGATE, // revoking the CURRENT delegate would leave this one in force
      Permissions: [],
    })
    expect(opts).toMatchObject({ flow: 'DELEGATE_REVOKE' })
  })

  it('does not spend a payload when there is nothing to revoke', async () => {
    const org = await mkUser('org')
    readPermission.mockResolvedValue('absent')

    const res = await request(app).post('/api/delegation/revoke').set('Authorization', as(org))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ state: 'revoked' })
    expect(createPayload).not.toHaveBeenCalled()
  })

  it('still builds a revoke when the ledger cannot be read', async () => {
    // "We could not tell" must not block someone trying to take access away.
    const org = await mkUser('org')
    readPermission.mockResolvedValue('unknown')

    const res = await request(app).post('/api/delegation/revoke').set('Authorization', as(org))

    expect(res.status).toBe(201)
  })

  it('is for organizers only', async () => {
    const user = await mkUser('plain', 'USER')
    const res = await request(app).post('/api/delegation/revoke').set('Authorization', as(user))
    expect(res.status).toBe(403)
  })
})

// ------------------------------------------------------------------ poll --

describe('GET /delegation/:uuid', () => {
  const get = (actor: Actor, uuid: string) =>
    request(app).get(`/api/delegation/${uuid}`).set('Authorization', as(actor))

  it('is private to the organizer who asked', async () => {
    const org = await mkUser('org')
    const other = await mkUser('other')
    const row = await mkRow(org)

    expect((await get(other, row.payloadUuid)).status).toBe(403)
    expect((await get(org, '00000000-0000-4000-8000-000000000000')).status).toBe(404)
  })

  it('stays pending while unsigned', async () => {
    const org = await mkUser('org')
    const row = await mkRow(org)
    tryGetPayload.mockResolvedValue({ signed: false, cancelled: false, expired: false, account: null, txid: null })

    const res = await get(org, row.payloadUuid)
    expect(res.body).toEqual({ state: 'pending' })
  })

  it('treats a rate-limited Xaman as pending, not as a failure', async () => {
    const org = await mkUser('org')
    const row = await mkRow(org)
    tryGetPayload.mockResolvedValue('unavailable')

    expect((await get(org, row.payloadUuid)).body).toEqual({ state: 'pending' })
  })

  it('marks an unsigned payload expired only after Xaman or the clock says so', async () => {
    const org = await mkUser('org')
    const row = await mkRow(org, { expiresInMs: -1000 })
    tryGetPayload.mockResolvedValue({ signed: false, cancelled: false, expired: false, account: null, txid: null })

    expect((await get(org, row.payloadUuid)).body).toEqual({ state: 'expired' })
    expect((await prisma.delegation.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('EXPIRED')
  })

  it('records a rejection', async () => {
    const org = await mkUser('org')
    const row = await mkRow(org)
    tryGetPayload.mockResolvedValue({ signed: false, cancelled: true, expired: false, account: null, txid: null })

    expect((await get(org, row.payloadUuid)).body).toEqual({ state: 'rejected' })
    expect((await prisma.delegation.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('REJECTED')
  })

  it('fails a grant signed by a different account', async () => {
    const org = await mkUser('org')
    const row = await mkRow(org)
    tryGetPayload.mockResolvedValue({
      signed: true,
      cancelled: false,
      expired: false,
      account: 'rSomeoneElse000000000000000000',
      txid: 'AB'.repeat(32),
    })

    const res = await get(org, row.payloadUuid)
    expect(res.body.state).toBe('failed')
    expect(res.body.reason).toMatch(/different account/)
    expect((await prisma.delegation.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('FAILED')
  })

  it('is pending, not granted, while a signature has no transaction yet', async () => {
    const org = await mkUser('org')
    const row = await mkRow(org)
    tryGetPayload.mockResolvedValue({ signed: true, cancelled: false, expired: false, account: org.address, txid: null })

    const res = await get(org, row.payloadUuid)
    expect(res.body).toEqual({ state: 'pending', signed: true })
  })

  it('is pending until the transaction has validated', async () => {
    const org = await mkUser('org')
    const row = await mkRow(org)
    tryGetPayload.mockResolvedValue({ signed: true, cancelled: false, expired: false, account: org.address, txid: 'AB'.repeat(32) })
    txSucceeded.mockResolvedValue(null)

    expect((await get(org, row.payloadUuid)).body).toEqual({ state: 'pending', signed: true })
    expect(readPermission).not.toHaveBeenCalled()
  })

  it('fails when the ledger applied the transaction unsuccessfully', async () => {
    const org = await mkUser('org')
    const row = await mkRow(org)
    tryGetPayload.mockResolvedValue({ signed: true, cancelled: false, expired: false, account: org.address, txid: 'AB'.repeat(32) })
    txSucceeded.mockResolvedValue(false)

    expect((await get(org, row.payloadUuid)).body.state).toBe('failed')
  })

  it('does NOT report granted on a signature alone — the Delegate object must agree', async () => {
    const org = await mkUser('org')
    const row = await mkRow(org)
    tryGetPayload.mockResolvedValue({ signed: true, cancelled: false, expired: false, account: org.address, txid: 'AB'.repeat(32) })
    txSucceeded.mockResolvedValue(true)
    readPermission.mockResolvedValue('absent')

    const res = await get(org, row.payloadUuid)

    expect(res.body).toEqual({ state: 'pending', signed: true })
    // And no failure is written: a read a ledger behind is not evidence the
    // request failed, and writing one would hide a good signature.
    expect((await prisma.delegation.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('SIGNED')
  })

  it('stays pending, not failed, when the ledger cannot be read', async () => {
    const org = await mkUser('org')
    const row = await mkRow(org)
    tryGetPayload.mockResolvedValue({ signed: true, cancelled: false, expired: false, account: org.address, txid: 'AB'.repeat(32) })
    readPermission.mockResolvedValue('unknown')

    expect((await get(org, row.payloadUuid)).body.state).toBe('pending')
  })

  it('reports granted once the ledger confirms, and caches it as ACTIVE', async () => {
    const org = await mkUser('org')
    const row = await mkRow(org)
    tryGetPayload.mockResolvedValue({ signed: true, cancelled: false, expired: false, account: org.address, txid: 'AB'.repeat(32) })
    readPermission.mockResolvedValue('granted')

    expect((await get(org, row.payloadUuid)).body).toEqual({ state: 'granted' })
    const after = await prisma.delegation.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.status).toBe('ACTIVE')
    expect(after.txHash).toBe('AB'.repeat(32))

    // Terminal: a later poll does not ask Xaman again.
    tryGetPayload.mockClear()
    expect((await get(org, row.payloadUuid)).body).toEqual({ state: 'granted' })
    expect(tryGetPayload).not.toHaveBeenCalled()
  })

  it('confirms a revoke by the permission being GONE', async () => {
    const org = await mkUser('org')
    const row = await mkRow(org, { kind: 'REVOKE' })
    tryGetPayload.mockResolvedValue({ signed: true, cancelled: false, expired: false, account: org.address, txid: 'CD'.repeat(32) })

    // Still granted after the signature: not revoked yet.
    readPermission.mockResolvedValue('granted')
    expect((await get(org, row.payloadUuid)).body.state).toBe('pending')

    readPermission.mockResolvedValue('absent')
    expect((await get(org, row.payloadUuid)).body).toEqual({ state: 'revoked' })
    expect((await prisma.delegation.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('REVOKED')
  })
})

// -------------------------------------------------------------------- me --

describe('GET /delegation/me', () => {
  it('reports the ledger state, and unknown is not not_granted', async () => {
    const org = await mkUser('org')
    const get = () => request(app).get('/api/delegation/me').set('Authorization', as(org))

    readPermission.mockResolvedValue('granted')
    expect((await get()).body).toMatchObject({ available: true, state: 'granted', delegateAddress: DELEGATE })

    readPermission.mockResolvedValue('absent')
    expect((await get()).body.state).toBe('not_granted')

    readPermission.mockResolvedValue('unknown')
    expect((await get()).body.state).toBe('unknown')
  })

  it('does not report a grant date once the permission is gone', async () => {
    const org = await mkUser('org')
    await mkRow(org, { kind: 'GRANT', status: 'ACTIVE' })
    const get = () => request(app).get('/api/delegation/me').set('Authorization', as(org))

    readPermission.mockResolvedValue('granted')
    expect((await get()).body.grantedAt).not.toBeNull()

    readPermission.mockResolvedValue('absent')
    expect((await get()).body.grantedAt).toBeNull()
  })

  it('says so when the grant on file names a delegate that is no longer current', async () => {
    const org = await mkUser('org')
    await mkRow(org, { kind: 'GRANT', status: 'ACTIVE', delegate: OLD_DELEGATE })
    readPermission.mockResolvedValue('absent')

    const res = await request(app).get('/api/delegation/me').set('Authorization', as(org))

    expect(res.body.staleGrant).toBe(true)
    expect(res.body.state).toBe('not_granted')
  })

  it('is unavailable without the amendment', async () => {
    const org = await mkUser('org')
    delegationAvailable.mockResolvedValue(false)

    const res = await request(app).get('/api/delegation/me').set('Authorization', as(org))

    expect(res.body).toEqual({ available: false, state: 'unavailable' })
  })

  it('is for organizers only', async () => {
    const user = await mkUser('plain', 'USER')
    const res = await request(app).get('/api/delegation/me').set('Authorization', as(user))
    expect(res.status).toBe(403)
  })
})
