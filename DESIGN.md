---
name: HubWorld
description: Event ticketing on the XRP Ledger, set as a calm departures board on a near-black ground.
colors:
  night-ground: "#0e0e12"
  night-plate: "#15151b"
  night-ink: "#f2f2f5"
  night-ink-muted: "#9b9aa7"
  day-ground: "#f6f6f8"
  day-plate: "#ffffff"
  day-ink: "#101014"
  day-ink-muted: "#6b6a76"
  ink-action-night: "#f2f2f5"
  ink-action-day: "#101014"
  brand-violet-night: "#8b7cff"
  brand-violet-day: "#6d4aff"
  live-green-night: "#3fb463"
  live-green-day: "#15803d"
  fault-red-night: "#f0575c"
  fault-red-day: "#d03b3b"
typography:
  page-title:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.75rem"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-0.03em"
  row-title:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.375
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
  data:
    fontFamily: "Geist Mono Variable, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
rounded:
  thumb: "12px"
  surface: "16px"
  pill: "9999px"
spacing:
  row-gap: "20px"
  plate-padding: "20px"
  page-top: "48px"
components:
  surface:
    backgroundColor: "{colors.night-plate}"
    rounded: "{rounded.surface}"
    padding: "20px"
  button-action:
    backgroundColor: "{colors.ink-action-night}"
    textColor: "#0e0e12"
    rounded: "{rounded.pill}"
    height: "40px"
    padding: "0 16px"
---

# Design System: HubWorld

## Overview

**Creative North Star: "The Departures Board"**

HubWorld reads as a timetable: dates run down a left-hand rail, each event is a plate hung off that rail, and a small node on the rail says in one glance what state the night is in. Nothing is decorative that is not also information. The surface is near-black with a faint violet cast, plates are translucent and held by a hairline, and the only things that carry colour are the action a person can take and the one state that cannot wait.

The system was translated from Luma's app UI (date rail, translucent plates, a pill switch) rather than copied from it. What is HubWorld's own: the rail node encodes real state, the live-auction edge is the single place the interface is allowed to glow, and the thumbnail is a poster, not a square avatar.

The signed-out Landing page is a deliberate exception: a marketing surface that keeps a teal accent, tonal washes and a navy closing panel from its earlier design, and a photograph behind its hero verdict. The rules below govern the app screens.

**Key Characteristics:**
- Near-black ground, translucent 4% plates, hairline edges that brighten on hover. No resting shadows.
- Actions are neutral pills (near-white on dark, ink on light). Violet is the brand and marks where you are and what is in focus; green is the one state colour. Never swapped.
- Titles in tight 600-weight Geist; addresses, prices and times in Geist Mono or tabular figures.
- State is always written down as well as coloured.

## Colors

A neutral ground with a violet cast, neutral action pills, a violet brand accent, one state colour.

