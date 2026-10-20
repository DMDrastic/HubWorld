# Creating the mainnet delegate account

What turns on **delegated minting** and the **lazy box-office sale** in
production. Until `DELEGATE_SEED` is set on the server, the delegation panels stay
hidden, the bulk-mint sweep stays off, and `/api/health` reports
`delegate: { mode: "disabled" }`. Nothing is broken in that state; it is simply the
older product (the organizer signs every mint).

Like `mainnet-broker-account.md`, this is a **manual** procedure by design: an
account with real money behind it should be a deliberate act, not something a
convenience script conjures.

Both halves have been run for real on mainnet with throwaway accounts
(`scripts/mainnet-sale-check.ts`, 2026-10-20, 14 of 14 on the second run). This
runbook is about the **production** account those runs stood in for.

## What this account is, and what it is not

It is the one key HubWorld holds that can act **as an organizer**. Organizers grant
it permissions with a `DelegateSet` signed in their own wallet, so it can do only
what each organizer has allowed, only while they allow it:

- **`NFTokenMint`** (the "Minting for you" grant): mint tickets as that organizer.
  The NFT's issuer stays the organizer, so the royalty stays theirs.
- **`NFTokenCreateOffer`** (the "Selling for you" grant): create one sell offer at a
  time, as that organizer, at checkout. A separate, more dangerous grant.
- It **cannot** send a `Payment` from an organizer's account, change their keys, or
  do anything they have not granted — the ledger refuses with
  `terNO_DELEGATE_PERMISSION`. That is the difference from `RegularKey`.
- It **pays the transaction fee** of every delegated transaction (12 drops each on
  mainnet), so it must stay funded.
- It is **not** the broker. The broker key matches sales; this one creates them. They
  are separate so that a leaked broker key does not mean "can mint as every
  organizer who granted". The server refuses to boot if the two seeds are equal.

### What a compromise would cost

Be specific about this, because it is the claim the design rests on:

- With the **mint** grant: the attacker can mint extra tickets as any organizer who
  granted it — past the advertised size, diluting scarcity. It cannot move money.
- With the **offers** grant: the attacker can list any ticket in that organizer's
  account at any price to any destination, including a zero-price offer to itself,
  which `tesSUCCESS`es. `checkSellOffer` guards this inside OUR code only; it does
  not bind someone holding the key.
- It cannot take an organizer's XRP, and it cannot touch tickets in an account that
  has not granted it.
- The account's own balance (a few XRP).

So the key is a hot key with a blast radius of "organizers who granted, for what they
granted". That is why the balance is small, why the offers grant is its own consent,
and why organizers can revoke each permission independently.

## Checklist

### 1. Generate the wallet offline

On a machine you trust, not in a browser tool and not on a shared host. `xrpl.js`
generates locally without touching the network. Print the **address only**:

```sh
node -e 'const {Wallet}=require("xrpl");const w=Wallet.generate();console.log(w.classicAddress)'
```

That prints an address whose seed you then cannot recover. Generate and store in one
step instead, so the seed is never on screen:

```sh
# macOS: generate and put the seed straight into the Keychain, printing only the address
node -e '
  const {Wallet}=require("xrpl"); const {execFileSync}=require("child_process");
  const w=Wallet.generate();
  execFileSync("security",["add-generic-password","-a","hubworld","-s","hubworld-delegate-seed","-w",w.seed]);
  console.log(w.classicAddress)'
```

(The seed is briefly visible in this process's arguments to other local users. On a
single-user laptop that is acceptable for a key holding ~2 XRP; if it is not, create
the Keychain item interactively with `security add-generic-password -a hubworld -s
hubworld-delegate-seed -w` and paste the seed at the prompt.)

- [ ] **Address recorded. Seed NOT printed to the terminal.**
- [ ] The seed is an `s...` family seed, since `Wallet.fromSeed` is what
      `ledger.ts` calls. A mnemonic or raw private key will not load.
- [ ] **It is a different seed from `PLATFORM_SEED`.** Never reuse the broker.

### 2. Put the seed in a real secret manager

- [ ] **Stored in a secret manager** (Keychain item `hubworld-delegate-seed`, plus an
      offline copy), not `.env`, not a note, not a browser password field.
- [ ] **A recovery path exists and has been tested by someone other than the person
      who created it.** A hot key with one copy on one laptop is an outage waiting
      for a hardware failure.
- [ ] **Not imported into Xaman.** Funding is one-way and the balance is readable
      without the key, so a phone copy buys nothing and adds a third copy of a hot
      key on the device most likely to be lost. Import it only for a deliberate,
      temporary reason.

### 3. Fund it

- [ ] **Send ~2 XRP.** The reserve (1 XRP base) is the cost; the fees are
      negligible — 12 drops per delegated transaction, so 1 XRP of headroom covers
      roughly 80,000 of them. The delegate holds **no objects**: it never owns an
      offer or an NFT, so it carries no owner reserve.
- [ ] **Do not overfund it.** It signs unattended. Top it up rather than parking a
      float in it.
