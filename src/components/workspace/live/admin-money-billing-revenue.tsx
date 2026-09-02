/**
 * The revenue half of screen 2c, and the arithmetic behind it.
 *
 * ADMIN ONLY. Nothing in this file may be imported from a coach or affiliate surface: it states
 * the platform's own recurring revenue, which `CLAUDE.md` puts on the admin side of the wall. It
 * lives beside `admin-money-billing.tsx` rather than in the shared kit for exactly that reason --
 * `coach-economics-wall.test.ts` exempts any module an admin route can reach, so a shared home
 * would have made the wall stop policing this text.
 *
 * The one thing the screen has to get right is that its figures agree with each other. NET MRR,
 * the opening balance, the four movement slices and the net delta are one identity:
 *
 *     opening + new + upgrades + churn + downgrades = closing
 *
 * so every one of them is derived here from the projection's own numbers rather than read from a
 * separate source that could drift. `netRevenueRetention` is the same identity with new business
 * removed, which is what retention means: what the book we already had did on its own.
 */

import type { ReactNode } from "react";

import { absentValue } from "@/components/kit/columns";
import { ConsoleRow, ConsoleSubstat } from "@/components/kit/console-deck";
import { DeckPanel } from "@/components/kit/deck-panel";
import {
  Figure,
  Legend,
  MonoMeta,
  Overline,
  SplitBar,
  StatusDot,
  type LegendItem,
  type SplitSegment,
  type Tone,
} from "@/components/kit/atomics";
import { workspaceDateFormat } from "@/lib/format/datetime";
import { formatMetric, money } from "@/lib/format/metric";
import type { MrrMovementRead } from "@/lib/repositories/billing";

/** A zero and an unknown are different facts, so an absent figure never formats as an amount. */
export function signedMoney(cents: number | null): string | null {
  return cents === null ? null : `${cents >= 0 ? "+" : "−"}${money(Math.abs(cents), "USD")}`;
}

export type MovementSegment = {
  key: "new" | "upgrades" | "churn" | "downgrades";
  label: string;
  /** Kept for the pinned column-direction contract in `money-portals.test.ts`. */
  direction: "up" | "down" | "warn";
  tone: Tone;
  /** The dimmer slice of a pair: upgrades beside new, downgrades beside churn. */
  secondary: boolean;
  cents: number | null;
};

export type RevenueMovementView = {
  /** Always four, always in this order. The bar, the legend and the net all read from it. */
  segments: readonly MovementSegment[];
  /** Every slice resolved. A bar missing one would draw a composition nobody measured. */
  complete: boolean;
  netCents: number | null;
  openingCents: number | null;
  closingCents: number | null;
  /** A percentage, not a ratio: 107 means 107%. Null unless the opening base is a real positive. */
  netRevenueRetention: number | null;
  windowLabel: string;
};

/**
 * Every figure the revenue card prints, from the one projection.
 *
 * `openingCents` is the closing balance minus the net movement rather than a second query, which
 * is what makes "90,240 → 96,420" impossible to disagree with the four slices under it: it is the
 * same subtraction the reader would do. If any slice is unresolved the whole chain goes null,
 * because an opening balance computed from three of four movements is a wrong number rather than
 * an imprecise one.
 */
export function deriveRevenueMovement(movement: MrrMovementRead | null): RevenueMovementView | null {
  if (!movement) return null;

  const segments: MovementSegment[] = [
    { key: "new", label: "New", direction: "up", tone: "good", secondary: false, cents: movement.newCents },
    { key: "upgrades", label: "Upgrades", direction: "up", tone: "good", secondary: true, cents: movement.upgradeCents },
    { key: "churn", label: "Churn", direction: "down", tone: "failure", secondary: false, cents: movement.churnCents },
    { key: "downgrades", label: "Downgrades", direction: "warn", tone: "failure", secondary: true, cents: movement.downgradeCents },
  ];

  const complete = segments.every((segment) => segment.cents !== null);
  const netCents = complete
    ? segments.reduce((sum, segment) => sum + (segment.cents ?? 0), 0)
    : null;
  const closingCents = movement.mrrCents;
  const openingCents = closingCents === null || netCents === null ? null : closingCents - netCents;

  // Retention is what the opening book did without help from new business, so `new` is the one
  // slice left out. A non-positive opening base has no retention to state, and dividing by it
  // would have produced an Infinity the card would happily have printed as a percentage.
  const expansionAndContraction = complete
    ? (movement.upgradeCents ?? 0) + (movement.churnCents ?? 0) + (movement.downgradeCents ?? 0)
    : null;
  const netRevenueRetention =
    openingCents !== null && openingCents > 0 && expansionAndContraction !== null
      ? ((openingCents + expansionAndContraction) / openingCents) * 100
      : null;

  return {
    segments,
    complete,
    netCents,
    openingCents,
    closingCents,
    netRevenueRetention,
    windowLabel: `${workspaceDateFormat.format(new Date(movement.windowStart))} to ${workspaceDateFormat.format(new Date(movement.asOf))}`,
  };
}

