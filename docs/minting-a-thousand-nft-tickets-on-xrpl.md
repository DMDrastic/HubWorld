# What we measured trying to mint 1,000 NFT tickets on XRPL

*Measured 2 August 2026 against XRPL testnet and devnet — rippled 3.3.0-rc5, xrpl.js 5.0.0. Mainnet was on 3.2.1. Every figure below was observed, not derived from documentation.*

---

We build event ticketing on the XRP Ledger. Tickets are NFTokens held in the attendee's own wallet, resale is settled in brokered mode, and the organizer is the NFT issuer so the native `TransferFee` pays them their royalty automatically.

That last decision has a consequence that caps the whole product.

## The constraint

`NFTokenMint` mints one NFT per transaction, and **the organizer has to sign every one** — because `TransferFee` pays the *issuer*, and the issuer must be the organizer for the royalty model to work at all.

A thousand tickets is a thousand signatures on somebody's phone. That is not a UX problem to design around; it's a wall.

The constraint is a triangle, and only two corners are available at once:

1. **The organizer is the issuer** — required for royalties.
2. **The platform signs as nobody** — the load-bearing trust claim.
3. **Unattended bulk minting.**

We had (1) + (2), which caps events in the low hundreds. This is what we learned trying to get (3) without giving up the others.

---

## Attempt 1: Multi-Purpose Tokens

MPTs (XLS-33, activated as `MPTokensV1` in October 2025) look like the obvious answer. One `MPTokenIssuance` covers an entire supply, and the issuance carries a `TransferFee` — so the royalty should survive.

**It doesn't. The `TransferFee` on an MPT is charged in tokens, not in XRP.**

With a 5% fee, sending 100 units:

```
sender:    200 → 95     (lost 105)
recipient:   0 → 100
issuer:      unchanged  (the 5 left circulation)
```

The reason is structural. An NFT's `TransferFee` applies to the **sale amount**, because `NFTokenAcceptOffer` knows the price. An MPT `Payment` carries no price, so there is nothing to take a percentage *of* except the tokens themselves. An organizer's "royalty" on an MPT resale arrives as **fractions of a ticket**, which is not revenue.

This is the finding we most want other builders to have, because "MPTokenIssuance carries a TransferFee, so royalties work" is an easy and wrong inference. We had it written down as fact in our own docs.

Three more measurements:

**There is no atomic swap.** No MPT equivalent of `NFTokenAcceptOffer` + `NFTokenBrokerFee`. A `Payment` moves the ticket one way with nothing coming back, so there is no spread for a broker fee.

**The DEX is not an escape hatch.** `OfferCreate` does not accept an MPT amount — in xrpl.js, `Amount` is `IssuedCurrencyAmount | string` and excludes `MPTAmount`. Submitting one anyway returns **`temDISABLED`**, even with `tfMPTCanTrade` set on the issuance.

**Holders must opt in, and the issuer cannot do it for them.** On the most permissive issuance possible — no `tfMPTRequireAuth` — a `Payment` to a holder who has not authorised returns **`tecNO_AUTH`**. An `MPTokenAuthorize` submitted by the issuer on the holder's behalf also returns `tecNO_AUTH`. So every buyer signs twice: once to opt in, once to pay.

**And the headline benefit is narrower than it appears.** One signature creates the *supply*, but the units sit in the issuer's account. Getting one to a buyer is a `Payment` signed by whoever holds them — so 3,000 buyers is still 3,000 issuer signatures unless the whole supply is consigned to a distributor, which means the platform holds the inventory.

Everything MPT breaks is secondary-market machinery. Everything it fixes is primary issuance. For general admission with no resale, that's a reasonable trade. For us it was not.

---

## Attempt 2: scoped permission delegation

`PermissionDelegationV1_1` lets an account authorise another to submit **specific transaction types** on its behalf. Unlike `RegularKey` — which is unscoped, and would also hand over the ability to send payments — this can be narrowed to exactly one thing.

The organizer signs one `DelegateSet`:

```json
{
  "TransactionType": "DelegateSet",
  "Account": "<organizer>",
  "Authorize": "<platform>",
  "Permissions": [{ "Permission": { "PermissionValue": "NFTokenMint" } }]
}
```

The platform then mints with `Account` = organizer, `Delegate` = platform, signed with the platform's own key.

**The question that decides everything: who is the issuer?**

```
Issuer     : <the organizer's address>
TransferFee: 5000 (5%)
NFTs in the platform's account: 0
```

**The organizer.** The royalty model survives completely, and the NFT lands in their wallet, not ours.

The scope is enforced by the ledger, not by our good behaviour. The platform attempting a `Payment` from the organizer's account:

```
terNO_DELEGATE_PERMISSION
```

Revocation is one transaction with an empty `Permissions` array, and takes effect immediately — the next delegated mint is refused with the same code.

### Two things that will bite you

**1. The `Sequence` belongs to the delegator; the fee to the delegate.**

`Sequence` always belongs to `Account`, and on a delegated mint `Account` is the organizer. So the **organizer's** sequence advances while the **platform** signs it and pays the fee. That split is unusual and easy to get backwards.

Getting it wrong does not fail cleanly. Our first bulk implementation used the delegate's sequence and *appeared to work at 100 tickets* — purely because two freshly funded devnet accounts happened to start at the same sequence number. Once the organizer signed the grant, the two diverged and the next run minted **zero**, with `terPRE_SEQ` on every submission. It looked like a network problem.

**2. Never infer success from the sequence advancing.**

A `tec` result **consumes the sequence and the fee** while changing nothing. Our first attempt fired all 1,000 mints at once and reported success; 962 came back `terPRE_SEQ`, rippled holds only a small number of future-sequence transactions per account and dropped the rest, and the tail outlived its `LastLedgerSequence`.

**402 of 1,000 tickets existed. The other 598 silently did not.** An event quietly short by 60% is the worst failure a ticketing product can have.

The working shape is to submit a wave, **wait for the sequence to actually advance**, then send the next — the sequence only moves when a transaction is really applied. `LastLedgerSequence` must be bounded per wave rather than once for the whole run, and a stalled wave must resume from where the ledger actually got to, because **one dropped transaction blocks every later sequence on that account permanently**.

### Results

| Tickets | Wall time | Rate | Organizer signatures | Reserve locked |
| --- | --- | --- | --- | --- |
| 100 | 13.3s | 7.5/s | **1** | ~0.8 XRP |
| 250 | 37.8s | 6.6/s | **1** | ~1.8 XRP |
| 500 | 51.1s | 9.8/s | **1** | ~4.6 XRP |
| **1000** | **67.1s** | **14.9/s** | **1** | ~8.0 XRP |

Throughput *improves* with scale. NFTs pack into `NFTokenPage`s at up to 32 each, so 1,000 tickets costs the organizer roughly 8 XRP of reserve rather than 200.

There is also a quota benefit worth naming: minting no longer touches the wallet-signing provider at all, because the platform signs directly. For us that removed our single largest consumer of a third-party payload quota.

---

## Selling is a separate problem, with two more walls

Minting a thousand tickets is half a product. Tickets nobody can buy are not tickets.

**Wall 1: unattended selling needs a second, far more dangerous permission.**

`NFTokenMint` distributes nothing. Listing requires `NFTokenCreateOffer`, which **can** be delegated — but the two permissions are not equally safe:

- Minting can only ever create value for the organizer.
- **Offer creation lets the delegate give the organizer's tickets away.** We measured it: a zero-price offer from the organizer's account to the delegate returns `tesSUCCESS`.

Money stays protected either way — a `Payment` is still refused. Inventory does not. So "the platform can mint tickets as you and nothing else" becomes "the platform can mint your tickets and also hand them to anyone" the moment unattended selling is wanted. That is a materially different thing to ask someone to agree to, and we think it should be a separate, time-boxed, plainly-worded grant rather than bundled into setup.

**Wall 2: an open sell offer costs owner reserve.**

Every open `NFTokenOffer` is an owned object costing **0.2 XRP of reserve on the seller**. Listing 1,000 tickets simultaneously locks about **200 XRP**.

