/**
 * Create and migrate the local test database.
 *
 *   npm run db:test:setup
 *   npm run db:test:setup -- --reset     drop it first
 *
 * Tests used to run against `hubworld_dev`, the same database the dev server
 * uses. That is three separate problems, all measured rather than theorised:
 *
 *  1. The dev server's settlement sweep runs every 15s and deletes fixtures out
 *     from under a running test — ~20% of full-suite runs failed with the server
 *     up, 0% with it stopped.
 *  2. Stryker runs four vitest workers concurrently against one database, which
 *     collides the same way.
 *  3. It is why `src/ledger.ts` — all the money math, the highest-value mutation
 *     target left — cannot be mutated.
 *
 * CI never had this problem: it already points DATABASE_URL at `hubworld_test`
 * in a throwaway service container. This just makes local match CI.
 *
 * Idempotent: safe to re-run, and `--reset` is the fix for a schema that has
 * drifted rather than something to reach for routinely.
 */
import { execFileSync } from 'node:child_process'
import { testDatabaseUrl, databaseName, adminUrl } from './test-db-url.js'

const reset = process.argv.includes('--reset')
const url = testDatabaseUrl()
const name = databaseName(url)

if (!/test/i.test(name)) {
  // A guard, not politeness. This script drops databases.
  console.error(`Refusing to touch "${name}" — the test database name must contain "test".`)
  process.exit(1)
}

const psql = (sql: string, target = adminUrl(url)) =>
  execFileSync('psql', [target, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], { stdio: 'pipe' })

try {
  if (reset) {
    psql(`DROP DATABASE IF EXISTS "${name}"`)
    console.log(`dropped ${name}`)
  }
  try {
    psql(`CREATE DATABASE "${name}"`)
    console.log(`created ${name}`)
  } catch {
    console.log(`${name} already exists`)
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  })
  console.log(`\n${name} is migrated and ready. \`npm test\` will use it automatically.`)
} catch (err) {
  console.error('\nFailed. Is Postgres running on the host in DATABASE_URL?')
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
