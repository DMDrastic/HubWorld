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

**Superseded in part by the MPT spike below** — thousands-scale is wanted, so
the question was investigated rather than deferred. The conclusion is narrower
and more actionable than "wait for a customer".

## 5a. The MPT spike, run 2026-08-02 — results

`scripts/mpt-spike.ts` and `scripts/mpt-fee-spike.ts`, against testnet with
faucet wallets. Both are kept as evidence and are imported by nothing.

**Q1 — does one issuance cover the whole supply, with a royalty? HALF YES.**
3,000 tickets were created in **one** organizer signature.

**Correction, made after the fact:** an earlier version of this section said the
organizer bottleneck was "genuinely removed". That was too strong. **One
signature covers ISSUANCE, not DISTRIBUTION.** The units sit in the organizer's
account, and getting one to a buyer is a `Payment` signed by whoever holds them
— so 3,000 buyers is still 3,000 organizer signatures. Fungibility does give an
escape NFTs lack: the whole supply can move to a distributor in a **single**
`Payment`, making it two organizer signatures at any scale. But that means
HubWorld holds the inventory, which is custody of tickets — consigned rather
than seized, and not funds, but a real departure from "HubWorld holds nothing".

The royalty does not survive either: `TransferFee` on an MPT is
charged **in tokens, not XRP**. Sending 100 units with a 5% fee cost the sender
105 and delivered 100; the 5 left circulation and never reached the issuer. A
royalty paid in fractions of a ticket is not revenue. `CLAUDE.md` previously
claimed the royalty survived; it has been corrected.

**Q2 — can a unit be resold with a fee captured, atomically? NO.** There is no
MPT equivalent of `NFTokenAcceptOffer` + `NFTokenBrokerFee`. A `Payment` moves
the ticket one way with nothing coming back, so there is no spread to take a
broker fee from. The DEX is not an escape hatch either: `OfferCreate` rejects an
MPT amount with **`temDISABLED`** even with `tfMPTCanTrade` set.

**Q3 — can the door distinguish "already admitted" from "no ticket"? NO, not
on-ledger.** The `MPToken` object carries a count and no per-unit identity.
Redemption would have to become an off-ledger per-account record, which is
wrong as soon as somebody holds two units.

**Unbudgeted cost found, and it is mandatory:** every attendee must sign
`MPTokenAuthorize` before they can receive units. Tested explicitly in
`scripts/mpt-optin-spike.ts` on the most permissive issuance possible, with no
`tfMPTRequireAuth`: a `Payment` to a buyer who has not opted in returns
**`tecNO_AUTH`**, and the issuer **cannot** do it on their behalf — that returns
`tecNO_AUTH` too. So buying an MPT ticket is irreducibly **two** buyer
signatures, and MPT **adds** a payload per attendee against the Xaman quota of
section 2.

The mitigation, if this path is ever taken: the opt-in is per **issuance**, not
per ticket, so move it to a low-commitment moment — "notify me", following an
event — well before tickets go on sale. Purchase then becomes one tap at the
moment that matters.

### What this means

Everything MPT breaks is **secondary-market machinery**. Everything it fixes is
the primary-issuance bottleneck. That is a clean seam, and it points at a
specific product rather than a vague tier:

> **An MPT tier is viable for large general admission if and only if that
> segment ships with primary sale and admission only — no resale, no auction,
> no royalty.**

This is more coherent than it first sounds. A royalty exists to pay the
organizer on **resale**; with no secondary market there is nothing to pay a
royalty *on*, so losing it costs nothing in that segment. The organizer sells at
face value and keeps it. The pieces that break are precisely the pieces that
segment would not use.

So the shape is:

- **Large GA (thousands)** — MPT. Primary sale, door admission, off-ledger
  redemption tracking. No secondary market.
- **Scarce / reserved / anything with a resale market** — NFTs, exactly as
  today, with brokered settlement, royalties and auctions intact.

**The open question is no longer technical, it is product:** is a
thousands-capacity GA ticket worth selling without resale? If yes, this is
buildable and the ceiling lifts. If the secondary market is essential at that
scale, then thousands-scale is **not** feasible on XRPL today at any reasonable
effort, and that should be said plainly rather than discovered late.

### Is `temDISABLED` amendment-gated? Checked — no.

`scripts/mpt-amendment-check.ts`, testnet on **rippled 3.3.0-rc5**, 2026-08-02.

Only three MPT amendments exist on that build: `MPTokensV1` (active),
`fixMPTDeliveredAmount` (active) and `DynamicMPT` (not active). **Nothing in the
26 not-yet-active amendments plausibly enables order books for MPTs** — there is
no `MPTokensV2`, no MPT-DEX amendment, under any name. `DynamicMPT` concerns
mutable issuance fields rather than trading; confirm against its spec if that
becomes load-bearing.

**So treat MPT resale as unavailable rather than imminent.** Revisit only if an
MPT-DEX amendment appears in a future `rippled` release. The conclusion above —
an MPT tier is primary-sale-and-door only — stands.

**A caveat on method, because it nearly produced a wrong answer:** `feature`
reports `Escrow`, `MultiSign` and `PayChan` as not enabled on testnet, which
cannot mean what it appears to. The on-ledger `Amendments` object agrees with
it, so the two sources are consistent — the likely explanation is that a reset
testnet starts with old amendments baked in rather than voted on, so they never
appear in that object. **The practical lesson: "absent from the amendments
object" does not mean "unavailable".** For recent amendments the signal is
reliable; for pre-reset ones it is not.

