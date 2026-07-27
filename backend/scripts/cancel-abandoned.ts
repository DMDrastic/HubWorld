/**
 * Free Xaman payload slots by cancelling ones nobody will sign.
 *
 * Xaman caps open UNRESOLVED payloads per application. Once full, the account
 * cannot create any payload at all and sign-in breaks for everyone — which is
 * exactly what happened here at 67.
 */
import { prisma } from '../src/prisma.js'
import { cancelAbandonedPayloads } from '../src/payload-store.js'

async function main() {
  const n = await cancelAbandonedPayloads(200)
  console.log(`cancelled ${n} abandoned payload(s)`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
