# HubWorld

## Stack

TypeScript end-to-end.

**Frontend** — React + Vite, Tailwind CSS, shadcn/ui components.

**Backend** — standalone Node + Express. Not serverless, not a meta-framework backend.

**Database** — PostgreSQL via Prisma.

**Validation** — Zod at every input boundary (HTTP handlers, socket events, env parsing).

**Ledger** — xrpl.js for XRPL interaction, Xaman for wallet signing.

**Live bidding** — Recharts for bid visualisations, Socket.IO for realtime transport.

The **read** half is built and runs on real data: `GET /api/events/:slug/auction` and `GET /api/auctions`, consumed by `BidChart` inside `AuctionDialog`. Updates are **pushed** over Socket.IO as bids commit, with a 30s fallback refresh in case the socket never connects. The HTTP fetch stays authoritative — realtime says *something changed*, the API says *what is true* — so one code path decides what counts as price. Vite's proxy needs `ws: true` on `/socket.io`, or the upgrade is proxied as plain HTTP and Socket.IO silently degrades to long polling.

The **write** half — how a bid is committed on-ledger — is an open decision. See "Bidding: the escrow problem" below. `npm run auction:create` fabricates an auction with bid history for development; those Bid rows are display fixtures with nothing escrowed, and the script refuses to run in production.

The auction lives in a dialog opened from an event row, **not** on the main page,
and only events with a live auction are clickable — a control that opens an empty
window is worse than no control. `hasLiveAuction(slug)` is the placeholder for a
field the API will carry (`EventSummary.activeAuction`).

Recharts is ~410kB, which more than doubled the main bundle, so `AuctionDialog`
is loaded with `React.lazy` and is now not fetched at all until someone opens an
auction. Keep it code-split, and keep it the only importer of `BidChart`.

## Structure

Modular monolith, two top-level folders:

```
frontend/    React + Vite app
backend/     Node + Express API
```

Each folder owns its own `package.json`, `tsconfig.json`, and `node_modules`. **No monorepo workspace** (no npm/pnpm/yarn workspaces, no Turborepo, no Nx) — that is a deliberate deferral, not an oversight. Don't add one without asking.

Shared types are duplicated or hand-copied for now. Revisit if the duplication becomes painful.

## Conventions

- TypeScript everywhere; no `.js` source files.
- Zod schemas are the source of truth for request/response shapes — derive TS types with `z.infer` rather than declaring interfaces separately.
- Prisma schema is the source of truth for the data model; don't hand-write SQL migrations.
- Never commit secrets. XRPL seeds and database URLs come from environment variables, parsed and validated with Zod at startup.

## Commands

Run these from inside `frontend/` or `backend/` — there is no root `package.json`.
Both dev servers must be running for the app to work.

