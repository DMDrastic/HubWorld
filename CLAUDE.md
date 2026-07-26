# HubWorld

## Stack

TypeScript end-to-end.

**Frontend** — React + Vite, Tailwind CSS, shadcn/ui components.

**Backend** — standalone Node + Express. Not serverless, not a meta-framework backend.

**Database** — PostgreSQL via Prisma.

**Validation** — Zod at every input boundary (HTTP handlers, socket events, env parsing).

**Ledger** — xrpl.js for XRPL interaction, Xaman for wallet signing.

**Live bidding (later)** — Socket.IO for realtime transport, Recharts for bid visualizations. Not built yet; do not scaffold ahead of it.

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

This machine still has a stale `/usr/local/bin/node` v18 from a 2023 `.pkg`
install. Homebrew's v23 now wins in login *and* interactive shells (`brew
shellenv` is in both `~/.zprofile` and `~/.zshrc`), but v18 still wins in
non-interactive shells — `zsh -c '...'`, some CI runners, and cron. If a script
fails with `EBADENGINE`, that's this.

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

**Frontend tests render inside `<StrictMode>` deliberately.** The original
sign-in bug was a `useRef` set during cleanup: StrictMode's
mount → cleanup → remount left it permanently true, so polling died silently.
It survived manual testing because the backend was driven with curl, which never
ran the React loop. The double-invocation *is* the thing under test — these tests
were confirmed to fail when that bug is reintroduced. Any new polling loop
belongs under the same discipline.

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
worlds. Tickets are XRPL NFTokens held in the user's own wallet (Xaman signs;
Hubworld never holds keys or seeds).

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

**Ownership is re-read from the ledger before a gift starts** (`holdsNft`). If it
disagrees with `Ticket.ownerAddress` the cache is cleared rather than trusted —
the holder may have moved the ticket in Xaman without touching Hubworld.
`GET /tickets/mine?verify=true` surfaces the same check per ticket as `onLedger`.

## Health check

`GET /api/health` → `{ status, db, uptime, timestamp }`

Always returns HTTP 200 so the UI can render a status even when Postgres is
down; a dead database shows as `status: "degraded"`, `db: "unavailable"`. Check
the `db` field, not the status code.
