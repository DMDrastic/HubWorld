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
6. **Processing rates are per event region:** Caribbean 3.7% (2.9% + 0.8% international) + C$0.30; Canada 2.9% + C$0.30; +2% only
   if currency conversion is needed (off by default: USD settles to a USD payout account). The C$0.30 is converted to US cents at
   `cadToUsd` and rounded up. **The default rate (0.75) is a conservative placeholder, not a measurement, and must be replaced.**
   The total is grossed up so HubWorld nets exactly price + fee, and the processor's cut is rounded up so we cannot lose money.

**Open, for the account owner (not code):** confirm in the Stripe dashboard or with Stripe support that the Canadian account can pay out
USD to a USD bank account. It is the difference between 3.7% and 5.7% processing on every Caribbean ticket.

## 8. Rollout

New listings use the new terms only when `FEE_MODEL=v2` is set; the default stays today's behaviour, so merging changes nothing in
production until the switch is turned on. Existing active listings stay on their frozen buyer-pays terms (`feeModel = BUYER_PAYS_V1`).
