---
version: 1
slug: "frontend-src-components-landing-tsx"
primary_target: "frontend/src/components/Landing.tsx"
related_targets: ["frontend/src/components/LandingPhoneShowcase.tsx","frontend/src/components/LandingAuctionDemo.tsx"]
---

# Surface brief: signed-out Landing page

Mode: Persuade. Visitor: an organizer arriving cold (from a LinkedIn post or a conversation) who runs events and has not heard of HubWorld. First action: sign in to apply as an organizer. Real proof to use: one measured mainnet resale split (seller 0.926250, organizer 0.048750, platform 0.024988 on a 1 XRP sale), and the 1,000-ticket single-signature run (20 Oct 2026, 736 s). Anything else shown is labelled as an example. Constraints: the iPhone showcase (`LandingPhoneShowcase`) and the auction demo stay and are not edited; the sticky phone has no overflow ancestor; the quiet ledger line stays (`Landing.test.tsx` pins it); `--accent` must stay defined for the children; violet is the action colour per DESIGN.md. At the owner's request (2026-10-28) the previous teal accent, tonal washes, dot grid, recessed auction panel with its tilted back card, and navy closing panel were RESTORED, so this surface is an acknowledged exception to the app's no-gradient rule.

Unresolved: the two concert photographs (not used in this pass); attendee-facing copy beyond a quiet link to Events.

## Direction contract

THESIS: The first screen is a verdict, not a pitch: the full-width moment at the door when a ticket either works or doesn't, with the organizer's offer written beneath it. Refuses the category default of a centred headline over two buttons and a row of cards.

OWN-WORLD: The Departures Board system from DESIGN.md for plates, type and the neutral action pill with a violet brand accent, plus the previous Landing's teal accent and tonal washes as the page atmosphere. The hero verdict sits on a crowd-under-stage-lights photograph under a flat 50% black layer, with white text; live green is only a dot and a check, always beside the word Admitted. Geist with Geist Mono for figures and labels. Sections other than the auction panel and closing panel are left-aligned on one grid.

STORY: A stranger understands in one screen that this is ticketing where each ticket is checked against a ledger at the door, reads that resale pays the organizer, sees the measured split, scrolls through one ticket's life on the phone, and is asked once to sign in and apply.

FIRST VIEWPORT: A rounded plate across the full container width carrying a stage-lights photograph, a mono label (green dot, door, staff phone, example), "Admitted" at up to 6rem, the guest handle and event beneath it on the right; under it two quiet verdict plates (already checked in, no ticket); under those the headline "Every ticket answers at the door, and pays you when it resells." at left with the single violet action "Sign in to apply" and a text link to Events at right. On a phone the plate stacks and the headline follows directly.

FORM: The Door, the dealt lead (index 6 of my ordered list) from the bolder re-roll, picked by the user. seed: ea7bfd487f111729

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