On a 100 XRP account, offers began failing with **`tecINSUFFICIENT_RESERVE`** after ~490 — matching the predicted ceiling of `(100 − 1) / 0.2 ≈ 495`. In a full run, only 453 of 1,000 offers existed, and 453 tickets sold. Silently, again, for the same `tec` reason.

**The design consequence:** don't list an event up front. Create the sell offer lazily at checkout, so reserve is only ever held for offers actually open — which also matches how tickets really sell. Or put the reserve on the buyer via buy offers: 0.2 XRP each for one object, rather than 200 XRP on the organizer for a thousand.

---

## The alternative that works on mainnet today

`NFTokenMinter` — an `AccountSet` field that has existed since the original NFT amendment — authorises another account to mint NFTs whose **issuer** is you. We tested it on **testnet**, deliberately, because that means it works on mainnet now.

It works. `Issuer` is the organizer, `TransferFee` intact, and the permission is *narrower* than delegation: the minter attempting a `Payment` as the organizer, or a mint with `Account` = organizer, both fail `tefBAD_AUTH`. `ClearFlag` revokes cleanly.

**The price: the minted ticket lands in the minter's account, not the issuer's.** So the platform holds the unsold inventory, and since the seller receives the proceeds, the platform receives the primary sale money too. That is a custody model — the merchant-of-record position many designs exist specifically to avoid.

Worth noting the asymmetry, because it cuts against the obvious reading: under `NFTokenMinter` the platform holds tickets **it minted itself**; under offer-delegation the platform can take tickets **out of the organizer's wallet**. Per permission, `NFTokenMinter` is the safer grant. It is the resulting custody, not the permission, that is the objection.

---

## Where the amendment actually stands

`PermissionDelegationV1_1`, amendment id:

```
0F48FF561C709540328F31F1C97FD512ACC8B4E42138A161CB0E21ECA292540B
```

| Network | rippled | Status |
| --- | --- | --- |
| Devnet | 3.3.0-rc5 | **active** |
| Testnet | 3.3.0-rc5 | not enabled, no majority |
| **Mainnet** | **3.2.1** | **not enabled, and zero amendments have majority support** |

Amendments activate by validator vote — 80% held continuously for two weeks — and one that crosses that line appears in the ledger's `Amendments` object under `Majorities` with the time it got there. That's roughly a fortnight of warning, and it is the event worth watching for.

Mainnet also runs an older rippled than testnet or devnet, and validators cannot vote for what their software does not implement, so a release has to land before voting can even begin.

You can check this yourself without admin access — the `feature` command is admin-only on public servers, but the `Amendments` ledger object is public and amendment ids are identical across networks:

```
ledger_entry index=7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4
```

Read the ids from `feature` on devnet, then look for them on mainnet.

---

## Takeaways

1. **MPT `TransferFee` is charged in tokens, not the sale currency.** If your model depends on a royalty in money, MPTs do not carry it.
2. **On a delegated transaction the sequence belongs to the delegator and the fee to the delegate.** Assume the opposite and you will mint nothing while thinking you minted everything.
3. **`tec` consumes the sequence and the fee.** An advancing sequence proves *inclusion*, never *success*. Check engine results.
4. **Open offers cost reserve.** You cannot list a large inventory at once; create offers at the point of sale.
5. **Delegating `NFTokenCreateOffer` is a much bigger trust ask than delegating `NFTokenMint`.** Treat them as different decisions.
6. **Amendment availability differs sharply across networks.** Devnet activation tells you nothing about when you can ship.

All of this is testnet and devnet. Nothing here has run on mainnet with real money, and we'd treat every number as provisional until it has.

---

*Reproduction scripts for each measurement are in our repository under `backend/scripts/` — `delegation-spike.ts`, `delegation-scale-spike.ts`, `full-event-sim.ts`, `authorized-minter-spike.ts`, `mpt-spike.ts`, `mpt-fee-spike.ts`, `mpt-optin-spike.ts` and `mpt-amendment-check.ts`. They are dev-only, imported by nothing, and run against faucet-funded throwaway wallets.*
