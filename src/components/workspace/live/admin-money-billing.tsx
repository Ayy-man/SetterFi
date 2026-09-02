"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ChevronRight, CircleX } from "@/components/kit/icons";

import { AppShell } from "@/components/kit/app-shell";
import { CellQuiet } from "@/components/kit/cell-quiet";
import { ChartLegend } from "@/components/kit/chart-theme";
import { ConsoleDeck } from "@/components/kit/console-deck";
import { absentValue, dateColumn, identityColumn } from "@/components/kit/columns";
import { LoggedReceipt, type Result } from "@/components/kit/confirm-flow";
import { DataState } from "@/components/kit/data-state";
import { DataTable, type RowAction } from "@/components/kit/data-table";
import type { ServerExportMenuProps } from "@/components/kit/export-menu";
import { KeyValue } from "@/components/kit/key-value";
import { LoggedButton } from "@/components/kit/logged-button";
import { RecordSheet } from "@/components/kit/record-sheet";
import {
  seededRowLabel,
  seededRowWords,
  wholePageProvenanceKind,
} from "@/components/kit/provenance-chip";
import { ProportionBar, Sparkline, SPARKLINE_MIN_POINTS } from "@/components/kit/sparkline";
import type { StatStripItem } from "@/components/kit/stat-strip";
import { ListPage } from "@/components/kit/templates/list-page";
import { ProgressBar, Status } from "@/components/kit/atomics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  costMarginValue,
  costPeriodLabel,
  fetchCostRows,
  normalizeCostRows,
  type CostRow,
} from "@/components/workspace/live/admin-money-billing-costs";
import {
  AtRiskCard,
  BookCompositionCard,
  MovementDisclosure,
  RevenueCard,
  type AtRiskAccount,
  type RevenueCardProps,
} from "@/components/workspace/live/admin-money-billing-revenue";
import { MoneySurfaceGuard, moneyPageHeader } from "@/components/workspace/live/admin-money-shell";
import { deriveMovementView } from "@/components/workspace/live/view-models";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { workspaceCountFormat, workspaceDateFormat } from "@/lib/format/datetime";
import { money } from "@/lib/format/metric";
import type { MrrMovementRead } from "@/lib/repositories/billing";
import { workspaceNavigationFor } from "@/lib/workspace-navigation";
import type { MoneyRefusalRecord } from "@/lib/repositories/money-page-audit";

/**
 * `tenants.is_demo` reaches a row as `dataLabel`, and the two words it can carry are separate
 * claims: a seeded workspace, and a tenant marked as test data. Collapsing them into one is what
 * let these pages state a whole-page provenance their rows did not support.
 */
const seedingOf = (row: { dataLabel: string | null }) =>
  row.dataLabel === null ? null : row.dataLabel === "Test" ? ("test" as const) : ("demo" as const);


type PlatformRole = "owner" | "admin" | "success";
type AccountState = "active" | "overdue" | "suspended";
export type SubscriptionView = "all" | "past-due" | "cancelling" | "trial" | "paused";
type LoadState = "loading" | "ready" | "error";
type ExportRow = Record<string, unknown>;

type SubscriptionRow = {
  rowKey: string;
  tenantId: string;
  businessName: string;
  accountStatus: string;
  subscriptionStatus: string | null;
  providerUpdatedAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pendingTierId: string | null;
  pendingEffectiveAt: string | null;
  dataLabel: string | null;
};

function eraseColumnValue<TData, TValue>(column: ColumnDef<TData, TValue>) {
  return column as unknown as ColumnDef<TData>;
}

export type AdminMoneyBillingProps = {
  surface: "billing";
  actorRole: PlatformRole;
  enabled: boolean;
  authorized: boolean;
  /**
   * The audit-write outcome for a role-boundary refusal, handed straight to `MoneySurfaceGuard`.
   * Absent on every arm that is not a refusal; the guard treats absence as "not recorded", which
   * is the safe direction for a page that cannot see its own audit result.
   */
  refusalRecord?: MoneyRefusalRecord;
  movement?: MrrMovementRead | null;
  initialRows?: readonly ExportRow[];
  initialCostRows?: readonly ExportRow[];
};

const EXPORT_REASON = "admin-billing-read";

const SUBSCRIPTION_EXPORT: ServerExportMenuProps = {
  mode: "server",
  filename: "setterfi-platform-billing",
  resource: "platform-billing",
  query: {
    reason: EXPORT_REASON,
    order: "created_desc",
    columns: [
      "tenantId",
      "businessName",
      "accountStatus",
      "subscriptionStatus",
      "providerUpdatedAt",
      "currentPeriodEnd",
      "cancelAtPeriodEnd",
      "pendingTierId",
      "pendingEffectiveAt",
      "dataLabel",
    ],
  },
};

/**
 * One bucket per row, in decision order: the reason an admin opens this screen is the worst thing
 * true of the account, so a trialing subscription that is also cancelling reads as cancelling.
 */
const VIEW_LABELS = {
  "past-due": "Past due",
  cancelling: "Cancelling",
  paused: "Paused",
  trial: "Trial",
} as const satisfies Record<Exclude<SubscriptionView, "all">, string>;

/**
 * Band order, worst first. A key the mirror produces that is not listed here (Cancelled, Payment
 * setup pending) is appended by the table under its own name, so a new provider state shows up as
 * its own band rather than silently joining another one.
 */
