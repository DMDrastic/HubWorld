# HubWorld

This file records what HubWorld **is** and why each decision was made.
**`ROADMAP.md` records what to do next, in what order, and what would be a
mistake** — including the Xaman quota and vendor-concentration risk, the
minting ceiling as a market segment rather than a defect, and the two changes
that would end the product.

## Stack

TypeScript end-to-end.

**Frontend** — React + Vite, Tailwind CSS, shadcn/ui components.

**Backend** — standalone Node + Express. Not serverless, not a meta-framework backend.

**Database** — PostgreSQL via Prisma.

**Validation** — Zod at every input boundary (HTTP handlers, socket events, env parsing).

**Ledger** — xrpl.js for XRPL interaction, Xaman for wallet signing.

**Live bidding** — Recharts for bid visualisations, Socket.IO for realtime transport.

The **read** half is built and runs on real data: `GET /api/events/:slug/auction` and `GET /api/auctions`, consumed by `BidChart` inside `AuctionDialog`. Updates are **pushed** over Socket.IO as bids commit, with a 30s fallback refresh in case the socket never connects. The HTTP fetch stays authoritative — realtime says *something changed*, the API says *what is true* — so one code path decides what counts as price. Vite's proxy needs `ws: true` on `/socket.io`, or the upgrade is proxied as plain HTTP and Socket.IO silently degrades to long polling.

Socket.IO keeps rooms **in this process** unless told otherwise. That is correct
for one instance and quietly wrong for two: a viewer connected to instance A
never receives a bid published from B, and nothing errors — the price simply
stops moving for half the audience. `REALTIME_ADAPTER=postgres` shares events
over LISTEN/NOTIFY on the database already in use, adding no new service. Turn it
on **at the same moment** you scale past one instance, not after, because the
failure mode is silent. Attaching is deliberately non-fatal: realtime is an
accelerator and the HTTP API stays authoritative, so a broken adapter degrades
delivery rather than refusing to start.

The **write** half — how a bid is committed on-ledger — is an open decision. See "Bidding: the escrow problem" below. `npm run auction:create` fabricates an auction with bid history for development; those Bid rows are display fixtures with nothing escrowed, and the script refuses to run in production.

**`npm run demo:seed` builds a whole demonstrable state in one command** — a
sold-out event whose tickets are all held by attendees (not the organizer, or
the auction rules correctly refuse it), one ACTIVE marketplace listing, and one
LIVE auction with a late-clustering bid history plus one ghosted pending bid
above the leader. `-- --clean` rebuilds it. Same fixture caveat and the same
production refusal, plus a mainnet refusal.

Two properties of that seeder are load-bearing rather than cosmetic. It creates
**no backing sell offer** for the auction, so if the auction is left to close
the sweep hits the `no-sell-offer` path and parks it — it can never submit a
broker transaction against fabricated offer indexes and burn a fee discovering
they are fiction. And it corrects `Event.status` by calling `evaluateSoldOut`
rather than writing `SOLD_OUT` itself, because a seeder that asserts the enum is
doing exactly what the rest of the system refuses to trust.

Bid times are spaced by `1 - (1 - u) ** 2.6`, **not** `u ** 2.6`. With `u`
uniform the density of mapped times goes as `1/f'(u)`, and `u ** 2.6` is flattest
near `u = 0`, so it piles bids up at the START — the opposite of the late rush
the velocity strip exists to show. `auction:create` still has the original form.

The auction lives in a dialog opened from an event row, **not** on the main page,
and only events with a live auction are clickable — a control that opens an empty
window is worse than no control. `hasLiveAuction(slug)` is the placeholder for a
field the API will carry (`EventSummary.activeAuction`).

Recharts is ~410kB, which more than doubled the main bundle, so `AuctionDialog`
is loaded with `React.lazy` and is now not fetched at all until someone opens an
auction. Keep it code-split, and keep it the only importer of `BidChart`.

## Frontend structure

Signed out you get `Landing` — the product explained before anyone is asked to
connect a wallet. Signed in, `/` is `Hub`: what you hold, what is happening now,
and where to go next. Everything requiring a decision lives on its own page
(`/events`, `/tickets`, `/market`, `/door`, `/organize`) rather than stacked in
one column.

**Routing is `src/lib/router.ts`, not react-router.** Six flat destinations, no
nesting, no params — a router would be a dependency and an architectural
commitment bought for very little. It uses `useSyncExternalStore` because the URL
is genuinely external state; the `useState` + effect version renders once with a
stale path, which shows as a flash of the wrong view. Links are real `<a href>`
so middle-click and open-in-new-tab keep working, and only plain left clicks are
intercepted.

**Deep links need an SPA fallback in production.** Vite serves `index.html` for
unknown paths in dev, so `/tickets` works; a deploy without the same rewrite will
404 on refresh.

Nav destinations are filtered by capability, matching the rest of the app:
organizer surfaces are absent for regular users rather than disabled. The Door
link is driven by `GET /door/events`, not the role, because a volunteer is a
plain `USER`.

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
npm run prisma:migrate -- --name <description>   # needs a real terminal, see below

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

