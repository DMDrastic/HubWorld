import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { prisma } from './prisma.js'

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/** Only the hash is ever persisted; the raw token exists once, in the response. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  await prisma.session.create({
    data: { tokenHash: hashToken(token), userId, expiresAt },
  })

  return { token, expiresAt }
}

export async function resolveSession(token: string) {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  })

  if (!session || session.revokedAt || session.expiresAt < new Date()) return null

  // Constant-time compare guards against a timing oracle on the hash lookup.
  const a = Buffer.from(session.tokenHash)
  const b = Buffer.from(hashToken(token))
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  await prisma.session.update({
    where: { id: session.id },
    data: { lastSeenAt: new Date() },
  })

  return session
}

export async function revokeSession(token: string) {
  await prisma.session
    .update({
      where: { tokenHash: hashToken(token) },
      data: { revokedAt: new Date() },
    })
    .catch(() => undefined) // already gone is not an error
}

export function bearerFrom(req: Request): string | null {
  const header = req.get('authorization')
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token.length > 0 ? token : null
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = bearerFrom(req)
  if (!token) {
    res.status(401).json({ error: 'Missing bearer token' })
    return
  }

  const session = await resolveSession(token)
  if (!session) {
    res.status(401).json({ error: 'Invalid or expired session' })
    return
  }

  req.userId = session.userId
  next()
}
