import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { prisma } from './prisma.js'
import { env } from './env.js'
import type { UserRole } from '@prisma/client'

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

/**
 * Session cookie.
 *
 * httpOnly is the point: the browser sends it automatically but no script can
 * read it, so an XSS bug can no longer exfiltrate the session the way reading
 * localStorage could.
 *
 * SameSite=Lax means the cookie is not sent on cross-site POSTs, which is what
 * closes the CSRF hole that cookie auth would otherwise open. That protection
 * assumes the API is served same-origin with the app — see the note in
 * CLAUDE.md about deploying behind one origin.
 */
export const SESSION_COOKIE = 'hubworld_session'

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Secure would make the cookie undeliverable over plain-HTTP localhost.
    secure: env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  })
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
  })
}

/**
 * Where a request's token comes from. The cookie is checked first — that is the
 * browser path. The Authorization header is still honoured for non-browser
 * clients (curl, scripts); it is not the risk, because the exposure was ever
 * only about JavaScript being able to read stored tokens.
 */
export function tokenFrom(req: Request): string | null {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies
  const fromCookie = cookies?.[SESSION_COOKIE]
  if (typeof fromCookie === 'string' && fromCookie.length > 0) return fromCookie

  const header = req.get('authorization')
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token.length > 0 ? token : null
}

/** @deprecated use {@link tokenFrom} — kept so callers read either source. */
export const bearerFrom = tokenFrom

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string
      userRole?: UserRole
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = tokenFrom(req)
  if (!token) {
    res.status(401).json({ error: 'Not signed in' })
    return
  }

  const session = await resolveSession(token)
  if (!session) {
    // A dead cookie would otherwise sit in the browser re-failing forever.
    clearSessionCookie(res)
    res.status(401).json({ error: 'Invalid or expired session' })
    return
  }

  req.userId = session.userId
  req.userRole = session.user.role
  next()
}

/**
 * Require an organizer (admins included).
 *
 * Deliberately a ROLE check, not "do you own this event". Ownership answers
 * which event you may act on; the role answers whether you may issue admission
 * at all. Conflating them means anyone handed an event row becomes an issuer,
 * and there would be nothing to gate self-serve event creation on.
 */
export function requireOrganizer(req: Request, res: Response, next: NextFunction) {
  if (req.userRole !== 'ORGANIZER' && req.userRole !== 'ADMIN') {
    // 403 rather than 404: they are authenticated, just not permitted.
    res.status(403).json({ error: 'This action is for event organizers' })
    return
  }
  next()
}

/** Require an admin. Reviewing organizer applications is the only such power. */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.userRole !== 'ADMIN') {
    res.status(403).json({ error: 'Admins only' })
    return
  }
  next()
}