### End-to-end: Playwright, in `frontend/e2e`

```sh
npm run e2e          # frontend/ — starts its own stack
npm run e2e:ui       # pick and watch individual specs
```

**Deliberately NOT part of `npm test`.** Vitest globs `src/**/*.test.tsx`, so the
fast loop stays fast and unaffected.

These exist only for what jsdom structurally cannot answer, not to restate unit
coverage:

- **Viewport.** Whether the QR is actually GONE below the `sm` breakpoint is a
  question about layout in a browser. jsdom has no viewport, so the mobile
  deep-link work had to be checked by hand on a phone.
- **The SPA fallback.** Loading `/tickets` directly and refreshing is a
  documented deploy hazard that nothing tested; it is a fact about a server
  answering an HTTP request, and jsdom never makes one.
- **Cookies** (`httpOnly`, `SameSite=Lax`) and **timing** — the sign-out bug
  lived in the window of a network round trip.

**Playwright rather than Cypress** because device emulation is the actual gap:
real device descriptors, touch and device pixel ratio. `cy.viewport()` is
CSS-only, which is precisely the fidelity we would have been buying it for.

**The backend runs in STUB MODE, on its own ports (4100/5273).** Stub mode is
what makes signing flows testable without a phone, and it means the suite costs
NOTHING against the Xaman payload quota. Its own ports mean a run cannot fight
the dev servers or — worse — quietly pass against a LIVE-mode backend that was
already running, where the stub endpoints 404.

Two traps worth knowing, both already paid for:

- **`XAMAN_API_KEY=''` does not select stub mode; it stops the server booting.**
  The schema is `.min(1).optional()`, so empty is present-but-invalid and env
  parsing exits. Credentials are excluded instead by pointing
  `DOTENV_CONFIG_PATH` at a file that does not exist, so `dotenv/config` loads
  nothing and `playwright.config.ts` supplies the whole environment.
- **Playwright matches accessible names by SUBSTRING.** `name: 'Hub'` matches the
  "HubWorld" brand link, and `name: 'Events'` matches EventList's "All events"
  heading — which only appears when no auction is live, so a loose match passes
  or fails depending on whether a demo auction happened to be running. Use
  `exact: true`.

Because stub mode withholds the deep link on purpose, the two device specs
intercept the sign-in response and hand back a LIVE payload. The component, CSS,
browser and viewport are all real; only the response is faked.


### Tests have their own database

```sh
npm run db:test:setup             # create + migrate hubworld_test
npm run db:test:setup -- --reset  # drop and rebuild if the schema drifts
```

`vitest.config.ts` points `DATABASE_URL` at **`hubworld_test`**, derived from the
dev URL by swapping the database name (or `TEST_DATABASE_URL` if you set one).
It is set in the config rather than a setup file because `src/env.ts` reads the
variable at import time, and dotenv never overwrites an already-set variable, so
this wins over `.env` without touching it.

**CI never had this problem** — it already points at a `hubworld_test` service
container, so the swap is a no-op there. This only makes local match CI.

It fixes three separate things, all measured rather than assumed:

- **The dev server was deleting fixtures mid-test.** Its settlement sweep runs
  every 15s against the same database. Full-suite failures went from **2/10 with
  the server running** to **0/6 after**, with the server still running.
- **Stryker's four concurrent workers collided the same way**, which is why
  `src/ledger.ts` could not be mutated. It now can.
- The confusing failures that trained everyone to re-run instead of investigate.

`tests/global-setup.ts` fails fast with the command to run if the database is
missing or unmigrated, rather than a Prisma trace about a database you did not
know was supposed to exist.

### Mutation testing: `npm run mutate` (backend)

Stryker grades the TESTS, not the code — it mutates the source and reports which
changes the suite fails to notice. A surviving mutant is a line no test actually
constrains. This automates the discipline stated below rather than replacing it.

**It earned its place on the first run.** `auction-policy.test.ts` reimplemented
the sold-out rule *inside the test file* — "Mirrors evaluateSoldOut's decision" —
and tested the copy, so `src/auction-policy.ts` had 78 mutants and no coverage.
Deleting `organizerHolds === 0` from the shipped source left every test passing.
With that half gone an organizer holding their whole allocation counts as sold
out and can auction their own stock. `auction-policy.real.test.ts` imports the
module and fails on exactly that deletion.

**A mirror in a test file is documentation that cannot fail.** If a test
reimplements the thing it is testing, it is testing nothing.

Scope is deliberate: pure policy modules only. `src/ledger.ts` holds all the
money math and is the most valuable target, but it also holds 11 network call
sites, so its mutants drag in the DB-backed suites — which Stryker runs
concurrently against the same Postgres, the fixture collision measured at ~20%
failures. **A separate test database is the prerequisite for mutating
`ledger.ts`.**

`thresholds.break` is a ratchet at 75 against a current 79.42. Raise it as
survivors get killed; lowering it to make a run pass is the one move that makes
the whole thing worthless.

