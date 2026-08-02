# Roadmap

Written 2026-08-02.

`CLAUDE.md` records what HubWorld **is** and why. This records what to do next
and in what order, and — more usefully — **what would be a mistake**. It is a
plan, not a promise: revise it when reality disagrees, but revise it
deliberately rather than drifting.

The ordering is the content. Anyone can list this work; the value is in the
claim that step 1 must precede the rest.

## The premise: there is no production yet

hubworld.app is live on Render and deploys from `develop`, so it *looks* like
production. It is not, in the sense that matters: **`XRPL_NETWORK` has only ever
been `testnet`.**

Every figure in `CLAUDE.md` is a testnet measurement — the 19.875 surplus, the
0.73125 royalty demonstrating that `TransferFee` is charged on the bid minus the
broker fee, the ~12 drop settlement cost, the 0.2 XRP owner reserve. Those
numbers are the basis for who gets paid. They have never been observed under
real money.

So the recurring question — "will this meet demand in production?" — is
premature. **You cannot plan capacity on figures you have not seen at stake.**
Everything below assumes that gets fixed first.

## 1. A mainnet dress rehearsal, before optimising anything

One small real event. Ten to twenty tickets, an event you control, real XRP.

This is first because it converts the largest unknowns into facts, and every
decision further down is guesswork without them:

- What reserves actually cost when XRP is not free.
- Whether the fee arithmetic holds — particularly the royalty-on-bid-minus-
  broker-fee behaviour, which is subtle enough to have surprised us once.
- What a real organizer does when they must tap Xaman forty times in a row.
  This is the minting ceiling meeting a human being, and it will teach you more
  than any estimate.
- What the door feels like with real attendees and real phone signal.

**Instrument payload counting before you start** (see 2), so the rehearsal
produces both sets of numbers in one pass rather than needing a second run.

Do not skip to scaling work because the rehearsal feels small. A ten-ticket
mainnet event de-risks more than a thousand-ticket testnet one.

## 2. Xaman is the top existential risk — above the minting ceiling

The minting ceiling is understood, bounded and documented. The Xaman dependency
is neither bounded nor measured, and it holds two distinct risks.

**The quota scales with USERS, not tickets.** Every sign-in, mint, gift, bid,
purchase and door check-in is a payload *created*, and creations cannot be
reclaimed — cancelling a resolved payload returns 404 and it still counts. The
testnet application is already exhausted. That is not an inconvenience; it is a
preview of the failure mode at scale, arriving early.

**The concentration risk is worse than the quota.** Auth, minting, resale,
bidding and the door all route through one vendor. If Xaman changes pricing,
terms or API, HubWorld stops working *entirely* — not degraded, stopped.

Two actions, both cheap, both now:

- **Instrument payload creation per flow.** Make quota a metric on a dashboard,
  not a surprise 503. Today you cannot answer *"how many payloads does one
  attendee cost us, end to end?"* — and that number decides whether the unit
  economics work at all. It is the single most valuable missing measurement in
  the system.
- **Get quota limits and pricing tiers from Xaman in writing** before selling
  anything to anyone.

Note the existing mitigations are real but bounded: `POST /auth/signin` reuses an
outstanding unsigned payload, `SIGNIN_TTL_MINUTES` is 3, and every poll site
goes through the cache in `tryGetPayload`. Those spend the quota more slowly.
**No code change fixes an exhausted quota.**

## 3. Protect the `src/xaman.ts` seam — it is the insurance policy

Stub mode forced a clean abstraction over signing, largely as a side effect of
wanting the sign-in loop developable without credentials. That seam is now the
most valuable architectural asset in the repo, because it is what would let a
second signer — Crossmark, GemWallet, a generic XRPL wallet — be added without a
rewrite.

**Keep it clean. Do not let Xaman-specific assumptions leak into routes.** Every
poll site already goes through `tryGetPayload` rather than touching the client
directly, which is why caching fixed sixteen flows at once. Preserve that
property; it is the same property that makes a second implementation possible.

This is insurance, not a project. Do not build a second signer speculatively —
just refuse to make one impossible.

