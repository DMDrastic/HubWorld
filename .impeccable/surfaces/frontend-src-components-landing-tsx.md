---
version: 1
slug: "frontend-src-components-landing-tsx"
primary_target: "frontend/src/components/Landing.tsx"
related_targets: ["frontend/src/components/LandingPhoneShowcase.tsx","frontend/src/components/LandingAuctionDemo.tsx","frontend/src/components/LandingPosterCloud.tsx","frontend/src/components/LandingCreateDemo.tsx"]
---

# Surface brief: signed-out Landing page

Revised 2026-10-28 after the owner found the first version "missing something" beside Luma's landing page: it explained a mechanism but showed no world. The door verdict is now the second beat, not the opening. The headline copy is the owner's original and is deliberately kept as written.

Mode: Persuade. Visitor: an organizer arriving cold (from a LinkedIn post or a conversation) who runs events and has not heard of HubWorld. First action: sign in to apply as an organizer. Real proof to use: one measured mainnet resale split (seller 0.926250, organizer 0.048750, platform 0.024988 on a 1 XRP sale), and the 1,000-ticket single-signature run (20 Oct 2026, 736 s). Anything else shown is labelled as an example. Constraints: the iPhone showcase (`LandingPhoneShowcase`) and the auction demo stay and are not edited; the sticky phone has no overflow ancestor; the quiet ledger line stays (`Landing.test.tsx` pins it); `--accent` must stay defined for the children; violet is the action colour per DESIGN.md. At the owner's request (2026-10-28) the previous teal accent, tonal washes, dot grid, recessed auction panel with its tilted back card, and navy closing panel were RESTORED, so this surface is an acknowledged exception to the app's no-gradient rule.

Unresolved: attendee-facing copy beyond a quiet link to Events. The poster cloud is only as full as the product is; with few events it will look sparse, and that is accepted over faking it.

## Direction contract

THESIS: The page shows a living product before it explains one. The owner's own headline first, surrounded by posters: the real events that are on HubWorld right now, then decorative artwork; then the door verdict as the proof that a ticket is checked; then the create page's best moment as something to do. Refuses the category default of a centred headline over two buttons and a row of identical cards, and never lets decoration pass for an event: the filler posters carry no title, date or place, are not links, and are hidden from assistive technology.

OWN-WORLD: The Departures Board system from DESIGN.md for plates, type and the neutral action pill, with a violet brand accent, plus the previous Landing's teal accent and tonal washes as the page atmosphere. Real event posters carry the colour, each a little askew at the edges of the hero, a hairline edge and one soft dark shadow for depth. Each poster drifts a few pixels on its own slow cycle and holds still under reduced motion. Gradient headline text was tried and removed at the owner's request. The door verdict sits on a stage-lights photograph under a flat 50% black layer with white text; live green is only a dot and a check beside the word Admitted. The create demo's plate takes on the tint read from the chosen sample poster.

STORY: A stranger reads what this does for them, sees that real events and posters already live here, understands from the door verdict that tickets are checked, picks a poster and watches the page take its colour, scrolls one ticket's life on the phone, sees the measured resale split, and is asked once to sign in and apply.

FIRST VIEWPORT: On screens 1280px and wider the headline "Every ticket you hold, in one hub." (the owner's own words) centred in a narrow column with the owner's supporting line, the single neutral "Sign in to apply" pill and a quiet "See events" link; eight posters scattered at both edges, each a few degrees askew and drifting gently, the real events first and decorative artwork in the remaining places. Below 1280px the first three sit in a row above the headline, because measured against the letters the scatter touches the text under about 1240px.

FORM: Headline-and-poster-cloud opening (after Luma's landing, translated), the Door verdict (dealt lead, index 6, seed:ea7bfd487f111729) as the second beat, and an interactive create demo as the third. seed: ea7bfd487f111729

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
