# Fee model: configuration and test plan

**Status: APPROVED 2026-10-31. `src/fees.ts` is implemented and tested (pure, not yet wired to any flow).** Schema, wiring
and the integration tests follow in separate PRs. Written from the confirmed fee decision and a read of the current code.

## 1. What the confirmed decision says

| Line | Amount | Who pays | How it is collected |
|---|---|---|---|
| Fan fee, first-time sale | **$1.25 + 3.5%** of the ticket price (2027 founding promo: **$1 + 3%**) | The buyer, inside the all-in price shown | Inside the card charge; HubWorld keeps it, the organizer receives the full ticket price |
| Resale fee | **5%** of the resale price | The **seller** (deducted) | By the broker, on the ledger |
| Organizer royalty | Organizer's choice, 5% default, 20% max | The ledger pays the organizer | Unchanged; it is not HubWorld revenue |
| Organizers on first-time sales | **Nothing** | | |

It replaces today's single `PLATFORM_FEE_BPS` default of 2.5%.

## 2. How the code works today (facts)

- One number drives everything: `Event.platformBps` (copied from `PLATFORM_FEE_BPS`, default 250), turned into
  drops by `platformFeeDrops(price, bps)` (floored, BigInt) and **frozen on each `Listing.platformFeeDrops`**.
- **The buyer pays the fee on top** for fixed-price sales: the bid is `price + fee`, the sell offer is `price`, and
  the broker's fee equals `fee` (`listings.ts`, `listing-advance.ts`, `primary-sale.ts`: `owed = price + fee`).
  The ledger needs `buy >= sell + brokerFee`.
- **Auctions are already seller-pays:** the sell offer sits at `reserve - fee` and the winning bid is whatever it is
  (`auctionSellAmountDrops`, `open-auction.ts`).
- The resale cap compares against `ask + fee` (`maxAskForCap`), because the buyer pays both.
- The royalty is charged by the ledger on **the bid minus the broker fee**.
- The fee appears in: `env.ts`, `ledger.ts`, `primary-sale.ts`, `listings.ts`, `listing-advance.ts`, `open-auction.ts`,
  `settlement.ts`, `resale-policy.ts`, `routes/mint.ts` (mint-with-offer), `routes/events.ts`, `routes/tickets.ts`,
  `routes/organizers.ts` (`/policy`), plus 14 scripts and 30+ tests.

## 3. What the testnet run measured (2026-10-31, Privy wallets, XRP)

A seller-pays resale is settled by listing at `price - fee`, bidding exactly `price`, and setting the broker fee to `fee`
(the ledger's `buy >= sell + brokerFee` holds with equality). Measured, price 10, fee 0.5, royalty 5%:

| Party | Result | Expected |
|---|---|---|
| Buyer | paid 10.000 (+12 drops network fee) | exactly the displayed price |
| Broker | +0.499988 | the fee |
| Organizer | **+0.475** | 5% of (price - fee) |
| Seller | +9.024988 | price - fee - royalty |

It ran **after a free issuer-to-holder hop** (the lazy-activation path), and the royalty still fired. So
"buyer pays what the page shows, seller nets the rest" works on the real ledger with no new mechanism.

## 4. Proposed design

### 4.1 One pure function owns every fee (`fees.ts`)
Nothing else computes a fee. Inputs are explicit, outputs are plain integers:

```
primaryFan({ price, currency, schedule, at })    -> { fee, allIn }          // buyer pays allIn
resaleFee({ price, schedule })                   -> { fee, sellOffer, buyerPays }   // sellOffer = price - fee
```

### 4.2 Configuration (versioned, one source)
```
FeeSchedule {
  version: 'v2'
  primary:  { fixedMinor, bps }                 // 125 (US cents), 350
  resale:   { bps }                             // 500
  promos:   [{ id, appliesTo: 'primary', from, to, fixedMinor, bps }]   // 2027 founding: 100, 300
}
```
Replaces `PLATFORM_FEE_BPS` with schedule values. The schedule in force is **snapshotted** onto the Event when it is
published and onto each Listing when it is created, so a later change never alters terms already shown.

### 4.3 Seller-pays for resale, with a compatibility switch
Add `Listing.feeModel` (`BUYER_PAYS_V1` | `SELLER_PAYS_V2`). Existing active listings stay V1 and settle exactly as
today; new ones are V2. Settlement and advancing branch on it. Auctions already match V2 and just take the 5%.

### 4.4 Face-value cap and Ontario
The cap is the **total original cost including fees**. Record `Ticket.originalCostMinor = price + fan fee` at the first
sale. With seller-pays, the buyer's total on resale **is** the price, so the cap check becomes `price <= originalCost`
and `maxAskForCap` simplifies (no fee term).

### 4.5 Where each line is collected
- **Card first-time sale:** the fan fee is in the card charge. No broker fee on the ledger, because the ticket moves by
  the free claim hop, not by a sale.
- **On-ledger first-time sale (crypto-native buyers, today's lazy checkout):** keeps its current shape (buyer pays
  `price + fee`, broker takes the fee). It uses the primary schedule.
- **Resale and auctions:** V2, 5%, seller-pays.

## 5. Edge cases the tests must pin
- Floor rounding never charges a buyer a unit more than the schedule says; a fee of zero and a price of one drop.
- Prices above 2^53 (BigInt); fee never exceeds the price; sell offer (`price - fee`) is at least one drop, so a resale
  below a minimum price is refused.
- Royalty plus resale fee never exceeds 100% (royalty is capped at 20%, fee is 5%).
- The royalty is on `price - fee`, so an organizer's effective rate is slightly under their nominal one (a 5% royalty
  with a 5% fee pays 4.75%). **Show the effective rate to organizers.**
