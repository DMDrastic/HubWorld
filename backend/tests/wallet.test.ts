/**
 * The Wallet table: an account is the identity, a wallet is attached to it.
 *
 * Phase 2a changes nothing about how the app behaves, so this pins what must hold while it
 * lands: the backfill gives every existing user exactly one XAMAN wallet carrying the address
 * they already had (and can be run twice), a new Xaman sign-up gets its wallet in the same
 * write, and the helper never assumes an address exists.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { Wallet } from 'xrpl'

const { prisma } = await import('../src/prisma.js')
const { createApp } = await import('../src/app.js')
const { getUserXrplAddress } = await import('../src/wallet.js')

const app = createApp()
const P = 'wallettest_'
const addr = () => Wallet.generate().classicAddress

async function cleanup() {
  await prisma.signInRequest.deleteMany({ where: { payloadUuid: { startsWith: '00000000-0000-4000-8000-' } } })
  await prisma.session.deleteMany({ where: { user: { username: { startsWith: P } } } })
  // Wallets go with their user (cascade), including any left by a half-finished test.
  await prisma.user.deleteMany({ where: { username: { startsWith: P } } })
}
beforeEach(cleanup)
afterEach(cleanup)
afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

/** The backfill statement itself, read from the shipped migration so this cannot test a copy. */
function backfillSql(): string {
  const dir = join(__dirname, '..', 'prisma', 'migrations', '20261030230000_wallet_table', 'migration.sql')
  const sql = readFileSync(dir, 'utf8')
  const at = sql.indexOf('INSERT INTO "Wallet"')
  if (at < 0) throw new Error('backfill statement not found in the migration')
  return sql.slice(at)
}

describe('getUserXrplAddress', () => {
  it('reads the wallet row when there is one', async () => {
    const a = addr()
    const u = await prisma.user.create({
      data: { username: `${P}a`, xrplAddress: a, wallet: { create: { xrplAddress: a, signerKind: 'XAMAN' } } },
    })
    expect(await getUserXrplAddress(u.id)).toBe(a)
  })

  it('falls back to the legacy column for a user with no wallet row', async () => {
    const a = addr()
    const u = await prisma.user.create({ data: { username: `${P}legacy`, xrplAddress: a } })
    expect(await prisma.wallet.count({ where: { userId: u.id } })).toBe(0)
    expect(await getUserXrplAddress(u.id)).toBe(a)
  })

  it('prefers the wallet row over the column when they differ', async () => {
    // Not a state we create, but it decides which one is the source of truth.
    const col = addr()
    const wal = addr()
    const u = await prisma.user.create({
      data: { username: `${P}diff`, xrplAddress: col, wallet: { create: { xrplAddress: wal, signerKind: 'XAMAN' } } },
    })
    expect(await getUserXrplAddress(u.id)).toBe(wal)
  })

  it('answers null for someone who does not exist, rather than throwing', async () => {
    expect(await getUserXrplAddress('00000000-0000-4000-8000-00000000dead')).toBeNull()
  })
})

describe('the backfill', () => {
  it('gives each existing user exactly one XAMAN wallet with the address they had, and nothing is guessed', async () => {
    const a1 = addr()
    const a2 = addr()
    const u1 = await prisma.user.create({ data: { username: `${P}one`, xrplAddress: a1 } })
    const u2 = await prisma.user.create({ data: { username: `${P}two`, xrplAddress: a2 } })

    await prisma.$executeRawUnsafe(backfillSql())

    for (const [u, a] of [[u1, a1], [u2, a2]] as const) {
      const w = await prisma.wallet.findMany({ where: { userId: u.id } })
      expect(w).toHaveLength(1)
      expect(w[0]).toMatchObject({ xrplAddress: a, signerKind: 'XAMAN', providerUserId: null, publicKey: null })
      // A sign-in proves control of an address, not that it is funded.
      expect(w[0]!.activatedAt).toBeNull()
    }
  })

  it('can be run twice without duplicating or failing, and leaves an existing wallet alone', async () => {
    const a = addr()
    const u = await prisma.user.create({
      data: {
        username: `${P}keep`,
        xrplAddress: a,
        wallet: { create: { xrplAddress: a, signerKind: 'PRIVY', providerUserId: 'did:privy:keep' } },
      },
    })
    await prisma.$executeRawUnsafe(backfillSql())
    await prisma.$executeRawUnsafe(backfillSql())
    const w = await prisma.wallet.findMany({ where: { userId: u.id } })
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ signerKind: 'PRIVY', providerUserId: 'did:privy:keep' })
  })
})

describe('signing up with Xaman', () => {
  async function signedRequest(n: number, address: string) {
    const uuid = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    await prisma.signInRequest.create({
      data: {
        payloadUuid: uuid,
        status: 'SIGNED',
        resolvedAddress: address,
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    return uuid
  }

  it('creates the account and its XAMAN wallet in the same write', async () => {
    const a = addr()
    const uuid = await signedRequest(1, a)
    const res = await request(app).post('/api/auth/claim').send({ uuid, username: `${P}new` })
    expect(res.status).toBe(201)
    const user = await prisma.user.findUniqueOrThrow({ where: { username: `${P}new` }, include: { wallet: true } })
    expect(user.xrplAddress).toBe(a)
    expect(user.wallet).toMatchObject({ xrplAddress: a, signerKind: 'XAMAN', providerUserId: null })
  })

  it('leaves no half-made account when the wallet cannot be written', async () => {
    const a = addr()
    // Another user's wallet already holds this address, so the nested wallet insert must fail.
    const other = await prisma.user.create({
      data: { username: `${P}holder`, xrplAddress: addr(), wallet: { create: { xrplAddress: a, signerKind: 'XAMAN' } } },
    })
    expect(other.id).toBeTruthy()
    const uuid = await signedRequest(2, a)
    const res = await request(app).post('/api/auth/claim').send({ uuid, username: `${P}ghost` })
    expect(res.status).toBeGreaterThanOrEqual(400)
    // The user write rolled back with the wallet write.
    expect(await prisma.user.count({ where: { username: `${P}ghost` } })).toBe(0)
  })
})
