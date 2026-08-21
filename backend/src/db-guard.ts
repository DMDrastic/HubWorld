/**
 * Refuse to run a destructive script against a database that is not local.
 *
 * Seven scripts used to guard with `env.NODE_ENV === 'production'`. That names
 * **the process**, not **the database the process is talking to** — and the two
 * come apart in the repo's own documented workflow, where `ledger:sync --apply`
 * against production is meant to be run from a laptop with the production
 * `DATABASE_URL` in a gitignored `.env.production.local`. Once that file exists,
 * "local process, production database" is a normal state and every one of those
 * guards passes.
 *
 * Confirmed in practice on 2026-08-13: `purge:test --apply` was run locally
 * against production to delete a test event. It did the right thing, but only
 * because it was dry-run first and the matched rows inspected by hand. **The
 * guard printed nothing and stopped nothing.**
 *
 * So the check asks the question that matters — *what am I connected to?* —
 * and it lives in ONE place. Seven copies is how a new script ends up with the
 * wrong one, which is the same reason payload counting lives in the signer seam
 * rather than in eleven routes.
 */
import { env } from './env.js'

/** Hosts that are unambiguously this machine. Everything else is somebody's server. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', ''])

/** Opt out ON PURPOSE, in a way that shows up in shell history. */
export const OVERRIDE_FLAG = '--allow-remote-database'

export type DatabaseTarget = { host: string; database: string; local: boolean }

/**
 * Where `DATABASE_URL` points, with the credentials left out.
 *
 * Deliberately returns the host and database only. A guard that prints a
 * connection string to make itself helpful is a guard that writes a password
 * into a terminal, a CI log and a screenshot.
 */
export function databaseTarget(url = env.DATABASE_URL): DatabaseTarget {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname
    return {
      host: host || '(unknown)',
      database: parsed.pathname.replace(/^\//, '') || '(unknown)',
      local: LOCAL_HOSTS.has(host),
    }
  } catch {
    // An unparseable URL is not evidence of safety. Treat it as remote and make
    // someone look, rather than assuming the benign case.
    return { host: '(unparseable)', database: '(unknown)', local: false }
  }
}

/**
 * The refusal message.
 *
 * Split out so it can be asserted without a process boundary, and so the wording
 * is pinned: it must name what it is connected to, because "refusing to run"
 * without saying WHERE leaves someone to guess whether the guard is right.
 */
export function remoteDatabaseMessage(script: string, target: DatabaseTarget): string {
  return (
    `Refusing to run ${script}: DATABASE_URL points at ${target.database} on ` +
    `${target.host}, which is not this machine.\n\n` +
    `This script changes or deletes data. If that is genuinely what you want, ` +
    `re-run it with ${OVERRIDE_FLAG}.`
  )
}

/**
 * Call at the top of any script that writes or deletes.
 *
 * Two refusals, because they catch different mistakes. `NODE_ENV=production`
 * catches running inside a deployed process; a non-local `DATABASE_URL` catches
 * the far likelier case of a developer or an agent pointed at production from a
 * laptop.
 *
 * The target is always printed, even when allowed, so a dry run makes the
 * destination unambiguous rather than assumed.
 */
export function assertSafeDatabase(script: string, argv: string[] = process.argv): void {
  if (env.NODE_ENV === 'production') {
    console.error(`Refusing to run ${script} in production.`)
    process.exit(1)
  }

  const target = databaseTarget()
  console.log(`${script} → ${target.database} on ${target.host}`)

  if (target.local) return
  if (argv.includes(OVERRIDE_FLAG)) {
    console.warn(`${OVERRIDE_FLAG} given — proceeding against a REMOTE database.`)
    return
  }

  console.error(`\n${remoteDatabaseMessage(script, target)}`)
  process.exit(1)
}
