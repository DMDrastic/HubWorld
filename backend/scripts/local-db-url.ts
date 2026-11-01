/**
 * Where the local stack's own database lives: `hubworld_local`, on the same server as the dev database, never the dev database
 * itself and never another machine. Its test events and purchases then stay out of the database an ordinary `npm run dev` uses.
 */
import { databaseName } from './test-db-url.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function localDatabaseUrl(input: { dev: string | undefined; explicit?: string }): string {
  const base = input.dev
  if (!input.explicit && !base) throw new Error('No DATABASE_URL to derive the local stack’s database from.')
  let url: string
  if (input.explicit) {
    url = input.explicit
  } else {
    const u = new URL(base!)
    u.pathname = '/hubworld_local'
    url = u.toString()
  }
  const host = new URL(url).hostname
  if (!LOCAL_HOSTS.has(host)) throw new Error(`The local stack’s database must be on this machine; ${host} is not local.`)
  if (base && databaseName(url) === databaseName(base) && new URL(url).hostname === new URL(base).hostname) {
    throw new Error('The local stack needs its own database, not the dev database.')
  }
  return url
}
