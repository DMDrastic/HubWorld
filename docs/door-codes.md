# Door codes (QR door mode)

How an event lets people in is chosen per event (`Event.doorMode`): **`QR`**, where the
attendee shows a short-lived code and door staff scan it, or **`SIGNATURE`**, where staff
show a code and the attendee approves it in Xaman. This page is for turning the first one
on, running it, and knowing what it does and does not prove. The design reasoning is in
`CLAUDE.md` under "Check-in at the door".

## Turning it on

The feature is **off until `DOOR_TOKEN_SECRET` is set.** Without it every event keeps the
Xaman flow, the code routes answer 503, and the create-event form does not offer the choice.

1. Generate a secret of at least 32 characters, without printing it:

   ```sh
   openssl rand -hex 32 | pbcopy      # then paste it into Render; nothing is echoed
   ```

2. Set `DOOR_TOKEN_SECRET` on the service (it is declared `sync: false` in `render.yaml`).
3. Confirm: `GET /api/policy` now says `"doorCodes": true`, and the organizer's create
   form offers "Door: guests show a code (fast)".

Existing events stay on `SIGNATURE`. An organizer switches one from the Door page ("How
guests get in"), or `POST /api/events/:slug/door-mode`.

## Rotating or turning it off

Codes live 45 seconds and the server stores none, so **replacing the secret is the whole
rotation**: codes on screen stop scanning within a minute and the pages fetch new ones.
Unsetting it turns the feature off; events set to `QR` then answer 503 at the door until
they are switched back to `SIGNATURE`, so switch them first if an event is under way.

## What it proves, and what it does not

A code proves **possession of a logged-in HubWorld session** for the account that holds the
ticket right now. It does **not** prove a wallet key at the door. Someone who hands over an
unlocked phone, or screen-shares live, gets in. A screenshot does not work (the code is dead
within a minute) and a live forwarded code admits only the first person to present it; the
second is told "already checked in". For an event where that is not enough, leave it on
`SIGNATURE`.

## Testing it on a real phone

The staff camera needs a secure context, so **plain `http://` cannot scan** (the page says
so). Test against the deployed site or an https tunnel, not `localhost` from a phone. Check
iPhone Safari as the staff device in particular: it has no built-in QR detector, so it uses
the JavaScript decoder.

## Looking at what happened

Every scan leaves a `Redemption` row with `method = QR`, including a bad or expired code, so
"what did staff scan at 9:42" has an answer. A QR that is not a HubWorld code at all (a
poster, a menu) is refused on the phone without a row.