Two mechanical notes. `tsconfigFile` points at a file that does not exist ON
PURPOSE — Stryker's tsconfig preprocessor calls `ts.parseConfigFileTextToJson`,
which **TypeScript 7 removed**, so any run dies the moment it finds a tsconfig;
naming an absent one skips the preprocessor, and the sandbox never needs it.
And `vitest.config.ts` exists mainly to EXCLUDE `.stryker-tmp`: Stryker copies
the project per run and only cleans up on success, so a crashed run leaves
working copies of every suite on disk — one turned 313 tests into 925 with 131
failing.

**Vitest**, installed separately in each folder (no workspace). Backend tests
live in `tests/` and are typechecked by `tsconfig.test.json` — the build's
`rootDir` is `src`, so without that second config they would never be checked.

`tsconfig.test.json` also covers **the scripts that touch Postgres** (named
individually). They were previously outside every tsconfig, so the `network`
column — which the compiler caught at every route and test — reached them only
as a runtime failure partway through a run. The ledger *spikes* stay excluded:
they cast loosely against xrpl's types on purpose, are imported by nothing, and
touch no tables.
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

**The bid must also pay for its own offer.** An `NFTokenCreateOffer` is an owned
object, so placing the bid raises the bidder's reserve by one increment (0.2 XRP)
and spendable *drops the moment the bid exists*. A bid of exactly the current
spendable balance is therefore not merely tight, it is arithmetically guaranteed
to be unsettleable — short by exactly the increment when settlement reads the
balance. `spendable < amount` accepted precisely that bid; `bidHeadroom` is the
rule that does not, and `spendable.test.ts` pins the boundary.

Above that floor it is the bidder's money and their call, so leaving little
behind is a **warning, not a refusal**: under a tenth of the bid remaining is
reported as `tight` on the 201 and shown on the signing screen, before the QR is
scanned, since that is the last moment the bid can still be changed. Both fields
are omitted when the ledger could not be read — "we do not know" must not render
as "you have nothing left".

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

### When an auction is allowed

Auctions are the **secondary market for scarcity**, so `src/auction-policy.ts`
gates them on two rules:

1. **The event must be sold out** — every promised ticket issued AND none still
   held by the organizer. Both halves matter: 10 minted with 4 unsold is not sold
   out, because buyers can still pay face value and there is nothing scarce to
   bid over.
2. **The organizer cannot auction their own allocation.** That is the primary
   sale at the price they set; an organizer auctioning their own stock is an
   organizer bidding up their own event.

**Sold out is derived, never read from `Event.status`.** That field is settable
and was demonstrably wrong — seeded `peachs-castle-afterparty` claimed SOLD_OUT
with zero tickets minted. Gating a market on a field anyone can set would let an
organizer open auctions on an event that never sold anything. `evaluateSoldOut`
counts the facts and corrects the status to match, so the enum stays honest
rather than becoming a second source of truth.

`GET /tickets/mine` returns `canAuction` and `auctionBlockedReason` per ticket, so
the UI explains *why* instead of offering a control that 409s.

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

## Deploying

**One image, one process, one origin.** The `Dockerfile` at the repo root builds
the frontend and backend separately and ships them together: Express serves the
built app from `WEB_DIST` alongside `/api`.

That is a requirement, not packaging convenience. The frontend calls a relative
`/api`, opens its socket with a bare `io()`, and authenticates with a
`SameSite=Lax` cookie — which a browser stops sending on XHR the moment the API
is a different site from the app. **Splitting the two across hosts breaks
sign-in**, and the fix is one origin, not `SameSite=None` (which reintroduces
the CSRF hole `Lax` closes). Any host that runs a container works; nothing in
the image is host-specific.

**The SPA fallback is part of the server, not the host's config.** The router
owns `/tickets`, `/market` and the rest, and those paths exist only in the
browser — so `serveWebApp` in `app.ts` returns `index.html` for any GET that
accepts HTML. Without it, loading one of those URLs directly, or just
refreshing, 404s on a page that works fine when navigated to. Vite hides this in
dev by doing the same thing.

Ordering matters and is easy to get wrong: **the `/api` 404 is registered before
the static and fallback handlers**, so a mistyped API route answers JSON rather
than falling through to the shell and handing the client HTML to parse as JSON.

`index.html` is served `no-cache` because it names the current hashed bundles; a
stale copy points at assets the next deploy has already deleted. Everything
under `/assets` is fingerprinted and gets a year, `immutable`. Everything else
keeps its name across deploys and gets an hour.

The container runs `prisma migrate deploy` before serving — a process that comes
up against an un-migrated database answers every request with a Prisma error,
which is worse than failing to start.

**Still outstanding before this is actually live:** `XRPL_NETWORK` has never
been anything but `testnet`, so every figure measured in this document is
testnet; and the Xaman application's payload quota is exhausted and its
credentials still need rotating.

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
- **`prisma migrate dev` needs an interactive terminal.** It refuses to run from
  a non-TTY ("environment is non-interactive, which is not supported"), which
  includes agent shells, `zsh -c` and CI. That is Prisma's design, not a repo
  defect. It works normally in your own terminal: the local role has `CREATEDB`,
  so Prisma creates and drops its own shadow database automatically and no
  `shadowDatabaseUrl` needs configuring. From a non-TTY use
  `prisma migrate diff` plus `prisma migrate deploy` instead.
