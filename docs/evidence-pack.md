# HubWorld: evidence pack

Source material for grant applications and pitch material. **Every figure here
was measured, and the section that says what does not work is as complete as the
section that says what does.** A reviewer who checks these numbers should find
them; a reviewer who finds an unstated limitation later should not.

Written 2026-08-22. Ledger figures are mainnet unless a line says otherwise.

---

## 1. What it is

NFT event ticketing on the XRP Ledger. Tickets are XRPL NFTokens held in the
attendee's own wallet. Organizers mint, sell, and take a royalty on resale;
HubWorld brokers settlement and takes a platform fee from the spread.

**The load-bearing constraint is that HubWorld never holds a user's key.** Xaman
signs everything that moves someone else's ticket or money, on their own device.
The single key HubWorld holds is its own broker account, which exists only to
sign the brokered `NFTokenAcceptOffer` that settles a sale. It cannot move
anyone's ticket on its own, and sale funds never rest with us.

---

## 2. It works on mainnet, with real money

A complete event ran on XRPL mainnet on **2026-08-13**: three tickets, four
accounts, every money path exercised. All hashes are publicly verifiable at
`livenet.xrpl.org/transactions/<hash>`.

| What it proves | Transaction |
| --- | --- |
| Mint (organizer is the issuer) | `40827533479616ED8BF0D6915548A070691DD932C14DFE8BC83E83D6ADAE1B57` |
| Mint | `11D5E4AE94FC2D49ED9DF7991DF6AE369E727F7411A4C1D9D0EE0E29CCE0D6A7` |
| Mint | `B77D50A64848ECFB37FDFF088CCFDA0EBD84C797D9E5D7B43B4EC28D841C1BCE` |
| Brokered fixed-price sale | `A4D09638BBFCC7D2E1E0735C1A86BD1EC66F63D6FC8E9CBF479D44C6DDB556E3` |
| Gift, accepted by recipient | `FFC488E6C33F545EC0992B6D60762C4D8658CB5D11F78E57D546DF7818FD4C08` |
| Brokered sale (event now sold out) | `91139AD7FA5D9C3F5FF45369EF938B37158ACD6262EDFD6ADC8FCFDCC0B878AA` |
| **Auction settled — three-way split in one atomic transaction** | `E46DF91F1FCA8B3E30830C59E2FC015B9B05F5BD99DA16E25AE60F74627C9236` |

Issuer/organizer `r4wQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf`,
broker `rp6hU3DAfsgCVD9Jt6r8P4fAFDKzGaS1TD`.

Plus a door check-in: admission proved by a Xaman signature, with the verdict
shown on the staff device rather than the attendee's, and the ledger re-read to
confirm the signer still holds a ticket.

---

## 3. The economics, measured rather than modelled

### The auction settlement, on a 1 XRP winning bid

| Party | Change |
| --- | --- |
| Winning bidder | **−1.000000** |
| Seller | **+0.926250** |
| Issuer (royalty) | **+0.048750** |
| Broker (platform fee) | **+0.024988** |

Reconciles to 0.999988; the missing 12 drops is the broker's own transaction fee.

**The finding worth publishing: the royalty is charged on the bid MINUS the
broker fee.** 5% of 1.0 would be 0.050000. The issuer received 0.048750, which
is 5% of 0.975. **So a nominal 5% royalty pays 4.875% in practice at a 250 bps
platform fee.** We have not found this documented anywhere.

**A primary sale by the organizer keeps 100%** — XRPL skips `TransferFee`
entirely when the issuer is party to the trade, so the royalty appears only on a
genuine secondary trade. Measured on the same day: seller received the full
1.000000.

**A sell offer is a floor, not a price.** The auction's offer was 0.487500 and
the seller received 0.926250 — surplus goes to the seller, which is what lets an
organizer commit one signature at auction open and never sign again.

### Ledger costs

| | |
| --- | --- |
| Transaction fee, every type observed | **12 drops** (0.000012 XRP) |
| Base reserve | 1 XRP per account |
| Owner reserve | 0.2 XRP per owned object |
| **NFT owner reserve** | **0.2 XRP per PAGE, not per ticket** — a page holds 32, so a 32-ticket event locks 0.2 XRP total, not 6.4 |

### Wallet-interaction cost

Payloads are the real constraint on event size, not ledger cost. Measured
end-to-end across the mainnet event: **16 created, 15 signed, 1 wasted** (a
sign-in that expired unscanned).

Per-flow: `signin 4 · mint 3 · listing_create 2 · listing_buy 2 ·
door_checkin 1 · gift_offer 1 · gift_accept 1 · auction_open 1 · auction_bid 1`.

That was ~3 payloads per ticket sold. Since shipping `NFTokenMintOffer`
(mint-and-list in one signature) it is **~2 per ticket sold, plus ~2 per
attendee**.

---

## 4. Original research on XRPL primitives

Eight spikes, each answering a question with an observation rather than an
assumption. All are in the public repository and reproducible.

### Scoped delegation (`PermissionDelegationV1_1`, devnet)

- An organizer can `DelegateSet` **only** `NFTokenMint` to HubWorld. HubWorld
  then mints with `Account` = organizer, and **the resulting NFT's `Issuer` is
  the ORGANIZER, with `TransferFee` intact — the royalty model survives.**
- A `Payment` attempted by the delegate is refused with
  `terNO_DELEGATE_PERMISSION`, so it is genuinely scoped, unlike `RegularKey`.
