/**
 * The signed-in home.
 *
 * The product is named for hub worlds — Station Square, Majula — a central space
 * that connects you to everywhere else. That idea had no representation in the
 * UI: signing in dropped you into a vertical stack of every panel at once.
 *
 * So this answers the three questions someone actually arrives with: what do I
 * hold, what is happening right now, and where do I go next. Anything requiring a
 * decision lives on its own page.
 *
 * What it no longer has, and why. A row of three stat cards ("tickets held",
 * "live auctions", "next event") sat above everything, restating numbers the
 * sections below already show; the sections ARE the answer. A trio of shortcut
 * cards linked to the same three pages the nav bar already names. And a violet
 * aurora hung behind the greeting. Each was weight without information. The
 * shortcuts survive in exactly one place, the empty state, where there is
 * genuinely nowhere else to go.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import {
  fetchAuctions,
  fetchInventory,
  isOrganizer,
  type AuctionSummary,
  type OwnedTicket,
  type User,
} from "@/lib/api";
import { formatFiat } from "@/lib/fiat";
import { PageHeader } from "@/components/PageHeader";
import { TicketStage, TicketTimeline } from "@/components/HubTickets";
import { groupTickets } from "@/lib/hub-tickets";
import { useLinkHandler, type Route } from "@/lib/router";

function Countdown({ endsAt }: { endsAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const ms = new Date(endsAt).getTime() - now;
  if (ms <= 0) return <span className="text-muted-foreground">closed</span>;
  const m = Math.floor(ms / 60_000);
  if (m >= 60)
    return (
      <span>
        {Math.floor(m / 60)}h {m % 60}m left
      </span>
    );
  const s = Math.floor((ms % 60_000) / 1000);
  return (
    <span className="tabular-nums">
      {m}m {String(s).padStart(2, "0")}s left
    </span>
  );
}

function SectionHeader({
  title,
  href,
  label,
  onNavigate,
}: {
  title: string;
  href: Route;
  label: string;
  onNavigate: (e: React.MouseEvent) => void;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <h2 className="text-lg font-semibold tracking-[-0.01em]">{title}</h2>
      <a
        href={href}
        onClick={onNavigate}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded text-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
      >
        {label}
      </a>
    </div>
  );
}

export function Hub({
  me,
  onOpenAuction,
}: {
  me: User;
  onOpenAuction: (slug: string) => void;
}) {
  const [tickets, setTickets] = useState<OwnedTicket[]>([]);
  const [auctions, setAuctions] = useState<AuctionSummary[]>([]);
  const link = useLinkHandler();

  const load = useCallback(async () => {
    const [inv, auc] = await Promise.allSettled([
      fetchInventory(),
      fetchAuctions(),
    ]);
    if (inv.status === "fulfilled") setTickets(inv.value.tickets);
    if (auc.status === "fulfilled") setAuctions(auc.value);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = groupTickets(tickets);
  const hasTickets =
    groups.featured.length + groups.upcoming.length + groups.past.length > 0;

  return (
    <div className="space-y-10 pb-8">
      <PageHeader
        title={`Welcome back, @${me.username}`}
        description={
          <span
            className="font-mono text-xs break-all"
            title="Your wallet address"
          >
            {me.xrplAddress}
          </span>
        }
      />

      {auctions.length > 0 && (
        <section className="space-y-3">
          <SectionHeader
            title="Bidding now"
            href="/events"
            label="all events"
            onNavigate={link("/events")}
          />
          <ul className="space-y-3">
            {auctions.slice(0, 3).map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => onOpenAuction(a.eventSlug)}
                  className="surface surface-hover surface-live focus-visible:ring-ring group flex w-full items-center justify-between gap-4 p-5 text-left focus-visible:ring-2 focus-visible:outline-none"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="relative flex size-1.5 shrink-0"
                        aria-hidden
                      >
                        <span className="bg-live absolute inline-flex size-full animate-ping rounded-full opacity-70" />
                        <span className="bg-live relative inline-flex size-1.5 rounded-full" />
                      </span>
                      <span className="truncate font-semibold tracking-tight">
                        {a.eventTitle}
                      </span>
                    </div>
                    <div className="text-muted-foreground mt-1 text-sm">
                      {a.bidCount} bid{a.bidCount === 1 ? "" : "s"} ·{" "}
                      <Countdown endsAt={a.endsAt} />
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {/* Fans see US$ only: with no fresh price the figure is left out rather than shown in XRP. */}
                    {a.fiat?.topBidDrops && (
                      <div className="text-right">
                        <div className="font-mono text-lg font-semibold tabular-nums">{formatFiat(a.fiat.topBidDrops)}</div>
                        <div className="text-muted-foreground text-xs">top bid</div>
                      </div>
                    )}
                    <ArrowUpRight
                      className="text-muted-foreground group-hover:text-foreground size-4 transition-colors"
                      aria-hidden
                    />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {groups.featured.length > 0 && (
        <section className="space-y-5">
          <SectionHeader
            title="Your next tickets"
            href="/tickets"
            label="all tickets"
            onNavigate={link("/tickets")}
          />
          <TicketStage tickets={groups.featured} />
        </section>
      )}

      <TicketTimeline upcoming={groups.upcoming} past={groups.past} />

      {/* The way in for someone who wants to run events. Not shown to organizers, who
          have the page in their nav already; the link is to the application, which
          shows its own status once one has been sent. */}
      {!isOrganizer(me.role) && (
        <section className="surface flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <h2 className="font-semibold tracking-tight">
              Run your own events
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Apply to become an organizer, and earn a royalty on every resale.
            </p>
          </div>
          <a
            href="/organize"
            onClick={link("/organize")}
            className="text-foreground focus-visible:ring-ring rounded text-sm font-medium underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
          >
            Apply to organize
          </a>
        </section>
      )}

      {!hasTickets && auctions.length === 0 && (
        <div className="surface px-6 py-14 text-center">
          <h2 className="text-lg font-semibold tracking-[-0.01em]">
            Your hub is empty
          </h2>
          <p className="text-muted-foreground mx-auto mt-2 max-w-sm text-sm leading-relaxed">
            Tickets you buy, receive or win will appear here.
          </p>
          <a
            href="/events"
            onClick={link("/events")}
            className="bg-primary text-primary-foreground focus-visible:ring-ring mt-6 inline-flex h-11 items-center rounded-full px-5 text-sm font-medium transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none sm:h-10"
          >
            Browse events
          </a>
        </div>
      )}
    </div>
  );
}