- Promo windows: boundaries inclusive or exclusive as written, precedence when two promos overlap, expiry mid-checkout
  (the schedule is snapshotted at event publish and listing creation, so an expiry never changes a quote already given).
- A free ticket (price zero) pays **no** fan fee (proposed; see decisions).
- Rows created before this change keep their old terms.

## 6. Test plan (tests first; each mutation-checked)

**Pure (`fees.test.ts`)** table tests for primary and resale across prices and currencies; promo boundaries and
precedence; rounding; BigInt extremes; and a **conservation property over thousands of random prices and rates:**
`buyerPays = sellerNet + platformFee + royalty` exactly, in integer units.

**Integration (real Postgres, ledger mocked at the network edge)**
- A V2 listing stores the schedule snapshot; changing the schedule afterwards leaves existing listings unchanged.
- V1 listings settle to **golden values taken from today's tests** before any change is made.
- Resale, auction and on-ledger first-time sale each settle with the right broker fee and the right quote.
- The face-value cap uses `originalCostMinor`; resale above it is refused with the existing message.
- The all-in price the API returns equals what the card charge will use (one function, asserted equal).

**On the ledger:** the seller-pays arithmetic is already proven (section 3). Before mainnet, re-run it on devnet
through the shipped code, as `primary-sale-devnet-check.ts` does for checkout.

**Frontend:** every place a price is shown (event row, checkout, marketplace card, sell form) displays the all-in
price from the server; no client-side fee arithmetic.

**Mutation targets:** every branch of `fees.ts`, the `feeModel` switch in `listing-advance.ts` and `settlement.ts`,
and the cap comparison in `resale-policy.ts`.

## 7. Decisions (resolved 2026-10-31)

1. **Fixed $1.25 on an XRP-priced on-ledger sale:** left out. XRP-priced on-ledger sales charge only the 3.5%; RLUSD-priced
   and card sales charge the full $1.25 + 3.5%. The difference is deliberate and documented in `fees.ts`.
2. **Founding promo:** only organizers an admin flags as founding (the first ~10), for events starting **before 2028-01-01 00:00
   in the event's own time zone** (America/St_Lucia for St. Lucia events), not UTC. An 11 pm New Year's Eve St. Lucia fete is
   already 2028 in UTC and is still included; a 12:30 am 1 Jan event is not.
