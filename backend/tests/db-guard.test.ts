/**
 * Destructive scripts must refuse based on WHAT THEY ARE CONNECTED TO.
 *
 * Seven scripts guarded with `env.NODE_ENV === 'production'`, which describes
 * the PROCESS rather than the database. Those come apart in this repo's own
 * documented workflow: `ledger:sync --apply` against production is meant to be
 * run from a laptop with the production `DATABASE_URL` in a gitignored
 * `.env.production.local`. Once that file exists, "local process, production
 * database" is ordinary — and every one of those guards passes.
 *
 * Not theoretical. On 2026-08-13 `purge:test --apply` was run locally against
 * production to delete a test event. It did the right thing, but only because it
 * was dry-run first and the matched rows read by hand. The guard printed nothing
 * and stopped nothing.
 *
 * These tests pin the decision function rather than the process exit, so they
 * assert the rule without spawning anything.
 */
import { describe, expect, it } from 'vitest'
import { OVERRIDE_FLAG, databaseTarget, remoteDatabaseMessage } from '../src/db-guard.js'

const LOCAL = 'postgresql://someone@localhost:5432/hubworld_dev?schema=public'
const LOOPBACK = 'postgresql://someone@127.0.0.1:5432/hubworld_dev'
const SUPABASE = 'postgresql://postgres.abc:hunter2@aws-1-us-west-2.pooler.supabase.com:5432/postgres'

describe('reading where DATABASE_URL points', () => {
  it('treats localhost and loopback as this machine', () => {
    expect(databaseTarget(LOCAL).local).toBe(true)
    expect(databaseTarget(LOOPBACK).local).toBe(true)
  })

  it('treats anything else as somebody else’s server', () => {
    const t = databaseTarget(SUPABASE)
    expect(t.local).toBe(false)
    expect(t.host).toBe('aws-1-us-west-2.pooler.supabase.com')
    expect(t.database).toBe('postgres')
  })

  it('never carries the password, even into a return value', () => {
    // A guard that prints a connection string to be helpful is a guard that
    // writes a password into a terminal, a CI log, and a screenshot.
    const t = databaseTarget(SUPABASE)
    expect(JSON.stringify(t)).not.toContain('hunter2')
  })

  it('treats an unparseable URL as REMOTE, not as safe', () => {
    // The benign assumption is the dangerous one here: an unreadable URL is not
    // evidence that it points somewhere harmless.
    expect(databaseTarget('not a url at all').local).toBe(false)
  })
})

describe('the refusal message', () => {
  it('names the host and database, so nobody has to guess if it is right', () => {
    const msg = remoteDatabaseMessage('purge:test', databaseTarget(SUPABASE))

    expect(msg).toContain('purge:test')
    expect(msg).toContain('aws-1-us-west-2.pooler.supabase.com')
    expect(msg).toContain('postgres')
  })

  it('says how to proceed deliberately', () => {
    // Without an escape hatch the guard gets commented out the first time
    // somebody genuinely needs it — and then it is gone for good.
    expect(remoteDatabaseMessage('demo:reset', databaseTarget(SUPABASE))).toContain(OVERRIDE_FLAG)
  })

  it('does not leak the password into the message', () => {
    expect(remoteDatabaseMessage('demo:reset', databaseTarget(SUPABASE))).not.toContain('hunter2')
  })
})

describe('the override', () => {
  it('is explicit enough to show up in shell history', () => {
    // Deliberately not an env var: a flag is visible in the command someone
    // actually ran, which is what an audit reads afterwards.
    expect(OVERRIDE_FLAG.startsWith('--')).toBe(true)
    expect(OVERRIDE_FLAG).toMatch(/remote|production/i)
  })
})
