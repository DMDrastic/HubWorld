---
version: 1
slug: "frontend-src-components-eventlist-tsx"
primary_target: "frontend/src/components/EventList.tsx"
related_targets: ["frontend/src/components/NavBar.tsx","frontend/src/components/Footer.tsx","frontend/src/components/Hub.tsx"]
---

# Surface brief: app shell and Events timeline

Mode: Operate (the visitor is finding an event and acting on it). Scope: nav, footer, tokens and primitives, Events, Hub, Tickets, Market page headers. Landing is out of scope for this pass.

Audience and job: organizers, attendees and door staff deciding what to attend, buy, bid on or check in. Constraints: existing behaviour and tests stay (gating, once-only naming, absent-not-disabled controls); violet accent is kept on purpose; Landing still uses `.aurora`, `.blob-*`, `.text-gradient`, `.glow-primary` and those classes must keep working.

Unresolved: where the two supplied concert photographs go (not used in this pass); Landing restyle; card-payment and series features.

## Direction contract

THESIS: Events are a dated timeline on a rail, not a wall of posters. The one structural device is the hub-node on the rail, which encodes something true: a ring is on sale or upcoming, a filled pulsing green node is a live auction, a dim node is past. Refuses the category default of a centred hero over a same-size card grid, and the old violet aurora.

OWN-WORLD: Ink-violet near-black ground (#0e0e12 dark; soft off-white light), cards as translucent-white 4% surfaces with a 1px hairline at white/7%, lifting to white/16% on hover. Violet (#8b7cff dark, #6d4aff light) only for the action a person can take and for focus; green only for live state, always with a label. Geist for everything, Geist Mono for addresses, prices and times. Titles 600 weight, tight tracking, 2.5rem on the page; cards 16px radius, poster thumbs 12px, pill segmented control. No shadows except modals; no gradients on surfaces or text.

STORY: Someone opening Events sees what is on and when, which nights are live, and acts from the row (buy, or watch the bidding) without opening anything first. Past events are one toggle away, never mixed in.

FIRST VIEWPORT: Top bar with icon-and-label destinations left, status and account right. Below it a left-aligned "Events" title at 2.5rem and an Upcoming/Past segmented control right-aligned on the same line. Beneath, a date column (day, weekday) at 7rem with the rail and its node beside it, and to its right the event card: time, title at 1.375rem, "By @organizer", venue, status chips, and the single action on the left; a portrait 3:4 poster thumbnail on the right. Primary action sits bottom-left of the card.

FORM: Luma-style app timeline (date rail, translucent cards, segmented control), pinned by the user from supplied screenshots, translated rather than copied. seed: none (user-pinned direction, no roll was run).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
