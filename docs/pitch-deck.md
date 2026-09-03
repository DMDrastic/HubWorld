# HubWorld — pitch deck content

Slide-by-slide copy to pour into a Canva template. **Content only; the design is
whatever Canva gives you.** Every figure here is measured and traceable to
`docs/evidence-pack.md`, so anything a reviewer checks will hold.

Written for **XRPL Commons Early Stage Grants**. Notes mark which slides to swap
for **GLOW**, which funds completed open-source work and does not ask about
traction.

---

## 1 — Title

**HubWorld**
NFT event ticketing on the XRP Ledger

*Tickets your attendees actually own. Royalties that pay the organizer on every
resale.*

`hubworld.app` · github.com/DMDrastic/HubWorld

> Speaker note: say in one sentence that it runs on mainnet today. Lead with
> that; it separates you from most of the room.

---

## 2 — The problem

**Ticketing is rented, not owned.**

- Attendees hold a barcode in someone else's app. Screenshot it and it's
  forwarded; lose the account and it's gone.
- **Organizers earn nothing on resale.** Scalpers capture the upside on exactly
  the events that sell out.
- Transfers happen off-platform, so nobody can prove who holds what at the door.

> Speaker note: this is the only slide with no measurement on it. Keep it to
> twenty seconds.

---

## 3 — What HubWorld does

**A ticket is an NFT in the attendee's own wallet.**

- **Organizers mint and sell.** They set a royalty and earn it automatically on
  every resale, enforced by the ledger.
- **HubWorld never holds a user's key.** Every transfer of a ticket or of money
  is signed by its owner on their own device.
- **Admission is a signature, not a screenshot.** A QR can be forwarded; a
  signature needs the attendee's key at that moment.

---

## 4 — It works, on mainnet, with real money

**A complete event ran on XRPL mainnet on 13 August 2026.**

Mint → gift → sale → auction → brokered settlement → royalty → door check-in.

Seven transactions, publicly verifiable:

`E46DF91F1FCA8B3E30830C59E2FC015B9B05F5BD99DA16E25AE60F74627C9236`
*(the auction settling — three-way split in one atomic transaction)*

> Speaker note: THE slide. Offer the hash and invite them to check it. Most
> applicants have a testnet demo; you have a ledger entry.

---

## 5 — Where the money goes

On a **1 XRP** winning bid, settled atomically in one transaction:

| | |
| --- | --- |
| Seller | **+0.926250** |
| Organizer (royalty) | **+0.048750** |
| HubWorld (platform fee) | **+0.024988** |
| Buyer | **−1.000000** |

**Funds never rest with HubWorld.** The ledger moves buyer → seller and
buyer → issuer in a single transaction; we sign it and take a fee from the
spread.

---

## 6 — What we measured that nobody had written down

- **The royalty is charged on the bid MINUS the broker fee.** A nominal 5% pays
  **4.875%** at a 250 bps platform fee.
- **`TransferFee` is skipped entirely when the issuer is party to the trade** — a
  primary sale by the organizer keeps 100%.
- **NFT owner reserve is per PAGE of 32, not per token** — a 32-ticket event
  locks 0.2 XRP, not 6.4.
- **MPT would remove the signing bottleneck and destroy the royalty**: its
  `TransferFee` is charged in tokens, not XRP.
- **Delegated bulk minting silently loses most of a large run** if submitted
  fire-and-forget: 402 of 1,000 landed.

> Speaker note: for GLOW, this becomes slides 4–6 and the product slides shrink.
> This is the ecosystem contribution.

---

## 6b — What already exists, and why this is different

**NFT ticketing is not an unproven idea.** GET Protocol processes over two
million tickets a year; GUTS, YellowHeart and others operate at festival scale.

What is unproven is doing it **natively on the XRP Ledger**:

- **The royalty is enforced by the ledger, not by a marketplace's goodwill.**
  `TransferFee` pays the issuer on any brokered sale. Elsewhere royalties are
  contract-enforced and can be routed around.
- **No smart contracts.** The entire settlement model is three native
  transaction types. Nothing to audit, nothing to upgrade, nothing to exploit.
- **No custody at any point** — including the attendee's ticket, which works
  whether or not HubWorld exists tomorrow.

> Speaker note: don't claim to beat GET Protocol. Claim to be the XRPL-native
> reference implementation, which is what an XRPL grant body is actually for.

---

## 7 — What we know doesn't work yet

- **No users.** The mainnet event used four accounts we control.
- **Production runs testnet.** The live site is a demonstration.
- **Onboarding isn't self-serve.** Because the royalty must pay the issuer, every
  organizer is their own issuer — so each arrives as an account wallets have
  never seen and flag until whitelisted.
- **Events cap out in the low hundreds**, because the organizer signs each mint.

> Speaker note: do not skip this. A reviewer who finds an unstated limitation
> later trusts nothing else on the deck. Said plainly, it reads as rigour.

---

## 8 — What would lift the ceiling

Three XRPL amendments are live on **devnet** and absent from **mainnet**:

- **`PermissionDelegationV1_1`** — an organizer delegates minting *only*, and the
  royalty survives. Measured: **1,000 mints in 67 seconds on one signature.**
- **`Sponsor`** — sponsored reserves would remove the requirement for an attendee
  to hold XRP before holding a ticket.
- **`BatchV1_1`** — eight transactions per signature. An 8× improvement, not a
  solution.

**The ceiling is the protocol's, not the product's.** We've built and measured
against all three on devnet.

---

## 9 — The ask

| | Deliverable | By | Cost |
| --- | --- | --- | --- |
| 1 | **Publish the research** — the findings above, written up for the ecosystem | Q4 2026 | *(fill)* |
| 2 | **A real event with a real organizer** — first non-synthetic use, venue and ticket float | Q1 2027 | *(fill)* |
| 3 | **Delegation readiness** — bulk-mint path built and tested on devnet, so the ceiling lifts the day it activates on mainnet | on activation | *(fill)* |

> Speaker note: cost YOUR line items even without knowing their budget — that is
> a different thing from guessing their ceiling. Blank reads as unconsidered;
> a costed plan reads as one you have thought through.

---

## 10 — Who

**Deandre Mendes**

- **Senior Java Developer, CIBC** — production software in a regulated bank.
- **XRPL Student Ambassador, Ripple (2023–2025)** — ran XRPL hackathons and
  taught blockchain development on campus.
- **Ran every transaction in this deck by hand**, on mainnet, with his own XRP.

> Speaker note: the ambassador role matters most here — you have been in this
> ecosystem for years, not since the grant round opened.

---

## Notes on using this

**Slide count is the point.** Ten slides. If Canva's template has twenty, delete
ten rather than filling them.

**Never put a number on a slide you can't source.** Every figure here traces to
`docs/evidence-pack.md`; if you change one, change it there too.

**For GLOW**, cut slides 2, 9 and 10 down to a line each and expand slide 6 into
three. GLOW funds work already done, not plans.

**Link the repository on every version.** It is the strongest thing you have and
it costs one line.
