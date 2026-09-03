"use client";

/**
 * The owner Money page, rehaul face.
 *
 * Five surfaces became one page with a `?tab=` row: Billing, Costs, Tiers, Affiliates,
 * Corrections. Nothing here reads anything new. The Billing tab is redrawn against the artboard
 * from the data `/admin/billing` already loads -- the movement projection and the subscription
 * mirror -- and the other four render the surfaces that already exist, inside this page's chrome
 * instead of their own.
 *
 * What the artboard asks for that the platform cannot say, and what stands in its place:
 *
 * - The 1M / 3M / 12M window segment is one item. It labels the movement window, and
 *   `projectMrrMovement` resolves the current month and nothing else, so a three- or
 *   twelve-month movement window would be a control over slices nobody computed. The
 *   twelve-month recurring-revenue series is drawn as its own chart instead.
 * - Every explainer sentence the five surfaces printed under a heading is off this page; the ones
 *   a reader still needs are handed to the eye.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { BarChart } from "@/components/kit/bar-chart";
import { absentValue } from "@/components/kit/columns";
import { DataState } from "@/components/kit/data-state";
import { ExportMenu } from "@/components/kit/export-menu";
import { KeyValue } from "@/components/kit/key-value";
import { RecordSheet } from "@/components/kit/record-sheet";
import type { Result } from "@/components/kit/confirm-flow";
import { TechnicalDetail } from "@/components/kit/technical-detail";
import {
  AccountStateConfirmFlow,
  CostRevenueTrend,
  SUBSCRIPTION_EXPORT,
  accountStateLabel,
  atRiskFrom,
  costSummary,
  displayDate,
  exportSubscriptionRows,
  normalizeSubscriptionRows,
  postStatus,
  providerEvidenceLabel,
  receiptBackedCount,
  renewalMovementLabel,
  subscriptionMovementLabel,
  subscriptionStatePresentation,
  subscriptionViewBucket,
  type AccountState,
  type SubscriptionRow,
} from "@/components/workspace/live/admin-money-billing";
import {
  AdminMoneyBillingCosts,
  fetchCostRows,
  normalizeCostRows,
  type CostRow,
} from "@/components/workspace/live/admin-money-billing-costs";
import {
  deriveRevenueMovement,
  signedMoney,
} from "@/components/workspace/live/admin-money-billing-revenue";
import { AdminMoneyAffiliates } from "@/components/workspace/live/admin-money-affiliates";
import { CorrectionQueue } from "@/components/workspace/live/admin-money-corrections";
import {
  AdminMoneyTiers,
  type ClientPricingByTenantId,
  type StripeReadinessReceipt,
  type TierImpactById,
} from "@/components/workspace/live/admin-money-tiers";
import type { PricingHistoryEntry } from "@/components/workspace/live/admin-money-pricing-history";
import {
  MoneySurfaceGuard,
  type MoneyActorRole,
} from "@/components/workspace/live/admin-money-shell";
import type { CorrectionEvidence } from "@/components/workspace/live/view-models";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import {
  CARD_TABLE,
  CardTable,
  Figure,
  Pill,
  RehaulTabs,
  Seg,
  StatusDot,
  type StatusTone,
} from "@/components/workspace/rehaul/_primitives";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { OWNER_MONEY_TABS, type OwnerMoneyTab } from "@/lib/console-tabs";
import { workspaceCountFormat } from "@/lib/format/datetime";
import { formatMetric, money } from "@/lib/format/metric";
import type {
  MoneyBillingRead,
  MoneyMrrPeriod,
  MrrMovementRead,
} from "@/lib/repositories/billing";
import type { MoneyRefusalRecord } from "@/lib/repositories/money-page-audit";

const TAB_LABELS: Record<OwnerMoneyTab, string> = {
  affiliates: "Affiliates",
  billing: "Billing",
  corrections: "Corrections",
  costs: "Costs",
  tiers: "Tiers",
};

/** The tiers tab's server reads, bundled so the page hands them straight through. */
export type OwnerMoneyTiersData = {
  clientPricingByTenantId: ClientPricingByTenantId | null;
  pricingHistory: PricingHistoryEntry[] | null;
  stripeActionHref: string;
  stripeReadinessReceipt: StripeReadinessReceipt | null;
  tierImpactById: TierImpactById | null;
};

