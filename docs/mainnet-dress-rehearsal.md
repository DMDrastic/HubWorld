# The mainnet dress rehearsal

One small real event. Ten to twenty tickets, an event you control, real XRP.

This is `ROADMAP.md`'s answer to "if only one thing happens next", and it has
been deferred repeatedly — not because anyone disagreed, but because it is the
only remaining task that can go wrong in public. Everything else can be done
alone at a keyboard with a green suite at the end.

**Every figure in `CLAUDE.md` is testnet.** The 0.125 broker fee, the 19.875
settlement, the 12-drop transaction cost, the whole royalty table. None of it has
been observed with real money. Until it has, "what does this cost per person?"
has no answer — and that is the first question a grant reviewer asks.

---

## What it is actually for

Four unknowns become facts, and none of them can be reasoned into existence:

1. **What reserves cost when XRP is not free.** Measured below, but measured
   figures and *felt* figures are different things.
2. **Whether the fee arithmetic holds.** Particularly the
   royalty-on-bid-minus-broker-fee behaviour, which is subtle enough to have
   surprised us once already on testnet.
3. **What a real organizer does when they must tap Xaman twenty times in a row.**
   This is the minting ceiling meeting a human being, and it will teach more than
   any estimate. Watch yourself get bored — that is the data.
4. **What the door feels like** with a real attendee, a real phone and real
   signal.

Plus the one this whole instrument was built for: **payloads per attendee**.

---

## RESULTS — first run, 2026-08-13

**A 3-ticket rehearsal ran end to end on mainnet with real XRP.** Every money
path was exercised: mint, gift, fixed-price sale, auction, brokered settlement,
royalty, and the door. Figures below are measured, not modelled.

### Accounts

| Role | Address | Funded |
| --- | --- | --- |
| Broker | `rp6hU3DAfsgCVD9Jt6r8P4fAFDKzGaS1TD` | 2 XRP |
| Organizer (issuer) | `r4wQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf` | ~17 XRP |
| Attendee A | `rGprrMfw6mhSm6YbERrN3zthsyJCNkCTGG` | 4 XRP |
| Attendee B | `rw47D5hmU3ibf6uc8SuSmzcAHbH5FnA7rn` | 4 XRP |

### What it cost on-ledger

- **Every transaction fee observed was 12 drops.** Identical to testnet.
- **The NFT owner reserve is 0.2 XRP per PAGE, not per ticket.** The first mint
  took the account from 0 to 1 owned object; mints 2 and 3 added none. A page
  holds 32 tickets, so a 32-ticket event locks 0.2 XRP total, not 6.4.
- Base reserve 1 XRP per account, as documented.

### The fee split, verified twice

**Fixed-price sale, 1 XRP, issuer IS the seller:**

| | |
| --- | --- |
| Seller (organizer) | **+1.000000** — the full amount |
| Buyer | −1.025000 |
| Broker | **+0.024988** (0.025 fee − 12 drops to submit) |

No royalty leg at all: XRPL skips `TransferFee` when the issuer is party to the
trade. **A primary sale by the organizer therefore keeps 100%.**

**Auction, winning bid 1 XRP, issuer UNINVOLVED** — reserve 0.5, sell offer
0.4875:

| | |
| --- | --- |
| Winning bidder | **−1.000000** |
| Seller (attendee A) | **+0.926250** |
| Issuer (organizer) | **+0.048750** ← the royalty |
| Broker | **+0.024988** |

Reconciles to 0.999988; the missing 12 drops is the broker's own fee.

**The royalty is charged on the bid MINUS the broker fee.** 5% of 1.0 would be
0.050000. The issuer received 0.048750, which is 5% of 0.975. **So a nominal 5%
royalty pays 4.875% in practice at a 250 bps platform fee** — worth saying out
loud before quoting a rate to an organizer.

**A sell offer is a floor, not a price.** The offer was 0.487500 and the seller
received 0.926250. The seller signed ONCE to open the auction and never again;
settlement happened with them nowhere near it.

### Payload cost — the number that was previously unanswerable

**16 created, 15 signed, 1 wasted** (a sign-in that expired before it was
scanned — the only part code can improve).

```
signin 4 · mint 3 · listing_create 2 · listing_buy 2
door_checkin 1 · gift_offer 1 · gift_accept 1 · auction_open 1 · auction_bid 1
```

Extrapolating from the per-flow costs: **a ticket sold costs ~3 payloads**
(mint, list, buy) and **an attendee costs ~2** (sign-in, door). A 20-ticket
event with 20 attendees is therefore **~100 payloads**.

**That is larger than the cap we have actually hit (~77).** A full-size event
does not fit in a fresh application's quota, which makes the outstanding Xaman
question — the creation cap, its window, and whether it is per application —
a blocker on event SIZE rather than a matter of housekeeping. See
`xaman-rate-limit-request.md`.

