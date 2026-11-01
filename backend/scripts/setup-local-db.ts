/**
 * Create and migrate the local stack's own database (`hubworld_local`), and write its URL where the stack can read it.
 *
 *   npx tsx scripts/setup-local-db.ts --emit <file>
 *
 * Called by `local-stack.sh start`; idempotent. The URL is written to <file> (mode 600) rather than printed, because it may hold
 * a password; only the database's NAME is printed.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { adminUrl, databaseName } from './test-db-url.js'
import { localDatabaseUrl } from './local-db-url.js'

const i = process.argv.indexOf('--emit')
const emit = i === -1 ? null : process.argv[i + 1]

try {
  const url = localDatabaseUrl({ dev: process.env.DATABASE_URL, explicit: process.env.LOCAL_DATABASE_URL })
  const name = databaseName(url)
  try {
    execFileSync('psql', [adminUrl(url), '-v', 'ON_ERROR_STOP=1', '-q', '-c', `CREATE DATABASE "${name}"`], { stdio: 'pipe' })
    console.log(`created ${name}`)
  } catch {
    // Already there, which is the usual case.
  }
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' })
  console.log(`${name} is migrated`)
  if (emit) {
    writeFileSync(emit, `DATABASE_URL=${url}\n`, { mode: 0o600 })
    chmodSync(emit, 0o600)
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