/**
 * The bar's slices, in the order they are drawn, as magnitudes.
 *
 * The bar shows composition, so a churn of −$3,220 contributes 3,220 of width; the tone and the
 * signed figure in the legend carry the direction. Only called once `complete` is true.
 */
export function movementSegments(view: RevenueMovementView): SplitSegment[] {
  return view.segments.map((segment) => ({
    label: segment.label,
    tone: segment.tone,
    secondary: segment.secondary,
    value: Math.abs(segment.cents ?? 0),
  }));
}

/**
 * The key under the bar, built from the same four numbers the bar is.
 *
 * `data-direction` rides on the label so the four columns keep the up / up / down / warn contract
 * the money-portals guard pins, and so the legend can never list the slices in an order the bar
 * does not draw them in.
 */
export function movementLegendItems(view: RevenueMovementView): LegendItem[] {
  return view.segments.map((segment): LegendItem => {
    const amount = signedMoney(segment.cents);
    return {
      tone: segment.tone,
      label: <span data-direction={segment.direction}>{segment.label}</span>,
      value: amount ?? absentValue("not resolved by the projection"),
    };
  });
}

/**
 * The movement region: what moved recurring revenue over the window, and what the projection
 * could not count.
 *
 * One bar and one legend rather than four boxed figures, which is the point of the screen it comes
 * from: four numbers in four cards cannot show that churn ate most of what new business brought
 * in. The caveats sit directly under the claim instead of behind a disclosure, because a figure
 * whose limits are one press away is a figure most readers will quote without them.
 */
