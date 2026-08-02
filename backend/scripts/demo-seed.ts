/**
 * Put the product into a state worth demonstrating, in one command.
 *
 *   npm run demo:seed
 *   npm run demo:seed -- --tickets 8 --clean
 *
 * The problem this solves: a fresh database shows an events list and nothing
 * else. The auction — the live step chart, the velocity strip, the distinct
 * bidder count, the ghosted unfunded bid — is the most distinctive thing here
 * and it is invisible without a sold-out event, holders who are not the
 * organizer, and a bid history. Assembling that by hand before a demo is a
 * twenty-minute job that gets rushed and produces a half-state.
 *
 * What it creates:
 *   - an organizer and four attendee accounts
 *   - an event whose every ticket is minted AND held by an attendee, which is
 *     what actually makes it sold out (see below)
 *   - one ACTIVE fixed-price listing, so the marketplace is not empty
 *   - one LIVE auction with back-loaded bid history and one ghosted pending bid
 *
 * ---------------------------------------------------------------------------
 * THE ROWS THIS WRITES ARE DISPLAY FIXTURES. NOTHING IS ON-LEDGER.
 *
 * The NFTokenIDs are fabricated, the bids have no buy offer, and the listing has
 * no sell offer. That is why this refuses to run in production or against
 * mainnet, exactly like `auction:create` and `demo:reset`. A demo of the UI is a
 * fair use of fixtures; a public site showing bids that do not exist is not.
 *
 * For a demo with REAL signatures, use the app itself — mint, list, buy and bid
 * through Xaman. That path works and is what the product actually is.
 * ---------------------------------------------------------------------------
 *
 * Two deliberate choices that keep the fixtures from doing damage:
 *
 * 1. NO BACKING SELL OFFER for the auction. Settlement needs the holder's ACTIVE
 *    listing to broker against, and without one it parks the auction in SETTLING
 *    and returns `no-sell-offer` — a setup gap, by design, rather than an
 *    attempted broker submission. So if the auction is left to close, the sweep
 *    CANNOT submit a transaction against fabricated offer indexes and burn a fee
 *    discovering they are fiction.
 *
 * 2. The auction closes well in the future (45 minutes by default). The sweep
 *    settles anything whose `endsAt` has passed, every 15 seconds, so a fixture
 *    auction that has already ended would be picked up immediately.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '../src/prisma.js'
import { NETWORK } from '../src/network.js'
import { env } from '../src/env.js'
import { evaluateSoldOut } from '../src/auction-policy.js'

const XRP = 1_000_000n

/** Everything this script creates is prefixed, so `--clean` cannot reach real data. */
const TAG = 'demo-'
const SLUG = `${TAG}skyline-sessions`
const TITLE = 'Skyline Sessions'

const ATTENDEES = ['demo_rin', 'demo_kaito', 'demo_mira', 'demo_juno'] as const

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const flag = (name: string) => process.argv.includes(`--${name}`)

/**
 * A fabricated 64-char hex NFTokenID.
 *
 * Deliberately NOT shaped like a real one — real ids encode the issuer's
 * AccountID and sequence, and a fixture that looks authentic is a fixture
 * someone will eventually mistake for authentic. `DEEDDEED` up front makes it
 * obvious in a database or a log that this ticket was never minted.
 */
function fixtureNfTokenId(n: number): string {
  return ('DEEDDEED' + n.toString(16).padStart(8, '0')).padEnd(64, '0').toUpperCase()
}

async function clean() {
  const where = { event: { slug: SLUG } }
  await prisma.bid.deleteMany({ where: { auction: { ticket: where } } })
  await prisma.listing.deleteMany({ where: { ticket: where } })
  await prisma.auction.deleteMany({ where: { ticket: where } })
  await prisma.transfer.deleteMany({ where: { ticket: where } })
  await prisma.redemption.deleteMany({ where: { event: { slug: SLUG } } })
  await prisma.gift.deleteMany({ where: { ticket: where } })
  await prisma.ticket.deleteMany({ where: { event: { slug: SLUG } } })
  await prisma.event.deleteMany({ where: { slug: SLUG } })
}

