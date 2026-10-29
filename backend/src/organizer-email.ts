/**
 * Proving an applicant controls the email they gave, and telling them what happened.
 *
 * An organizer application used to carry a free-text "contact" and nothing could reach
 * it, so an approval, a rejection or a question was only ever seen if the applicant
 * happened to sign in again. This is the smallest thing that fixes that.
 *
 * Rules, each of which closes a way for this to be abused:
 *
 * - **Only the token's hash is stored**, so a leaked table is not a set of working links.
 * - **A link vouches for one address.** It records the email it was sent to, and verifying
 *   marks the application verified only if that is still the address on the application.
 *   Switching address after requesting a link therefore cannot verify the new one.
 * - **Single use, 24 hours.** `usedAt` is set in the same conditional update that checks it,
 *   so two clicks verify once.
 * - **Nothing is mailed to an unverified address except the verification itself.** Anyone
 *   can type anyone's address; a decision or a reminder sent to a stranger is spam from us.
 * - **A resend has a cooldown**, so the form cannot be used to flood an inbox.
 * - **A failed send is reported, not fatal.** The application exists either way.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { OrganizerApplication } from '@prisma/client'
import { prisma } from './prisma.js'
import { env } from './env.js'
import { mailer, type MailSender, type SendResult } from './mailer.js'

export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000
export const RESEND_COOLDOWN_MS = 60 * 1000

const hash = (token: string) => createHash('sha256').update(token).digest('hex')

/** The link in the email. The page it opens POSTs the token; the link itself changes nothing. */
export function verifyUrl(token: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/organize?verify=${encodeURIComponent(token)}`
}

/** Create a link for the application's CURRENT address and email it. */
export async function sendVerification(
  application: Pick<OrganizerApplication, 'id' | 'email' | 'orgName'>,
  sender: MailSender = mailer,
): Promise<SendResult> {
  if (!application.email) return 'failed'
  const token = randomBytes(32).toString('base64url')
  await prisma.emailVerification.create({
    data: {
      applicationId: application.id,
      email: application.email,
      tokenHash: hash(token),
      expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
    },
  })
  return sender.send({
    to: application.email,
    subject: 'Confirm your email for your HubWorld organizer application',
    text: [
      `You applied to organize on HubWorld as "${application.orgName}".`,
      '',
      'Confirm this is your email address so we can reach you about your application:',
      verifyUrl(token),
      '',
      'The link works once and expires in 24 hours. If you did not apply, ignore this email and nothing happens.',
    ].join('\n'),
  })
}

export type VerifyOutcome = 'verified' | 'invalid'

/**
 * Consume a link. One answer for every failure (unknown, expired, used, address changed),
 * because telling a guesser which of those it was only helps them.
 */
export async function verifyEmail(token: string): Promise<VerifyOutcome> {
  const row = await prisma.emailVerification.findUnique({
    where: { tokenHash: hash(token) },
    include: { application: { select: { email: true } } },
  })
  if (!row || row.usedAt || row.expiresAt <= new Date()) return 'invalid'
  if (row.application.email !== row.email) return 'invalid'

  // The conditional update is the single-use guarantee: of two concurrent clicks,
  // exactly one finds usedAt still null.
  const claimed = await prisma.emailVerification.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  })
  if (claimed.count !== 1) return 'invalid'

  await prisma.organizerApplication.update({
    where: { id: row.applicationId },
    data: { emailVerifiedAt: new Date() },
  })
  return 'verified'
}

/** Seconds until another link may be requested, or 0. */
export async function resendWaitSeconds(applicationId: string, now = Date.now()): Promise<number> {
  const last = await prisma.emailVerification.findFirst({
    where: { applicationId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  if (!last) return 0
  const wait = last.createdAt.getTime() + RESEND_COOLDOWN_MS - now
  return wait > 0 ? Math.ceil(wait / 1000) : 0
}

/** Tell an applicant the outcome. Only to a VERIFIED address; otherwise a quiet no-op. */
export async function sendDecision(
  application: Pick<OrganizerApplication, 'email' | 'emailVerifiedAt' | 'orgName'>,
  approved: boolean,
  note: string | null,
  sender: MailSender = mailer,
): Promise<SendResult | 'skipped'> {
  if (!application.email || !application.emailVerifiedAt) return 'skipped'
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, '')
  return sender.send({
    to: application.email,
    subject: approved
      ? 'You are approved to organize on HubWorld'
      : 'An update on your HubWorld organizer application',
    text: approved
      ? [
          `Your application for "${application.orgName}" was approved.`,
          '',
          `Sign in and open Organize to create your first event: ${base}/organize`,
        ].join('\n')
      : [
          `Your application for "${application.orgName}" was not approved this time.`,
          ...(note ? ['', `Note from the team: ${note}`] : []),
          '',
          `You can revise it and apply again from ${base}/organize.`,
        ].join('\n'),
  })
}
