# Minting 1,000 NFT tickets on XRPL: measurements and constraints

*Measured 2 August 2026 against XRPL testnet and devnet — rippled 3.3.0-rc5, xrpl.js 5.0.0. Mainnet was on 3.2.1. Every figure below was observed rather than derived from documentation.*

---

HubWorld is event ticketing on the XRP Ledger. Tickets are NFTokens held in the attendee's own wallet, resale settles in brokered mode, and the organizer is the NFT issuer so the native `TransferFee` pays the royalty automatically.

That last decision caps the product, and this document records what was measured trying to lift the cap.

## The constraint

`NFTokenMint` mints one NFT per transaction, and the organizer must sign every one — `TransferFee` pays the issuer, and the issuer must be the organizer for the royalty model to function.

A thousand tickets is therefore a thousand signatures on one person's phone. This is a structural limit rather than an interface problem.

The constraint forms a triangle, of which only two corners are simultaneously available:

1. The organizer is the issuer — required for royalties.
2. The platform signs as nobody — the load-bearing trust claim.
3. Unattended bulk minting.

Holding (1) and (2) caps events in the low hundreds. What follows is an assessment of the routes to (3).

---

## Approach 1: Multi-Purpose Tokens

MPTs (XLS-33, activated as `MPTokensV1` in October 2025) present as the obvious answer. A single `MPTokenIssuance` covers an entire supply, and the issuance carries a `TransferFee`, which suggests the royalty survives.

It does not. The `TransferFee` on an MPT is charged in tokens rather than in XRP.

With a 5% fee, sending 100 units:

```
sender:    200 → 95     (lost 105)
recipient:   0 → 100
issuer:      unchanged  (the 5 left circulation)
```

The behaviour is structural. An NFT's `TransferFee` applies to the sale amount, as `NFTokenAcceptOffer` carries the price. An MPT `Payment` carries no price, leaving no quantity to take a percentage of other than the tokens themselves.

Consequently, a `TransferFee` on an MPT issuance is settled in token units rather than in the sale currency. An issuer's royalty on a resale arrives as fractions of a ticket. For a revenue model that depends on a royalty denominated in money, MPT does not provide one.

Note that the documented presence of a `TransferFee` field on `MPTokenIssuance` does not imply equivalence with the NFT royalty mechanism. An earlier version of this project's own documentation recorded the opposite as fact.

Three further measurements:

**There is no atomic swap.** No MPT equivalent of `NFTokenAcceptOffer` with `NFTokenBrokerFee` exists. A `Payment` moves the ticket in one direction with nothing returning, so there is no spread from which a broker fee could be taken.

**The DEX does not substitute for one.** `OfferCreate` does not accept an MPT amount — in xrpl.js, `Amount` is typed `IssuedCurrencyAmount | string` and excludes `MPTAmount`. Submitting one regardless returns `temDISABLED`, including when `tfMPTCanTrade` is set on the issuance.

**Holders must opt in, and the issuer cannot opt in on their behalf.** On the most permissive issuance available — without `tfMPTRequireAuth` — a `Payment` to a holder who has not authorised returns `tecNO_AUTH`. An `MPTokenAuthorize` submitted by the issuer for the holder returns `tecNO_AUTH` as well. Every buyer therefore signs twice: once to opt in, once to pay.

The headline benefit is also narrower than it first appears. One signature creates the supply, but the units are held in the issuer's account. Moving one to a buyer requires a `Payment` signed by whoever holds them, so 3,000 buyers remain 3,000 issuer signatures unless the entire supply is consigned to a distributor — which places inventory with the platform.

What MPT breaks is secondary-market machinery; what it solves is primary issuance. For general admission without resale that is a reasonable trade. For a model with royalties and resale it is not.

---

## Approach 2: scoped permission delegation

`PermissionDelegationV1_1` allows an account to authorise another to submit specified transaction types on its behalf. Unlike `RegularKey`, which is unscoped and would also confer the ability to send payments, this can be narrowed to a single transaction type.

The organizer signs one `DelegateSet`:

```json
{
  "TransactionType": "DelegateSet",
  "Account": "<organizer>",
  "Authorize": "<platform>",
  "Permissions": [{ "Permission": { "PermissionValue": "NFTokenMint" } }]
}
```

