# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Organizers and promoters** who sell tickets and want control after the first sale: royalties, resale rules, auctions. Recurring-event organizers (a weekly league, a club night) and festival-scale operators are both in view. Becoming an organizer is reviewed, not self-declared.
- **Attendees** who hold, gift, resell and bid on tickets. Today they sign with a wallet (Xaman); a card-payment path is under consideration and is not decided.
- **Door staff and volunteers**, who are plain users with a per-event door grant and work the entrance from a phone.
- **Operators/admins**, who review organizer applications and read platform usage.

## Product Purpose

Event ticketing on the XRP Ledger, themed on video-game hub worlds. Tickets are XRPL NFTs held in the holder's own wallet, so a ticket can be gifted, resold, or auctioned, and the organizer is paid a royalty on resale. Success is an organizer running a real event end to end, and a sold-out night changing hands without the organizer losing sight of it.

## Positioning

HubWorld gives organizers control beyond the sale. It does not compete with Luma or Eventbrite on registration, email or CRM; the part a neighbouring product cannot truthfully copy is that ownership, royalties and resale rules live on the ledger rather than in one company's database.

## Operating Context

- Signed out, `/` is the Landing page; signed in, `/` is the Hub. Everything that needs a decision lives on its own page: `/events`, `/tickets`, `/market`, `/door`, `/organize`. Routing is a small custom router, not react-router.
- Organizer surfaces are absent for regular users rather than disabled. The Door link depends on a per-event grant, not on role.
- Door staff work on phones, in motion, often in poor light, so verdicts must read at a glance.
- Dark is the default theme; light is fully supported and tuned by hand.
- The network (testnet / mainnet) is shown only when it is not mainnet.

## Capabilities and Constraints

- Stack: React + Vite, Tailwind, shadcn/ui, Recharts, Socket.IO. Frontend lives in `frontend/`; routing is `src/lib/router.ts`.
- Money is shown from BigInt drops converted to XRP, never as floats.
- Live auction state has its own green token, deliberately not the brand hue.
- Recharts is code-split; `AuctionDialog` must stay lazy and remain the only importer of `BidChart`.
- Polling must be paced and never put poll-updated state in an effect's dependency list.
- Undecided product facts: a fiat/card payment rail, organizer-held tickets for card buyers, and recurring-event ("series") support.

## Brand Commitments

- Name: HubWorld. Mark: two nodes orbiting a hub (`NavBar.tsx` `Mark`, `favicon.svg`).
- **The violet brand accent is kept, deliberately** (confirmed 2026-10-28), even though `frontend/CLAUDE.md` bans purple as a primary hue. Executed with care: no gradient headline words, no purple gradients, no aurora backdrops on the app surfaces.
- Visual reference the user pinned: Luma's app UI (screenshots supplied 2026-10-28) as design philosophy, translated into something unmistakably HubWorld, not copied. Two stage-light concert photographs were supplied as imagery.
- Organizer features are hidden, not disabled.

## Evidence on Hand

- A running local app with seeded events; real mainnet rehearsal results in `docs/mainnet-dress-rehearsal.md`.
- No customer testimonials, logos or usage figures exist; none may be invented. One organizer has expressed interest in a pilot; do not name them in product copy.

## Product Principles

1. The ledger is the authority; the interface shows what is true and says plainly when it does not know.
2. A control that cannot work is absent, not disabled.
3. Restraint over spectacle: live auction state is the one place the interface is allowed to glow.
4. Plain, specific copy in the product's own language; no interchangeable SaaS slogans.
5. Organizers' control after the first sale is the story, so the UI should make ownership and resale rules legible.

## Accessibility & Inclusion

Keyboard focus visible everywhere; WCAG AA contrast; `prefers-reduced-motion` respected; state is never carried by hue alone (live and admitted states always pair colour with a label or icon). Usable one-handed on a phone at the door.