export function MovementDisclosure({ movement }: { movement: MrrMovementRead | null }) {
  const view = deriveRevenueMovement(movement);

  if (!movement || !view) {
    return (
      <p className="m-0 text-[length:var(--t-body)] text-[color:var(--muted)]" role="status">
        Monthly movement is unavailable. The movement projection could not be read, so no
        breakdown is shown.
      </p>
    );
  }

  const opening = view.openingCents === null ? null : money(view.openingCents, "USD");
  const closing = view.closingCents === null ? null : money(view.closingCents, "USD");
  const net = signedMoney(view.netCents);

  return (
    <div data-slot="movement-disclosure">
      <div className="flex flex-wrap items-baseline gap-x-[var(--s-3)] gap-y-[var(--s-1)]">
        <Overline>Movement this month</Overline>
        {opening && closing ? (
          <MonoMeta>
            {opening} → {closing}
          </MonoMeta>
        ) : (
          <span className="text-[11.5px]">{absentValue("not resolved by the projection")}</span>
        )}
      </div>

      <p className="mt-[var(--s-1)] mb-[var(--s-3)] text-[11.5px] leading-[1.45] text-[color:var(--faint)]">
        Monthly movement, {view.windowLabel}.
      </p>

      {view.complete ? (
        <SplitBar
          className="mb-[11px]"
          label={`Movement over the window: ${view.segments
            .map((segment) => `${segment.label} ${signedMoney(segment.cents)}`)
            .join(", ")}`}
          segments={movementSegments(view)}
        />
      ) : (
        // Three slices drawn out of four would read as a composition rather than as an
        // incomplete one, so the bar is withheld and the legend still names every figure.
        <p className="mb-[11px] text-[11.5px] leading-[1.45] text-[color:var(--muted)]">
          The movement bar is withheld while a slice is unresolved: a bar drawn from three of the
          four would show a shape the projection did not measure.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-[22px] gap-y-[var(--s-2)]">
        <Legend items={movementLegendItems(view)} />
        <span className="ml-auto flex items-center gap-[var(--s-2)]">
          <span className="text-[12px] text-[color:var(--muted)]">Net</span>
          {net === null ? (
            absentValue("not resolved by the projection")
          ) : (
            <Figure size="sm" tone={(view.netCents ?? 0) >= 0 ? "good" : "failure"}>
              {net}
            </Figure>
          )}
        </span>
      </div>

      <ul className="mt-[var(--s-3)] flex flex-col gap-[var(--s-1)] text-[11.5px] leading-[1.45] text-[color:var(--muted)]">
        {movementCaveats(movement).map((caveat) => (
          <li key={caveat}>{caveat}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What the projection could not count, in its own words.
 *
 * Kept here rather than derived in the component so the sentences are testable on their own, and
 * so the tier-reassignment gap is stated on every render that carries it rather than whenever
 * somebody remembers.
 */
export function movementCaveats(movement: MrrMovementRead): string[] {
  const caveats: string[] = [];
  if (movement.missingSources.includes("tier_reassignment")) {
    caveats.push(
      "Tier reassignment is not counted: no row records a tenant's previous tier, so a move between tiers leaves nothing to replay.",
    );
  }
  caveats.push(movement.scheduledCancellations === 1
    ? "1 subscription is scheduled to cancel at period end and is not counted until it takes effect."
    : `${movement.scheduledCancellations} subscriptions are scheduled to cancel at period end and are not counted until they take effect.`);
  if (movement.missingSources.includes("unpriced_tenant")) {
    caveats.push("A tenant with no resolvable price leaves the figure unavailable rather than zero.");
  }
  if (movement.missingSources.includes("unpriced_at_window_start")) {
    caveats.push(
      "A tenant whose price at the window start cannot be resolved is left out of upgrades and downgrades rather than read as no movement.",
    );
  }
  return caveats;
}

export type RevenueCardProps = {
  movement: MrrMovementRead | null;
  /**
   * Whether the headline figure resolves, and the words for when it does not. It is passed in
   * rather than recomputed so the card and the availability contract in `movementTile` can never
   * disagree about whether the platform has priced evidence.
   */
  headline: { kind: "value"; cents: number } | { kind: "unavailable"; note: string };
};

/**
 * The revenue card: the one figure the page is opened for, the retention it implies, and the
 * movement that produced it, in that order under a hairline.
 *
 * There is no trend line, and that is a data gap rather than a design choice: the only history
 * series the platform records is signup counts (`platform_history_series`), so a twelve-month MRR
 * sparkline has nothing to read from. Drawing one from a single point would be an invented shape.
 */
export function RevenueCard({ headline, movement }: RevenueCardProps) {
  const view = deriveRevenueMovement(movement);
  const delta = view ? signedMoney(view.netCents) : null;
  const retention = view?.netRevenueRetention ?? null;

  /*
   * The footer's three figures.
   *
   * The canvas draws model spend, gross margin and cost per booked call here. This page cannot
   * honestly print any of them: the subscription mirror it reads carries no price and no cost,
   * and those three are source-backed on `/admin/billing/costs`, which is one quiet link away in
   * the page header. So the footer carries the two figures this projection does resolve -- what
   * the book did without new business, and what the four movement slices net to -- and the third
   * slot stays empty rather than being filled with a number computed somewhere the page cannot
   * show its work for. That is the same rule the missing plan-mix split follows below.
   */
  const footerItems = [
    {
      label: "Net revenue retention",
      value: retention === null
        ? absentValue("no priced opening balance")
        : formatMetric(retention, "percent"),
    },
    {
      label: "Net movement this month",
      value: delta ?? absentValue("not resolved by the projection"),
    },
  ];

  return (
    <DeckPanel
      className="min-w-0"
      drench="live"
      eyebrow="Recurring revenue, this month"
      figure={headline.kind === "value"
        ? money(headline.cents, "USD")
        : <span className="text-[length:var(--t-body)]">{absentValue(headline.note)}</span>}
      footer={<ConsoleSubstat items={footerItems} />}
      headingId="revenue-card-title"
      hero
      name="Net MRR"
      sentence={view
        ? `Upgrades, churn and downgrades against the opening balance, ${view.windowLabel}. New business excluded from retention.`
        : "The movement projection could not be read, so no window is claimed."}
    >
      <div className="mt-[16px] border-t border-[var(--console-on-drench-line,var(--line))] pt-[14px]">
        <MovementDisclosure movement={movement} />
      </div>
    </DeckPanel>
  );
}

export type AtRiskAccount = {
  tenantId: string;
  businessName: string;
  /** What the mirror says is wrong, in words. Never a score, a guess, or a staleness heuristic. */
  reason: string;
  tone: Extract<Tone, "failure" | "warning">;
};

/**
 * Accounts at risk this cycle.
 *
 * Every reason is a field the provider mirror actually carries -- a past-due status, an admin
 * suspension, a cancellation flag, a scheduled plan change -- so the card names a fact and not a
 * judgement. There is deliberately no engagement or usage signal here: nothing on this screen
 * records a last login, and "no login in 6 days" invented in the component would be exactly the
 * fabricated advisory statistic the system rejects.
 *
 * There is no dollar total either. The subscription mirror this screen reads carries no price, so
 * a figure would have to come from somewhere the page cannot show its work for.
 */
export function AtRiskCard({ accounts }: { accounts: readonly AtRiskAccount[] }) {
  if (accounts.length === 0) {
    return (
      <DeckPanel
        eyebrow="Needs a human"
        headingId="at-risk-title"
        name="Nothing is in trouble"
        sentence="No account is past due, suspended, cancelling, or carrying a scheduled plan change."
      />
    );
  }

  return (
    <DeckPanel
      className="console-panel--flush"
      eyebrow="Needs a human"
      headingId="at-risk-title"
      name={accounts.length === 1
        ? "One subscription in trouble"
        : `${accounts.length} subscriptions in trouble`}
    >
      {/* The mark never carries the state on its own: the sentence under the name says what is
          wrong in words, which is the Never-Colour-Alone rule and also the only way a reader can
          tell a card decline from a scheduled plan change. */}
      {accounts.map((account) => (
        <ConsoleRow
          key={account.tenantId}
          mark={<StatusDot tone={account.tone} />}
          name={account.businessName}
          sentence={account.reason}
        />
      ))}

      <p className="m-0 px-[18px] py-[12px] text-[11px] leading-[1.45] text-[color:var(--faint)]">
        No dollar figure: the subscription mirror carries no price per account, so the revenue at
        risk cannot be shown from what this screen reads.
      </p>
    </DeckPanel>
  );
}

/**
 * What the book is made of, at the resolution the data supports.
 *
 * The artifact draws a plan mix here -- MRR split across Growth, Scale and Starter. The mirror
 * this screen reads carries no tier and no price per subscription, so the split by plan cannot be
 * drawn honestly; what it does carry is how many subscriptions stand on a provider receipt and
 * what state they are in, which answers the same question one level coarser.
 */
export function BookCompositionCard({ rows }: { rows: readonly { label: string; value: ReactNode; tone?: Tone }[] }) {
  return (
    /* The name is not "Subscriptions": the table under this deck is already a region with that
       accessible name, and two landmarks called the same thing leave neither addressable by name.
       The panel is the composition of the book, so it says so. */
    <DeckPanel
      eyebrow="The book"
      headingId="book-composition-title"
      name="What the book is made of"
    >
      {/* The row shape -- a dt beside a dd inside one flex parent -- is what
          `admin-money-billing.test.tsx` reads when it asserts that "Live subscriptions" and its
          count share a parent. Keep them siblings under one element. */}
      <dl className="m-0 flex flex-col gap-[9px]">
        {rows.map((row) => (
          <div className="flex items-baseline justify-between gap-[var(--s-3)]" key={row.label}>
            <dt className="min-w-0 truncate text-[12.5px] text-[color:var(--muted)]">{row.label}</dt>
            <dd className="m-0 shrink-0">
              {typeof row.value === "string" || typeof row.value === "number" ? (
                <Figure size="sm" tone={row.tone ?? "neutral"}>
                  {row.value}
                </Figure>
              ) : (
                row.value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </DeckPanel>
  );
}
