/**
 * Dev utility: create an event owned by an existing @handle.
 *
 * There is no event-creation API yet — organizers are onboarded by hand while
 * the platform is pre-launch. This exists so you can mint against an event you
 * actually control, rather than the seeded ones owned by @stationsquare.
 *
 *   npm run event:create -- --organizer dm_drastic --title "Neon Rooftop"
 */
import { prisma } from '../src/prisma.js'
import { env } from '../src/env.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

async function main() {
  const organizer = arg('organizer')?.replace(/^@/, '')
  const title = arg('title')

  if (!organizer || !title) {
    console.error('Usage: --organizer <handle> --title "<title>" [--slug s] [--royalty-bps 500] [--tickets 50]')
    process.exit(1)
  }

  const user = await prisma.user.findUnique({ where: { username: organizer } })
  if (!user) {
    console.error(`No user @${organizer}. Sign in first so the account exists.`)
    process.exit(1)
  }

  const slug = arg('slug') ?? slugify(title)
  const royaltyBps = Number(arg('royalty-bps') ?? 500)
  // Policy, not an argument. The API refuses organizer-supplied platform fees;
  // a script that quietly accepted one would be the same hole with a different
  // door — and scripts are exactly where such things get forgotten.
  const platformBps = env.PLATFORM_FEE_BPS

  if (royaltyBps > env.MAX_ROYALTY_BPS) {
    console.error(`Royalty ${royaltyBps}bps exceeds the ${env.MAX_ROYALTY_BPS}bps cap.`)
    process.exit(1)
  }
  const ticketCount = Number(arg('tickets') ?? 50)

  // Taxon groups every ticket for one event on-ledger. Keep it unique per
  // event so `account_nfts` can be filtered back to a single event.
  const highest = await prisma.event.findFirst({
    orderBy: { nftTaxon: 'desc' },
    select: { nftTaxon: true },
  })
  const nftTaxon = Number(arg('taxon') ?? (highest?.nftTaxon ?? 1000) + 1)

  const existing = await prisma.event.findUnique({ where: { slug } })
  if (existing) {
    console.error(`Event "${slug}" already exists.`)
    process.exit(1)
  }

  const startsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  const event = await prisma.event.create({
    data: {
      slug,
      title,
      venue: arg('venue') ?? 'Hub World',
      description: arg('description') ?? null,
      startsAt,
      organizerId: user.id,
      nftTaxon,
      royaltyBps,
      platformBps,
      ticketCount,
      status: 'PUBLISHED',
    },
  })

  console.log(`Created "${event.title}"`)
  console.log(`  slug        ${event.slug}`)
  console.log(`  organizer   @${user.username} (${user.xrplAddress})`)
  console.log(`  taxon       ${event.nftTaxon}`)
  console.log(`  royalty     ${event.royaltyBps} bps -> TransferFee ${event.royaltyBps * 10}`)
  console.log(`  tickets     ${event.ticketCount}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