### Incidental findings that matter more than the DEX question

Three pending amendments bear directly on constraints documented in `CLAUDE.md`:

- **`PermissionDelegationV1_1`** — `CLAUDE.md` states that granular
  per-transaction-type delegation "would be a better shape if it becomes
  available". **It is now visible on testnet, pending activation.** That is the
  (1)+(3) corner of the minting triangle becoming reachable: an organizer could
  delegate *only* `NFTokenMint` without handing over payment authority the way
  an unscoped `RegularKey` does. This deserves its own spike — it may lift the
  NFT ceiling without any of MPT's losses, which would be a far better outcome
  than the MPT tier. **Note it still weakens "HubWorld cannot act as you", so
  it is a product decision, not just a technical one.**
- **`BatchV1_1`** — the successor `CLAUDE.md` names after `Batch` was pulled in
  Feb 2026 is now on testnet, `supported=true`, pending. Still capped at eight
  inner transactions, so still 8× rather than a solution — but it is real now
  rather than hypothetical.
- **`Sponsor`** — sponsored reserves would cut the per-attendee onboarding cost
  (every holder currently funds their own reserve). Relevant to any
  thousands-scale plan regardless of which token primitive wins.

## 5b. Delegation supersedes the MPT tier — spiked on devnet, 2026-08-02

**Do not build the MPT tier.** `scripts/delegation-spike.ts`, run against
**devnet** where `PermissionDelegationV1_1` is already active, answers the
question MPT was only ever a workaround for.

The minting triangle said: organizer-is-issuer, no-delegation, unattended-bulk —
pick two. We chose the first two because the only delegation lever was
`RegularKey`, which is unscoped. Scoped delegation changes that, and every
result came back favourable:

| Question | Result |
| --- | --- |
| Can an organizer delegate **only** `NFTokenMint`? | **Yes** — `DelegateSet` with `PermissionValue: 'NFTokenMint'`, `tesSUCCESS` |
| Does the delegate's mint succeed? | **Yes** — `Account` = organizer, `Delegate` = HubWorld, signed by HubWorld's key |
| **Is the NFT's issuer still the organizer?** | **YES.** `Issuer` = the organizer's address, `TransferFee` = 5000. **The royalty model survives intact.** |
| Does the NFT land in HubWorld's account? | **No** — 0 NFTs there, it goes to the organizer |
| Who pays the transaction fee? | **The delegate.** HubWorld's balance moved, the organizer's did not |
| Is the permission actually scoped? | **Yes** — HubWorld attempting a `Payment` from the organizer's account was refused with **`terNO_DELEGATE_PERMISSION`** |
| Does revocation work? | **Yes, immediately** — an empty `Permissions` array, and the next mint is refused with the same code |

### Why this makes MPT pointless

MPT solved exactly one problem — the organizer's signing burden — and broke the
royalty, atomic settlement, the platform fee, resale, auctions, the door's crisp
verdicts, and single-signature purchase. Delegation solves the same problem and
**breaks none of them**. NFTs stay exactly as they are today.

It also attacks section 2's top risk from the other side: **minting currently
costs one Xaman payload per ticket, and under delegation it costs none**, because
HubWorld signs with its own key. The single largest consumer of the quota
disappears. MPT would have made the quota slightly *worse*.

Throughput is not a concern — 1,000 mints is 1,000 ordinary transactions, and
NFTs pack into `NFTokenPage`s at 32 per page, so the organizer's reserve for
1,000 unsold tickets is roughly 6 XRP rather than 200.

### What it costs, stated honestly

**"HubWorld cannot act as you" becomes "HubWorld can mint tickets as you,
nothing else, and only while you allow it."** That is far narrower than a
`RegularKey`, it is enforced by the ledger rather than by our good behaviour,
and it is revocable in one transaction. But it is still a weakening of the claim
the whole design rests on, and section 6 exists precisely so this is decided
deliberately rather than because it is convenient.

The mitigating fact: the delegation is granted by the organizer, scoped to one
transaction type, and cannot touch their funds — proven above, not asserted.

### The one real caveat

**`PermissionDelegationV1_1` is not on mainnet.** It is active on devnet,
pending on testnet, absent from mainnet. So this is a bet on activation rather
than something shippable today, and until it activates the low-hundreds ceiling
stands exactly as documented.

That still argues for waiting rather than building MPT: the MPT tier is weeks of
work that delegation would render pointless, and it would cost the royalty, the
secondary market and the door's precision permanently.

### What to do about it

- **Watch `PermissionDelegationV1_1` toward mainnet.** It is now the single
  highest-value amendment to this product.
- **Design the delegated minting flow now** — organizer grants once at event
  creation, HubWorld mints the run unattended, revocation surfaced in the UI —
  so it can ship when the amendment lands.
- **Re-run `scripts/delegation-spike.ts` on testnet once it activates there**,
  before trusting any of the above on a network that carries value.
- **Do not start the MPT tier.**

### If the MPT tier ever proceeds anyway, do these first
- Design the off-ledger redemption record for multi-unit holders before writing
  any issuance code; it is the part with no obvious right answer.
- Count the added `MPTokenAuthorize` payload into the quota model from
  section 2.

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