- **A malformed `--shadow-database-url` will operate on your REAL database, and
  it is easy to malform.** `DATABASE_URL` ends in `?schema=public`, so appending
  a suffix to it yields `...hubworld_dev?schema=public_myshadow` — still the
  live database, merely a different *schema* inside it. Prisma then replays
  migration history there, and any migration mixing schema-qualified with
  unqualified names (`20260727024342_bids_as_buy_offers` does, on two lines)
  resolves half its statements against `public` — the real tables. That run
  reports a confusing enum-cast failure which looks like broken migration
  history and is not. **The shadow must be a separate DATABASE**, e.g.
  `postgresql://…@localhost:5432/hubworld_shadow?schema=public`, created and
  dropped around the run. Verified 2026-08-02: with a correct shadow URL the
  full history replays cleanly and
  `migrate diff --from-migrations … --to-schema-datamodel` returns an empty
  diff, so **the recorded history is sound and must not be "fixed"** — editing
  an applied migration changes its checksum, which is stored in
  `_prisma_migrations` in every environment including Supabase, and would make
  `migrate dev` offer to reset the database.
- `backend/.env` is gitignored; `backend/.env.example` is the template.
- Vite proxies `/api` to `localhost:4000` in dev, so the browser stays
  same-origin and CORS never fires. The `cors` middleware exists for deployed
  environments where the two are on different hosts.

## Roles and platform policy

Three roles on `User`: `USER`, `ORGANIZER`, `ADMIN`.

**Organizers are a separate account type, not a user who happens to own an
Event row.** Issuing admission and taking money is a different trust level from
attending, so it is an account property gated by `requireOrganizer`. Before this,
"organizer" was implied by an `Event.organizerId` foreign key — which meant
self-serve event creation would have made every signed-in user an issuer.

Becoming one is **reviewed, not self-declared**: a user applies, an admin
approves. Nothing a client sends can promote an account. The first `ADMIN` is
granted with `npm run role:grant -- @handle ADMIN`, deliberately a script rather
than a route — a self-serve "make me an admin" endpoint is an obvious escalation.

**Regular users do not see organizer features at all.** Minting, the door and
event creation are absent from their UI rather than disabled: a greyed-out
control still advertises a capability and invites someone to probe the endpoint.
The server enforces this independently — hiding is presentation, not security.

### `platformBps` is policy; `royaltyBps` is the organizer's

`PLATFORM_FEE_BPS` (env, default 250, capped at 1000) is set **by the server** on
every event. It is deliberately absent from `CreateEventBody`: an organizer
choosing Hubworld's cut would choose zero, and because the fee is frozen onto each
Listing at creation it would not be retroactively recoverable — the revenue is
simply never earned.

`royaltyBps` IS the organizer's to choose, since it is their revenue, but it is
capped by `MAX_ROYALTY_BPS` (default 2000). An unbounded royalty makes resale
pointless and the ticket effectively non-transferable, which defeats the product.

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

### Every ledger-bound row records its network

`Event`, `MintRequest`, `Ticket`, `Gift`, `Redemption`, `Listing`, `Auction`,
`Bid` and `Transfer` carry `network: XrplNetwork` (`TESTNET`/`DEVNET`/`MAINNET`).
`src/network.ts` exports `NETWORK` — the one place `env.XRPL_NETWORK`'s lowercase
value is reconciled with the uppercase enum — and `onThisNetwork` for scoping
reads.

**Identity deliberately does NOT carry it.** `User`, `Session` and
`SignInRequest` are network-free: a `SignIn` is a pseudo-transaction that is
never submitted to any ledger, so the proof binding an @handle to an r-address
holds on all of them. The same person is the same person everywhere.

**There is no database default, on purpose.** A default means a forgotten field
silently labels a mainnet row as testnet — exactly the failure the column
exists to prevent. Instead the column is required, so the *compiler* finds every
create; the migration backfilled existing rows to `TESTNET`, which is what they
factually are, using a `DEFAULT` that it drops again in the same file.

**`nfTokenId` and `txHash` are unique per network, not globally**
(`@@unique([network, nfTokenId])`, `@@unique([network, txHash])`). An NFTokenID
derives from the issuer's AccountID, the taxon and the sequence — none of which
are network-specific — so the same account minting the same taxon at the same
sequence on two networks produces byte-identical ids. Reusing a seed across
networks is ordinary in development, so this is reachable, not theoretical. A
global unique would reject a legitimate mainnet ticket or let an upsert quietly
rewrite the testnet row holding that id. Lookups are
`where: { network_nfTokenId: { network: NETWORK, nfTokenId } }`.