The platform then mints with `Account` set to the organizer and `Delegate` set to the platform, signed with the platform's own key.

The question that determines whether the model survives is which account ends up as issuer. Observed:

```
Issuer     : <the organizer's address>
TransferFee: 5000 (5%)
NFTs in the platform's account: 0
```

The issuer is the organizer. The royalty model survives intact, and the NFT is delivered to the organizer's wallet rather than the platform's.

The scope is enforced by the ledger rather than by the delegate's restraint. A `Payment` attempted by the platform from the organizer's account returns:

```
terNO_DELEGATE_PERMISSION
```

Revocation is a single transaction carrying an empty `Permissions` array and takes effect immediately; the next delegated mint is refused with the same code.

### Two implementation facts that are easy to get wrong

**1. The sequence belongs to the delegator; the fee to the delegate.**

`Sequence` always belongs to `Account`, and on a delegated mint `Account` is the organizer. The organizer's sequence therefore advances while the platform signs the transaction and pays the fee. Bulk submission must increment the organizer's sequence.

The failure mode is not clean. An implementation using the delegate's sequence appeared to work at 100 tickets, because two freshly funded devnet accounts happened to begin at the same sequence number. Once the organizer signed the grant the two diverged, and the following run produced zero tickets, returning `terPRE_SEQ` on every submission. The symptom resembled a network fault.

**2. An advancing sequence is not evidence of success.**

A `tec` result consumes both the sequence and the fee while changing nothing.

Submitting all 1,000 mints at once fails for a related reason: rippled retains only a small number of future-sequence transactions per account and drops the remainder, after which the tail outlives its `LastLedgerSequence`. At 1,000 tickets, 402 existed and 598 silently did not. An event short by 60% without an error is the most damaging failure available to a ticketing system.

The working shape is to submit a wave, wait for the sequence to actually advance, then submit the next — the sequence moves only when a transaction is genuinely applied. Waves of 10 sustain 7–17/s. `LastLedgerSequence` must be bounded per wave rather than once for the whole run, and a stalled wave must resume from the point the ledger actually reached, because a single dropped transaction blocks every later sequence on that account permanently.

### Results

| Tickets | Wall time | Rate | Organizer signatures | Reserve locked |
| --- | --- | --- | --- | --- |
| 100 | 13.3s | 7.5/s | 1 | ~0.8 XRP |
| 250 | 37.8s | 6.6/s | 1 | ~1.8 XRP |
| 500 | 51.1s | 9.8/s | 1 | ~4.6 XRP |
| 1000 | 67.1s | 14.9/s | 1 | ~8.0 XRP |

All runs completed with no shortfall. Throughput improves with scale rather than degrading, indicating the limit is network absorption rather than the design.

NFTs pack into `NFTokenPage`s at up to 32 each, so 1,000 tickets costs the organizer roughly 8 XRP of reserve rather than 200. This is a precondition to verify before a run begins rather than a condition to discover at ticket 600. Fees fall to the delegate and were 1 drop per mint on devnet, so even at mainnet rates a thousand tickets costs a fraction of an XRP.

One further consequence: minting no longer touches the wallet-signing provider, because the platform signs directly. For this project that removed the single largest consumer of a third-party payload quota.

---

## Distribution is a separate problem, with two further walls

Minting a thousand tickets is half a product; tickets that cannot be bought are not tickets.

**Wall 1: unattended distribution requires a second and considerably more dangerous permission.**

`NFTokenMint` distributes nothing. Listing requires `NFTokenCreateOffer`, which can also be delegated, but the two permissions are not equivalent in risk:

- Minting can only create value for the organizer.
- Offer creation allows the delegate to transfer the organizer's tickets away. Measured: a zero-price offer from the organizer's account to the delegate returns `tesSUCCESS`.

Funds remain protected in both cases, as a `Payment` is still refused. Inventory does not. The claim "the platform can mint tickets as you and nothing else" therefore becomes "the platform can mint your tickets and also transfer them to anyone" as soon as unattended distribution is required. That is a materially different proposition, and it warrants a separate, time-boxed and explicitly worded grant rather than inclusion in initial setup.

**Wall 2: an open sell offer costs owner reserve.**

Every open `NFTokenOffer` is an owned object costing 0.2 XRP of reserve on the seller. Listing 1,000 tickets simultaneously locks approximately 200 XRP.

