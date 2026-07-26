import { z } from 'zod'

/** @handles are stored lowercase; the leading @ is a display concern, not data. */
export const usernameSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/^@/, '').toLowerCase())
  .pipe(
    z
      .string()
      .regex(/^[a-z0-9_]{3,20}$/, 'usernames are 3–20 chars: a–z, 0–9, underscore'),
  )

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]{1,80}$/, 'invalid slug')

/** XRPL classic address: base58, no 0/O/I/l. */
export const xrplAddressSchema = z
  .string()
  .trim()
  .regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/, 'not a valid XRPL classic address')

/** Turn a Zod error into a flat list of human-readable strings. */
export function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const path = i.path.join('.')
    return path ? `${path}: ${i.message}` : i.message
  })
}