**Anything that ACTS on the ledger must scope by network**, and both such paths
now do: `settleDueAuctions` (it submits a transaction — a foreign auction would
be brokered against offers that do not exist here, spending the fee to find out)
and `ledger:sync` (pointed at mainnet it saw every testnet ticket as held by
nobody and reported the whole inventory as drift, which `--apply` would have
acted on). Read-only list endpoints are NOT scoped yet; that only matters if one
database ever holds two networks, which the deployment guidance says to avoid.

The recommendation stands regardless: **one database per network.** The column
is what makes a mistake survivable, not a licence to mix.

**Royalties use XRPL brokered mode**: the organizer is the NFT issuer and
collects `royaltyBps` via the native `TransferFee`; Hubworld brokers the
`NFTokenAcceptOffer` and takes `platformBps` from the spread. This keeps
Hubworld out of the funds-custody path. Changing this changes who mints.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | liveness + db status + running commit + ledger |
| `POST /api/auth/signin` | create Xaman SignIn payload → `{uuid, qrPng, next}` |
| `GET /api/auth/signin/:uuid` | poll → `pending` / `needs_username` / `authenticated` / `rejected` / `expired` |
| `POST /api/auth/claim` | bind an @handle to a freshly-verified address |
| `GET /api/auth/me` | current user (bearer token) |
| `POST /api/auth/signout` | revoke session |
| `GET /api/users/:username` | @handle → XRPL address (accepts a leading `@`) |
| `POST /api/organizers/apply` | apply to become an organizer |
| `GET /api/organizers/me` | my role + application status |
| `GET /api/admin/organizer-applications` | admin: the review queue |
| `POST /api/admin/organizer-applications/:id/review` | admin: approve / reject |
| `GET /api/policy` | platform fee + royalty cap (public) |
| `POST /api/events` | organizer-only; create an event |
| `GET /api/events?status=&limit=` | event list |
| `GET /api/events/:slug` | event detail |
| `POST /api/events/:slug/image` | organizer-only; upload the event poster (raw image body) |
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
| `GET /api/door/events` | events I may work the door for |
| `GET /api/events/:slug/staff` | organizer-only; who is on the door |
| `POST /api/events/:slug/staff` | organizer-only; add door staff |
| `POST /api/events/:slug/staff/remove` | organizer-only; revoke door staff |

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

### On a phone, the QR is replaced by a deep link

A QR is an instruction to a SECOND device, so on a phone it is a dead end — you
cannot scan the screen you are reading. Xaman returns a universal link alongside
every QR (`body.next.always`, surfaced as `next` on all seven signing endpoints),
and `QrCode` renders it instead of the code below the `sm` breakpoint.

**`DoorPanel` deliberately passes no `next`, and that must not be "fixed".** The
door inverts the assumption every other flow makes: its payload is signed by the
ATTENDEE while the code is displayed on the STAFF device for their phone to scan.
A door volunteer holds a phone, so a link there opens Xaman on the staff device
and has the wrong person sign — admitting nobody, or the wrong person if that
volunteer happens to hold a ticket for the event.

Stub mode gets no link either: it returns `hubworld-stub://sign/<uuid>`, which
opens nothing.

**The round trip is verified on real hardware** (iPhone 12, Safari, 2026-08-02):
tapping through to Xaman, signing, and returning to the browser completes the
sign-in. That is not a given — the poll lives on the page, so the tab has to
survive being backgrounded for the signature to be noticed. The link therefore
opens in the SAME tab; `target="_blank"` would background the page holding the
poll behind Xaman's return, and `QrCode.test.tsx` pins that.

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

### Identity is the cookie's answer, never a snapshot

Because the page holds no credential, **who it thinks it is and who the cookie
actually belongs to are two different facts**, and they diverged in exactly the
way that predicts. The frontend asked `/auth/me` twice — at mount, and just
after a sign-in — and nothing ever asked again. So a cookie that changed
underneath it (another tab signing in as a different account, a session
expiring, one revoked) left the header naming one account while every request
was attributed to another. Both were the server's answers; only the header was
old. "Sign out" then revoked the *current* session rather than the one on
screen, which is why it looked like it revoked nothing.

Three rules keep them together, all pinned by tests:

- **A 401 from ANY call retires the identity**, not just from `/auth/me` —
  `onAuthLost` in `lib/api.ts` announces it once, centrally, so it lands even
  where the caller swallows the error.
- **Only a 401 does.** A transport failure carries no status and says nothing
  about who is signed in; clearing identity there signs someone out because the
  backend blinked — the same mistake door check-in refuses to make with the
  ledger.
- **Revalidate on focus/visibility, never on a timer.** A poll keyed on fetched
  state is the `GiftPanel` runaway again, so the frontend test bounds
  `/auth/me` by request COUNT, not by end state.

Server side, **issuing a session revokes the one the browser is about to
forget** (`issueSession` in `routes/auth.ts`). Setting the cookie replaces that
token, so if it still names a live session nobody holds it any more — and
revocation needs the token, so nothing could ever end it. It would stay valid
for its full 7 days. `/auth/signout` answers `{ revoked }` rather than a bare
204 for the same reason: a sign-out that ended nothing must not be
indistinguishable from one that worked.