- **1,000 tickets minted in 67 seconds on ONE organizer signature.**
- **But fire-and-forget silently loses most of them.** rippled holds only a small
  number of future-sequence transactions per account: at 1,000, **402 existed and
  598 did not**, the tail outliving its `LastLedgerSequence`. An event quietly
  short by 60% is the worst failure a ticketing product can have. The working
  shape is waves of 10 that wait for the sequence to actually advance, sustaining
  7–17/s.
- **The sequence belongs to the delegator, the fee to the delegate.** An earlier
  run used the delegate's sequence and appeared to work at 100 purely because two
  freshly funded accounts started at the same number; once they diverged the next
  run produced **zero** tickets, `terPRE_SEQ` on every submission.

### Where delegated distribution stops

Minting is not distributing. Selling unattended needs `NFTokenCreateOffer`
delegated too, and the two permissions are not equally safe:

- **Measured: a zero-price offer from the organizer's account to the delegate
  returns `tesSUCCESS`.** So "HubWorld can mint tickets as you and nothing else"
  becomes "HubWorld can mint your tickets and also give them away."
- **1,000 open sell offers lock ~200 XRP of owner reserve.** Measured:
  `tecINSUFFICIENT_RESERVE` after ~490 offers on a 100 XRP account; only 453 of
  1,000 existed.

Money stays protected either way — a `Payment` is still refused. **Inventory is
not.** That is a product decision, not a bug, and it is why unattended selling is
not shipped.

### Multi-Purpose Tokens (`MPTokensV1`, testnet)

MPT is the obvious answer to the minting ceiling. It does not survive contact.

- **3,000 tickets created in ONE organizer signature** — the bottleneck genuinely
  removed.
- **But the royalty does not survive.** `MPTokenIssuance` carries a
  `TransferFee`, and it is charged **in tokens, not XRP**. Measured: with a 5%
  fee, sending 100 units cost the sender 105 and delivered 100; the 5 never
  reached the issuer and left circulation. An organizer's "royalty" would be paid
  in fractions of a ticket.
- **There is no atomic swap.** `NFTokenAcceptOffer` with `NFTokenBrokerFee` has
  no MPT equivalent, so there is no spread a broker fee could come from.
- **The DEX is not an escape hatch.** `OfferCreate` does not accept an MPT
  amount; submitting one returns **`temDISABLED`** even with `tfMPTCanTrade` set.
- **Every attendee costs an extra signature** — `MPTokenAuthorize` is required
  before a holder can receive units.

### Stablecoin pricing (testnet)

A full brokered sale denominated in an issued currency works, with every leg
intact:

| | before | after |
| --- | --- | --- |
| buyer | 1000 | **895** (paid 105) |
| broker (platform fee) | 0 | **5** |
| organizer (royalty) | 0 | **5** |
| seller | 0 | **95** |

### Amendment status, checked directly against mainnet (2026-08-13)

| Amendment | Mainnet |
| --- | --- |
| `DynamicNFT` (mutable URIs) | **enabled** |
| `NFTokenMintOffer` (mint + list in one tx) | **enabled** |
| `PermissionDelegation` | not enabled |
| `Batch` | not enabled |

Both enabled amendments are now used in production code.

---

## 5. Engineering evidence

- **380 backend tests** across 39 files, **120 frontend tests** across 15, plus a
  Playwright suite for what jsdom structurally cannot answer.
- **Mutation testing** (Stryker) with a ratchet threshold, because a test that
  cannot fail is documentation. It earned its place on the first run by finding a
  policy module with 78 mutants and no real coverage.
- **CI on every PR**, and a `commit` field on `/api/health` so "which build is
  live?" is one request.
- **~21,000 words of decision documentation** (`CLAUDE.md`, `ROADMAP.md`)
  recording not just what was built but what would be a mistake.

---

## 6. What does not work yet — stated plainly

**No users.** The mainnet event used four accounts we control. Zero organizers,
zero attendees, zero revenue.

**Production runs testnet.** The live deployment is a demonstration.

**Wallet trust blocks self-serve onboarding.** Xaman flags tickets from unknown
issuers. Because `TransferFee` pays the issuer, every organizer must be their own
issuer, so each arrives as an account no wallet has seen. Xaman whitelisted our
issuing account on request, but if that is the only route then onboarding
contains a manual third-party step with ~24h lead time — survivable for a handful
of organizers, not for a self-serve product. Open with Xaman: whether a
**platform** can be registered rather than clearing accounts one at a time.

**Event size is in the tens to low hundreds today.** The organizer is the issuer
and must sign each mint. Scoped delegation would lift this and is measured to
work — but it is not active on mainnet.

**One vendor.** Auth, minting, resale, bidding and the door all route through
Xaman. There are no paid tiers, so there is no contract and no SLA, and limits
are set at their discretion. The mitigation is architectural rather than
commercial: the signing seam is deliberately abstracted so a second signer
remains possible.

---

## 7. What the research is worth to the ecosystem

Independent of HubWorld as a product, these are findings any XRPL NFT project
would benefit from and none of which we found documented:

1. Royalty is charged on the amount **after** the broker fee, so an organizer's
   effective rate is below their nominal one.
2. `TransferFee` is skipped entirely when the issuer is party to the trade.
3. NFT owner reserve is per **page** of 32, not per token.
4. MPT `TransferFee` is charged in tokens, which silently breaks any royalty
   model ported from NFTs.
5. Delegated bulk minting must follow the delegator's sequence, and
   fire-and-forget loses most of a large run without erroring.
6. Delegating offer creation lets the delegate give the delegator's tokens away.
7. Any platform where the merchant must be the issuer generates a new unknown
   issuing account per merchant, which wallets flag as suspicious.

A 2,189-word write-up of the first tranche exists at
`docs/minting-a-thousand-nft-tickets-on-xrpl.md`, unpublished.
