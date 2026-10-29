/**
 * Your tickets on the Hub: a few that float, then a timeline for the rest.
 *
 * The Hub used to list up to three plain rows. A ticket is the one thing here worth looking
 * at, so the soonest ones (never more than four, see `FEATURED_MAX`) are posters, tilted a
 * few degrees and drifting on their own slow cycles like the landing page's cloud. Everything
 * beyond them goes on a timeline in the same shape as the Events page (date on the left, a
 * rail, a plate per ticket, the poster as its thumbnail), with Upcoming and Past views.
 *
 * What is kept from the plain version, because each is a fact and not a style:
 * - Status is a WORD on the ticket ("listed", "in auction", "used"), never only a tint.
 * - The tilt is on the outer element and the drift on a wrapper inside it, so one can never
 *   overwrite the other (see `.float-y` in index.css), and reduced motion leaves every poster
 *   at rest, straight where it was placed.
 * - A ticket with no poster shows its date tile instead of a broken image.
 */
import { useId, useState } from "react";
import { MapPin } from "lucide-react";
import { FallbackThumb } from "@/components/EventRow";
import { Segmented } from "@/components/Segmented";
import type { OwnedTicket } from "@/lib/api";
import { posterSrcSet, posterUrl } from "@/lib/poster";
import { useLinkHandler } from "@/lib/router";

const dayFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const dayYearFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const shortDayFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

/** "Oct 5", or "Oct 5, 2027" when the year is not this one. */
function formatDay(when: Date): string {
  return when.getFullYear() === new Date().getFullYear()
    ? dayFmt.format(when)
    : dayYearFmt.format(when);
}

/** The words on a ticket whose state is not simply "yours and unused". */
function statusWord(t: OwnedTicket): string | null {
  if (t.status === "REDEEMED") return "used";
  if (t.status === "LISTED") return "listed";
  if (t.status === "IN_AUCTION") return "in auction";
  return null;
}

function Poster({ ticket }: { ticket: OwnedTicket }) {
  const { event } = ticket;
  return event.imageUrl ? (
    <img
      src={posterUrl(event.imageUrl, 480)}
      srcSet={posterSrcSet(event.imageUrl, 480)}
      alt=""
      loading="lazy"
      decoding="async"
      className="absolute inset-0 size-full object-cover"
    />
  ) : (
    <FallbackThumb event={event} />
  );
}

/**
 * Where each floating poster sits: its tilt, how far it drifts, how long a cycle takes, and a
 * negative delay so the stage is already mid-motion on first paint and no two rise together.
 * Position in the row follows the soonest-first order, so the first poster is the next night.
 */
const FLOATS: ReadonlyArray<{
  tilt: number;
  drop: string;
  float: readonly [number, number, number];
}> = [
  { tilt: -3, drop: "", float: [9, 7.4, -1.2] },
  { tilt: 2, drop: "sm:mt-8", float: [11, 8.6, -4.8] },
  { tilt: -2, drop: "", float: [8, 6.8, -3.1] },
  { tilt: 3, drop: "sm:mt-8", float: [10, 9.2, -6.4] },
];