**The Xaman webhook** is built (`src/routes/webhooks.ts`, `src/payload-store.ts`)
but only active when `XAMAN_WEBHOOK_SECRET` is set, so dev still works with no
public tunnel.

**The webhook body is never trusted — only the uuid is read from it.** The state
always comes from an authenticated fetch with our API secret. A callback that
believed itself would accept `{ signed: true, account: "rAttacker" }` from anyone
on the internet: a forged sign-in as any address, a forged mint, a forged door
check-in. Treating it as a nudge rather than a source removes that whole class of
attack, and means we do not depend on reproducing Xaman's signing scheme
correctly. The secret in the path is a doorbell, not the boundary.

All 16 poll sites go through `tryGetPayload`, so caching there fixed every flow
without touching a single route. Terminal states (signed/cancelled/expired) are
cached permanently — they cannot change again. While pending, webhook mode
refreshes at most once per **1.5s** per payload rather than once per poll per viewer,
because a pure-webhook design loses signatures when a callback is dropped. The
sweep also reconciles any payload left non-terminal for over a minute.

**That window is deliberately shorter than the client's 2s poll, and 10s was
wrong.** The saving is per PAYLOAD, not per viewer: N people watching one auction
collapse to one request per window whatever it is set to. Sign-in is the opposite
shape — one person watching their own payload — so a long window saves nothing
and costs its full length. Measured on production with the webhook enabled but
its URL never registered in the Xaman console: signing took ~5s to be noticed,
the average of a 10s window, against ~2s before. At 1.5s a lone poller refreshes
on essentially every poll while a crowded auction stays capped.

**Setting `XAMAN_WEBHOOK_SECRET` without registering the URL is the worst of both
worlds** — throttled polling and no push. If the console entry is not done, the
variable is better left unset.

Configure in the Xaman console as
`https://<host>/api/webhooks/xaman/<XAMAN_WEBHOOK_SECRET>`.

### The Xaman payload quota

**The developer application has a quota on payloads CREATED, and it cannot be
reclaimed.** Measured after an initially wrong guess: the number in Xaman's
error rises as more payloads are made (67 → 77), so it counts creations rather
than open payloads. `DELETE` on a resolved payload returns 404 — Xaman has
already discarded it — and it still counts against the total.

So cancelling does not help, and no code change fixes an exhausted quota. It
needs a higher application limit or fresh credentials. **This is the same
application whose credentials still need rotating, so doing that solves both.**

What code can do is spend the quota more slowly, which is now done:

- `POST /auth/signin` **reuses an outstanding unsigned sign-in** rather than
  minting one per click, tracked by a short-lived `hubworld_signin` cookie. Six
  clicks used to cost six payloads.

  **Reuse is confirmed against Xaman, never against our own row.**
  `SignInRequest.status` only becomes `SIGNED` when a poll observes it, so
  signing and then closing the tab left it reading `PENDING` — and the next
  attempt handed back a payload Xaman had already resolved and would refuse.
  Sign-in then stayed broken until the TTL expired, which made switching between
  accounts fail every time. Only positive evidence that a payload is still
  unsigned permits reuse; signed, cancelled, expired, unknown, or a 429 all mint
  a fresh one. Spending one more slot is bounded; handing back a dead payload is
  a sign-in the user can neither complete nor diagnose. Reading a payload does
  not consume quota — only creating one does.
- `SIGNIN_TTL_MINUTES` is **3**, not 10. A QR is scanned within a minute or
  abandoned, so a long TTL bought nothing.
- `cancelAbandonedPayloads` still runs on the sweep as hygiene — an abandoned
  payload scanned much later produces a signature for something the user has
  moved on from — but it is NOT quota recovery.

A quota error answers 503 with a specific message rather than a 500.

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

Events are created through `POST /api/events` (organizer-only, via
`OrganizerPanel`). The script remains for seeding and for onboarding an
organizer before they have signed in:

```sh
npm run event:create -- --organizer <handle> --title "<title>" [--tickets 50]
```

### Bulk minting: why this caps out in the low hundreds

`NFTokenMint` is one NFT per transaction, and the organizer must sign each one
because the issuer is the royalty recipient. A thousand tickets is a thousand
Xaman payloads, a thousand taps, and a thousand against the payload quota. That
is not a UX problem to design around; it is a wall, and it is worth stating
plainly rather than discovering during a sales conversation.

**The constraint is a triangle, and only two corners are available at once:**

1. **The organizer is the issuer** — required, because `TransferFee` pays the
   issuer and that is the whole royalty model.
2. **No delegation** — Hubworld cannot sign as anyone.
3. **Unattended bulk minting.**

(1)+(2) is where we are: the organizer signs everything, so it does not scale.
(1)+(3) needs delegation. (2)+(3) means Hubworld issues, royalties accrue to us,
and paying organizers out reintroduces exactly the funds-custody role brokered
mode exists to avoid.

**We chose (1)+(2), deliberately.** "Hubworld cannot act as you" is the load-
bearing claim of the whole design, and it is very hard to win back once given up.
XRPL's `RegularKey` is the obvious lever and the wrong one — it is unscoped, so
an organizer granting it would also be granting the ability to send payments from
their account. Granular per-transaction-type delegation would be a better shape
if it becomes available, but it still ends the claim above.