### Behaviour confirmed

- **Sold-out is derived.** `Event.status` sat at `PUBLISHED` until something
  asked, then corrected itself to `SOLD_OUT` once all three tickets had left the
  organizer. The auction was refused before that and permitted after.
- **The auction's sell offer stayed out of `GET /listings`**, so nobody could
  buy the ticket at the auction floor.
- **The auction waited at `SCHEDULED`** until its sell offer was confirmed
  on-ledger, then went `LIVE`.
- **The sweep settled it unattended**, 15s after close, with no one watching.
- **The door verified whoever signed**, then re-read the ledger to confirm that
  address still held a ticket. The account that signed was not the one we
  expected, and it was admitted correctly on its own ticket — which is the rule
  working, not a hole: a signature proves WHO, the ledger check proves WHAT.

### Two traps found by running it

- **`DOTENV_CONFIG_PATH` did not point scripts at the mainnet database.**
  `@prisma/client` loads a `.env` of its own at import time, and ESM evaluates
  imports in source order, so Prisma's `DATABASE_URL` won before `env.ts` ran.
  `payload:report` printed a MAINNET header while querying the DEV database and
  reported zero payloads immediately after sixteen were created. Fixed by
  importing `env.js` first in `src/prisma.ts`, pinned by
  `tests/prisma-import-order.test.ts`.
- **A 10-minute auction is tight** when each signature needs an account switch
  in Xaman. The minimum is 5 and the default is 60; prefer the default unless
  someone is standing by.

---

## Measured mainnet costs

Read from `wss://xrplcluster.com` at ledger 106,229,687:

| | |
| --- | --- |
| Base reserve | **1 XRP** per account |
| Owner reserve | **0.2 XRP** per owned object |
| Base fee | **0.00001 XRP** (10 drops) |

An owned object is an NFT page (one per 32 tickets), an open offer, a trust
line. So a holder with one live bid is holding 1.2 XRP they cannot spend, and
`spendableDrops` already accounts for this — see `spendableFrom`.

**Budget, for a 20-ticket event across three wallets:**

| Account | Needs | Why |
| --- | --- | --- |
| Broker | ~2 XRP | 1 base, plus fees for every settlement it signs |
| Organizer | ~3 XRP | 1 base, 0.2 for the NFT page, fees for 20 mints |
| Attendee | ~3 XRP + ticket price | 1 base, 0.2 per open bid |

**Call it 15 XRP** to run the whole thing without thinking about it. Most is
reserve, which is not spent — it is locked while the accounts exist.

The transaction fees are genuinely negligible: 20 mints at 10 drops is
0.0002 XRP. **The reserve is the cost, not the fees.**

---

## Preconditions

Do not start until every box is ticked. Each one is a thing that, missing, ends
the rehearsal partway with real money already committed.

- [ ] **A separate mainnet database.** Not the testnet one. The `network` column
      makes mixing survivable rather than safe, and read-only list endpoints are
      not scoped — see CLAUDE.md. One database per network.
- [ ] **A mainnet broker account, created by hand and funded.**
      `npm run platform:setup` **refuses mainnet on purpose**
      (`setup-platform-account.ts:31`): an account with real money behind it
      should be a deliberate act, not something a script conjures. Create it,
      fund it, and put the seed in a real secret manager.
- [ ] **`XAMAN_WEBHOOK_SECRET` either registered in the Xaman console or unset.**
      Set-but-unregistered is the worst of both worlds — throttled polling and no
      push.
- [ ] **Xaman quota confirmed in writing.** 20 mints plus sign-ins plus
      check-ins is 40–60 payloads. If the application limit is unknown, you may
      run out halfway through, and no code change fixes that.
- [ ] **A second wallet that is not the issuer.** A royalty split cannot be
      exercised when one side minted the ticket — XRPL skips `TransferFee`
      entirely when the issuer is party to the trade. Two wallets are not enough
      if one of them is yours as organizer.
- [ ] **A phone with Xaman, on mainnet**, and the wallet funded on mainnet.

---

## The sequence

### 0. Take the "before" reading

```sh
npm run payload:report                    # against the MAINNET database
npm run payload:report -- --all-signers
```

Expect zeros on a fresh database. **Record them anyway.** A before-reading you
did not take is a difference you cannot compute, and "it was zero, obviously" is
how people end up guessing.

### 1. Confirm what is actually running

```sh
curl -s https://<host>/api/health | jq -r '.commit, .network, .db'
```

`network` must say `mainnet`. That field exists precisely so this question is
answerable from outside the process, and it is pinned by a test that fails if it
is ever hardcoded.