export type OwnerMoneyProps = {
  /** The tab in the URL. The page loaded the data for this one and no other. */
  tab: OwnerMoneyTab;
  actorRole: MoneyActorRole;
  enabled: boolean;
  /** Whether this reader carries the active tab. Corrections is the one a success role carries. */
  authorized: boolean;
  refusalRecord?: MoneyRefusalRecord;
  /** Billing tab. */
  movement?: MrrMovementRead | null;
  /**
   * The month-end recurring-revenue series and the priced client rows behind the table's Plan and
   * MRR columns. Absent where the read failed, which leaves the chart and both columns saying so
   * rather than drawing a figure nothing stands behind.
   */
  billing?: MoneyBillingRead | null;
  initialRows?: readonly Record<string, unknown>[];
  initialCostRows?: readonly Record<string, unknown>[];
  /** Affiliates tab. */
  affiliatesEnabled?: boolean;
  /** Tiers tab. */
  tiers?: OwnerMoneyTiersData;
  /** Corrections tab. */
  corrections?: readonly CorrectionEvidence[];
  correctionsReadFailure?: { code: string; reason: string } | null;
  /**
   * The two amber tab counts. They are numbers only where the page actually read them: the tab
   * row is drawn on every tab but the page loads one tab's data, so a count it did not read stays
   * absent rather than printing a zero nobody measured.
   */
  pendingApprovals?: number | null;
  openCorrections?: number | null;
};

const EYE_COPY = [
  "Billing shows what the platform bills and which subscriptions are in trouble. Recurring revenue by month is drawn from month-end subscription receipts, and a month the platform could not price is left out of the series rather than drawn as a zero; cost against revenue is source-backed on the Costs tab.",
  "Net revenue retention is what the opening book did without new business: upgrades, churn and downgrades against the opening balance. A movement slice the projection could not resolve withholds the bar rather than drawing three of four.",
  "Costs, Tiers, Affiliates and Corrections are the same surfaces as before, and each keeps its own role gate. Corrections is the one Money tab a success reviewer carries; the other four are open to the platform owner and admins only, because they print cost against revenue.",
].join(" ");

/* --------------------------------------------------------------------------------------------
 * Billing tab
 * ------------------------------------------------------------------------------------------ */

/** Worst first, in the same decision order the folded table's bands used. */
const BUCKET_RANK: Record<string, number> = {
  "Past due": 0,
  Cancelling: 1,
  Paused: 2,
  Trial: 3,
  "Payment setup expired": 4,
  "Payment setup pending": 5,
  Active: 6,
  Cancelled: 7,
  "No provider state": 8,
};

function bucketRank(row: SubscriptionRow) {
  return BUCKET_RANK[subscriptionViewBucket(row)] ?? 5.5;
}

const STATE_TONE: Record<string, StatusTone> = {
  Active: "good",
  Cancelled: "grey",
  Cancelling: "amber",
  "No provider state": "grey",
  Paused: "wait",
  "Past due": "bad",
  "Payment setup expired": "bad",
  "Payment setup pending": "amber",
  Trial: "wait",
};

/** A count renders as a figure, or says in words that no receipt stands behind it. */
function countText(count: number | null) {
  return count === null ? null : workspaceCountFormat.format(count);
}

type MovementBar = {
  key: string;
  label: string;
  amount: string | null;
  width: number;
  tone: "good" | "bad" | "amber";
};

/**
 * The net movement line sits on the dark card, so it cannot use `--muted` / `--warning-text`:
 * those tokens are tuned for ink on a light ground. These are the dark-card equivalents of the
 * same three meanings, and only a positive net gets the green.
 */
type NetTone = "up" | "flat" | "down" | "unresolved";

const NET_INK: Record<NetTone, string> = {
  down: "text-[oklch(0.82_0.10_32)]",
  flat: "text-[oklch(0.78_0.02_262)]",
  unresolved: "text-[oklch(0.78_0.02_262)]",
  up: "text-[oklch(0.78_0.12_164)]",
};

const BAR_TONE: Record<MovementBar["tone"], string> = {
  amber: "bg-[oklch(0.6409_0.115_71)]",
  bad: "bg-[oklch(0.6503_0.135_32)]",
  good: "bg-[oklch(0.6237_0.095_164)]",
};

/**
 * The four movement bars, scaled against the largest slice on the card.
 *
 * The scale is the slices themselves rather than a fixed ceiling, because there is no ceiling: a
 * month's churn has no maximum, and inventing one would draw a real number as a fraction of a
 * threshold nobody set. A slice the projection could not resolve gets no bar at all and says so
 * in words, which is the same rule `MovementDisclosure` follows when it withholds its bar.
 */