**It now exists, and it works.** `PermissionDelegationV1_1` is **active on
devnet** (pending on testnet, absent from mainnet). Measured 2026-08-02 with
`scripts/delegation-spike.ts`:

- An organizer can `DelegateSet` **only** `NFTokenMint` to Hubworld.
- Hubworld mints with `Account` = organizer, `Delegate` = Hubworld, signed by
  Hubworld's key — and **the resulting NFT's `Issuer` is the ORGANIZER**, with
  `TransferFee` intact. **The royalty model survives.**
- Hubworld attempting a `Payment` from the organizer's account is refused with
  `terNO_DELEGATE_PERMISSION` — so it is genuinely scoped, unlike `RegularKey`.
- Revocation is one transaction and takes effect immediately.
- The **delegate** pays the transaction fee, not the organizer.

That is the (1)+(3) corner, reachable without giving up (1). It lifts the
minting ceiling while keeping royalties, brokered settlement, resale, auctions
and per-ticket door verdicts — everything MPT would have destroyed — and it
takes minting off the Xaman quota entirely, since Hubworld signs directly.

**It still weakens "Hubworld cannot act as you"**, to "Hubworld can mint tickets
as you, nothing else, and only while you allow it". Narrower, ledger-enforced
and revocable, but a product decision rather than a free win. And it is **not on
mainnet**, so the low-hundreds ceiling stands until it activates. See
`ROADMAP.md` §5b.

**Batch transactions do not rescue this, on two counts.** The `Batch` amendment
(XLS-56) would let one signature carry several inner mints, but a signature-
validation flaw found on 19 Feb 2026 led to rippled 3.1.1 marking both `Batch`
and `fixBatchInnerSigs` unsupported and blocking them from validator votes on all
production networks; a `BatchV1_1` successor is the replacement — **now visible
on testnet as `supported=true`, pending activation** (2026-08-02). More
decisively, **the cap is eight inner transactions** — so even once it ships, a
thousand tickets is 125 signatures. An 8× improvement, not a solution.

**MPTs are the only path that actually reaches thousands.** Multi-Purpose Tokens
(XLS-33) activated as `MPTokensV1` in October 2025. One issuance transaction
covers the entire supply, whatever its size — **measured on testnet 2026-08-02:
3,000 tickets created in ONE organizer signature** (`scripts/mpt-spike.ts`).
That is the organizer bottleneck genuinely removed.

**The royalty does NOT survive, and an earlier version of this document was
wrong to say it did.** `MPTokenIssuance` does carry a `TransferFee`, but it is
charged **in tokens, not in XRP**. Measured: with a 5% fee, sending 100 units
cost the sender 105 and delivered 100, and the 5 never appeared in the issuer's
holdings — they left circulation. The NFT `TransferFee` is charged on the SALE
AMOUNT because `NFTokenAcceptOffer` knows the price; an MPT `Payment` carries no
price, so there is nothing to take a percentage *of* except the tickets
themselves. An organizer's "royalty" on an MPT resale is therefore paid in
fractions of a ticket, which is not revenue.

The catch is that MPT units are fungible — which is *honest* for general
admission, where there is no meaningful difference between ticket #447 and #448,
and wrong for reserved seating, where `seat` means something. So **tiers are the
natural seam**: general admission becomes an MPT issuance, reserved seating stays
NFTs. Not two products bolted together; the right primitive for each.

**What MPT costs, now measured rather than predicted** (`scripts/mpt-spike.ts`,
testnet, 2026-08-02):

- **There is no atomic swap.** `NFTokenAcceptOffer` with `NFTokenBrokerFee` —
  moving ticket and XRP together with our fee taken from the spread, neither
  party able to settle alone — is NFT-specific machinery with no MPT equivalent.
  An MPT `Payment` moves the ticket one way and nothing back, so there is no
  spread a broker fee could come from.
- **The DEX is not an escape hatch.** `OfferCreate` does not accept an MPT
  amount: `Amount` in xrpl.js is `IssuedCurrencyAmount | string` and excludes
  `MPTAmount`, and submitting one anyway returns **`temDISABLED`** on testnet
  even with `tfMPTCanTrade` set on the issuance.
- **Redemption cannot be answered on-ledger.** The `MPToken` object carries an
  `MPTAmount` count and no per-unit identity, so a holder of 2 units admitted
  once is indistinguishable from one admitted twice. `already_used` versus
  `no_ticket` has to become an off-ledger per-account record, and that record
  is wrong the moment somebody buys two tickets.
- **Every attendee costs an extra signature.** A holder must submit
  `MPTokenAuthorize` to opt in before they can be sent any units — so MPT *adds*
  a payload per attendee against the Xaman quota.

So resale, the platform fee, the royalty and the whole auction mechanism do not
port. What DOES port is primary sale and admission, which is the honest scope of
an MPT tier. See `ROADMAP.md`.