export function TicketStage({ tickets }: { tickets: OwnedTicket[] }) {
  const link = useLinkHandler();
  return (
    <ul
      aria-label="Your next tickets"
      className="grid grid-cols-2 gap-x-5 gap-y-9 sm:grid-cols-4 sm:gap-x-6"
    >
      {tickets.map((t, i) => {
        const slot = FLOATS[i % FLOATS.length]!;
        const [distance, seconds, delay] = slot.float;
        const when = new Date(t.event.startsAt);
        const word = statusWord(t);
        const seat = [t.tier, t.seat].filter(Boolean).join(" · ");
        return (
          <li
            key={t.nfTokenId}
            className={slot.drop}
            style={{ transform: `rotate(${slot.tilt}deg)` }}
          >
            <div
              className="float-y"
              style={
                {
                  "--float-distance": `${distance}px`,
                  "--float-duration": `${seconds}s`,
                  animationDelay: `${delay}s`,
                } as React.CSSProperties
              }
            >
              <a
                href="/tickets"
                onClick={link("/tickets")}
                className="focus-visible:ring-ring group block rounded-xl focus-visible:ring-2 focus-visible:outline-none"
              >
                <div className="relative aspect-3/4 overflow-hidden rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] shadow-[0_10px_28px_-10px_rgb(0_0_0/0.55)] transition-transform duration-300 group-hover:-translate-y-1 group-hover:scale-[1.04]">
                  <Poster ticket={t} />
                  {word && (
                    // A flat dark pill with white text over the artwork, so it reads on any poster.
                    <span className="absolute top-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
                      {word}
                    </span>
                  )}
                </div>
                <div className="mt-3 min-w-0">
                  <div className="truncate font-semibold tracking-tight">
                    {t.event.title}
                  </div>
                  <div className="text-muted-foreground text-sm tabular-nums">
                    {shortDayFmt.format(when)} · {timeFmt.format(when)}
                  </div>
                  {seat && (
                    <div className="text-muted-foreground truncate text-sm">
                      {seat}
                    </div>
                  )}
                </div>
              </a>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function TicketRow({
  ticket,
  showDate,
  first,
  last,
}: {
  ticket: OwnedTicket;
  showDate: boolean;
  first: boolean;
  last: boolean;
}) {
  const link = useLinkHandler();
  const when = new Date(ticket.event.startsAt);
  const word = statusWord(ticket);
  const seat = [ticket.tier, ticket.seat].filter(Boolean).join(" · ");
  const NODE_Y = "1.75rem";

  return (
    <li className="grid sm:grid-cols-[7rem_1.5rem_minmax(0,1fr)] sm:gap-x-4">
      <div className="hidden pt-[1.15rem] sm:block">
        {showDate && (
          <>
            <div className="font-medium tracking-tight">{formatDay(when)}</div>
            <div className="text-muted-foreground text-sm">
              {weekdayFmt.format(when)}
            </div>
          </>
        )}
      </div>

      <div className="relative hidden sm:block" aria-hidden>
        <div
          className="bg-border absolute left-1/2 w-px -translate-x-1/2"
          style={{
            top: first ? NODE_Y : 0,
            bottom: last ? `calc(100% - ${NODE_Y})` : 0,
          }}
        />
        <div
          className="bg-foreground/25 absolute left-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ top: NODE_Y }}
        />
      </div>

      <div className={last ? "" : "pb-5"}>
        {showDate && (
          <div className="mt-6 mb-2 first:mt-0 sm:hidden">
            <span className="font-medium tracking-tight">
              {formatDay(when)}
            </span>
            <span className="text-muted-foreground">
              {" "}
              · {weekdayFmt.format(when)}
            </span>
          </div>
        )}
        <a
          href="/tickets"
          onClick={link("/tickets")}
          className="surface surface-hover focus-visible:ring-ring flex gap-4 p-4 focus-visible:ring-2 focus-visible:outline-none sm:p-5"
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="text-muted-foreground text-sm tabular-nums">
              {timeFmt.format(when)}
            </p>
            <h3 className="font-heading mt-1 text-xl leading-snug font-semibold tracking-[-0.02em] text-balance">
              {ticket.event.title}
            </h3>
            {ticket.event.venue && (
              <p className="text-muted-foreground mt-2 flex items-center gap-2 text-sm">
                <MapPin className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{ticket.event.venue}</span>
              </p>
            )}
            {seat && (
              <p className="text-muted-foreground mt-1 text-sm">{seat}</p>
            )}
            {word && (
              <span className="bg-foreground/8 text-foreground/80 mt-3 inline-flex h-6 w-fit items-center rounded-full px-2.5 text-xs font-medium">
                {word}
              </span>
            )}
          </div>
          <div className="relative aspect-3/4 w-20 shrink-0 self-start overflow-hidden rounded-xl sm:w-28">
            <Poster ticket={ticket} />
          </div>
        </a>
      </div>
    </li>
  );
}

const VIEWS = [
  { value: "upcoming", label: "Upcoming" },
  { value: "past", label: "Past" },
] as const;
type View = (typeof VIEWS)[number]["value"];

function Timeline({ tickets }: { tickets: OwnedTicket[] }) {
  return (
    <ul>
      {tickets.map((t, i) => {
        const day = (x: OwnedTicket) =>
          new Date(x.event.startsAt).toDateString();
        return (
          <TicketRow
            key={t.nfTokenId}
            ticket={t}
            showDate={i === 0 || day(t) !== day(tickets[i - 1]!)}
            first={i === 0}
            last={i === tickets.length - 1}
          />
        );
      })}
    </ul>
  );
}

/**
 * Everything that is not floating. Hidden entirely when there is nothing to put in it, because
 * an empty "Past" under someone's first ticket is a section about nothing.
 */
export function TicketTimeline({
  upcoming,
  past,
}: {
  upcoming: OwnedTicket[];
  past: OwnedTicket[];
}) {
  const id = useId();
  // Only an explicit choice is remembered. The default is DERIVED each render, because the
  // tickets arrive after first paint: a default captured on the first render (when both lists
  // are still empty) would stick on "past" and show last month before next week.
  const [chosen, setChosen] = useState<View | null>(null);
  if (upcoming.length === 0 && past.length === 0) return null;

  const both = upcoming.length > 0 && past.length > 0;
  const shown: View = both
    ? (chosen ?? "upcoming")
    : upcoming.length > 0
      ? "upcoming"
      : "past";
  const title = both
    ? "More tickets"
    : shown === "upcoming"
      ? "More tickets"
      : "Past tickets";

  return (
    <section className="space-y-4" aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id={`${id}-title`}
          className="text-lg font-semibold tracking-[-0.01em]"
        >
          {title}
        </h2>
        {both && (
          <Segmented
            label="Show tickets"
            options={VIEWS}
            value={shown}
            onChange={setChosen}
            idBase={`${id}-view`}
            panelId={`${id}-panel`}
          />
        )}
      </div>
      <div
        role={both ? "tabpanel" : undefined}
        id={`${id}-panel`}
        aria-labelledby={both ? `${id}-view-${shown}` : undefined}
      >
        <Timeline tickets={shown === "upcoming" ? upcoming : past} />
      </div>
    </section>
  );
}