**If it says testnet, stop.** Everything after this point spends real money on
the assumption that field is true.

### 2. Create the event

Through `POST /api/events` as an organizer, or:

```sh
npm run event:create -- --organizer <handle> --title "<title>" --tickets 20
```

Note `platformBps` is set **by the server**, not by the organizer, and is frozen
onto each Listing at creation.

### 3. Mint — and pay attention to yourself

Twenty `NFTokenMint` transactions, twenty Xaman payloads, twenty taps on your
phone. The organizer is the issuer because `TransferFee` pays the issuer, and
Hubworld cannot sign as anyone.

**This is the point of the rehearsal, not an obstacle to it.** Time it. Notice
where it stops being tolerable. That number is what tells you whether the
low-hundreds ceiling is a real constraint on a real customer or a theoretical
one, and it is the single most useful thing you will learn today.

Watch for: a poll that never returns (`MintRequest` survives that gap by design
— the `NFTokenID` does not exist until the transaction is validated), and any
429 from Xaman.

### 4. Sell one ticket to the second wallet

The three-signature brokered path — seller offer, buyer bid, broker accept.

**Verify the split on-ledger, not in our database.** This is the arithmetic that
surprised us once: the royalty is charged on the bid *minus the broker fee*, not
on the headline price. On testnet a 15 XRP sale paid the issuer 0.73125 rather
than 0.75, because 5% was taken of 14.625.

Record: what the seller received, what the issuer received, what the broker took,
and the fee the broker paid to submit.

### 5. Open an auction and settle it

Requires the event to be genuinely sold out — every ticket issued **and** none
still held by the organizer. Both halves are enforced (`auction-policy.ts`), and
derived from counted facts rather than `Event.status`.

The sell offer sits **below** the reserve by the fee-at-reserve, because
`buy >= sell + brokerFee` bites otherwise. Let the sweep settle it rather than
forcing it — the 15-second cadence is part of what you are testing.

### 6. Check someone in at the door

On a phone, at whatever passes for a venue. The attendee signs; the verdict
appears on the **staff** device. If the ledger is unreachable the cached claim is
accepted rather than turning away a real person — see whether that ever fires.

### 7. Take the "after" reading

```sh
npm run payload:report
npm run payload:report -- --all-signers
```

**This difference is the deliverable.** Not the tickets, not the sale — the
number of payloads a real event consumed, broken down by what spent them.

---

## What to record

Write these down as you go. The temptation is to reconstruct afterwards, and
afterwards you will not remember which of the three sales had the odd fee.

- Payloads created, signed, and wasted — by flow
- Payloads per attendee, end to end
- Seller / issuer / broker amounts for every sale, from the ledger
- Wall-clock time to mint 20 tickets, and where boredom set in
- Every failure, including the ones you worked around without thinking

---

## When it goes wrong

It will, somewhere. That is the purpose.

- **`tecINSUFFICIENT_FUNDS` is NOT terminal.** Observed for real on testnet: a
  100 XRP sale failed because the buyer was broke, was marked `FAILED`, and both
  offers stayed live on-ledger. The buyer was later funded, so a settleable sale
  sat written off in our database while remaining matchable on the ledger.
  Settlement retries or re-opens; `ledger:sync` reports it as
  `failed-but-retryable`.
- **A losing bid is inert, not lost.** `Destination` = broker means nobody else
  can execute it. Cleanup is cosmetic; an uncancelled offer holds 0.2 XRP of the
  bidder's reserve and can do nothing else.
- **Reconcile before concluding anything.**
  ```sh
  npm run ledger:sync              # dry run, ALWAYS first
  npm run ledger:sync -- --apply   # only after reading the dry run
  ```
  It is dry by default because a reconciler that silently rewrites ownership is
  worse than the drift it corrects. **It is scoped to `NETWORK`** — pointed at
  the wrong one it would see every ticket as held by nobody.
- **Xaman quota exhausted** answers 503 with a specific message. No code change
  fixes it; it needs a higher limit or fresh credentials.

### Abort conditions

Stop and reassess rather than pushing through:

- `/api/health` reports a `network` you did not expect
- The broker account runs dry — every sale platform-wide is serialised behind its
  single sequence, so it halts everything, not just yours
- Two sales in a row settle with arithmetic you cannot explain
- Xaman starts returning 429 during minting

Nothing here is unrecoverable as long as you stop. The ledger is the source of
truth, `ledger:sync` will tell you what it actually says, and no ticket can move
without somebody signing for it.

---

## After

Update `CLAUDE.md` so the measured figures are mainnet ones, and mark
`ROADMAP.md` §1 done — with the numbers, not with "done".

Then the grant application can say what a ticket costs to issue, what an attendee
costs to serve, and what settlement pays each party, in real money, observed.