**So, today: Hubworld suits events in the tens to low hundreds.** That is a
consequence of refusing delegation, not an oversight, and the honest thing is to
say so rather than let an organizer find out at ticket 200.

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
Verified on testnet:

- issuer as buyer, 10 XRP sale → seller received the full **10.0**, no royalty leg
- issuer uninvolved, 10 XRP sale → seller **9.5**, issuer **+0.5**, broker **0.25**
- issuer uninvolved, 15 XRP **auction** → seller **13.89375**, issuer **+0.73125**,
  broker **0.375**

**The royalty is charged on the bid MINUS the broker fee, not on the headline
price.** That last case makes it explicit: 5% of 15 would be 0.75, but the issuer
received 0.73125, which is 5% of 14.625 — the amount left after brokerage.
`TransferFee` applies to what actually transfers to the seller, so an organizer's
effective take is slightly under their nominal rate whenever a broker fee is
involved. Worth knowing before quoting a royalty to an organizer.

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

**`Listing.brokerAddress` is frozen for a harder reason.** Both offers carry
`Destination` = the broker, so ONLY that account can ever match them. Resolving
the broker globally at each step is correct only while `PLATFORM_SEED` has never
changed — the moment it rotates, a buyer's offer names the new account while the
seller's already names the old one. Both transactions still succeed; the pair
simply becomes unsettleable, and nothing records which key it needed. So the
address is snapshotted on the Listing and every later step reads it from there,
including auction bids, which must match the sell offer created when the auction
opened.

Rows written before that column carry null and fall back to the current address.
**Run `npm run broker:backfill` (dry run; `-- --apply` to write) before ANY
platform key rotation** — rotating first makes the fallback wrong and the answer
is not recoverable from our own data.

The column is also the prerequisite for ever having more than one broker. Every
sale platform-wide is serialised behind the broker's single sequence, so one
stuck transaction halts all of them; sharding is impossible while offers do not
record which broker they name.

## Check-in at the door

`src/routes/redemption.ts`. This is what makes an NFT a ticket rather than a
collectible.

**Proof is a signature, not a display.** A QR on an attendee's phone can be
screenshotted and forwarded; a Xaman signature cannot, because it needs their key
at that moment. Check-in reuses the `SignIn` pseudo-transaction — no fee, no
reserve, so an unfunded wallet can still be admitted.

**Door access is per event, not the organizer role** (`src/door-access.ts`).
Checking people in and issuing tickets are very different powers, and they used
to be the same one. A door needs volunteers, and granting each of them ORGANIZER
would hand over minting, event creation and auctions so somebody can scan QRs for
an evening.

`EventStaff` grants one person the door of one event, revocable, with an audit
trail — revoked rather than deleted, because a disputed check-in is exactly when
you need to know who had access and when it ended. Only the organizer manages the
list: letting staff add staff means one compromised volunteer account can widen
access indefinitely. Admins can work any door, since they arbitrate disputes and
cannot depend on the organizer's cooperation.

`GET /door/events` exists because a volunteer is a plain `USER`, so the UI cannot
tell from the role alone whether to show them a door.

**Check-in is staff-initiated and the verdict appears on the STAFF device.**
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

`GET /api/health` → `{ status, db, commit, network, uptime, timestamp }`

Always returns HTTP 200 so the UI can render a status even when Postgres is
down; a dead database shows as `status: "degraded"`, `db: "unavailable"`. Check
the `db` field, not the status code.

**`commit` answers "which build is live?"** Nothing did, so confirming a deploy
had shipped meant probing an endpoint for a behaviour change and inferring it —
which gives no answer at all for a release that changes nothing observable.
Compare it against `git log` to know exactly what is running:

```sh
curl -s https://hubworld.app/api/health | jq -r '.commit, .network'
```

**`network` answers "is this pointed at real money?"** — previously unanswerable
from outside the process, inferable only from the repo's default and a dashboard
nobody checks in a hurry. It reads `env.XRPL_NETWORK` directly and is pinned by
a test that fails if it is ever hardcoded, because a field claiming `testnet`
while running mainnet is worse than no field. Exposing it is safe: every payload
already sends it to Xaman as `force_network`, and it names a public ledger.

The Dockerfile bakes it from `ARG COMMIT_SHA`, so the value describes the code
in the image and cannot drift from it. Render injects `RENDER_GIT_COMMIT` into
builds, so `--build-arg COMMIT_SHA=$RENDER_GIT_COMMIT` is all a host needs;
absent that, the backend reads `RENDER_GIT_COMMIT` at runtime, then falls back
to `'unknown'`. The field is always present — a client must never have to tell
"absent" from "not built with one".

**Reporting the build must never stop the build running.** `ARG COMMIT_SHA=""`
sets the variable to an EMPTY string rather than leaving it unset, and env
parsing exits the process on a bad value — so a plain `.min(7).optional()` would
have made an image built without `--build-arg` refuse to boot because it did not
know its own name. `emptyAsAbsent` in `env.ts` treats empty as unset;
`health.test.ts` pins it, and reverting it reproduces the startup failure.
