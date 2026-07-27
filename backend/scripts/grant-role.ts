/**
 * Bootstrap: grant a role from the command line.
 *
 * The first ADMIN has to come from somewhere, and it must not be a route —
 * a self-serve "make me an admin" endpoint is an obvious privilege escalation.
 * Granting requires database access, which is the point.
 *
 *   npm run role:grant -- @handle ADMIN
 */
import { prisma } from '../src/prisma.js'

async function main() {
  const handle = (process.argv[2] ?? '').replace(/^@/, '')
  const role = (process.argv[3] ?? '').toUpperCase()

  if (!handle || !['USER', 'ORGANIZER', 'ADMIN'].includes(role)) {
    console.error('Usage: npm run role:grant -- @handle USER|ORGANIZER|ADMIN')
    process.exit(1)
  }

  const user = await prisma.user.findUnique({ where: { username: handle } })
  if (!user) {
    console.error(`No user @${handle}`)
    process.exit(1)
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { role: role as 'USER' | 'ORGANIZER' | 'ADMIN' },
  })
  console.log(`@${updated.username}: ${user.role} -> ${updated.role}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
