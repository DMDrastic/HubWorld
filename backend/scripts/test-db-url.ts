/**
 * Where the tests' database lives.
 *
 * Shared by `setup-test-db.ts` and `vitest.config.ts` so the two can never
 * disagree about which database is being created versus used — a mismatch there
 * would be a very confusing afternoon.
 *
 * Precedence: an explicit TEST_DATABASE_URL wins; otherwise the dev URL with its
 * database name swapped for `hubworld_test`. CI already sets DATABASE_URL to a
 * `hubworld_test` database, so the swap is a no-op there and nothing special is
 * needed for it.
 *
 * dotenv is loaded HERE rather than by each caller, so neither can forget it.
 * It never overwrites a variable that is already set, so CI — which exports
 * DATABASE_URL directly and ships no .env — is unaffected.
 */
import { config as loadEnv } from 'dotenv'

loadEnv()
export function testDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL
  if (explicit) return explicit

  const dev = process.env.DATABASE_URL
  if (!dev) {
    throw new Error('No DATABASE_URL or TEST_DATABASE_URL — nothing to derive a test database from.')
  }
  const u = new URL(dev)
  u.pathname = '/hubworld_test'
  return u.toString()
}

export function databaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, '')
}

/** The same server, but connected to `postgres` — you cannot CREATE a database from inside it. */
export function adminUrl(url: string): string {
  const u = new URL(url)
  u.pathname = '/postgres'
  u.search = ''
  return u.toString()
}
