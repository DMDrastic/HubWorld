/** Where the local stack's own database lives: next to the dev database, never in it, and never on another machine. */
import { describe, expect, it } from 'vitest'
import { localDatabaseUrl } from '../scripts/local-db-url.js'

const DEV = 'postgresql://me:p%40ss@localhost:5432/hubworld_dev?schema=public'

describe('localDatabaseUrl', () => {
  it('is the dev database’s server with the name hubworld_local, keeping the rest', () => {
    const u = new URL(localDatabaseUrl({ dev: DEV }))
    expect(u.pathname).toBe('/hubworld_local')
    expect(u.hostname).toBe('localhost')
    expect(u.searchParams.get('schema')).toBe('public')
    expect(u.password).toBe('p%40ss')
  })

  it('an explicit LOCAL_DATABASE_URL wins', () => {
    expect(localDatabaseUrl({ dev: DEV, explicit: 'postgresql://me@127.0.0.1:5433/mine' })).toBe('postgresql://me@127.0.0.1:5433/mine')
  })

  it('refuses a database that is not on this machine, either way it is given', () => {
    expect(() => localDatabaseUrl({ dev: 'postgresql://me@db.example.com:5432/hubworld_dev' })).toThrow(/not local/i)
    expect(() => localDatabaseUrl({ dev: DEV, explicit: 'postgresql://me@db.example.com/x' })).toThrow(/not local/i)
  })

  it('refuses to be the dev database itself', () => {
    expect(() => localDatabaseUrl({ dev: DEV, explicit: DEV })).toThrow(/own database/i)
  })

  it('needs something to start from', () => {
    expect(() => localDatabaseUrl({ dev: undefined })).toThrow(/DATABASE_URL/)
  })
})