- [ ] **Verify the balance on-ledger before relying on it**, not on the sending
      wallet's confirmation screen.

### 4. Wire it up

- [ ] **`DELEGATE_SEED` set on the server.** It is `sync: false` in `render.yaml`;
      enter it in the Render dashboard. Set it **after** the account is funded.
- [ ] **Confirm the derived address matches the funded one.** The seed is the input;
      the address is derived. The wrong seed gives a well-formed account that is not
      the one holding the money:

```sh
# from backend/ — prints the address the loaded seed actually derives to
DOTENV_CONFIG_PATH=.env.mainnet.local npx tsx -e \
  'import("./src/ledger.js").then(l=>console.log(l.delegateAddress()))'
```

- [ ] **`GET /api/health` reports the delegate as live and funded:**

```sh
curl -s https://hubworld.app/api/health | jq '.delegate, .broker.address'
# .delegate -> { "mode": "live", "address": "<the funded one>", "status": "ok", ... }
```

      `mode: "misconfigured"` means the seed is set but is not a usable seed.
      `status: "unknown"` means the ledger could not be read, **not** that the
      account is empty. The two addresses (`delegate` and `broker`) must differ.
- [ ] **The server booted.** If `DELEGATE_SEED` equals `PLATFORM_SEED` it exits at
      startup with a message naming both — which is the intended behaviour, and
      Render will keep serving the previous container while the new one fails.

### 5. Before it carries real volume

- [ ] **A balance alarm on `/api/health` → `delegate.status`.** `low` is under
      0.5 XRP spendable and `unfunded` is zero. A dry delegate stops every bulk mint
      on the platform, silently — no request fails; runs just stop with "waiting".
      Check it the way you check the broker.
- [ ] **Run `npm run ledger:sync` (dry run) on a schedule** and read the
      `EXPOSED-OFFER` section. An organizer's account holding an open or
      other-destined sell offer that no listing accounts for is the signature of the
      delegate key being used for something it was not asked to. Only the organizer
      can cancel an exposed offer, so this is reported, never auto-fixed.
- [ ] **Exercise it once yourself before an organizer does.** Be the organizer on a
      small event: grant "Minting for you" and "Selling for you" in the UI, bulk mint
      a few tickets, buy one from a second wallet, then revoke selling and confirm
      checkout closes and minting is untouched. (`scripts/mainnet-sale-check.ts`
      already does this with throwaway accounts; this is the same thing through the
      product, against the real key.)
- [ ] **Know the Xaman issuer constraint.** Every organizer is their own NFT issuer,
      and Xaman classifies by issuing account, so a first-time organizer's tickets can
      show a scam warning until that account is whitelisted (`ROADMAP.md` §5d). This
      is independent of how the tickets were minted.

## Turning it off

Unset `DELEGATE_SEED` (or leave it unset). Effects, all safe:

- The "Minting for you" / "Selling for you" panels and the bulk-mint panel disappear.
- The bulk-mint sweep stops. Runs in progress stay `QUEUED`; nothing is lost, and
  they resume when a key is configured again.
- Checkout answers "Sales are not available on this server" (a 503) for every event,
  because there is no key to create the offers; the box-office Buy control still
  shows on priced events, so unset the key only briefly, or unset prices too.
- Holds already open are still released by the sweep, which runs on the broker.
- **Grants already on the ledger stay there.** Unsetting the key does not revoke
  them; only each organizer can. If the key is compromised, telling organizers to
  revoke both permissions is part of the response, not an optional extra.

## Two traps that are expensive to learn late

**Rotating the seed strands existing grants.** A grant authorises ONE account. After
rotation every organizer's grant still names the old delegate on the ledger, and the
new key has no permission anywhere. `Delegation.delegateAddress` freezes the address a
grant named (like `Listing.brokerAddress`), so:

- `GET /delegation/me` reports `staleGrant: true` and the panel tells the organizer
  their earlier approval "names a minting account that has since been replaced";
- **revoke** names the delegate the grant named, not the configured one, so an
  organizer can still withdraw the old permission;
- every organizer must **grant again** to the new key. Plan for that: it is one
  signature per organizer per permission, not an engineering task, but it is an
  announcement.

For a **planned** rotation keep the old key funded until the old grants are revoked.
For a **compromise**, unset the key first, then notify organizers to revoke.

**The delegate is not a serialisation point; the organizer's account is.** Unlike the
broker (one sequence gates every sale platform-wide), delegated transactions consume
the **organizer's** sequence, not the delegate's — so two organizers never queue
behind each other. What does serialise is one organizer's own mints and sales, which
share a lease (`organizer-lease.ts`). That is why one organizer's checkouts are
measured at ~2 per second, and why it is per organizer rather than platform-wide.

## When it is done

`/api/health` shows the delegate live and funded, an organizer you control has
granted both permissions through the UI and run a small event end to end, and the
balance and `ledger:sync` checks are on a schedule. Until then, leave `DELEGATE_SEED`
unset and the product behaves exactly as it did before delegation existed.