## 4. Two operational safety nets that are missing

Both are small, and both are the kind of gap that is invisible until it is
expensive.

- **The broker account must stay funded or sales silently stop settling.**
  Settlement costs HubWorld the transaction fee because the broker submits it.
  That needs a balance alarm. Discovering it from a customer is the bad path.
- **The settlement sweep has never been load-tested with many auctions closing
  at once.** Per-auction `JobLock` leases make it *correct* under concurrency —
  correct and fast are different claims. A closing-time thundering herd is
  exactly the moment it must not fall over, and auctions naturally cluster at
  round times.

## 5. The minting ceiling: lean into it, do not engineer around it

Worth stating plainly, because it reframes the constraint:

**Auctions only make sense for sold-out, scarce events** — `auction-policy.ts`
enforces exactly that, and refuses an organizer auctioning their own allocation.
So the differentiator and the architectural ceiling point at the *same*
customer: limited drops, club nights, member events, tens to low hundreds of
tickets.

That is not a limitation to apologise for. It is a segment. Sell it
deliberately, and **state the ceiling before ticket 200 rather than letting an
organizer discover it** — a sales conversation is a much better place to find
this than a mint queue.

**Build the MPT tier seam only when a real customer with real money demands
thousands.** Fungible general admission as an MPT issuance, reserved seating
staying NFTs, is the right shape — but doing it speculatively costs the brokered
settlement, the platform fee, the whole auction mechanism, and the crisp
`already_used` versus `no_ticket` distinction the door depends on. That is most
of the product, traded for demand that may never arrive.

## 6. What would end HubWorld

Every scaling pressure will push toward one of these. They are listed so the
decision is conscious rather than incremental.

- **Trading custody for scale.** "Let HubWorld issue and pay organizers out"
  solves bulk minting and reintroduces exactly the funds-custody role brokered
  mode exists to avoid.
- **Granting a `RegularKey`.** It is unscoped: an organizer granting it also
  grants the ability to send payments from their account.

Both dissolve **"HubWorld cannot act as you"**, which is the claim the entire
design supports and the only one that is genuinely hard to win back. Either
would make this a different product with a different regulatory posture. If that
trade is ever worth making, make it explicitly and at the top level — not as an
implementation detail inside a sprint.

## What protects longevity

The strongest property already exists: **tickets survive HubWorld
disappearing.** They are NFTs in the holder's own wallet, the ledger is the
source of truth, and `Ticket.ownerId` is only a cache carrying `syncedAt`.

Guard that discipline. It is what makes the product defensible, and it is why
`ledger:sync` can be a real reconciler — dry run by default, because a
reconciler that silently rewrites ownership is worse than the drift it corrects
— rather than a hopeful one.

The test discipline is the other half: DB-backed suites against real Postgres,
only the network stubbed, and guards verified by **mutation** rather than by
going green. A test that cannot fail is documentation. That standard is what
caught the `CANCELLING` trap and the bid-reserve boundary, and it is worth more
than any amount of coverage percentage.

## Known gaps, carried forward

Not roadmap items so much as debts that should not be forgotten:

- **Auth identity staleness.** Observed 2026-08-02: the header displayed one
  signed-in user while requests were attributed to another, and "Sign out"
  revoked no session. Unexplained and uninvestigated. **Fix this early** — a UI
  showing the wrong signed-in user is a trust problem, and trust is the pitch.
- **Credential rotation.** The Supabase password was exposed in a transcript on
  2026-07-30. The Xaman credentials still need rotating, which is also the only
  thing that clears the exhausted payload quota.
- **No `--warning` design token.** The bid headroom notice borrows `destructive`
  at lower emphasis. Fine once; do not let it spread.
- **Single broker key.** `PLATFORM_SEED` cannot move anyone's ticket, but it is
  one key with no rotation story. Worth one before mainnet carries volume.

## If only one thing happens next

The mainnet dress rehearsal, with payload counting instrumented first — because
it answers the capacity question and the unit-economics question in a single
pass, and both are currently unanswerable.