On a 100 XRP account, offers began failing with `tecINSUFFICIENT_RESERVE` after approximately 490, matching the predicted ceiling of `(100 − 1) / 0.2 ≈ 495`. Across a full run, 453 of 1,000 offers existed and 453 tickets sold — silently, and for the same `tec` reason as above.

The design consequence is that an event should not be listed up front. Creating the sell offer lazily at checkout holds reserve only for offers actually open, which also matches how tickets sell in practice. The alternative is to place the reserve on the buyer through buy offers: 0.2 XRP each for a single object, rather than 200 XRP held against the organizer for a thousand.

---

## The alternative available on mainnet today

`NFTokenMinter` is an `AccountSet` field present since the original NFT amendment. It authorises another account to mint NFTs whose issuer is the granting account. It was tested on testnet deliberately, since that establishes it works on mainnet now.

It functions as documented. `Issuer` is the organizer, `TransferFee` is intact, and the permission is narrower than delegation: a `Payment` attempted by the minter as the organizer, and a mint with `Account` set to the organizer, both fail with `tefBAD_AUTH`. `ClearFlag` revokes cleanly.

The cost is that the minted ticket is delivered to the minter's account rather than the issuer's. The platform therefore holds unsold inventory, and because the seller receives the proceeds, the platform also receives the primary sale funds. This is a custody model — the merchant-of-record position that brokered settlement exists to avoid.

The asymmetry is worth stating, as it cuts against the intuitive reading. Under `NFTokenMinter` the platform holds tickets it minted itself; under offer delegation the platform can remove tickets from the organizer's wallet. Considered as a permission, `NFTokenMinter` is the narrower grant. The objection is to the resulting custody, not to the permission.

---

## Amendment status

`PermissionDelegationV1_1`, amendment id:

```
0F48FF561C709540328F31F1C97FD512ACC8B4E42138A161CB0E21ECA292540B
```

| Network | rippled | Status |
| --- | --- | --- |
| Devnet | 3.3.0-rc5 | Active |
| Testnet | 3.3.0-rc5 | Not enabled, no majority |
| Mainnet | 3.2.1 | Not enabled; no amendment holds majority support |

Amendments activate by validator vote — 80% sustained for two weeks — and one crossing that threshold appears in the ledger's `Amendments` object under `Majorities` with the time it arrived. That provides roughly a fortnight of warning and is the event worth monitoring.

Mainnet also runs an older rippled than testnet or devnet. Validators cannot vote for what their software does not implement, so a release must land before voting can begin.

This is verifiable without admin access. The `feature` command is admin-only on public servers, but the `Amendments` ledger object is public and amendment ids are identical across networks:

```
ledger_entry index=7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4
```

Read the ids from `feature` on devnet, then look for them on mainnet.

---

## Summary of findings

1. MPT `TransferFee` is charged in tokens rather than the sale currency. A model requiring a royalty denominated in money does not survive the move to MPT.
2. On a delegated transaction the sequence belongs to the delegator and the fee to the delegate. The opposite assumption mints nothing while reporting success.
3. A `tec` result consumes the sequence and the fee. An advancing sequence demonstrates inclusion, never success; engine results must be checked.
4. Open offers cost reserve, so a large inventory cannot be listed at once. Offers should be created at the point of sale.
5. Delegating `NFTokenCreateOffer` is a substantially greater trust concession than delegating `NFTokenMint`, and the two warrant separate decisions.
6. Amendment availability differs sharply across networks. Devnet activation carries no information about shipping dates.

All measurements were taken on testnet and devnet. Nothing recorded here has run on mainnet with real funds, and every figure should be treated as provisional until it has.

---

*Reproduction scripts for each measurement are in the HubWorld repository under `backend/scripts/` — `delegation-spike.ts`, `delegation-scale-spike.ts`, `full-event-sim.ts`, `authorized-minter-spike.ts`, `mpt-spike.ts`, `mpt-fee-spike.ts`, `mpt-optin-spike.ts` and `mpt-amendment-check.ts`. They are dev-only, imported by nothing, and run against faucet-funded throwaway wallets.*

*Measurements were run and this document drafted with Claude Code. Every figure was verified against the ledger.*