const SUBSCRIPTION_GROUPS = [
  {
    annotation: "the provider has not taken this cycle's payment",
    id: VIEW_LABELS["past-due"],
    label: "Past due",
    tone: "failure",
  },
  {
    annotation: "still billing until the current period ends",
    id: VIEW_LABELS.cancelling,
    label: "Cancelling at renewal",
    tone: "warning",
  },
  {
    annotation: "the provider is collecting nothing while these are paused",
    id: VIEW_LABELS.paused,
    label: "Paused",
    tone: "waiting",
  },
  {
    annotation: "the provider has not charged these yet",
    id: VIEW_LABELS.trial,
    label: "Trial",
    tone: "waiting",
  },
  {
    annotation: "the last provider receipt says these are billing normally",
    id: "Active",
    label: "Active",
    tone: "good",
  },
  {
    annotation: "no receipt from the billing provider yet, so nothing is claimed",
    id: "No provider state",
    label: "No provider state",
    tone: "neutral",
  },
] as const;

const ACCOUNT_STATE_OPTIONS: readonly { value: AccountState; label: string; help: string }[] = [
  {
    value: "active",
    label: "Active",
    help: "Restore normal billing access for this account.",
  },
  {
    value: "overdue",
    label: "Overdue",
    help: "Record that payment follow-up is required.",
  },
  {
    value: "suspended",
    label: "Suspended",
    help: "Stop new account activity after the change is confirmed.",
  },
];

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Billing data is missing ${field}.`);
  }
  return value;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The seeded tenants are named "Reid Funding Group (demo)" in the database, and the suffix is a
 * database-side safeguard rather than a label this table should print: `tenants.is_demo` is what
 * marks a test tenant, it reaches this row as `dataLabel`, and the table already carries it -- as
 * a small tag beside the name, or, when every row on screen is seeded, as one provenance line
 * above the table so eight identical tags do not read as eight facts.
 *
 * So the suffix is dropped for display, and only where the flag agrees it is redundant. A tenant
 * that is genuinely not flagged keeps whatever it is called, parenthesis and all -- the flag is
 * the detection mechanism here, never the name.
 */
function displayBusinessName(name: string, dataLabel: string | null) {
  if (dataLabel === null) return name;
  const stripped = name.replace(/\s*\(demo\)$/i, "").trim();
  return stripped.length > 0 ? stripped : name;
}

function normalizeSubscriptionRows(value: unknown): SubscriptionRow[] {
  if (!Array.isArray(value)) throw new Error("Subscription rows could not be read.");

  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("A subscription row could not be read.");
    }
    const row = candidate as ExportRow;
    const label = optionalString(row.dataLabel);
    return {
      rowKey: `subscription-${index}`,
      tenantId: requiredString(row.tenantId, "an account reference"),
      businessName: displayBusinessName(requiredString(row.businessName, "a business name"), label),
      accountStatus: requiredString(row.accountStatus, "an account state"),
      subscriptionStatus: optionalString(row.subscriptionStatus),
      providerUpdatedAt: optionalString(row.providerUpdatedAt),
      currentPeriodEnd: optionalString(row.currentPeriodEnd),
      cancelAtPeriodEnd: row.cancelAtPeriodEnd === true,
      pendingTierId: optionalString(row.pendingTierId),
      pendingEffectiveAt: optionalString(row.pendingEffectiveAt),
      dataLabel: label,
    };
  });
}

async function exportSubscriptionRows(signal: AbortSignal) {
  const response = await fetch(
    `/api/exports/platform-billing?format=json&reason=${encodeURIComponent(EXPORT_REASON)}`,
    { cache: "no-store", signal },
  );
  if (!response.ok) throw new Error("Billing data could not be loaded.");
  return response.json() as Promise<unknown>;
}

async function postStatus(input: {
  tenantId: string;
  status: AccountState;
  reason: string;
}) {
  const response = await fetch("/api/platform/billing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "set_tenant_status",
      tenantId: input.tenantId,
      status: input.status,
      reason: input.reason,
    }),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "The account state was not changed.");
  }
  return payload.result as Record<string, unknown> | undefined;
}

function accountStatePresentation(value: string) {
  if (value === "active") return { label: "Active", tone: "good" as const };
  if (value === "overdue") return { label: "Overdue", tone: "critical" as const };
  if (value === "suspended") return { label: "Suspended", tone: "critical" as const };
  return { label: "State not classified", tone: "neutral" as const };
}

function subscriptionStatePresentation(value: string | null) {
  if (value === "active") return { label: "Active", tone: "good" as const };
  if (value === "trialing") return { label: "Trial", tone: "info" as const };
  if (value === "past_due") return { label: "Past due", tone: "critical" as const };
  if (value === "canceled") return { label: "Cancelled", tone: "neutral" as const };
  if (value === "paused") return { label: "Paused", tone: "warning" as const };
  if (value === "incomplete") return { label: "Payment setup pending", tone: "warning" as const };
  if (value === "incomplete_expired") return { label: "Payment setup expired", tone: "critical" as const };
  return { label: "No provider state", tone: "neutral" as const };
}

function accountStateLabel(value: string) {
  return accountStatePresentation(value).label;
}

function displayDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : workspaceDateFormat.format(date);
}

function daysPastDue(currentPeriodEnd: string | null) {
  const end = currentPeriodEnd ? new Date(currentPeriodEnd) : null;
  if (!end || Number.isNaN(end.getTime())) return null;
  const days = Math.floor((Date.now() - end.getTime()) / 86_400_000);
  return days > 0 ? days : null;
}

function providerEvidenceLabel(row: SubscriptionRow) {
  return displayDate(row.providerUpdatedAt) ?? "No provider receipt";
}

function renewalMovementLabel(row: SubscriptionRow) {
  if (!row.pendingTierId || !row.pendingEffectiveAt) return "No scheduled change";
  const date = displayDate(row.pendingEffectiveAt);
  return date ? `Plan change on ${date}` : "Scheduled date not recorded";
}

/**
 * The one thing outstanding on a row, in decision order. The band header above the row already
 * says which bucket it is in, so this column carries the part the band cannot: how many days a
 * past-due account has been past due, the date a cancellation lands, the plan change already
 * scheduled. A row with nothing outstanding says so as an absence rather than as a state.
 */
export function subscriptionMovementLabel(row: SubscriptionRow) {
  if (row.accountStatus === "suspended") return "Suspended by an admin";

  if (row.subscriptionStatus === "past_due") {
    const days = daysPastDue(row.currentPeriodEnd);
    return days === null
      ? "Past due, no period end recorded"
      : `Past due, ${days} ${days === 1 ? "day" : "days"}`;
  }

  if (row.accountStatus === "overdue") return "Overdue, payment follow-up open";

  if (row.cancelAtPeriodEnd) {
    const date = displayDate(row.currentPeriodEnd);
    return date ? `Cancelling on ${date}` : "Cancelling at renewal";
  }

  return renewalMovementLabel(row);
}

/**
 * One Status per row, carrying the worst thing true of the account. Pairing it with a second
 * state read as two states at once ("Active State not classified"), so both raw fields now live
 * in the record sheet and behind the Account state column instead.
 */
function subscriptionStateView(row: SubscriptionRow) {
  const provider = subscriptionStatePresentation(row.subscriptionStatus);

  if (row.accountStatus === "suspended") {
    return { label: "Suspended", tone: "critical" as const };
  }

  if (row.subscriptionStatus === "past_due") {
    const days = daysPastDue(row.currentPeriodEnd);
    return {
      label: days === null ? "Past due" : `Past due, ${days} ${days === 1 ? "day" : "days"}`,
      tone: "critical" as const,
    };
  }

  if (row.accountStatus === "overdue") {
    return { label: "Overdue", tone: "critical" as const };
  }

  if (row.cancelAtPeriodEnd) {
    const date = displayDate(row.currentPeriodEnd);
    return {
      label: date ? `Cancelling ${date}` : "Cancelling at renewal",
      tone: "warning" as const,
    };
  }

  return { label: provider.label, tone: provider.tone };
}

/** The single filter bucket a row falls in, used by the Subscription view facet. */
export function subscriptionViewBucket(row: SubscriptionRow) {
  if (row.subscriptionStatus === "past_due") return VIEW_LABELS["past-due"];
  if (row.cancelAtPeriodEnd) return VIEW_LABELS.cancelling;
  if (row.subscriptionStatus === "paused") return VIEW_LABELS.paused;
  if (row.subscriptionStatus === "trialing") return VIEW_LABELS.trial;
  return subscriptionStatePresentation(row.subscriptionStatus).label;
}

/**
 * A count is only offered where a real, receipt-backed subscription stands behind it: a demo or
 * test row, or a row with no provider receipt, would make the tile read as fact when it is not.
 * With none of those present the count is absent rather than zero.
 */
export function receiptBackedCount(view: SubscriptionView, rows: readonly SubscriptionRow[]) {
  const receiptBackedRows = rows.filter((row) =>
    row.dataLabel === null &&
    row.subscriptionStatus !== null &&
    row.providerUpdatedAt !== null,
  );
  if (receiptBackedRows.length === 0) return null;
  if (view === "all") return receiptBackedRows.length;
  if (view === "past-due") return receiptBackedRows.filter((row) => row.subscriptionStatus === "past_due").length;
  if (view === "cancelling") return receiptBackedRows.filter((row) => row.cancelAtPeriodEnd).length;
  if (view === "trial") return receiptBackedRows.filter((row) => row.subscriptionStatus === "trialing").length;
  return receiptBackedRows.filter((row) => row.subscriptionStatus === "paused").length;
}

/**
 * The monthly recurring revenue tile. A projection that could not resolve a price reads as
 * unavailable, never as a zero the screen cannot stand behind.
 */
export function movementTile(
  movement: MrrMovementRead | null,
  onOpenMovement?: () => void,
): StatStripItem {
  return {
    label: "Monthly recurring revenue",
    action: onOpenMovement
      ? { label: "Monthly movement", onClick: onOpenMovement }
      : undefined,
    availability: movement && movement.mrrCents !== null
      ? { kind: "value", value: movement.mrrCents, format: "money" }
      : { kind: "unavailable", note: "No priced subscription evidence" },
  };
}

/**
 * The strip and the table read from two different sources -- a priced movement projection and the
 * subscription mirror -- so when the projection prices nothing while the mirror has rows, the page
 * says which of the two is empty rather than letting a $0.00 stand next to five Active rows.
 */
export function revenueGapSentence(
  movement: MrrMovementRead | null,
  rowCount: number,
): string | null {
  if (rowCount === 0) return null;
  if (!movement || movement.mrrCents === null) {
    return `Recurring revenue is unavailable: no price could be read for the ${rowCount} ${rowCount === 1 ? "subscription" : "subscriptions"} below.`;
  }
  if (movement.clientCount > 0) return null;
  return `Recurring revenue reads $0.00 because no subscription below carries a price we can stand behind; the ${rowCount} ${rowCount === 1 ? "row" : "rows"} here are still counted as subscriptions.`;
}

/** What the composition card shows for one of the receipt-backed counts. */
export type RevenueHeadline = RevenueCardProps["headline"];

/** A count renders as a figure, or says in words that no receipt stands behind it. */
function countValue(count: number | null): ReactNode {
  return count === null ? absentValue("No receipt yet") : workspaceCountFormat.format(count);
}

/**
 * The accounts at risk this cycle, each named by a fact the provider mirror carries.
 *
 * A seeded row never appears here: the card is read as a work queue, and a demo account in it
 * would send an admin after a client that is not actually in trouble.
 */
function atRiskFrom(rows: readonly SubscriptionRow[]): readonly AtRiskAccount[] {
  const accounts: AtRiskAccount[] = [];
  for (const row of rows) {
    if (row.dataLabel !== null) continue;
    if (row.accountStatus === "suspended") {
      accounts.push({
        tenantId: row.tenantId,
        businessName: row.businessName,
        reason: "Suspended by an admin",
        tone: "failure",
      });
      continue;
    }
    if (row.subscriptionStatus === "past_due") {
      const days = daysPastDue(row.currentPeriodEnd);
      accounts.push({
        tenantId: row.tenantId,
        businessName: row.businessName,
        reason: days === null
          ? "The provider reports the subscription past due"
          : `Past due ${days} ${days === 1 ? "day" : "days"} at the provider`,
        tone: "failure",
      });
      continue;
    }
    if (row.cancelAtPeriodEnd) {
      const date = displayDate(row.currentPeriodEnd);
      accounts.push({
        tenantId: row.tenantId,
        businessName: row.businessName,
        reason: date ? `Cancelling at renewal on ${date}` : "Cancelling at renewal",
        tone: "warning",
      });
      continue;
    }
    if (row.pendingTierId !== null) {
      const date = displayDate(row.pendingEffectiveAt);
      accounts.push({
        tenantId: row.tenantId,
        businessName: row.businessName,
        reason: date ? `Plan change scheduled for ${date}` : "Plan change scheduled",
        tone: "warning",
      });
    }
  }
  return accounts;
}

function AccountStateConfirmFlow({
  open,
  onOpenChange,
  onConfirm,
  row,
  selected,
  onSelectedChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: { reason?: string }) => Promise<Result>;
  row: SubscriptionRow | null;
  selected: AccountState | null;
  onSelectedChange: (value: AccountState) => void;
}) {
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [isPending, setIsPending] = useState(false);
  const action = selected === "suspended" ? "billing.tenant.suspended" : "billing.tenant.unsuspended";

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !reason.trim() || isPending) return;
    setIsPending(true);
    try {
      setResult(await onConfirm({ reason: reason.trim() }));
    } catch {
      setResult({ ok: false, message: "We could not complete this action." });
    } finally {
      setIsPending(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isPending) onOpenChange(nextOpen);
      }}
    >
      <SheetContent className="w-full max-w-(--drawer-w) gap-0 border-[var(--line)] bg-[var(--raised)] p-0 shadow-(--shadow-drawer) transition-[transform,opacity] duration-(--duration-fast) ease-(--ease-out) motion-reduce:transition-none sm:max-w-(--drawer-w)">
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
          <div className="relative min-h-0 flex-1 overflow-y-auto">
            <SheetHeader className="gap-[var(--s-1)] border-b border-[var(--line)] px-[var(--s-5)] py-[var(--s-5)]">
              <SheetTitle className="text-section text-[var(--ink)]">Confirm account state</SheetTitle>
              <SheetDescription className="text-body text-[var(--muted)]">
                {row ? `Choose the next state for ${row.businessName}, then record the reason.` : "Select an account row first."}
              </SheetDescription>
            </SheetHeader>

            {row ? (
              <dl className="mx-[var(--s-5)] mt-[var(--s-4)] overflow-hidden rounded-[var(--r-card)] border border-[var(--line)]">
                {[
                  { label: "Account state", value: accountStateLabel(row.accountStatus) },
                  { label: "Provider state", value: subscriptionStatePresentation(row.subscriptionStatus).label },
                  { label: "Provider evidence at", value: providerEvidenceLabel(row) },
                  { label: "Renewal movement", value: renewalMovementLabel(row) },
                ].map((detail) => (
                  <div
                    className="grid grid-cols-[minmax(var(--sidebar-w-collapsed),1fr)_2fr] gap-[var(--s-3)] border-b border-[var(--line)] px-[var(--s-3)] py-[var(--s-2)] text-body last:border-b-0"
                    key={detail.label}
                  >
                    <dt className="text-[var(--muted)]">{detail.label}</dt>
                    <dd className="text-[var(--ink)]">{detail.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}

            <fieldset className="flex flex-col gap-[var(--s-2)] px-[var(--s-5)] py-[var(--s-4)]" disabled={isPending || Boolean(result?.ok)}>
              <legend className="mb-[var(--s-2)] text-[length:var(--t-body)] font-medium text-[var(--ink)]">
                Next state
              </legend>
              {ACCOUNT_STATE_OPTIONS.map((option) => (
                <label
                  className="flex cursor-pointer items-start gap-[var(--s-3)] rounded-[var(--r-card)] border border-[var(--line)] p-[var(--s-3)] hover:bg-[var(--row-hover)] has-checked:border-[var(--focus-ring)] has-checked:bg-[var(--accent-wash)]"
                  key={option.value}
                >
                  <input
                    checked={selected === option.value}
                    className="mt-[var(--s-1)] size-[var(--s-4)] accent-[var(--accent)]"
                    name="account-state"
                    onChange={() => onSelectedChange(option.value)}
                    type="radio"
                    value={option.value}
                  />
                  <span className="flex min-w-0 flex-col gap-[var(--s-1)]">
                    <span className="text-[length:var(--t-row)] font-[var(--t-row-w)] text-[var(--ink)]">
                      {option.label}
                    </span>
                    <span className="text-body text-[var(--muted)]">{option.help}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <div className="flex flex-col gap-[var(--s-2)] px-[var(--s-5)] pb-[var(--s-4)]">
              <label className="text-[length:var(--t-body)] font-medium text-[var(--ink)]" htmlFor="account-state-reason">Reason</label>
              <p className="text-body text-[var(--muted)]" id="account-state-reason-hint">Explain why this account state must change.</p>
              <Input
                aria-describedby="account-state-reason-hint"
                disabled={isPending || Boolean(result?.ok)}
                id="account-state-reason"
                onChange={(event) => setReason(event.currentTarget.value)}
                required
                value={reason}
              />
            </div>

            {result?.ok ? (
              <div className="mx-[var(--s-5)] mb-[var(--s-4)]">
                <LoggedReceipt actionKey={result.receipt.actionKey} auditId={result.receipt.auditId} />
              </div>
            ) : null}

            {result && !result.ok ? (
              <div aria-live="assertive" className="mx-[var(--s-5)] mb-[var(--s-4)] flex items-start gap-[var(--s-2)] rounded-[var(--r-card)] bg-[var(--critical-wash)] p-[var(--s-3)] text-body text-[var(--critical)]" role="alert">
                <CircleX aria-hidden className="mt-[var(--s-1)] size-[var(--s-4)] shrink-0" />
                <p>{result.message} Nothing changed.</p>
              </div>
            ) : null}
          </div>

          <SheetFooter className="mt-auto flex-row justify-end gap-[var(--s-2)] border-t border-[var(--line)] px-[var(--s-5)] py-[var(--s-3)]">
            <Button disabled={isPending} onClick={() => onOpenChange(false)} type="button" variant="outline">
              {result?.ok ? "Done" : "Cancel"}
            </Button>
            {!result?.ok ? selected ? (
              <LoggedButton
                actionKey={action}
                aria-busy={isPending}
                disabled={isPending || !reason.trim()}
                type="submit"
                variant={selected === "suspended" ? "danger" : "primary"}
              >
                {isPending ? "Saving account state..." : selected === "suspended" ? "Suspend account" : "Confirm account state"}
              </LoggedButton>
            ) : (
              <Button disabled type="submit">Confirm account state</Button>
            ) : null}
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Re-exported so `money-portals.test.ts` and every other reader keeps one import path for the
 * movement card while the card itself lives beside the rest of the revenue drawing.
 */
export { MovementDisclosure };

/** The three cost sources, in the order they are drawn and legended. */
const COST_SOURCES = [
  { key: "modelCostCents", label: "Model" },
  { key: "messagingCostCents", label: "Messaging" },
  { key: "embeddingCostCents", label: "Embedding" },
] as const satisfies readonly { key: keyof CostRow; label: string }[];

function share(part: number, whole: number) {
  return `${Math.round((part / whole) * 100)}%`;
}

/**
 * Where a period's revenue went, as one bar.
 *
 * Four money figures in a column give you the numbers but not the shape, and the shape is the
 * question an admin opens this tab with: is this client's cost a sliver of its revenue or most of
 * it. Three segments drawn against revenue, with the unspent remainder left as bare track, answer
 * that without reading a digit -- and the legend still carries every figure, because a bar is a
 * shape and a shape is not a number.
 *
 * It draws only where `costMarginValue` resolves, the same gate the Margin figure uses: every
 * cost source present, revenue recorded, source evidence stamped. A period missing a source gets
 * no bar rather than a bar with a hole in it, because two of three sources drawn would read as a
 * cheap client when it is really an unmeasured one -- and the Evidence line below already names
 * what is missing.
 */
function CostComposition({ row }: { row: CostRow }) {
  const revenue = row.revenueCents;
  if (costMarginValue(row) === null || revenue === null || revenue <= 0) return null;

  const parts = COST_SOURCES
    .map((source, index) => ({ ...source, index, value: row[source.key] as number | null }))
    .filter((part): part is typeof part & { value: number } => part.value !== null && part.value > 0);
  if (parts.length === 0) return null;

  const spent = parts.reduce((running, part) => running + part.value, 0);
  const description = parts
    .map((part) => `${part.label} ${share(part.value, revenue)}`)
    .join(", ");

  return (
    <div className="flex flex-col gap-[var(--s-2)]">
      <span className="t-overline">Where the revenue went</span>
      <ProportionBar
        label={spent > revenue
          ? `Cost ran past revenue: ${description} of revenue, ${share(spent, revenue)} in total.`
          : `${description} of revenue; ${share(revenue - spent, revenue)} left as margin.`}
        segments={parts.map((part) => ({
          label: part.label,
          series: part.index,
          value: part.value,
        }))}
        total={revenue}
      />
      <ChartLegend
        items={parts.map((part) => ({
          label: `${part.label} ${money(part.value, "USD")}`,
          series: part.index,
        }))}
      />
    </div>
  );
}

/**
 * Revenue by period for one client, oldest first.
 *
 * The Cost tab lists a client's periods as separate blocks, so whether the account is growing or
 * shrinking is something the reader has to reconstruct by scrolling and comparing. One line says
 * it. A period with no recorded revenue is not a point -- it is dropped rather than plotted as a
 * zero the client never billed -- and with fewer than two points left the line is not drawn at
 * all, because two readings is the least a direction can honestly be claimed from.
 */
function CostRevenueTrend({ rows }: { rows: readonly CostRow[] }) {
  const dated = rows
    .filter((row): row is CostRow & { revenueCents: number; windowStart: string } =>
      row.revenueCents !== null && row.windowStart !== null)
    .map((row) => ({ at: new Date(row.windowStart).getTime(), revenue: row.revenueCents }))
    .filter((point) => Number.isFinite(point.at))
    .sort((left, right) => left.at - right.at);
  if (dated.length < SPARKLINE_MIN_POINTS) return null;

  const first = dated[0] as (typeof dated)[number];
  const last = dated[dated.length - 1] as (typeof dated)[number];
  return (
    <div className="flex items-center gap-[var(--s-3)]">
      <Sparkline
        label={`Revenue across ${dated.length} recorded periods, ${money(first.revenue, "USD")} to ${money(last.revenue, "USD")}`}
        points={dated.map((point) => point.revenue)}
      />
      <span className="text-body text-[var(--muted)]">
        Revenue across {dated.length} recorded periods
      </span>
    </div>
  );
}

function costSummary(row: CostRow) {
  const margin = costMarginValue(row);
  return (
    <dl className="grid gap-[var(--s-2)]" key={row.rowKey}>
      <KeyValue label="Period" layout="stacked" value={costPeriodLabel(row)} />
      <KeyValue
        label="Revenue"
        layout="stacked"
        value={row.revenueCents === null ? "Not recorded" : money(row.revenueCents, "USD")}
      />
      <CostComposition row={row} />
      <KeyValue
        label="Margin"
        layout="stacked"
        value={margin === null ? "Not shown while a source is missing" : money(margin, "USD")}
      />
      <KeyValue
        label="Evidence"
        layout="stacked"
        value={row.complete ? "Complete" : `Sources missing: ${row.missingSources ?? "not recorded"}`}
      />
    </dl>
  );
}

export function AdminMoneyBilling({
  actorRole,
  authorized,
  refusalRecord,
  enabled,
  initialRows,
  initialCostRows,
  movement = null,
}: AdminMoneyBillingProps) {
  const [rows, setRows] = useState<SubscriptionRow[]>(() =>
    initialRows === undefined ? [] : normalizeSubscriptionRows(initialRows),
  );
  // Seeded from the server payload when there is one, exactly as the cost sub-page does it. The
  // effect below skips the fetch whenever `initialCostRows` is present, so leaving the state at
  // `[]` meant a caller that supplied rows got no cost rows at all -- every client's Cost tab
  // reading "no source-backed cost period recorded" while the payload sat unused in props.
  const [costRows, setCostRows] = useState<CostRow[]>(() =>
    initialCostRows === undefined ? [] : normalizeCostRows(initialCostRows),
  );
  const [subscriptionLoad, setSubscriptionLoad] = useState<LoadState>(initialRows === undefined ? "loading" : "ready");
  const [selected, setSelected] = useState<SubscriptionRow | null>(null);
  const [targetRow, setTargetRow] = useState<SubscriptionRow | null>(null);
  const [selectedState, setSelectedState] = useState<AccountState | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (!enabled || !authorized || initialRows !== undefined) return;
    const controller = new AbortController();
    void exportSubscriptionRows(controller.signal)
      .then((payload) => {
        setRows(normalizeSubscriptionRows(payload));
        setSubscriptionLoad("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setSubscriptionLoad("error");
      });
    return () => controller.abort();
  }, [authorized, enabled, initialRows]);

  // Cost rows never reach the default screen; they are read so a client's own economics can be
  // opened from that client's row.
  useEffect(() => {
    if (!enabled || !authorized || initialCostRows !== undefined) return;
    const controller = new AbortController();
    void fetchCostRows(controller.signal)
      .then(setCostRows)
      .catch(() => {
        // A failed cost read leaves the row's Cost tab saying so; the revenue screen still works.
      });
    return () => controller.abort();
  }, [authorized, enabled, initialCostRows]);

  // The record sheet and the account-state sheet are both modal, so exactly one of them may be
  // open: two open dialogs make each other inert and neither can be used.
  function openStateChange(row: SubscriptionRow) {
    setSelected(null);
    setTargetRow(row);
    setSelectedState(null);
    setConfirmOpen(true);
  }

  /**
   * The deepest past-due run among the rows on screen, and the denominator the Movement cell's
   * magnitude bar is drawn against.
   *
   * The scale is the rows in view rather than a fixed ceiling: no carrier or contract says how
   * many days past due is the maximum, and inventing one would draw a real 40-day account as
   * "half way" to a threshold nobody set. One past-due row therefore draws a full bar, and the
   * label says why -- it is the longest run on this screen, because it is the only one. Holding
   * the bar back until a second row appeared meant that on the set an admin actually opens, which
   * is usually one account in trouble, the bar could never render at all.
   */
  const deepestPastDue = useMemo(() => {
    const counts = rows
      .filter((row) => row.subscriptionStatus === "past_due")
      .map((row) => daysPastDue(row.currentPeriodEnd))
      .filter((days): days is number => days !== null);
    return counts.length === 0 ? null : Math.max(...counts);
  }, [rows]);

  const columns = useMemo<ColumnDef<SubscriptionRow>[]>(() => {
    const declared: ColumnDef<SubscriptionRow>[] = [
    eraseColumnValue(identityColumn<SubscriptionRow, string>({
      id: "business",
      header: "Business",
      accessor: (row) => row.businessName,
    })),
    eraseColumnValue(dateColumn<SubscriptionRow>({
      id: "provider-evidence",
      header: "Evidence at",
      accessor: (row) => row.providerUpdatedAt,
      emptyLabel: "No provider receipt",
    })),
    // The band header carries the state, so this column carries what the band cannot: the day
    // count behind a past-due row, the date a cancellation lands, the plan change already booked.
    // A pill here would repeat the band on every line and stop carrying information.
    {
      id: "renewal",
      header: "Movement",
      accessorFn: (row) => subscriptionMovementLabel(row),
      meta: { cellKind: "secondary", label: "Movement", minWidth: 240 },
      // The bar's slot is drawn only on the rows that can have one. It used to be reserved on
      // every row so the text would not ragged-edge, which cost 48px of indent on all eight rows
      // to align the one row that had a bar -- and on any set with fewer than two past-due rows
      // the bar could not render, so the gutter was reserved for something that never arrived.
      // Past-due rows share a band, so their bars still line up with each other, which is the
      // only comparison the bar exists to support.
      cell: ({ row }) => {
        const label = subscriptionMovementLabel(row.original);
        const pastDue = row.original.subscriptionStatus === "past_due";
        const days = pastDue ? daysPastDue(row.original.currentPeriodEnd) : null;
        return (
          <span className="flex min-w-0 items-center gap-[var(--s-2)]">
            {days === null || deepestPastDue === null ? null : (
              <span className="w-[3rem] shrink-0">
                <ProportionBar
                  height={4}
                  label={days === deepestPastDue
                    ? `${days} days past due, the longest run on this screen`
                    : `${days} of ${deepestPastDue} days, against the longest run past due on this screen`}
                  segments={[{ label: "Days past due", series: 2, value: days }]}
                  total={deepestPastDue}
                />
              </span>
            )}
            {label === "No scheduled change"
              ? <CellQuiet>no scheduled change</CellQuiet>
              // Money that is owed is the reason this screen exists, so the one row that says so
              // is not left in the same ink as the dates around it. Plain text, not a pill: the
              // band overhead already names the state, and a pill here would repeat it per row.
              : pastDue
                ? <span className="min-w-0 truncate text-[length:var(--t-body)] font-medium text-[var(--failure-text)]">{label}</span>
                : <span className="min-w-0 truncate text-[length:var(--t-body)] text-[var(--body)]">{label}</span>}
          </span>
        );
      },
    },
    {
      id: "view",
      header: "Subscription view",
      accessorFn: subscriptionViewBucket,
      filterFn: "arrIncludesSome",
      meta: { cellKind: "secondary", defaultHidden: true, label: "Subscription view" },
    },
    {
      id: "account-state",
      header: "Account state",
      accessorFn: (row) => accountStateLabel(row.accountStatus),
      meta: { cellKind: "secondary", defaultHidden: true, label: "Account state" },
    },
      eraseColumnValue(dateColumn<SubscriptionRow>({
        id: "period-end",
        header: "Period ends",
        accessor: (row) => row.currentPeriodEnd,
        emptyLabel: "Not recorded",
      })),
    ];

    return declared.map((column) =>
      column.id === "period-end"
        ? { ...column, meta: { ...column.meta, defaultHidden: true } }
        : column,
    );
  }, [deepestPastDue]);

  /*
   * The chip's word comes from every row or from none of them.
   *
   * This used to take the label off the first row `Array.prototype.find` returned that carried one
   * -- whatever order the query happened to produce -- and pair it with "are all the rows
   * labelled?". Those two questions do not compose: a fully seeded page carrying one demo tenant
   * and one test tenant answers yes to the second, so the chip printed whichever word happened to
   * sort first and asserted over the title that the platform's whole revenue view is demo when
   * half of it is a test tenant, or the reverse. `wholePageProvenanceKind` returns `null` for
   * exactly that case -- demo and test are not synonyms -- and the sentence arm below names both.
   */
  const pageProvenanceKind = wholePageProvenanceKind(rows, seedingOf);
  const labelledWords = seededRowWords(rows, seedingOf);
  const stateAction = selectedState === "suspended" ? "billing.tenant.suspended" : "billing.tenant.unsuspended";
  const ready = subscriptionLoad === "ready";
  const movementView = deriveMovementView(movement);
  const liveCount = receiptBackedCount("all", rows);
  const gapSentence = ready ? revenueGapSentence(movement, rows.length) : null;

  // The headline is taken from the same availability contract the movement tile publishes, so the
  // card and `movementTile` can never disagree about whether the platform has priced evidence.
  const headlineAvailability = movementTile(movement).availability;
  const revenueHeadline: RevenueHeadline = headlineAvailability.kind === "value"
    ? { kind: "value", cents: Number(headlineAvailability.value) }
    : {
        kind: "unavailable",
        note: "note" in headlineAvailability
          ? headlineAvailability.note
          : "No priced subscription evidence",
      };

  // Three rows printing the same "no receipt" sentence is a wall of grey, not three facts: when
  // no row is receipt-backed there is exactly one thing to say, so the three counts collapse into
  // one row and the card goes back to carrying figures.
  const compositionRows = liveCount === null
    ? [
        {
          label: "Receipt-backed subscriptions",
          value: absentValue(
            ready ? "No row carries a provider receipt yet" : "Reading subscriptions",
          ),
        },
      ]
    : [
        { label: "Live subscriptions", value: countValue(liveCount) },
        {
          label: "Past due",
          value: countValue(receiptBackedCount("past-due", rows)),
          tone: "failure" as const,
        },
        {
          label: "Cancelling at renewal",
          value: countValue(receiptBackedCount("cancelling", rows)),
          tone: "warning" as const,
        },
      ];

  const atRiskAccounts = atRiskFrom(rows);

  const rowActions = (row: SubscriptionRow): readonly RowAction[] => [
    {
      id: "account-state",
      label: "Change account state",
      logged: AUDIT_ACTIONS["billing.tenant.suspended"].microcopy,
      onSelect: () => openStateChange(row),
    },
  ];

  async function confirmStateChange(input: { reason?: string }): Promise<Result> {
    if (!targetRow || !selectedState || !input.reason) {
      return { ok: false, message: "Choose a state and add a reason before confirming." };
    }
    try {
      const result = await postStatus({
        tenantId: targetRow.tenantId,
        status: selectedState,
        reason: input.reason,
      });
      if (typeof result?.auditId !== "number" || result.status !== selectedState) {
        return { ok: false, message: "The account state receipt could not be verified." };
      }
      if (selectedState === "suspended" && typeof result.notificationId !== "string") {
        return { ok: false, message: "The suspension notice receipt could not be verified." };
      }
      setRows((current) => current.map((row) =>
        row.tenantId === targetRow.tenantId ? { ...row, accountStatus: selectedState } : row,
      ));
      return { ok: true, receipt: { auditId: result.auditId, actionKey: stateAction } };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "The account state was not changed.",
      };
    }
  }

  const selectedCostRows = selected
    ? costRows.filter((row) => row.tenantId === selected.tenantId)
    : [];

  return (
    <AppShell
      activePath="/admin/billing"
      crumbs={[{ label: "Money" }, { label: "Revenue and subscriptions" }]}
      nav={workspaceNavigationFor("admin")}
      role="admin"
    >
      <ListPage
        /*
         * Both of these go through `moneyPageHeader` because the guard below wraps only this
         * page's children: on a refusal the description described withheld content and the action
         * linked to `/admin/billing/costs`, which refuses the same reader again.
         *
         * The description when the page is readable: the canvas reads "What the platform bills,
         * what it costs to serve, and which subscriptions are in trouble." The middle clause is
         * dropped: this page reads the subscription mirror, which carries no cost and no price, so
         * what it costs to serve is not on this screen at all -- it is source-backed on
         * `/admin/billing/costs`, which the header links to. Promising it here would have the
         * reader scanning for a figure the page never prints.
         */
        {...moneyPageHeader({
          actions: (
            // Cost economics is a sub-route an admin goes to deliberately, not the thing this page
            // is for, so it reads as a quiet link rather than the page's strongest control.
            <a
              className="inline-flex items-center gap-[var(--s-1)] text-[length:var(--t-body)] font-medium text-[var(--muted)] underline-offset-[var(--s-1)] hover:text-[var(--ink)] hover:underline"
              href="/admin/billing/costs"
            >
              Cost evidence
              <ChevronRight aria-hidden className="size-[var(--s-4)]" />
            </a>
          ),
          authorized: authorized && actorRole !== "success",
          description: "What the platform bills, and which subscriptions are in trouble.",
          enabled,
        })}
        /*
         * Two disclosures, and which one is right depends on the rows rather than on taste.
         * Every row seeded is a claim about the page, so it goes in the chip above the `<h1>`
         * where the console artboards put it and where a reader meets it before the money. A
         * mixed table cannot say that -- the chip would tell a reader the platform's real revenue
         * is not moving on a page where some of it is -- so it keeps the sentence and the table
         * keeps its per-row chip. `assertOneProvenanceClaim` fails the render if both ever land.
         */
        provenance={
          pageProvenanceKind !== null || labelledWords.length === 0
            ? undefined
            : `${labelledWords.join(" and ")} rows are labelled in the table and excluded from analytics.`
        }
        provenanceKind={pageProvenanceKind ?? undefined}
        stats={(
          // The card lays itself out from its own width, not the viewport's: this slot sits inside
          // the list page's content column, which runs narrower than the window by the rail.
          <section
            aria-label="Revenue summary"
            className="flex flex-col gap-[var(--s-3)]"
          >
            {/*
              * One drenched panel on the screen and nothing else fills. The MRR hero earns it --
              * it is the figure the page is opened for -- so Subscriptions and the trouble list
              * beside it stay on the card face, and the accent is still legible as emphasis.
              */}
            <ConsoleDeck variant="lead">
              <RevenueCard headline={revenueHeadline} movement={movement ?? null} />
              <div className="flex min-w-0 flex-col gap-[14px]">
                <BookCompositionCard rows={compositionRows} />
                <AtRiskCard accounts={atRiskAccounts} />
              </div>
            </ConsoleDeck>
            {gapSentence ? (
              <p className="m-0 text-[length:var(--t-body)] text-[var(--muted)]">{gapSentence}</p>
            ) : null}
            {movementView ? (
              <p className="sr-only">{movementView.chip}</p>
            ) : null}
          </section>
        )}
        title="Revenue and subscriptions"
      >
        <MoneySurfaceGuard
          actorRole={actorRole}
          authorized={authorized && actorRole !== "success"}
          enabled={enabled}
          refusalRecord={refusalRecord}
          surface="billing"
        >
          <DataTable
            ariaLabel="Subscriptions"
            columns={columns}
            data={rows}
            emptyState={(
              <DataState
                body="Accounts appear here after the billing mirror returns a matching row."
                kind="empty"
                title="No subscriptions yet"
              />
            )}
            error={subscriptionLoad === "error" ? {
              title: "Subscriptions could not load",
              body: "Subscription evidence could not be loaded.",
              retry: () => {
                setSubscriptionLoad("loading");
                void exportSubscriptionRows(new AbortController().signal)
                  .then((payload) => {
                    setRows(normalizeSubscriptionRows(payload));
                    setSubscriptionLoad("ready");
                  })
                  .catch(() => setSubscriptionLoad("error"));
              },
            } : undefined}
            exportResource={SUBSCRIPTION_EXPORT}
            facets={[{
              columnId: "view",
              title: "Subscription view",
              options: Object.values(VIEW_LABELS).map((label) => ({ label, value: label })),
            }]}
            getRowId={(row) => row.rowKey}
            // The lifecycle is the page: a reader opens this screen to find the accounts in
            // trouble. Bands put those together under one header instead of scattering a column of
            // pills the eye has to re-read row by row, so the pill column comes off the table.
            footerNote="inside a band, rows sit in the order the billing mirror returned them, not longest past due first"
            groupBy={subscriptionViewBucket}
            groups={SUBSCRIPTION_GROUPS}
            loading={subscriptionLoad === "loading"}
            onRowClick={setSelected}
            ordering="worst state first"
            pagination={{ mode: "offset", pageSize: 25 }}
            rowActions={rowActions}
            rowActionsLabel={(row) => `Actions for ${row.businessName}`}
            rowLabel={{ singular: "subscription", plural: "subscriptions" }}
            search={{ columnId: "business", placeholder: "Search business" }}
            testRow={(row) => row.dataLabel !== null}
            testRowLabel={seededRowLabel(labelledWords)}
            variant="ledger"
          />
        </MoneySurfaceGuard>
      </ListPage>

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
        state={selected ? { kind: "lifecycle", ...subscriptionStateView(selected) } : undefined}
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
    </AppShell>
  );
}