async function main() {
  // Same guards as auction:create and demo:reset, for the same reason.
  if (env.NODE_ENV === 'production') {
    console.error('Refusing to seed fixtures in production.')
    console.error('These are display rows with nothing on-ledger; a public site must not show them.')
    process.exit(1)
  }
  if (env.XRPL_NETWORK === 'mainnet') {
    console.error('Refusing to seed fixtures against mainnet.')
    process.exit(1)
  }

  const ticketCount = Number(arg('tickets') ?? 6)
  const minutesLeft = Number(arg('minutes') ?? 45)
  const organizerHandle = (arg('organizer') ?? 'dm_drastic').replace(/^@/, '')

  if (ticketCount < 3) {
    console.error('Need at least 3 tickets: one to auction, one to list, one to just be held.')
    process.exit(1)
  }
  if (minutesLeft < 5) {
    console.error('Auction must close at least 5 minutes out, or the sweep settles it mid-demo.')
    process.exit(1)
  }

  if (flag('clean')) {
    await clean()
    console.log('cleaned previous demo data')
  }

  const existing = await prisma.event.findUnique({ where: { slug: SLUG } })
  if (existing) {
    console.error(`"${SLUG}" already exists. Re-run with --clean to rebuild it.`)
    process.exit(1)
  }

  // The organizer must already exist — creating accounts implies an r-address,
  // and inventing one for a real handle would corrupt a real user's row.
  const organizer = await prisma.user.findUnique({ where: { username: organizerHandle } })
  if (!organizer) {
    console.error(`No user @${organizerHandle}. Sign in once, or pass --organizer <handle>.`)
    process.exit(1)
  }

  // Attendees are upserted rather than created, so re-running does not collide.
  const attendees = []
  for (const [i, username] of ATTENDEES.entries()) {
    attendees.push(
      await prisma.user.upsert({
        where: { username },
        update: {},
        create: {
          username,
          displayName: username.replace('demo_', '').replace(/^./, (c) => c.toUpperCase()),
          // Fixture address, obviously not a real account.
          xrplAddress: `rDEMO${username.slice(5)}${'0'.repeat(30)}`.slice(0, 34),
        },
      }),
    )
    void i
  }

  const event = await prisma.event.create({
    data: {
      slug: SLUG,
      network: NETWORK,
      title: TITLE,
      venue: 'The Observatory, Rooftop',
      description: 'A night of live sets above the city. Sold out.',
      startsAt: new Date(Date.now() + 12 * 86_400_000),
      organizerId: organizer.id,
      nftTaxon: 90_000 + Math.floor(Math.random() * 9_000),
      royaltyBps: 500,
      platformBps: env.PLATFORM_FEE_BPS,
      ticketCount,
      status: 'PUBLISHED',
    },
  })

  // Every ticket minted AND held by an attendee. Both halves matter: `soldOut`
  // is DERIVED as `minted >= ticketCount && organizerHolds === 0`, so tickets
  // left with the organizer would keep the event out of the auction rules no
  // matter what `status` said.
  const tickets = []
  for (let i = 0; i < ticketCount; i++) {
    const holder = attendees[i % attendees.length]!
    tickets.push(
      await prisma.ticket.create({
        data: {
          nfTokenId: fixtureNfTokenId(i + 1),
          network: NETWORK,
          eventId: event.id,
          ownerId: holder.id,
          ownerAddress: holder.xrplAddress,
          syncedAt: new Date(),
          seat: `${String.fromCharCode(65 + (i % 4))}${12 + i}`,
          tier: i === 0 ? 'front row' : 'general',
          status: 'MINTED',
        },
      }),
    )
  }

  // Marketplace: a plain resale, so /market is not an empty page.
  const forSale = tickets[1]!
  const priceDrops = 15n * XRP
  await prisma.listing.create({
    data: {
      network: NETWORK,
      ticketId: forSale.id,
      sellerId: forSale.ownerId!,
      sellerAddress: forSale.ownerAddress!,
      priceDrops,
      // Frozen at listing time from the event's rate, same as the real route.
      platformFeeDrops: (priceDrops * BigInt(event.platformBps)) / 10_000n,
      listPayloadUuid: `demo-list-${event.id}`,
      offerIndex: `DEMOOFFER${'0'.repeat(55)}`.slice(0, 64),
      status: 'ACTIVE',
      listedAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  })
  await prisma.ticket.update({ where: { id: forSale.id }, data: { status: 'LISTED' } })

  // The auction, on a different ticket. No backing sell offer — see the header.
  const onAuction = tickets[0]!
  const now = Date.now()
  const endsAt = new Date(now + minutesLeft * 60_000)
  const startsAt = new Date(endsAt.getTime() - 120 * 60_000)
  const reserveDrops = 12n * XRP

  const auction = await prisma.auction.create({
    data: {
      network: NETWORK,
      ticketId: onAuction.id,
      startsAt,
      endsAt,
      reserveDrops,
      status: 'LIVE',
    },
  })
  await prisma.ticket.update({ where: { id: onAuction.id }, data: { status: 'IN_AUCTION' } })

  // Bidders are anyone who is not the holder — a holder bidding on their own
  // ticket is the thing the real route refuses.
  const bidders = attendees.filter((a) => a.id !== onAuction.ownerId)

  // Bids cluster toward the close, because real auctions rush at the end and
  // that late spike is the entire reason the velocity strip exists — a flat or
  // front-loaded spread makes the strip look like it is measuring nothing.
  //
  // Getting this right is fiddlier than it looks. Spacing bids by `u ** 2.6`
  // does the OPPOSITE: with u uniform, the density of the mapped times goes as
  // 1/f'(u), and that curve's slope is smallest near u=0, so the bids pile up
  // at the START. `1 - (1 - u) ** 2.6` has its flat end at u=1 instead, which
  // is the late rush actually wanted.
  //
  // Spread over startsAt→NOW rather than the full window: bidding cannot have
  // happened in the future, and using the whole span left a dead stretch before
  // the close where a live auction should look busiest.
  const openSpan = now - startsAt.getTime()
  const rows: Prisma.BidCreateManyInput[] = []
  let price = 9n * XRP
  const bidCount = 18
  for (let i = 0; i < bidCount; i++) {
    const u = (i + 1) / (bidCount + 1)
    const at = startsAt.getTime() + openSpan * (1 - Math.pow(1 - u, 2.6))
    price += BigInt(Math.round((0.25 + Math.random() * 0.8 + i * 0.12) * 1_000_000))
    rows.push({
      auctionId: auction.id,
      network: NETWORK,
      bidderId: bidders[i % bidders.length]!.id,
      bidderAddress: bidders[i % bidders.length]!.xrplAddress,
      amountDrops: price,
      placedAt: new Date(at),
      status: 'OUTBID',
    })
  }
  if (rows.length === 0) {
    console.error('No bids landed before now — try a larger --minutes.')
    process.exit(1)
  }
  rows[rows.length - 1]!.status = 'COMMITTED'

  // An unfunded bid ABOVE the leader. It must render ghosted and must not move
  // the price: a PENDING bid is money nobody has committed, and letting it set
  // the price would make the chart a manipulation surface.
  rows.push({
    auctionId: auction.id,
    network: NETWORK,
    bidderId: bidders[0]!.id,
    bidderAddress: bidders[0]!.xrplAddress,
    amountDrops: price + 3n * XRP,
    placedAt: new Date(now - 20_000),
    status: 'PENDING',
  })

  await prisma.bid.createMany({ data: rows })

  const committed = rows.filter((r) => r.status !== 'PENDING')
  const distinct = new Set(committed.map((r) => r.bidderId)).size

  // Correct Event.status through the REAL evaluator rather than asserting
  // SOLD_OUT here. The status is derived from counted facts — a seeder that
  // simply wrote the enum would be doing exactly what the codebase refuses to
  // trust, and would happily label a half-empty event sold out.
  const state = await evaluateSoldOut(event.id)
  if (!state.soldOut) {
    console.error(`Seed is inconsistent: minted ${state.minted}/${state.ticketCount}, organizer holds ${state.organizerHolds}.`)
    process.exit(1)
  }

  console.log(`\nSeeded "${TITLE}" (${SLUG}) on ${NETWORK}\n`)
  console.log(`  tickets     ${ticketCount}, all held by attendees -> event is SOLD OUT`)
  console.log(`  organizer   @${organizerHandle} (holds none, so auctions are permitted)`)
  console.log(`  marketplace 1 active listing at ${Number(priceDrops) / 1e6} XRP (seat ${forSale.seat})`)
  console.log(`  auction     seat ${onAuction.seat}, reserve ${Number(reserveDrops) / 1e6} XRP`)
  console.log(`              ${committed.length} funded bids from ${distinct} bidders, 1 ghosted pending`)
  console.log(`              top ${Number(price) / 1e6} XRP, closes in ${minutesLeft} min`)
  console.log(`\n  open  /events  ->  ${TITLE}  ->  the auction dialog`)
  console.log(`\n  These are DISPLAY FIXTURES: nothing is on-ledger, and the auction has`)
  console.log(`  no sell offer, so settlement parks it rather than submitting anything.`)
  console.log(`  Re-run with --clean to rebuild.\n`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
