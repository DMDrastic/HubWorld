# The Xaman limits enquiry

A record of what was asked, what came back, and what is still unanswered. Kept
because the answers decide two things: whether a separate production application
is needed, and what a real event costs against the quota.

## Timeline

- **2026-08-12** — asked by email to `support@xaman.app` and by a ticket in the
  Support xApp. Six questions: the free-tier limit and its window, confirmation
  that it counts CREATIONS and cannot be reclaimed, **whether limits are per
  application or per account**, paid tiers and prices, lead time to raise a
  limit, and whether a 429 consumes quota.
- **2026-08-13** — replied. Pointed at the rate-limits page and sent a
  questionnaire to forward to their infra team.
- **2026-08-13** — questionnaire answered, in two parts. The main answers went
  first; the "On the no-polling condition" section followed as a second message,
  after reading their "Raising API limits" wording closely. Both are reproduced
  below as one document — it was sent as two.

## The reply answered a different limit, and that matters

Their [rate-limits page](https://docs.xaman.dev/concepts/limitations/rate-limits)
describes calls **per minute**:

| | |
| --- | --- |
| General API calls | ~60–200 / min |
| **Payload creation** | **~30 / min** |
| Transaction fetching | 60 / min |
| Account metadata | 120 / min |

Every response carries `X-RateLimit-Limit` and `X-RateLimit-Remaining` for the
current sliding minute, and the page says the figures are averages that the
platform adjusts on the fly rather than guarantees.

**None of that is the limit that blocked us.** The application stopped being able
to create payloads at all, quoting a count that ROSE as more were created
(67, then 77) — a cap on payloads created, not a rate. So the original questions
stand, and the answers below repeat them.

**Elevation is gated on "no polling techniques"** — but the same paragraph says
**"Backend applications can also use a webhook"**, so webhooks are an accepted
route rather than a consolation. We are on it: callbacks registered and arriving.

The reply answers that gate head-on rather than leaving it to be inferred, and
makes a second point in our favour — their page says transaction fetching needs
no platform call, and we already read the ledger directly over xrpl.js, touching
only the three `/payload` endpoints.

**It also commits us**: if webhook-plus-bounded-fallback is not enough, we move
the fallback onto their websocket. That change lives at the `src/xaman.ts` seam
(`createAndSubscribe` / raw websocket), which is contained rather than a rewrite
— but it is a commitment made in writing, so honour it if they ask.

## What was sent

> Thanks — answers below. I've grouped the questions about polling, since
> several ask the same thing.
>
> **Nature of the application, user base and services**
>
> An NFT event-ticketing platform on the XRP Ledger. Tickets are NFTokens held
> in attendees' own wallets. The platform never holds a user key: Xaman signs
> everything that moves someone else's ticket or money. The only key we hold is
> our own broker account, used solely to sign the brokered `NFTokenAcceptOffer`
> that settles a sale.
>
> Services: wallet sign-in, ticket minting by event organizers, gifting,
> fixed-price resale, auctions, and door check-in at the event itself.
>
> User base today is pre-production. We have run on testnet only and are
> preparing a first real event of 10–20 tickets. Realistic near-term events are
> in the tens to low hundreds of attendees.
>
> **What kind of calls we make**
>
> **We use the REST API directly, not the SDK.** Calls go to
> `https://xumm.app/api/v1/platform` from a Node backend with
> `X-API-Key`/`X-API-Secret` headers. Exactly three endpoints are used:
> `POST /payload` to create, `GET /payload/{uuid}` to read state, and
> `DELETE /payload/{uuid}` to cancel abandoned ones. The API secret never
> reaches the browser.
>
> Eleven distinct flows create sign requests: sign-in, door check-in, mint, gift
> offer/accept/cancel, listing create/buy/cancel, auction open, and auction bid.
>
> **A sign request, from creation to resolution**
>
> 1. A user presses a button that requires a signature. Our backend calls
>    `POST /payload` with `force_network` set, and stores the returned uuid
>    against the flow that created it.
> 2. The browser is given the uuid, the QR, and the universal link — on a phone
>    we show the link instead of the QR, since you cannot scan the screen you are
>    reading.
> 3. The user signs in Xaman.
> 4. Your webhook fires at our registered URL. **We read only the uuid from the
>    callback body and never trust its contents** — the state always comes from
>    an authenticated `GET /payload/{uuid}`, so a forged callback cannot fake a
>    signature.
> 5. In parallel, the browser polls our backend, which serves cached state and
>    refreshes from you at most once per 1.5s per payload while pending.
> 6. On a terminal state (signed / cancelled / expired) we cache permanently and
>    stop calling you about that payload for good. If it signed, the resulting
>    transaction hash is read back and the outcome recorded — for a mint, the
>    `NFTokenID` only exists once validated, so that read is a separate step.
> 7. Payloads left non-terminal for over a minute are reconciled by a sweep, and
>    abandoned unsigned ones are cancelled with `DELETE`.
>
> **How sign requests are generated**
>
> **Only on demand, by explicit user interaction.** Never per visitor and never
> on page load. A payload exists because somebody pressed a button to sign
> something.
>
> Sign-in additionally **reuses an outstanding unsigned payload** rather than
> creating a new one per click, tracked by a short-lived cookie — six clicks used
> to cost six payloads and now cost one. Reuse only happens on positive evidence
> from your API that the payload is still unsigned; signed, cancelled, expired,
> unknown or a 429 all mint a fresh one, because handing a user back a payload
> you have already resolved is a sign-in they can neither complete nor diagnose.
>
> **How outcomes are processed — webhooks and polling, and why both**
>
> We use **webhooks**, registered in the console and receiving callbacks in
> production. We also poll, and the design deliberately makes polling cheap:
>
> - The **browser** polls our own backend every 2–2.5 seconds. Those requests
>   never reach you.
> - Our **backend** refreshes a given payload from your API **at most once per
>   1.5 seconds, per payload** — not per poll and not per viewer. Ten people
>   watching one auction produce the same load on you as one.
> - **Terminal states (signed, cancelled, expired) are cached permanently.** Once
>   a payload resolves we never ask you about it again.
> - A sweep reconciles any payload left non-terminal for over a minute.
>
> We kept polling as a fallback because a dropped callback otherwise loses a real
> signature — for a mint or a bid that means a user's money is stuck with no way
> to notice.
>
> **On the no-polling condition**
>
> We are a backend application using webhooks, which your documentation lists as
> an accepted alternative to the websocket. Callbacks are registered and arriving
> in production.
>
> We also follow the guidance elsewhere on that page: we do not use your platform
> for transaction fetching. Ledger reads go directly to an XRPL node over a native
> websocket via xrpl.js, and the only endpoints we touch are the three payload
> ones listed above.
>
> The one place we still call you outside the webhook is a reconciliation
> fallback: while a payload is pending we refresh it at most once per 1.5 seconds,
> and any payload left non-terminal for over a minute is re-checked once. That
> exists because a dropped callback otherwise loses a real signature, and for a
> mint or a bid that means a user's funds are stuck with nothing to notice it.
>
> If webhook-plus-bounded-fallback does not satisfy the condition, we will move
> that fallback onto your websocket. Please tell us which you require and we will
> implement it before you action the request.
>
> **Peak or sustained?**
>
> **Peak, and short.** Sustained load is near zero — a handful of calls per
> minute.
>
> The peak is **door check-in**, where attendees arrive in a burst: each check-in
> is one payload creation plus status reads until it resolves, typically 5–15
> seconds. With four staff devices working a door, that is roughly **4 concurrent
> payloads (~160 status reads/min at our 1.5s throttle) and 10–15 creations/min**,
> for perhaps 30 minutes.
>
> Minting is the other burst: an organizer signs each `NFTokenMint` individually
> because the organizer is the issuer and receives the royalty via `TransferFee`.
> A 20-ticket event is 20 payloads, signed sequentially, so it is one open
> payload at a time.
>
> **The number we are asking for:** roughly **300 general calls/min and 60
> payload creations/min**, which is about double our estimated peak so a busier
> door than expected does not fail mid-event. If the per-minute limits already
> sit at the upper end of the published 60–200 range, we may need no change to
> them at all — our blocking problem is the creation cap described below.
>
> **Which calls we expect to hit limits**
>
> Payload creation, at a door. Everything else is comfortably inside the
> published averages.
>
> **Are we currently rate-limited, or is this proactive?**
>
> Both, and the distinction matters.
>
> Proactive for the per-minute limits — we have not hit those and expect to sit
> inside them.
>
> **Not proactive for the other limit.** Our application stopped being able to
> create payloads entirely, with an error quoting a payload count that *rose* as
> we created more (67, then 77). Cancelling did not recover any: `DELETE` on a
> resolved payload returns 404 and it still counted. That is what prompted the
> original enquiry, and it reads as a cap on payloads created rather than a
> per-minute rate.
>
> That limit is not described on the rate-limits page, so I'd be grateful for
> three specifics:
>
> 1. What is that limit, and is it per month, rolling, or lifetime per
>    application?
> 2. **Is it scoped per application or per developer account?** If per
>    application, we would register a separate application for production so
>    development and automated testing cannot consume a live event's budget. This
>    is the answer that changes how we set things up, so it's the one we most
>    need.
> 3. Does a 429 consume any allowance?
>
> **API key**
>
> `<API KEY HERE>`  ← filled in at send time from `backend/.env`; NEVER the
> secret, and never committed to this file
>
> Happy to provide anything else useful.

## Resolved 2026-08-21/22

- **No fixed creation cap.** Confirmed: the 67 → 77 error was the dynamic limit
  moving, not a lifetime quota being consumed.
- **Limits are per API key**, adjusted dynamically on activity, key age and user
  reports. **No maturation period** — age cannot be banked by registering early,
  which is why `ROADMAP.md` §2 now says NOT to register a second application
  until a continuously-running mainnet deployment exists.
- **429s do not consume the limit.**
- **No paid tiers — the service is free.** Whitelisting is the lever for
  event-day bursts, on request and in advance.
- **Webhook-first shipped** (PR #69) and confirmed in production, which reports
  `webhook: receiving`.
- **The issuing account was whitelisted** on request, so the scam warning on
  `r4wQ…BjcF` should clear. That fixes the instance, not the class — see
  `ROADMAP.md` §5d.

## Still unanswered

1. **Whether a PLATFORM can be registered** so accounts issuing through it are
   treated as known, rather than clearing every organizer one at a time. This is
   the one that decides whether organizer signup can ever be self-serve.
2. **The process and turnaround for per-account whitelisting**, so it can be
   built into onboarding rather than discovered when an organizer's first event
   goes on sale.
3. **Why a public `https` image returning 200 `image/png` does not render**, when
   their documentation emphasises IPFS.

## Figures quoted, and where they come from

The peak estimate is derived, not guessed, so it can be corrected if the shape
of an event turns out different:

- **1.5s per payload** is `REFRESH_THROTTLE_MS` in `src/payload-store.ts`, so one
  open payload costs at most 40 reads/min however many people are watching.
- **2–2.5s** is the browser's poll of OUR backend (`POLL_MS` in the panel
  components) — those never reach Xaman.
- **Eleven flows** is the `PayloadFlow` enum in `schema.prisma`, which is also
  what `npm run payload:report` breaks down.
- Door concurrency of four is an assumption about staffing, not a measurement.
  **The rehearsal is what replaces it with a real number.**
