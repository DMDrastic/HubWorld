/**
 * Sending email, behind a seam.
 *
 * Mirrors `xaman.ts`: a live sender and a stub, chosen by `mailMode`, so the whole
 * flow can be driven in dev and tests with no provider and no cost. The stub keeps
 * what it was asked to send in `outbox`, which is how tests read a verification link
 * without a mailbox.
 *
 * Sending is best-effort and says so: `send` resolves to `'sent'` or `'failed'` and
 * never throws, because a provider outage must not turn an application, a review or a
 * resend into a 500 — the row is the record, the email is a notification of it.
 *
 * Neither implementation logs an address or a body in production. The stub prints a
 * message only outside production (that is how a developer finds the link); the live
 * sender logs the provider's status code and nothing else.
 */
import { env, mailMode } from './env.js'

export type Mail = { to: string; subject: string; text: string }
export type SendResult = 'sent' | 'failed'

export interface MailSender {
  readonly mode: 'live' | 'stub'
  send(mail: Mail): Promise<SendResult>
}

const OUTBOX_LIMIT = 50

/** Messages the stub was asked to send, newest last. Capped so a dev server cannot grow it forever. */
export const outbox: Mail[] = []

export const stubSender: MailSender = {
  mode: 'stub',
  async send(mail) {
    outbox.push(mail)
    if (outbox.length > OUTBOX_LIMIT) outbox.shift()
    if (env.NODE_ENV !== 'production') {
      console.log(`[mail:stub] to=${mail.to} subject="${mail.subject}"\n${mail.text}`)
    }
    return 'sent'
  },
}

/** Resend's send endpoint. Overridable so a test can point at a local server. */
export const RESEND_URL = 'https://api.resend.com/emails'

export function resendSender(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): MailSender {
  return {
    mode: 'live',
    async send(mail) {
      try {
        const res = await fetchImpl(RESEND_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
          // A hung provider must not hold a request open.
          signal: AbortSignal.timeout(8000),
        })
        if (res.ok) return 'sent'
        console.warn(`mail send refused by provider: HTTP ${res.status}`)
        return 'failed'
      } catch (err) {
        console.warn('mail send failed:', err instanceof Error ? err.name : 'unknown error')
        return 'failed'
      }
    },
  }
}

export const mailer: MailSender =
  mailMode === 'live' ? resendSender(env.RESEND_API_KEY!, env.MAIL_FROM!) : stubSender