3. **Minimum resale price:** the equivalent of US$5 at listing time (the user's suggestion, not measured; adjust after the pilot).
   Below it resale is off and gifting/transfer stays. Rounded up in XRP.
4. **Free tickets and comps:** no fan fee; cost 0, so the resale cap is 0: they can be gifted or transferred, never resold for money.
5. **Card processing:** one all-in price on every screen, broken out on the receipt only. `Ticket.originalCostMinor` stores the full
   all-in amount paid, processing included, and is the resale cap.
6. **Processing rates are per event region:** Caribbean 3.7% (2.9% + 0.8% international); Canada 2.9%; +2% only if currency
   conversion is needed (off by default: USD settles to a USD payout account). The fixed part is **configured directly in the
   charge currency, 30 US cents**, the safe upper bound (it can only slightly over-collect processing). There is no exchange rate.
   All three numbers are unverified for our account and are replaced from the fee breakdown of a real test charge.
   The total is grossed up so HubWorld nets exactly price + fee, and the processor's cut is rounded up so we cannot lose money.

**Open, for the account owner (not code):**
1. Confirm the Canadian account can pay out US dollars to a US-dollar bank account (3.7% vs 5.7% processing on every Caribbean ticket).
2. Make one test charge in US dollars and read the payment's fee breakdown: the real percentage and fixed part. Update the three config numbers.

## 8. Rollout

New listings use the new terms only when `FEE_MODEL=v2` is set; the default stays today's behaviour, so merging changes nothing in
production until the switch is turned on. Existing active listings stay on their frozen buyer-pays terms (`feeModel = BUYER_PAYS_V1`).

## 9. The resale cap under the new model (decided 2026-11-01, built)

The effective cap is the **lower of** the organizer's policy and the all-in amount the buyer actually paid. DISABLED stays disabled.

- **Only new terms.** It applies when `FEE_MODEL=v2` AND the ticket has a recorded all-in amount. A ticket with no recorded amount (sold
  before it existed, or never sold), and everything while the model is off, keeps its organizer policy EXACTLY. Both are pinned by tests.
- **A ticket that cost nothing** (recorded amount 0) can never be resold for money under any policy; it can still be given away.
- **Same currency.** The cap is compared in drops, so a ticket bought in another currency must be resold in that currency; no exchange
  rate is guessed.
- **Organizer options.** Under v2 the policies that promise more than will happen (UNRESTRICTED, a percentage above 100%, a fixed cap
  above the ticket price) are hidden in the form and refused by the server for NEW events, and the default is face value only. The code
  paths and every existing event are untouched. `ALLOW_LOOSE_RESALE_POLICIES=true` turns them back on (default: on under v1, off under v2).
- **What people are told.** Organizers: "Resale is capped at what the buyer paid." Sellers: "Capped at what the buyer paid: list for up
  to X XRP" (or the organizer's wording when it is the policy that binds; a free ticket is told it can't be sold for money but can be given).

## 10. Wired behind `FEE_MODEL` (built 2026-11-01; default `v1` = today's behaviour)

With `FEE_MODEL=v2` (which also requires `XRP_USD_CENTS`, or the server refuses to boot), one function per question decides the money:

- **First sale** (`firstSaleQuote` in `listing-terms.ts`): the box-office checkout, a mint's own sell offer and the event page all ask it. The
  organizer is offered the full price; the buyer pays price + fan fee (3.5%, or 3% for a flagged founding organizer whose event starts before
  2028-01-01 in its own time zone). The listing records the rate (`feeBps`) and `isPrimarySale`; on completion the ticket records what the buyer
  paid (`originalCostMinor`), which is the resale cap.
- **Resale** (`resaleListingTerms`): refused below the US$5 floor; `SELLER_PAYS_V2`: the buyer pays exactly the price, the sell offer is price - 5%,
  the broker takes the 5%. Terms are frozen on the listing.
- **Auctions**: the 5% is frozen on the auction and its listing at opening; settlement reads the frozen rate.
- **Free tickets**: a ticket gifted before it was ever sold records cost 0 (can be given on, never sold for money). Sold tickets and tickets from
  before the amount existed are untouched.
- **Screens**: the server sends `primaryFeeDrops` / `primaryAllInDrops` on events and `feeModel` on listings; the event row, checkout dialog,
  marketplace card, a seller's own listing and the sold summary show them. No fee arithmetic in the browser.

**Not switched on anywhere.** Before it is: (1) re-run the seller-pays resale on devnet through the shipped code; (2) the free claim-offer variant
of `checkSellOffer` (destination = the named holder, amount 0) for lazy activation; (3) the card rail for the card-priced pieces (processing
gross-up and the card `originalCostMinor`), which remain pure functions in `fees.ts`. Existing listings and auctions keep their frozen terms.