**Requires Node 20.19+** (Vite 8 won't run on less). Both `package.json` files
declare `engines`, and `.npmrc` sets `engine-strict=true`, so npm refuses to
install on an older runtime instead of failing later inside Vite or tsx.

A stale `/usr/local/bin/node` v18 from a 2023 `.pkg` install used to shadow
Homebrew's v23 in non-interactive shells (`zsh -c '...'`, CI runners, cron),
causing `EBADENGINE` even though interactive shells were fine. **Resolved** — the
v18 `node`/`npm`/`npx`/`corepack` were moved to `~/node18-disabled/`, so all
three shell types now resolve `/opt/homebrew/bin/node` v23. `/usr/local/bin` is
user-owned, so no sudo was involved; restore with
`mv ~/node18-disabled/* /usr/local/bin/`.

Note that `ng`, `vue`, `tsc`, `tsserver` and `yarn` still symlink into
`/usr/local/lib/node_modules` and now run under v23. Nothing here uses them.

```sh
# backend/ — http://localhost:4000
npm install
npm run dev              # tsx watch, reloads on save
npm run build            # tsc -> dist/
npm start                # run the build
npm run typecheck
npm run prisma:generate
npm run prisma:migrate -- --name <description>

# frontend/ — http://localhost:5173
npm install
npm run dev
npm run build            # tsc -b && vite build
npm run preview
npm run typecheck
npm run lint             # oxlint, not eslint
npm test                 # vitest run
npm run test:watch
```

## Tests

**Vitest**, installed separately in each folder (no workspace). Backend tests
live in `tests/` and are typechecked by `tsconfig.test.json` — the build's
`rootDir` is `src`, so without that second config they would never be checked.
Frontend tests live in `src/__tests__/` with jsdom + Testing Library.

Backend coverage is the pure ledger logic: `TransferFee` scaling, the
`tfTransferable` flag, URI limits, and the offer builders. These are values that
decide who gets paid and whether a ticket can move at all — a wrong constant is
not a crash, it is a silently wrong royalty found on mainnet.

**Polling must be paced, and pacing must be asserted by counting requests.** A
runaway poll still reaches the right final state, so no state-based test catches
it. `GiftPanel` once stored polled state inside its phase object, so every
response produced a new object, the effect's dependency changed, the effect
re-ran, and it fired the next request immediately instead of after `POLL_MS` —
15 requests where 5 was correct, until Xaman answered 429 and the UI showed
"internal server error" on a gift that had signed perfectly. **Never put
poll-updated state in an effect's dependency list**; key the effect on a
primitive id.

Rate limiting is transient and says nothing about a payload, so `tryGetPayload`
turns a 429 into `'unavailable'` and every poll route reports `pending`. Letting
it propagate makes an already-signed transaction look like a crash.

**Frontend tests render inside `<StrictMode>` deliberately.** The original
sign-in bug was a `useRef` set during cleanup: StrictMode's
mount → cleanup → remount left it permanently true, so polling died silently.
It survived manual testing because the backend was driven with curl, which never
ran the React loop. The double-invocation *is* the thing under test — these tests
were confirmed to fail when that bug is reintroduced. Any new polling loop
belongs under the same discipline.

## Bidding: a bid is a buy offer, not an escrow

**Decided.** Despite the name the model started with, bids are **not** escrowed.

An XRPL `Escrow` releases XRP on a time or crypto-condition trigger and knows
nothing about the NFT, so it cannot settle a ticket sale atomically — it can pay
a seller whose ticket never moves. Gating release on a condition Hubworld holds
the preimage for would work mechanically but makes us the arbiter of releasing
funds, reintroducing the custody role brokered mode exists to avoid.

So a bid is an `NFTokenCreateOffer` (buy offer) with `Destination` = the broker.
`NFTokenAcceptOffer` moves the NFT and the XRP together, all-or-nothing — the same
path gifting and resale already proved on testnet.

`Destination` = broker does double duty: nobody but Hubworld can match a bid, and
a losing bid is **inert** on-ledger rather than a live order someone could take
later. It also means cleanup is cosmetic, not safety-critical — an uncancelled
losing offer holds the bidder's owner reserve (0.2 XRP) but cannot be executed.
**Verified on testnet: the `Destination` of an offer may cancel it, not only its
creator**, so settlement cancels the losing bids centrally (`brokerCancelOffers`)
and no loser has to sign anything to reclaim their reserve. Best-effort — a
failure there must never undo a completed sale.

The trade-off, stated plainly: **funds are not locked.** A bidder can spend the
money after bidding and settlement then fails with `tecINSUFFICIENT_FUNDS`. So
`spendableDrops` is checked when a bid is placed and must be re-checked at
settlement, falling back to the next-highest bid. Note that spendable is *not*
the balance — reserves are withheld per owned object (`spendableFrom`).

The compensating benefit is real: losing costs nothing, needs no refund, and
requires no transaction from the loser. The originally planned "cancellation
reaper" is not needed.

### The surplus question, measured

**The surplus goes to the seller.** Measured on testnet: a sell offer of 5 XRP
matched against a 20 XRP bid with a 0.125 broker fee paid the seller **19.875** —
that is `buyAmount - brokerFee`, not the asking amount. A sell offer is a
**floor**, not a price.

This is what makes the auction design workable: the seller commits **one** sell
offer when the auction opens and never signs again. Settlement does not need the
seller present at close.

**But `buy >= sell + brokerFee` bites.** A sell offer placed *at* the reserve
leaves no headroom for the fee, so a bid barely above the reserve dies with
`tecINSUFFICIENT_FUNDS` — there is one such failure in the broker's history. The
sell offer must therefore sit below the reserve by the fee-at-reserve, which is
what `auctionSellAmountDrops` computes and `auction-settlement.test.ts` pins
across the bid range and up to a 99.99% fee.

**`tecINSUFFICIENT_FUNDS` is NOT terminal, and treating it as such loses money.**
Observed for real: a 100 XRP sale failed because the buyer was broke, was marked
`FAILED`, and both offers stayed live on-ledger. The buyer was later paid by
another sale and now has ample balance — so a settleable sale sits written off in
our database while remaining matchable on the ledger. Settlement must retry or
re-open rather than close the listing, and `ledger:sync` reports this case as
`failed-but-retryable`.

### Opening an auction

`POST /api/tickets/:nfTokenId/auction` — holder-only, **one signature**. It
creates the `Auction` (reserve, close time) and a `Listing` that is the on-ledger
sell offer settlement will broker against, at `auctionSellAmountDrops(reserve)`.

The auction stays `SCHEDULED` until that offer is confirmed on-ledger, then goes
`LIVE`. Accepting bids earlier would be taking commitments we could not settle.

**An auction's sell offer must never be publicly buyable.** It is priced at the
auction FLOOR, so a direct purchase would take the ticket for the reserve and skip
the bidding entirely. `Listing.auctionId` marks it, and both `GET /listings` and
`POST /listings/:id/buy` exclude it — `auction-open.test.ts` pins that.

### Settlement

`src/settlement.ts`. An auction ends at a wall-clock time, not when someone opens
the page, so settlement is a **sweep** (every 15s in `server.ts`), not a
request-driven action. `npm run auction:settle` runs it on demand.

It walks committed bids from highest down and **falls through to the runner-up**
when a bidder cannot pay, rather than failing the auction — funds are not locked,
so the top bidder is not guaranteed good for it. Spendable balance is read before
submitting, since that is cheaper than burning a transaction fee to find out.
Nothing is refunded to losers because nothing was ever locked.

Settlement needs the holder's **ACTIVE listing** to broker against; without one
the auction parks in `SETTLING` rather than failing, since that is a setup gap
rather than an auction outcome.

**The sweep holds a database lease** (`JobLock`, `src/job-lock.ts`) so two
instances cannot settle the same auction — the loser would burn a transaction fee
discovering the offers were already consumed. It is a lease rather than a
Postgres advisory lock because advisory locks are scoped to a CONNECTION and
Prisma pools connections, so the unlock can land on a different connection than
the lock and leak it permanently. A lease is connection-agnostic and self-healing:
a process that dies simply lets it expire.

## Reconciling with the ledger

`npm run ledger:sync` walks the ledger and reports every disagreement with
Postgres; `-- --apply` fixes them. **Dry run by default** — a reconciler that
silently rewrites ownership is worse than the drift it corrects.

It catches ticket-owner drift (including settlements done out-of-band), NFTs held
with no `Ticket` row, tickets that left every known account, listings whose offer
has been consumed while our status still says otherwise, and the
`failed-but-retryable` case above.

Any script that touches the ledger must `await disconnectLedger()` before exiting.
The websocket keeps the event loop alive, so without it the script hangs forever
and its output is never flushed — which looked exactly like a crash until it was
traced.

## Price tracker

Decisions that are load-bearing, not stylistic:

- **Only funded bids set the price.** A bid is real once its XRPL escrow
  validates, so `ESCROWED`/`OUTBID`/`WON` count and `PENDING` does not. Plotting
  unfunded bids would let anyone pump the visible price with money they never
  committed — the chart would become a manipulation surface. Pending bids render
  ghosted, never as price. `BidChart.test.tsx` tests exactly this attack.
- **Step, not line** (`stepAfter`). The leading bid holds flat until someone
  outbids; a smooth line implies interpolation that never happened.
- **Running maximum, not latest.** The price never goes down.
- **Candlesticks were considered and rejected.** OHLC compresses many trades per
  interval into a range; an auction has few monotonically rising bids, so every
  candle would be a rangeless doji — sophisticated-looking and uninformative.
- **Velocity gets its own strip.** Bids-per-interval rising toward the close is
  the tension a price line cannot show.
- **X-axis is time-to-close**, not wall-clock.
- **Distinct bidder count is shown**, because one person walking up their own bid
  is a different market from three competing and price cannot distinguish them.

## Local environment

- Postgres: Homebrew `postgresql@15` on `:5432`, database `hubworld_dev`.
  `postgresql@14` is also installed but stopped — both wanted `:5432` and `@14`
  crash-looped. Don't start it without moving it to another port first.
- A **third** Postgres exists: an EnterpriseDB `.pkg` install at
  `/Library/PostgreSQL/16`, running as user `postgres` on **:5434**. It does not
  conflict, but `pgrep postgres` showing live processes does *not* mean `@15` is
  up — check `:5432` specifically.
- If `@15` starts "successfully" but nothing listens on `:5432`, look for
  `lock file "postmaster.pid" already exists` in
  `/opt/homebrew/var/log/postgresql@15.log`. After an unclean shutdown the PID
  in that file gets recycled onto an unrelated process, so the hint names a live
  PID that is not Postgres. **Verify with `ps -p <pid>` before deleting it** —
  removing a live cluster's `postmaster.pid` corrupts data.
- `backend/.env` is gitignored; `backend/.env.example` is the template.
- Vite proxies `/api` to `localhost:4000` in dev, so the browser stays
  same-origin and CORS never fires. The `cors` middleware exists for deployed
  environments where the two are on different hosts.

## Domain model

HubWorld is NFT event ticketing on the XRP Ledger, themed on video-game hub
worlds. Tickets are XRPL NFTokens held in the user's own wallet.

**Hubworld never holds a USER's key.** Xaman signs everything that moves someone
else's ticket or money, on their own device. The one key Hubworld does hold is
its own broker account (`PLATFORM_SEED`), and it exists solely to sign the
brokered `NFTokenAcceptOffer` that settles a sale — see Selling below. It cannot
move anyone's ticket on its own, and sale funds never rest with us.

**The ledger is the source of truth for ownership, not Postgres.** A holder can
transfer a ticket in Xaman without touching Hubworld, so `Ticket.ownerId` /
`ownerAddress` are a *cache* and carry `syncedAt`. Never treat them as
authoritative for anything that matters — re-read the ledger first.

**Money is always `BigInt` drops** (1 XRP = 1_000_000 drops). Never `Float`.
The API serialises BigInt as strings (see the `json replacer` in `app.ts`);
clients must not parse them into JS numbers.

Models: `User` (@handle → r-address), `Event`, `Ticket`, `Listing`
(fixed-price), `Auction` + `Bid` (escrow-locked), `Transfer` (append-only
provenance).

**Royalties use XRPL brokered mode**: the organizer is the NFT issuer and
collects `royaltyBps` via the native `TransferFee`; Hubworld brokers the
`NFTokenAcceptOffer` and takes `platformBps` from the spread. This keeps
Hubworld out of the funds-custody path. Changing this changes who mints.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | liveness + db status |
| `POST /api/auth/signin` | create Xaman SignIn payload → `{uuid, qrPng, next}` |
| `GET /api/auth/signin/:uuid` | poll → `pending` / `needs_username` / `authenticated` / `rejected` / `expired` |
| `POST /api/auth/claim` | bind an @handle to a freshly-verified address |
| `GET /api/auth/me` | current user (bearer token) |
| `POST /api/auth/signout` | revoke session |
| `GET /api/users/:username` | @handle → XRPL address (accepts a leading `@`) |
| `GET /api/events?status=&limit=` | event list |
| `GET /api/events/:slug` | event detail |
| `POST /api/events/:slug/mint` | organizer-only; build an NFTokenMint → Xaman payload |
| `GET /api/mint/:uuid` | poll → `pending` / `minted` / `rejected` / `expired` / `failed` |
| `GET /api/tickets/mine?verify=` | inventory; `verify=true` reconciles against the ledger |
| `POST /api/tickets/:nfTokenId/gift` | owner-only; zero-amount offer to an @handle |
| `POST /api/gifts/:id/accept` | recipient-only; sign the acceptance |
| `POST /api/gifts/:id/cancel` | sender-only; withdraw the offer |
| `GET /api/gifts/:id` | poll the gift state machine |
| `GET /api/gifts?role=incoming\|outgoing` | gifts awaiting me / sent by me |
| `POST /api/tickets/:nfTokenId/list` | owner-only; list for sale at a drops price |
| `GET /api/listings` | the marketplace (public); ACTIVE listings only |
| `GET /api/listings/mine` | what I'm selling and what I'm buying |
| `POST /api/listings/:id/buy` | buyer bids price + platform fee |
| `POST /api/listings/:id/cancel` | seller-only; withdraw |
| `GET /api/listings/:id` | poll the three-phase sale |
| `POST /api/tickets/:nfTokenId/auction` | holder-only; open an auction (one signature) |
| `POST /api/auctions/:id/bid` | place a bid (a buy offer) |
| `GET /api/bids/:id` | poll a bid to `committed` |
| `GET /api/events/:slug/auction` | the live auction + bid history |
| `GET /api/auctions` | events with a live auction |
| `POST /api/events/:slug/checkin` | organizer-only; start a door check-in |
| `GET /api/checkin/:uuid` | the verdict, on the staff device |
| `GET /api/events/:slug/door` | admitted/issued counts + recent entries |

Errors are `{ error, details? }` with 400 for validation and 404 for missing.

## Xaman sign-in

Xaman is a **backend** integration: the API secret must never reach the Vite
bundle. The frontend only renders a QR and polls.

```
React → POST /auth/signin → Express → Xaman: create payload
React ← {uuid, qrPng}     ←         ←
   [user signs in the Xaman app on their phone]
React → GET /auth/signin/:uuid (every 2s) → Express → Xaman: payload status
React ← authenticated + token             ←
```

Signing a `SignIn` payload is what proves wallet ownership — it is the only
trustworthy way to bind an @handle to an r-address. A wallet with no account
resolves to `needs_username`, and `POST /auth/claim` mints the `User`.

**Stub mode.** With `XAMAN_API_KEY`/`SECRET` unset, `src/xaman.ts` swaps in an
in-memory fake and `POST /api/auth/signin/simulate` stands in for a human
signing. That endpoint is double-guarded (stub-mode only, and never when
`NODE_ENV=production`); the server refuses to boot at all in stub mode under
production. Going live is only setting the two env vars.

## Sessions

Session tokens are SHA-256 hashed at rest with a 7-day expiry, and are delivered
to the browser as an **httpOnly `SameSite=Lax` cookie** (`hubworld_session`).
`Secure` is set only when `NODE_ENV=production`, since it would make the cookie
undeliverable over plain-HTTP localhost.

The token is deliberately **not** returned in any response body. No script on
the page can read it, so an XSS bug cannot exfiltrate a session the way reading
`localStorage` could. "Am I signed in?" is answered by calling `/auth/me` and
seeing whether it succeeds — the frontend holds no credential at all.

`SameSite=Lax` is what closes the CSRF hole that cookie auth would otherwise
open: the cookie is not sent on cross-site POSTs, and every mutation here is a
POST. **That protection assumes the API is same-origin with the app.** In dev
the Vite proxy guarantees it. If you ever deploy the two on different hosts,
`Lax` will stop sending the cookie on XHR at all, and the fix is to put both
behind one origin — not to switch to `SameSite=None`, which would reintroduce
CSRF and require token defences.

`Authorization: Bearer` is still accepted, for curl and scripts. That is not the
risk being managed; the exposure was only ever JavaScript-readable storage.

Not built: the Xaman webhook (polling is used instead, so no public tunnel is
needed in dev), and any real XRPL transaction — no xrpl.js yet.

## Minting

The organizer is the issuer, so the organizer signs the `NFTokenMint` in Xaman —
Hubworld only builds the transaction. `src/ledger.ts` constructs and reads;
it signs nothing.

Minting is **two-phase, and the split is not optional**: a signature is not a
mint. The `NFTokenID` is derived by the ledger, so it does not exist until the
transaction is in a validated ledger. `MintRequest` is what survives that gap —
without it a signed mint whose poll never returned would be an NFT on-ledger
with no Hubworld record. The poll reports `pending` with `signed: true` during
that window.

`Ticket` + the `MINT` `Transfer` are written in one `$transaction`, keyed on the
unique `nfTokenId`, so a duplicate poll is a no-op rather than a second ticket.

Payloads set `force_network` from `XRPL_NETWORK`. Without it a wallet set to
mainnet would sign a testnet-intended mint against real funds.

There is no event-creation API yet; organizers are onboarded by hand:

```sh
npm run event:create -- --organizer <handle> --title "<title>" [--tickets 50]
```

## Gifting

XRPL has **no transfer transaction**, so a gift is two signatures on two
devices:

1. sender — `NFTokenCreateOffer`, `Amount: "0"`, `Destination` = recipient
2. recipient — `NFTokenAcceptOffer` on the offer index

Ownership does not move until the second one validates. `Destination` means the
in-flight offer is claimable by nobody else. The offer index is assigned *by the
ledger*, so it has to be read back out of the transaction metadata
(`offerIndexFromTx`) — it is not in what we submitted.

Withdrawal splits on whether anything reached the ledger: before the sender
signs it is a local status flip, but once the offer exists it takes a signed
`NFTokenCancelOffer`. If sender and recipient both sign, the ledger settles the
race and the poll reports whichever won.

**An `NFTokenOffer` has no expiry.** `Gift.expiresAt` is the lifetime of an
*unsigned Xaman payload*, never the gift's — see `src/gift-policy.ts`. Conflating
them is a trap worth naming: marking an `OFFERED` gift expired while its offer
stays live on-ledger means the recipient can still accept it in Xaman, ownership
moves, and the `GIFT` provenance row is never written. So only `PENDING_OFFER`
expires; on-ledger states end solely by acceptance or withdrawal, and a stale
*accept* payload reverts to `OFFERED` so the recipient can retry. Any endpoint
minting a fresh payload must also refresh `expiresAt`, or the retry is born
expired and reverts on its first poll.

**Ownership is re-read from the ledger before a gift starts** (`holdsNft`). If it
disagrees with `Ticket.ownerAddress` the cache is cleared rather than trusted —
the holder may have moved the ticket in Xaman without touching Hubworld.
`GET /tickets/mine?verify=true` surfaces the same check per ticket as `onLedger`.

## Selling (brokered)

Fixed-price resale takes **three signatures on three accounts**:

1. **seller** `NFTokenCreateOffer` — `Amount` = price, `Destination` = broker, tfSell
2. **buyer** `NFTokenCreateOffer` — `Amount` = price + fee, `Owner` = seller (a bid)
3. **Hubworld** `NFTokenAcceptOffer` — both offers plus `NFTokenBrokerFee`

Step 3 is the one exception to "Hubworld holds no keys": brokered mode requires
the broker's signature, so `PLATFORM_SEED` exists. It signs nothing else. Funds
still never rest with Hubworld — the ledger moves buyer → seller and
buyer → issuer atomically in that single transaction.

Create the account with `npm run platform:setup` (testnet/devnet only; it refuses
mainnet and refuses to overwrite an existing seed). The seed is written straight
to `.env`, never printed, and `.env` is chmod 600.

**Both offers must set `Destination` = broker.** On the sell side that stops a
buyer taking the offer directly; on the buy side it stops the seller accepting a
bid that already includes our fee. Omit either and the platform fee is
bypassable — brokerage is only enforced when neither party can settle alone.

The ledger requires `buy >= sell + brokerFee`, which is why the bid is
price + fee. The organizer's royalty is not modelled at all: the NFToken's native
`TransferFee` deducts it and pays the issuer automatically.

**XRPL skips `TransferFee` entirely when the issuer is party to the trade.**
Both halves are verified on testnet:

- issuer as buyer, 10 XRP sale → seller received the full **10.0**, no royalty leg
- issuer uninvolved, 10 XRP sale → seller **9.5**, issuer **+0.5**, broker **0.25**

Not a bug, and it matches the model: an organizer selling keeps 100%, while a
genuine secondary resale pays them a royalty with no involvement at all. The
testing consequence: **a royalty split cannot be exercised unless neither side is
the issuer** — two wallets are not enough when one of them minted.

Settlement costs Hubworld the transaction fee (~12 drops observed), since the
broker submits it. Netted against `platformBps` that is negligible, but the
broker account must stay funded or sales stop settling.

`platformFeeDrops` is frozen on the Listing at creation, so changing an event's
`platformBps` later cannot alter terms a buyer has already been shown. Fee
arithmetic floors, so rounding never favours the platform.

## Check-in at the door

`src/routes/redemption.ts`. This is what makes an NFT a ticket rather than a
collectible.

**Proof is a signature, not a display.** A QR on an attendee's phone can be
screenshotted and forwarded; a Xaman signature cannot, because it needs their key
at that moment. Check-in reuses the `SignIn` pseudo-transaction — no fee, no
reserve, so an unfunded wallet can still be admitted.

**Check-in is organizer-initiated and the verdict appears on the STAFF device.**
If the attendee's screen showed "admitted", a screenshot of a green tick would be
a ticket.

**A signature proves who, not what.** The ledger is re-read (`holdsNft`) to
confirm that address still holds a ticket for this event — the ownership column is
a cache and they may have sold it since. If the ledger is unreachable the cached
claim is accepted rather than turning away a real attendee on a network blip;
the audit trail carries it.

`already_used` and `no_ticket` are distinct verdicts on purpose. At a door those
are different conversations — a duplicate versus a stranger — and collapsing them
would make real double-entry invisible.

**A `REDEEMED` ticket cannot be gifted, listed or auctioned.** Admission has been
used, so passing it on would be passing on nothing. The NFT still exists and can
be moved in Xaman as a collectible; Hubworld just stops presenting it as a ticket.

## Health check

`GET /api/health` → `{ status, db, uptime, timestamp }`

Always returns HTTP 200 so the UI can render a status even when Postgres is
down; a dead database shows as `status: "degraded"`, `db: "unavailable"`. Check
the `db` field, not the status code.
