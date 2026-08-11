/**
 * Fail fast, and say what to do about it.
 *
 * Without this, running the suite before creating the test database gives a
 * Prisma stack trace about a database that does not exist — accurate, and no
 * help at all if you did not know a separate one existed. One query and a
 * sentence is worth more than the trace.
 */
import { PrismaClient } from '@prisma/client'
import { testDatabaseUrl, databaseName } from '../scripts/test-db-url.js'

export default async function setup() {
  const url = testDatabaseUrl()
  const prisma = new PrismaClient({ datasourceUrl: url })
  try {
    // Touches a real table, so an existing-but-unmigrated database fails here
    // rather than deep inside the first suite that needs a schema.
    await prisma.user.count()
  } catch {
    throw new Error(
      `\nThe test database "${databaseName(url)}" is missing or unmigrated.\n\n` +
        `  npm run db:test:setup\n\n` +
        `Tests deliberately do NOT share hubworld_dev: the dev server's 15s\n` +
        `settlement sweep deletes fixtures mid-test, which cost ~20% of runs.\n`,
    )
  } finally {
    await prisma.$disconnect()
  }
}