### Primary
- **Brand Violet** (#8b7cff on night, #6d4aff on day): where you are and what is in focus, never what to press. Keyboard focus, the current-page bar, the "on sale" ring on the timeline, links, text selection, the caret, a progress bar. Also the logo.
- **Action Ink** (#f2f2f5 on night, #101014 on day): the fill of every primary action. The strongest contrast either theme has, and indifferent to the colour a poster washes the page in.

### Secondary
- **Live Green** (#3fb463 night, #15803d day): a live auction, or a ticket admitted at the door, and nothing else, always paired with a label ("auction live", "Admitted") or an icon. It is also the rail node's filled, pulsing state.

### Neutral
- **Night Ground** (#0e0e12): the page. **Night Plate** (#15151b): solid surfaces such as dialogs. **Night Ink** (#f2f2f5) and **Night Ink Muted** (#9b9aa7): text.
- **Day Ground** (#f6f6f8), **Day Plate** (#ffffff), **Day Ink** (#101014), **Day Ink Muted** (#6b6a76): the light theme, tuned by hand rather than inverted.
- **Fault Red** (#f0575c night, #d03b3b day): errors and a cancelled event only.

### Named Rules
**The One Meaning Rule.** A neutral pill means "you can act", violet means "you are here, or this is focused", green means "live". A thumbnail, a chip or a chart that happens to land in either hue is moved out of it (see `offGreen` in `EventRow`).
**The Words Too Rule.** State is never carried by hue alone. A node is backed by a chip; a chip is backed by its label.

## Typography

**Display and body font:** Geist Variable (fallback `ui-sans-serif, system-ui, sans-serif`)
**Label/Mono font:** Geist Mono Variable, for wallet addresses, amounts and timestamps.

**Character:** One family doing every job at different weights, with the mono as a measuring tool, not a costume. Weight and tracking carry the hierarchy.

### Hierarchy
- **Page title** (600, 2.75rem at sm and up, 2.25rem below, 1.05): the one `h1` per page.
- **Row title** (600, 1.25rem, 1.375, -0.02em): an event's name.
- **Body** (400, 1rem, 1.5): descriptions, capped near 65ch by the page's own max widths.
- **Label** (500, 0.875rem): nav, tabs, buttons.
- **Data** (400, 0.75rem mono): addresses and build hashes.

### Named Rules
**The No Eyebrow Rule.** No small tracked-capital label above a heading. The heading carries its own weight.

## Layout

A single column inside a 72rem container with 1rem gutters. The Events page is a three-part grid on wide screens: a 7rem date column, a 1.5rem rail, and the plate. Below the `sm` breakpoint the rail disappears and each day's date heads its plates instead. Rows are separated by 20px of padding inside the plate column, not a gap, so the rail's line is continuous. The page title and its one control share a line and wrap rather than shrink.

## Elevation & Depth

Flat. Depth is tonal and edge-driven: a plate is a 4% white wash with a 1px border at 8% that rises to 18% on hover. There are no resting shadows. The one exception is dialogs, which keep the project's layered modal shadow. A live auction's plate takes a green border (42%) in place of any glow.

## Shapes

Soft but not round. Plates are 16px, thumbnails 12px, the tab switch's inner pills 0.65rem inside a 12px track, and every action is a full pill. Posters stay portrait (3:4) so artwork is not cropped to a square.

## Components

### Buttons
- **Shape:** full pill, 40px tall (44px on touch).
- **Action:** a neutral fill (near-white on night, ink on day) with the opposite colour as its text; opacity to 90% on hover. Disabled is the same pill at 50%.
- **Focus:** 2px ring in brand violet.

### Event row
- **Plate:** `surface` with `surface-hover`; `surface-live` adds the green edge.
- **Content:** time, title, organizer with a coloured monogram, venue, then chips and the one available action.
- **Thumbnail:** portrait poster, or a flat tile holding the date in a colour derived from the slug.

### Rail node
- A 12px circle: filled green with a pulse for a live auction, a violet ring where tickets can be bought, a dim dot otherwise. Decorative, because the chip says the same in words.

### Composer
- The create-event page: a 3:4 poster tile at left, and at right the event name as the largest thing on the page, a Starts plate beside a time-zone plate, a location plate, then one divided plate of options (price, tickets, royalty, resale, door) with each value right-aligned and its hint beneath. One full-width action closes it.
- Only fields the server takes appear. Rows for things that do not exist (calendar, visibility, theme, end time, description, approval) are absent, not disabled.
- A row lights up while its control has focus, so the target is the line, not a thin input inside it.
- The page behind it takes a soft wash of the chosen poster's dominant colour (see `.poster-wash`), fading to nothing. It is the one gradient the app screens allow, because the owner asked for it by name, and it is held to one hue, only while a poster with colour in it is chosen, and to a strength measured against muted text: at least 5.0:1 in dark and 4.6:1 in light with deliberately harsh posters. A poster with no colour gives no wash.

### Tab switch
- A pill track holding two or three tabs; the selected tab is a 10% foreground wash. Arrow keys move between tabs and only the selected one is in the tab order.

### Navigation
- Icon and label per destination, current page brighter with a 2px violet bar on the header's edge. Below `sm` it becomes a scrollable row of 44px targets.

## Do's and Don'ts

### Do:
- **Do** keep action pills neutral, violet for place and focus, and green for what is live.
- **Do** write state as a word as well as a colour.
- **Do** let an edge brighten on hover instead of adding a shadow.
- **Do** keep controls that cannot work absent, not disabled.

### Don't:
- **Don't** add a gradient to a surface, a headline word or a button on the app screens. The poster wash on the create page is the one allowed exception.
- **Don't** put a decorative glow on anything but a live auction.
- **Don't** put a kicker or tracked-capital label above a heading.
- **Don't** let a fallback thumbnail or chip land in the greens.
