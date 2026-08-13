# Creating the mainnet broker account

A precondition of `mainnet-dress-rehearsal.md`. It is a **manual** procedure by
design: `npm run platform:setup` refuses mainnet
(`scripts/setup-platform-account.ts:31`) because an account with real money
behind it should be a deliberate act, not something a convenience script
conjures on a faucet.

## What this account is, and what it is not

Brokered mode requires the broker's own signature: settlement is an
`NFTokenAcceptOffer` matching a seller's offer to a buyer's, taking
`platformBps` as `NFTokenBrokerFee`. So this is the **one key HubWorld holds**,
and it is a hot key — it lives in the server's environment and signs
unattended.

What it cannot do is the reassuring part, and it is worth stating precisely
because it is the claim the whole design rests on:

- **It cannot move anyone's ticket.** Both offers carry `Destination` = the
  broker, so it can only match offers that were created naming it. It cannot
  create an offer on someone else's behalf.
- **Funds never rest with it.** The ledger moves buyer → seller and
  buyer → issuer atomically inside the single accept transaction. The broker
  fee is taken from the spread, not custodied.
- **It is not the issuer.** Royalties go to the organizer via the NFT's native
  `TransferFee`. Compromising this key does not let anyone mint.

What a compromise *would* cost: the ability to settle sales on terms of the
attacker's choosing, and the account's own balance. Size the balance
accordingly — see funding below.

## Checklist

### 1. Generate the wallet offline

Generate it on a machine you trust, not in a browser tool and not on a shared
host. `xrpl.js` generates locally without touching the network:

```sh
node -e 'const {Wallet}=require("xrpl");const w=Wallet.generate();console.log(w.classicAddress)'
```

- [ ] **Address recorded. Seed NOT printed to the terminal.**
      `setup-platform-account.ts` goes out of its way to avoid echoing a seed,
      for a reason: anything printed is in shell history and scrollback. Write
      the seed straight into the secret manager from the generating process, or
      generate it inside the secret manager if it can.

The seed must be the `s...` family seed, since `Wallet.fromSeed` is what
`ledger.ts:143` calls. A mnemonic or a raw private key will not load.

### 2. Put the seed in a real secret manager

- [ ] **Stored in a secret manager**, not `.env`, not a note, not a password
      field in a browser.
- [ ] **Recovery path exists and has been tested by someone other than the
      person who created it.** A hot key with one copy on one laptop is an
      outage waiting for a hardware failure.
- [ ] For the local rehearsal, paste it into `backend/.env.mainnet.local` **for
      the duration only**, then remove it. That file is mode 600 and gitignored
      by `.gitignore:6`, which is a floor, not a vault.

### 3. Fund it

- [ ] **Send ~2 XRP.** From the rehearsal runbook's measured mainnet figures:
      1 XRP base reserve, plus transaction fees for every settlement it signs at
      0.00001 XRP each. The reserve is the cost; the fees are negligible.
- [ ] **Do not overfund it.** It is a hot key that signs unattended. It needs
      enough to hold the reserve and pay fees, and no more — top it up rather
      than parking a float in it.
- [ ] **Verify the balance on-ledger before relying on it**, rather than
      trusting the sending wallet's confirmation screen.

### 4. Wire it up

- [ ] `PLATFORM_SEED` set in the environment the rehearsal actually runs in.
      For the local run that is `backend/.env.mainnet.local`; for a deployed
      run it is `sync: false` in `render.yaml` and entered in the dashboard.
- [ ] **Confirm the derived address matches the funded one.** The seed is the
      input; the address is derived. Getting the wrong seed in gives a
      well-formed account that simply is not the one holding the money:

```sh
# from backend/ — prints the address the loaded seed actually derives to
DOTENV_CONFIG_PATH=.env.mainnet.local npx tsx -e \
  'import("./src/ledger.js").then(l=>console.log(l.platformAddress()))'
```

- [ ] **`brokerMode` reads `live`, not `disabled`** (`env.ts:160`). With the
      seed absent the server still boots and still takes listings — it just
      cannot settle anything, so auctions run and never close. The startup
      warning at `env.ts:181` is the tell.

### 5. Before it ever carries volume

- [ ] **A balance alarm.** Roadmap §4: settlement costs HubWorld the fee because
      the broker submits it, so a drained broker stops settling sales silently
      and platform-wide. Discovering this from a customer is the bad path.
- [ ] **Know the rotation procedure before you need it.** `PLATFORM_SEED` has no
      rotation story, and rotation is not a simple swap — see below.

## Two traps that are expensive to learn late

**Rotating the seed strands live offers.** Both sides of every open sale carry
`Destination` = the broker address as it was when the offer was created. Rotate
the key and a buyer's new offer names the new account while the seller's already
names the old one: both transactions still succeed, and the pair is simply
unsettleable, with nothing recording which key it needed.
`Listing.brokerAddress` exists to snapshot this, but **rows written before that
column carry null and fall back to the current address**. So:

> **Run `npm run broker:backfill` (dry run, then `-- --apply`) BEFORE any
> rotation.** Rotating first makes the fallback wrong, and the answer is not
> recoverable from our own data.

**One broker is a platform-wide serialisation point.** Every sale is submitted
by the same account, so they queue behind its single sequence number. One stuck
transaction halts settlement for everyone, while the account still looks
perfectly healthy. That is why `Listing.brokerAddress` is also the prerequisite
for ever having more than one broker.

## When it is done

The rehearsal's precondition list can be ticked, and step 5 (open an auction and
settle it) becomes possible. Until then everything up to and including a sale
can be exercised, but nothing closes.
