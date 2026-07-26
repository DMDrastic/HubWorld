/**
 * Dev seed. Idempotent — safe to re-run.
 *
 * Addresses below are syntactically valid XRPL testnet-style addresses used as
 * placeholders. Nothing here is minted on any ledger; these rows exist so the
 * UI has something to render before real XRPL integration lands.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const organizer = await prisma.user.upsert({
    where: { username: 'stationsquare' },
    update: {},
    create: {
      username: 'stationsquare',
      displayName: 'Station Square Events',
      xrplAddress: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
    },
  })

  const attendee = await prisma.user.upsert({
    where: { username: 'majula' },
    update: {},
    create: {
      username: 'majula',
      displayName: 'Majula',
      xrplAddress: 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w',
    },
  })

  const events = [
    {
      slug: 'neon-district-launch',
      title: 'Neon District — Launch Night',
      description: 'Opening night at the Neon District main stage.',
      venue: 'Neon District',
      startsAt: new Date('2026-09-12T20:00:00Z'),
      nftTaxon: 1001,
      royaltyBps: 500, // 5% organizer royalty
      platformBps: 250, // 2.5% Hubworld fee
      ticketCount: 500,
      status: 'PUBLISHED' as const,
    },
    {
      slug: 'peachs-castle-afterparty',
      title: "Peach's Castle Afterparty",
      description: 'Sold out. Resale via auction only.',
      venue: 'Castle Grounds',
      startsAt: new Date('2026-10-03T22:00:00Z'),
      nftTaxon: 1002,
      royaltyBps: 750,
      platformBps: 250,
      ticketCount: 200,
      status: 'SOLD_OUT' as const,
    },
  ]

  for (const e of events) {
    await prisma.event.upsert({
      where: { slug: e.slug },
      update: {},
      create: { ...e, organizerId: organizer.id },
    })
  }

  console.log(
    `seeded: users=@${organizer.username} @${attendee.username}, events=${events.length}`,
  )
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