function movementBars(movement: MrrMovementRead | null): readonly MovementBar[] {
  const view = deriveRevenueMovement(movement);
  if (!view) return [];
  const largest = Math.max(
    ...view.segments.map((segment) => Math.abs(segment.cents ?? 0)),
    1,
  );
  return view.segments.map((segment) => ({
    key: segment.key,
    label: segment.label,
    amount: signedMoney(segment.cents),
    width: segment.cents === null ? 0 : Math.abs(segment.cents) / largest,
    tone: segment.key === "downgrades" ? "amber" : segment.tone === "good" ? "good" : "bad",
  }));
}

function NetMrrCard({ movement }: { movement: MrrMovementRead | null }) {
  const view = deriveRevenueMovement(movement);
  const bars = movementBars(movement);
  const net = view ? signedMoney(view.netCents) : null;
  const netCents = view ? view.netCents : null;
  const netTone: NetTone = net === null || netCents === null
    ? "unresolved"
    : netCents < 0
      ? "down"
      : netCents === 0
        ? "flat"
        : "up";
  const headline = movement && movement.mrrCents !== null ? money(movement.mrrCents, "USD") : null;

  return (
    <div
      className="flex min-h-[196px] min-w-0 flex-col rounded-[14px] border border-transparent bg-[linear-gradient(160deg,oklch(0.2905_0.045_262),oklch(0.2325_0.023_262))] px-5 py-[18px] text-[oklch(0.97_0.004_262)]"
      data-slot="owner-money-net-mrr"
    >
      <div className="flex items-baseline gap-2.5">
        <span className="text-[12.5px] font-medium text-[oklch(0.78_0.02_262)]">Net MRR</span>
        <span className={`ml-auto font-mono text-[12px] ${NET_INK[netTone]}`}>
          {net === null ? "movement not resolved" : `${net} this month`}
        </span>
      </div>
      <Figure className="mt-1.5" size="lg">
        {headline ?? (
          <span className="text-[13px] font-sans">{absentValue("No priced subscription evidence")}</span>
        )}
      </Figure>
      <div className="mt-auto grid grid-cols-4 gap-2.5 text-[12px]">
        {bars.map((bar) => (
          <div key={bar.key}>
            <div className="h-1.5 rounded-[3px] bg-[oklch(0.4_0.03_262)]">
              {bar.width === 0 ? null : (
                <div
                  className={`h-1.5 rounded-[3px] ${BAR_TONE[bar.tone]}`}
                  style={{ width: `${bar.width * 100}%` }}
                />
              )}
            </div>
            <div className="mt-1.5 text-[oklch(0.78_0.02_262)]">{bar.label}</div>
            <div className="font-mono">{bar.amount ?? "not resolved"}</div>
          </div>
        ))}
        {bars.length === 0 ? (
          <p className="col-span-4 m-0 text-[12px] text-[oklch(0.78_0.02_262)]">
            The movement projection could not be read.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ recurring revenue by month */

const PERIOD_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

function periodLabel(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Period" : PERIOD_LABEL.format(parsed);
}

/** Two months is the shortest thing that is a series rather than a single reading drawn wide. */
const MRR_CHART_MIN_PERIODS = 2;

/**
 * The drawn width of a chart that has to fill a fluid column.
 *
 * `BarChart` computes its geometry in real pixels rather than stretching a viewBox, which is what
 * keeps a 4px bar radius round, so the panel measures itself and hands the width down. The
 * fallback is the artboard's own width, so a server render draws something sensible too.
 */
function useMeasuredWidth(fallback: number) {
  const [width, setWidth] = useState(fallback);
  const measure = useCallback((node: HTMLDivElement | null) => {
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { measure, width };
}

/**
 * The run of month-end periods the platform could price, ending at the latest one.
 *
 * A month with no priced subscription evidence is `null`, and a null is not a zero: drawing it at
 * the baseline would say the book was empty that month when what happened is that nobody can say.
 * Dropping it and closing the gap is worse still, because it would slide two non-adjacent months
 * next to each other on a time axis. So the chart draws the unbroken tail and stops where the
 * evidence stops.
 */
function pricedTail(periods: readonly MoneyMrrPeriod[]): readonly MoneyMrrPeriod[] {
  const tail: MoneyMrrPeriod[] = [];
  for (let index = periods.length - 1; index >= 0; index -= 1) {
    const period = periods[index];
    if (!period || period.mrrCents === null) break;
    tail.unshift(period);
  }
  return tail;
}

function MrrChartPanel({ periods }: { periods: readonly MoneyMrrPeriod[] }) {
  const { measure, width } = useMeasuredWidth(640);
  const tail = useMemo(() => pricedTail(periods), [periods]);
  const labels = tail.map((period) => periodLabel(period.periodEnd));

  return (
    <section
      aria-labelledby="owner-money-mrr-heading"
      className={`${CARD_TABLE.card} flex min-w-0 flex-col px-5 py-[18px]`}
      data-slot="owner-money-mrr-chart"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <h2
          className="m-0 text-[15px] font-semibold text-[var(--ink)]"
          id="owner-money-mrr-heading"
        >
          Recurring revenue by month
        </h2>
        <span className="ml-auto text-[12.5px] font-medium text-[var(--faint)]">
          month end, trailing 12
        </span>
      </div>
      <div className="mt-3.5" ref={measure}>
        {tail.length >= MRR_CHART_MIN_PERIODS ? (
          <BarChart
            height={150}
            label={`Recurring revenue by month: ${tail
              .map((period, index) =>
                `${labels[index]} ${money(period.mrrCents ?? 0, "USD")}`)
              .join(", ")}`}
            labels={labels}
            values={tail.map((period) => (period.mrrCents ?? 0) / 100)}
            width={width}
          />
        ) : (
          <p className="m-0 flex h-[150px] items-center font-mono text-[11px] text-[var(--faint)]">
            No closed month with priced subscription evidence yet
          </p>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ the book */

/** One priced client row off `loadMoneyBilling`, keyed into the table by tenant. */
type MoneyClient = MoneyBillingRead["rows"][number];

/**
 * The dot beside a subscription's state, from the provider's own words.
 *
 * `countsAsLive` is the repository's single definition of live MRR -- status is exactly `active`
 * -- so green is spent on that and on nothing else. `cancelAtPeriodEnd` takes precedence because
 * a subscription still collecting but already told to stop is a pending end, and amber is the
 * colour a pending thing keeps. Everything else falls to the raw status, never to the bucket
 * label printed beside it: a label is presentation, and colour that reads presentation drifts the
 * moment the wording does.
 */
const STATUS_TONE: Record<string, StatusTone> = {
  canceled: "grey",
  incomplete: "amber",
  incomplete_expired: "bad",
  past_due: "bad",
  paused: "wait",
  trialing: "wait",
  unpaid: "bad",
};

function clientTone(client: MoneyClient): StatusTone {
  if (client.cancelAtPeriodEnd) return "amber";
  if (client.countsAsLive) return "good";
  return STATUS_TONE[client.status] ?? "grey";
}

/**
 * "Live" is the green line on the card, so it counts only what the provider says is `active`.
 *
 * Where the priced read came back, that test is `countsAsLive`, which the repository defines as
 * exactly `active` and nothing else; a row cancelling at renewal is held out because it is the
 * amber line two rows down, and counting it twice would put a leaving account inside the number
 * that says how many stayed.
 *
 * Without that read the fallback is the export mirror, on the same rule: `receiptBackedCount("all",
 * …)` is every receipt-backed row whatever its state, which would put the past-due and cancelling
 * rows listed underneath inside the number above them, and paint a trial green before a payment
 * was ever collected. The receipt test is the same one `receiptBackedCount` applies, so a row
 * without provider evidence is counted by neither.
 */
function liveCount(rows: readonly SubscriptionRow[], clients: readonly MoneyClient[]) {
  if (clients.length > 0) {
    return clients.filter((client) => client.countsAsLive && !client.cancelAtPeriodEnd).length;
  }
  const receiptBacked = rows.filter((row) =>
    row.dataLabel === null &&
    row.subscriptionStatus !== null &&
    row.providerUpdatedAt !== null,
  );
  if (receiptBacked.length === 0) return null;
  return receiptBacked.filter((row) => row.subscriptionStatus === "active" && !row.cancelAtPeriodEnd).length;
}

function BookCard({
  clients,
  movement,
  rows,
}: {
  clients: readonly MoneyClient[];
  movement: MrrMovementRead | null;
  rows: readonly SubscriptionRow[];
}) {
  const retention = deriveRevenueMovement(movement)?.netRevenueRetention ?? null;
  const lines: readonly { label: string; tone: StatusTone; value: number | null; ink?: string }[] = [
    { label: "Live", tone: "good", value: liveCount(rows, clients) },
    {
      ink: "text-[var(--failure-text)]",
      label: "Past due",
      tone: "bad",
      value: receiptBackedCount("past-due", rows),
    },
    {
      ink: "text-[var(--warning-text)]",
      label: "Cancelling at renewal",
      tone: "amber",
      value: receiptBackedCount("cancelling", rows),
    },
  ];

  return (
    <div
      className={`${CARD_TABLE.card} flex min-w-0 flex-col gap-2.5 px-5 py-[18px]`}
      data-slot="owner-money-book"
    >
      <span className="text-[12.5px] font-medium text-[var(--faint)]">The book</span>
      {lines.map((line) => {
        const text = countText(line.value);
        return (
          <div className="flex items-baseline gap-2.5 text-[13px]" key={line.label}>
            <StatusDot tone={line.tone} />
            <span className="text-[var(--body)]">{line.label}</span>
            <span className={`ml-auto font-mono text-[22px] leading-none tracking-[-0.05em] ${line.ink ?? "text-[var(--ink)]"}`}>
              {text ?? <span className="text-[13px]">{absentValue("No receipt yet")}</span>}
            </span>
          </div>
        );
      })}
      <div className="mt-auto flex items-baseline gap-2.5 border-t border-[var(--line-soft)] pt-2">
        <span className="text-[12.5px] text-[var(--faint)]">Net revenue retention</span>
        <span className="ml-auto font-mono text-[13px] text-[var(--ink)]">
          {retention === null ? absentValue("no priced opening balance") : formatMetric(retention, "percent")}
        </span>
      </div>
    </div>
  );
}

function NeedsHumanCard({
  accounts,
  onChangeState,
}: {
  accounts: readonly { tenantId: string; businessName: string; reason: string; tone: "failure" | "warning" }[];
  onChangeState: (() => void) | null;
}) {
  return (
    <div
      className={`${CARD_TABLE.card} flex min-w-0 flex-col gap-2 border-[var(--warning-line)] px-5 py-[18px]`}
      data-slot="owner-money-needs-human"
    >
      <span className="text-[12.5px] font-medium text-[var(--faint)]">Needs a human</span>
      {accounts.length === 0 ? (
        <p className="m-0 text-[12.5px] text-[var(--muted)]">
          Nothing is past due, suspended, cancelling, or carrying a scheduled plan change.
        </p>
      ) : (
        accounts.slice(0, 3).map((account) => (
          <div
            className={`rounded-[10px] px-3 py-2.5 ${account.tone === "failure" ? "bg-[var(--warning-wash)]" : "bg-[var(--well)]"}`}
            key={account.tenantId}
          >
            <div className="text-[13px] font-medium text-[var(--ink)]">{account.businessName}</div>
            <div className="text-[12.5px] text-[var(--muted)]">{account.reason}</div>
          </div>
        ))
      )}
      {onChangeState ? (
        <button
          className="mt-auto inline-flex h-8 items-center justify-center rounded-lg border border-[var(--line-input)] bg-[var(--card-top)] px-3 text-[13px] text-[var(--ink)]"
          onClick={onChangeState}
          type="button"
        >
          Change account state
        </button>
      ) : null}
      <span className="font-mono text-[11px] text-[var(--overline)]">
        {AUDIT_ACTIONS["billing.tenant.suspended"].microcopy}
      </span>
    </div>
  );
}

function MoneyBillingTab({
  authorized,
  billing,
  enabled,
  initialCostRows,
  initialRows,
  movement,
  refusalRecord,
  actorRole,
}: {
  actorRole: MoneyActorRole;
  authorized: boolean;
  billing: MoneyBillingRead | null;
  enabled: boolean;
  initialCostRows?: readonly Record<string, unknown>[];
  initialRows?: readonly Record<string, unknown>[];
  movement: MrrMovementRead | null;
  refusalRecord?: MoneyRefusalRecord;
}) {
  const [rows, setRows] = useState<SubscriptionRow[]>(() =>
    initialRows === undefined ? [] : normalizeSubscriptionRows(initialRows));
  const [costRows, setCostRows] = useState<CostRow[]>(() =>
    initialCostRows === undefined ? [] : normalizeCostRows(initialCostRows));
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState<SubscriptionRow | null>(null);
  const [targetRow, setTargetRow] = useState<SubscriptionRow | null>(null);
  const [selectedState, setSelectedState] = useState<AccountState | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (!enabled || !authorized || initialRows !== undefined) return;
    const controller = new AbortController();
    void exportSubscriptionRows(controller.signal)
      .then((payload) => setRows(normalizeSubscriptionRows(payload)))
      .catch(() => {
        if (!controller.signal.aborted) setLoadFailed(true);
      });
    return () => controller.abort();
  }, [authorized, enabled, initialRows]);

  useEffect(() => {
    if (!enabled || !authorized || initialCostRows !== undefined) return;
    const controller = new AbortController();
    void fetchCostRows(controller.signal)
      .then(setCostRows)
      .catch(() => {
        // A failed cost read leaves the record sheet's Cost tab saying so; revenue still works.
      });
    return () => controller.abort();
  }, [authorized, enabled, initialCostRows]);

  const ordered = useMemo(
    () => [...rows].sort((left, right) => bucketRank(left) - bucketRank(right)),
    [rows],
  );
  const atRisk = useMemo(() => atRiskFrom(rows), [rows]);
  const clients = billing?.rows ?? [];
  const clientByTenantId = useMemo(() => {
    const index = new Map<string, MoneyClient>();
    for (const client of billing?.rows ?? []) index.set(client.tenantId, client);
    return index;
  }, [billing]);

  function openStateChange(row: SubscriptionRow) {
    setSelected(null);
    setTargetRow(row);
    setSelectedState(null);
    setConfirmOpen(true);
  }

  const firstAtRisk = atRisk[0]
    ? rows.find((row) => row.tenantId === atRisk[0]?.tenantId) ?? null
    : null;

  async function confirmStateChange(input: { reason?: string }): Promise<Result> {
    if (!targetRow || !selectedState || !input.reason) {
      return { ok: false as const, message: "Choose a state and add a reason before confirming." };
    }
    try {
      const result = await postStatus({
        tenantId: targetRow.tenantId,
        status: selectedState,
        reason: input.reason,
      });
      if (typeof result?.auditId !== "number" || result.status !== selectedState) {
        return { ok: false as const, message: "The account state receipt could not be verified." };
      }
      if (selectedState === "suspended" && typeof result.notificationId !== "string") {
        return { ok: false as const, message: "The suspension notice receipt could not be verified." };
      }
      setRows((current) => current.map((row) =>
        row.tenantId === targetRow.tenantId ? { ...row, accountStatus: selectedState } : row));
      return {
        ok: true as const,
        receipt: {
          auditId: result.auditId,
          actionKey: selectedState === "suspended"
            ? ("billing.tenant.suspended" as const)
            : ("billing.tenant.unsuspended" as const),
        },
      };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : "The account state was not changed.",
      };
    }
  }

  const selectedCostRows = selected
    ? costRows.filter((row) => row.tenantId === selected.tenantId)
    : [];

  return (
    <MoneySurfaceGuard
      actorRole={actorRole}
      authorized={authorized}
      enabled={enabled}
      refusalRecord={refusalRecord}
      surface="billing"
    >
      <div className="flex min-h-0 flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr_1fr]">
          <NetMrrCard movement={movement} />
          <BookCard clients={clients} movement={movement} rows={rows} />
          <NeedsHumanCard
            accounts={atRisk}
            onChangeState={firstAtRisk ? () => openStateChange(firstAtRisk) : null}
          />
        </div>

        <MrrChartPanel periods={billing?.mrrByPeriod ?? []} />

        <CardTable>
          <div className="flex items-center gap-2.5 border-b border-[var(--line)] px-3.5 py-2.5">
            <span className="text-[13px] font-semibold text-[var(--ink)]">Subscriptions</span>
            <span className="font-mono text-[11.5px] text-[var(--faint)]">
              {workspaceCountFormat.format(ordered.length)}
            </span>
            {/*
              * The artboard's three-cell order control is one cell. The subscription mirror
              * carries neither a plan nor a created date per row, so "By plan" and "Newest" would
              * be orders over columns this page cannot read.
              */}
            <Seg
              className="ml-auto"
              items={[{ active: true, label: "Worst first" }]}
              label="Subscription order"
            />
          </div>
          {loadFailed ? (
            <DataState
              body="Subscription evidence could not be loaded."
              kind="unavailable"
              title="Subscriptions could not load"
            />
          ) : ordered.length === 0 ? (
            // `DataState` requires a `body`; the empty string is how a title-only empty state
            // is drawn without printing an explainer sentence under it.
            <DataState kind="empty" title="No subscription rows returned" />
          ) : (
            <table className={CARD_TABLE.table}>
              <thead>
                <tr>
                  <th className={CARD_TABLE.th}>Business</th>
                  <th className={CARD_TABLE.th}>Plan</th>
                  <th className={CARD_TABLE.th}>State</th>
                  <th className={`${CARD_TABLE.th} text-right`}>MRR</th>
                  <th className={CARD_TABLE.th}>Movement</th>
                  <th className={CARD_TABLE.th}>Renews</th>
                  <th className={CARD_TABLE.th}>Evidence</th>
                  <th className={CARD_TABLE.th} />
                </tr>
              </thead>
              <tbody>
                {ordered.map((row) => {
                  const bucket = subscriptionViewBucket(row);
                  const client = clientByTenantId.get(row.tenantId) ?? null;
                  const tone = client ? clientTone(client) : STATE_TONE[bucket] ?? "grey";
                  return (
                    <tr key={row.rowKey}>
                      <td className={`${CARD_TABLE.td} font-medium text-[var(--ink)]`}>
                        {row.businessName}
                        {row.dataLabel === null ? null : (
                          <span className="ml-2 text-[11.5px] text-[var(--faint)]">{row.dataLabel}</span>
                        )}
                      </td>
                      <td className={`${CARD_TABLE.td} text-[var(--body)]`}>
                        {client?.plan ?? absentValue("no plan recorded")}
                      </td>
                      <td className={CARD_TABLE.td}>
                        <Pill tone={tone === "amber" ? "amber" : "neutral"}>
                          <StatusDot tone={tone} />
                          {bucket}
                        </Pill>
                      </td>
                      <td className={`${CARD_TABLE.td} ${CARD_TABLE.num} text-[var(--body)]`}>
                        {client && client.monthlyAmountCents !== null
                          ? money(client.monthlyAmountCents, "USD")
                          : absentValue("no price recorded")}
                      </td>
                      <td className={`${CARD_TABLE.td} text-[var(--body)]`}>
                        {subscriptionMovementLabel(row)}
                      </td>
                      <td className={`${CARD_TABLE.td} font-mono text-[var(--body)]`}>
                        {displayDate(row.currentPeriodEnd) ?? "not recorded"}
                      </td>
                      <td className={`${CARD_TABLE.td} text-[var(--faint)]`}>
                        {providerEvidenceLabel(row)}
                      </td>
                      <td className={CARD_TABLE.td}>
                        <button
                          className="font-mono text-[12px] text-[var(--accent-text)]"
                          onClick={() => setSelected(row)}
                          type="button"
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardTable>
      </div>

      <RecordSheet
        logged={AUDIT_ACTIONS["billing.tenant.suspended"].microcopy}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        open={selected !== null && !confirmOpen}
        primaryAction={selected ? {
          label: "Change account state",
          onClick: () => {
            const row = selected;
            setSelected(null);
            openStateChange(row);
          },
        } : undefined}
        subtitle={selected ? `Evidence at ${providerEvidenceLabel(selected)}` : undefined}
        tabs={selected ? [
          {
            id: "account",
            label: "Account",
            sections: [
              {
                title: "State",
                body: (
                  <dl className="grid gap-[var(--s-2)]">
                    <KeyValue label="Account state" layout="stacked" value={accountStateLabel(selected.accountStatus)} />
                    <KeyValue
                      label="Provider state"
                      layout="stacked"
                      value={subscriptionStatePresentation(selected.subscriptionStatus).label}
                    />
                    <KeyValue label="Provider evidence at" layout="stacked" value={providerEvidenceLabel(selected)} />
                  </dl>
                ),
              },
              {
                title: "Renewal",
                body: (
                  <dl className="grid gap-[var(--s-2)]">
                    <KeyValue label="Renewal movement" layout="stacked" value={renewalMovementLabel(selected)} />
                    <KeyValue
                      label="Period ends"
                      layout="stacked"
                      value={displayDate(selected.currentPeriodEnd) ?? "Not recorded"}
                    />
                  </dl>
                ),
              },
            ],
          },
          {
            id: "cost",
            label: "Cost",
            sections: [{
              title: "Cost against revenue",
              body: selectedCostRows.length === 0 ? (
                <p className="m-0 text-[length:var(--t-body)] text-[var(--muted)]">
                  No source-backed cost period has been recorded for this client yet.
                </p>
              ) : (
                <div className="grid gap-[var(--s-4)]">
                  <CostRevenueTrend rows={selectedCostRows} />
                  {selectedCostRows.map(costSummary)}
                </div>
              ),
            }],
          },
        ] : undefined}
        technical={selected ? [
          { label: "Account reference", value: selected.tenantId },
          { label: "Provider state", value: selected.subscriptionStatus ?? "Not recorded" },
          { label: "Provider evidence at", value: selected.providerUpdatedAt ?? "Not recorded" },
        ] : undefined}
        title={selected?.businessName ?? "Subscription"}
      />

      <AccountStateConfirmFlow
        key={`${targetRow?.rowKey ?? "none"}:${confirmOpen ? "open" : "closed"}`}
        onConfirm={confirmStateChange}
        onOpenChange={(open) => {
          setConfirmOpen(open);
          if (!open) {
            setSelectedState(null);
            setTargetRow(null);
            setSelected(null);
          }
        }}
        onSelectedChange={setSelectedState}
        open={confirmOpen}
        row={targetRow}
        selected={selectedState}
      />
    </MoneySurfaceGuard>
  );
}

/* --------------------------------------------------------------------------------------------
 * Page
 * ------------------------------------------------------------------------------------------ */

export function OwnerMoney({
  actorRole,
  affiliatesEnabled,
  authorized,
  billing = null,
  corrections,
  correctionsReadFailure = null,
  enabled,
  initialCostRows,
  initialRows,
  movement = null,
  openCorrections = null,
  pendingApprovals = null,
  refusalRecord,
  tab,
  tiers,
}: OwnerMoneyProps) {
  const billingAuthorized = authorized && actorRole !== "success";
  const movementView = deriveRevenueMovement(movement);

  return (
    <AppShell
      activePath="/admin/billing"
      crumbs={[{ label: "Run" }, { label: "Money" }]}
      platformRole={actorRole}
      role="admin"
    >
      <div className="flex min-h-0 flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="m-0 text-[30px] font-semibold tracking-tight text-[var(--ink)]">Money</h1>
          {/*
            * The page's trailing control row, and the eye is the last thing in it.
            *
            * `EyeRule.dc.html` is the reason it moved: floating bottom-right is also where a
            * pane's action row ends, so the eye sat on top of a primary action. A screen with a
            * header row docks it there instead, after Export, at the same 32px as its neighbours.
            * The row now renders on every tab because the eye belongs to the page rather than to
            * the billing tab that happened to own the only controls.
            */}
          <div className="flex flex-wrap items-center gap-2">
            {tab === "billing" ? (
              <>
                {/*
                  * One window, not three. `projectMrrMovement` returns the current month and the
                  * platform records no MRR history, so 3M and 12M would be controls over data that
                  * does not exist.
                  */}
                <Seg
                  items={[{
                    active: true,
                    label: movementView ? movementView.windowLabel : "This month",
                  }]}
                  label="Revenue window"
                />
                <ExportMenu {...SUBSCRIPTION_EXPORT} />
              </>
            ) : null}
            <ContextEye copy={EYE_COPY} placement="header" screen="Money" />
          </div>
        </div>

        <RehaulTabs
          items={OWNER_MONEY_TABS.map((key) => ({
            active: key === tab,
            count: key === "affiliates"
              ? pendingApprovals ?? undefined
              : key === "corrections"
                ? openCorrections ?? undefined
                : undefined,
            href: `/admin/billing?tab=${key}`,
            label: TAB_LABELS[key],
          }))}
          label="Money sections"
        />

        {tab === "billing" ? (
          <MoneyBillingTab
            actorRole={actorRole}
            authorized={billingAuthorized}
            billing={billing}
            enabled={enabled}
            initialCostRows={initialCostRows}
            initialRows={initialRows}
            movement={movement}
            refusalRecord={refusalRecord}
          />
        ) : null}

        {tab === "costs" ? (
          <AdminMoneyBillingCosts
            actorRole={actorRole}
            authorized={billingAuthorized}
            chrome="embedded"
            enabled={enabled}
            initialCostRows={initialCostRows}
            refusalRecord={refusalRecord}
          />
        ) : null}

        {tab === "tiers" ? (
          <AdminMoneyTiers
            actorRole={actorRole}
            authorized={billingAuthorized}
            chrome="embedded"
            clientPricingByTenantId={tiers?.clientPricingByTenantId ?? null}
            enabled={enabled}
            pricingHistory={tiers?.pricingHistory ?? null}
            refusalRecord={refusalRecord}
            stripeActionHref={tiers?.stripeActionHref ?? ""}
            stripeReadinessReceipt={tiers?.stripeReadinessReceipt ?? null}
            surface="tiers"
            tierImpactById={tiers?.tierImpactById ?? null}
          />
        ) : null}

        {tab === "affiliates" ? (
          <AdminMoneyAffiliates
            actorRole={actorRole}
            affiliatesEnabled={affiliatesEnabled}
            authorized={billingAuthorized}
            chrome="embedded"
            enabled={enabled}
            refusalRecord={refusalRecord}
            surface="affiliates"
          />
        ) : null}

        {tab === "corrections" ? (
          <MoneySurfaceGuard authorized enabled={enabled} surface="corrections">
            {correctionsReadFailure ? (
              <>
                <DataState
                  body={correctionsReadFailure.reason}
                  kind="unavailable"
                  title="Billing corrections could not load"
                />
                <TechnicalDetail
                  className="mt-[var(--s-3)]"
                  items={[{ label: "Error code", value: correctionsReadFailure.code }]}
                />
              </>
            ) : (
              <CorrectionQueue
                actorRole={actorRole}
                chrome="embedded"
                initialCorrections={corrections ?? []}
              />
            )}
          </MoneySurfaceGuard>
        ) : null}
      </div>
    </AppShell>
  );
}
