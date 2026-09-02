"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useEffect, useMemo, useState } from "react";

import { ChevronLeft } from "@/components/kit/icons";

import {
  dateColumn,
  identityColumn,
  moneyColumn,
} from "@/components/kit/columns";
import { CellQuiet } from "@/components/kit/cell-quiet";
import { DataState } from "@/components/kit/data-state";
import { DataTable } from "@/components/kit/data-table";
import type { ServerExportMenuProps } from "@/components/kit/export-menu";
import { KeyValue } from "@/components/kit/key-value";
import {
  seededRowLabel,
  seededRowWords,
  wholePageProvenanceKind,
} from "@/components/kit/provenance-chip";
import { RecordSheet } from "@/components/kit/record-sheet";
import { FigureStrip, type FigureStripItem } from "@/components/kit/atomics";
import { ListPage } from "@/components/kit/templates/list-page";
import {
  MoneySurfaceGuard,
  moneyPageHeader,
} from "@/components/workspace/live/admin-money-shell";
import { deriveCostView } from "@/components/workspace/live/view-models";
import { workspaceDateFormat } from "@/lib/format/datetime";
import type { MoneyRefusalRecord } from "@/lib/repositories/money-page-audit";

/**
 * `tenants.is_demo` reaches a row as `dataLabel`, and the two words it can carry are separate
 * claims: a seeded workspace, and a tenant marked as test data. Collapsing them into one is what
 * let these pages state a whole-page provenance their rows did not support.
 */
const seedingOf = (row: { dataLabel: string | null }) =>
  row.dataLabel === null ? null : row.dataLabel === "Test" ? ("test" as const) : ("demo" as const);


/**
 * Cost against revenue is admin-only economics, so it never sits on the default revenue screen.
 * It lives on its own sub-page and, per client, in the revenue row's Cost tab.
 */

export type PlatformRole = "owner" | "admin" | "success";

export type CostRow = {
  rowKey: string;
  rollupId: string;
  tenantId: string;
  businessName: string;
  windowStart: string | null;
  windowEnd: string | null;
  revenueCents: number | null;
  modelCostCents: number | null;
  messagingCostCents: number | null;
  embeddingCostCents: number | null;
  complete: boolean;
  missingSources: string | null;
  sourceEvidenceAt: string | null;
  dataLabel: string | null;
};

export const COST_EXPORT_REASON = "admin-billing-read";

export const COST_EXPORT: ServerExportMenuProps = {
  mode: "server",
  filename: "setterfi-billing-cost-rollups",
  resource: "billing-cost-rollups",
  query: {
    reason: COST_EXPORT_REASON,
    order: "created_desc",
    columns: [
      "rollupId",
      "tenantId",
      "businessName",
      "windowStart",
      "windowEnd",
      "revenueCents",
      "modelCostCents",
      "messagingCostCents",
      "embeddingCostCents",
      "complete",
      "missingSources",
      "sourceEvidenceAt",
      "dataLabel",
    ],
  },
};

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Billing data is missing ${field}.`);
  }
  return value;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function optionalInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function normalizeCostRows(value: unknown): CostRow[] {
  if (!Array.isArray(value)) throw new Error("Cost rows could not be read.");

  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("A cost row could not be read.");
    }
    const row = candidate as Record<string, unknown>;
    return {
      rowKey: `cost-${index}`,
      rollupId: requiredString(row.rollupId, "a cost reference"),
      tenantId: requiredString(row.tenantId, "an account reference"),
      businessName: requiredString(row.businessName, "a business name"),
      windowStart: optionalString(row.windowStart),
      windowEnd: optionalString(row.windowEnd),
      revenueCents: optionalInteger(row.revenueCents),
      modelCostCents: optionalInteger(row.modelCostCents),
      messagingCostCents: optionalInteger(row.messagingCostCents),
      embeddingCostCents: optionalInteger(row.embeddingCostCents),
      complete: row.complete === true,
      missingSources: optionalString(row.missingSources),
      sourceEvidenceAt: optionalString(row.sourceEvidenceAt),
      dataLabel: optionalString(row.dataLabel),
    };
  });
}

export async function fetchCostRows(signal?: AbortSignal) {
  const response = await fetch(
    `/api/exports/billing-cost-rollups?format=json&reason=${encodeURIComponent(COST_EXPORT_REASON)}`,
    { cache: "no-store", signal },
  );
  if (!response.ok) throw new Error("Billing data could not be loaded.");
  return normalizeCostRows((await response.json()) as unknown);
}

export function costPeriodLabel(row: CostRow) {
  if (!row.windowStart || !row.windowEnd) return "Period not recorded";
  const start = new Date(row.windowStart);
  const end = new Date(row.windowEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return "Period not recorded";
  }
  return `${workspaceDateFormat.format(start)} to ${workspaceDateFormat.format(end)}`;
}

/**
 * Margin is derived only where every required source is present; a missing source leaves the
 * figure absent rather than reading as zero.
 */
export function costMarginValue(row: CostRow) {
  if (
    row.revenueCents === null ||
    !row.windowStart ||
    !row.windowEnd ||
    !row.sourceEvidenceAt
  ) return null;
  const costSources = ["model", "messaging", "embedding"] as const;
  const missingSources = (row.missingSources?.split("; ") ?? []).filter(
    (source): source is (typeof costSources)[number] =>
      costSources.some((candidate) => candidate === source),
  );
  const view = deriveCostView({
    rollupId: row.rollupId,
    tenantId: row.tenantId,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    revenueCents: row.revenueCents,
    modelCostCents: row.modelCostCents,
    messagingCostCents: row.messagingCostCents,
    embeddingCostCents: row.embeddingCostCents,
    complete: row.complete,
    missingSources,
    sourceEvidenceAt: row.sourceEvidenceAt,
  });
  return "margin" in view
    ? row.revenueCents
      - (row.modelCostCents ?? 0)
      - (row.messagingCostCents ?? 0)
      - (row.embeddingCostCents ?? 0)
    : null;
}

function eraseColumnValue<TData, TValue>(column: ColumnDef<TData, TValue>) {
  return column as unknown as ColumnDef<TData>;
}

const MARGIN_FORMAT = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * A cost source that was never recorded is absent, not zero. Reading it as $0.00 would be the
 * same lie the Margin column refuses to tell, one level down.
 */
function sourceAmount(cents: number | null) {
  return cents === null ? "Not recorded" : MARGIN_FORMAT.format(cents / 100);
}

/**
 * The three bands a reader filters on. A period whose margin cannot be derived is its own band
 * rather than being folded in with the profitable ones, because "we do not know" and "it made
 * money" are different answers to the same question.
 */
const MARGIN_BANDS = {
  loss: "Cost exceeded revenue",
  profit: "Revenue exceeded cost",
  unknown: "Margin not shown",
} as const;

export function marginBand(row: CostRow) {
  const margin = costMarginValue(row);
  if (margin === null) return MARGIN_BANDS.unknown;
  return margin < 0 ? MARGIN_BANDS.loss : MARGIN_BANDS.profit;
}

const EVIDENCE_GROUPS = [
  {
    annotation: "no margin is derived while a cost source is missing",
    id: "Sources missing",
    label: "Sources missing",
    tone: "warning",
  },
  {
    annotation: "revenue and all three cost sources are recorded for the period",
    id: "Every source present",
    label: "Every source present",
    tone: "neutral",
  },
] as const;

function evidenceBand(row: CostRow) {
  return row.complete ? "Every source present" : "Sources missing";
}

export function costColumns(): ColumnDef<CostRow>[] {
  // The three cost splits and the source receipt ship behind Display: the default view answers
  // "is this client profitable and is the evidence complete", not "where did every cent go".
  const columns: ColumnDef<CostRow>[] = [
    eraseColumnValue(identityColumn<CostRow, string>({
      id: "business",
      header: "Business",
      accessor: (row) => row.businessName,
    })),
    {
      id: "period",
      header: "Period",
      accessorFn: (row) => costPeriodLabel(row),
      meta: { cellKind: "secondary", label: "Period" },
    },
    eraseColumnValue(moneyColumn<CostRow>({
      id: "revenue",
      header: "Revenue",
      accessor: (row) => row.revenueCents,
    })),
    // "Not shown" is the honest state this page exists to demonstrate, and it is an absence, not a
    // figure: it renders as a quiet cell so a missing margin never sits at the weight of a real
    // one, and never as a rule the reader has to decode.
    {
      id: "margin",
      header: "Margin",
      accessorFn: costMarginValue,
      meta: {
        cellClassName: "text-right",
        cellKind: "money",
        headerClassName: "text-right",
        label: "Margin",
      },
      cell: ({ row }) => {
        const margin = costMarginValue(row.original);
        if (margin === null) return <CellQuiet>Not shown</CellQuiet>;
        // A period that cost more than it earned is the row an admin came here to find, so a
        // negative margin carries the critical text colour and the accounting parenthesis.
        return (
          // Same mono tabular figure as every other money column: a margin has to line up with the
          // Revenue cell beside it, digit for digit, or the comparison the column exists for is
          // work the reader has to do by eye.
          <span
            className={`font-mono text-[12.5px] leading-[1.35] tabular-nums ${margin < 0 ? "text-[var(--critical-text)]" : "text-[var(--ink)]"}`}
          >
            {margin < 0
              ? `(${MARGIN_FORMAT.format(Math.abs(margin) / 100)})`
              : MARGIN_FORMAT.format(margin / 100)}
          </span>
        );
      },
    },
    // Completeness is a band header now, so the pill that repeated it on every row is gone. The
    // band a reader actually hunts for is the loss-making one, so that becomes the facet chip.
    {
      id: "marginBand",
      header: "Margin band",
      accessorFn: marginBand,
      filterFn: "arrIncludesSome",
      meta: { cellKind: "secondary", defaultHidden: true, label: "Margin band" },
    },
    eraseColumnValue(moneyColumn<CostRow>({
      id: "model-cost",
      header: "Model cost",
      accessor: (row) => row.modelCostCents,
    })),
    eraseColumnValue(moneyColumn<CostRow>({
      id: "message-cost",
      header: "Message cost",
      accessor: (row) => row.messagingCostCents,
    })),
    eraseColumnValue(moneyColumn<CostRow>({
      id: "embedding-cost",
      header: "Embedding cost",
      accessor: (row) => row.embeddingCostCents,
    })),
    eraseColumnValue(dateColumn<CostRow>({
      id: "source-evidence",
      header: "Source evidence at",
      accessor: (row) => row.sourceEvidenceAt,
      emptyLabel: "No source receipt",
    })),
  ];

  // The default view answers "is this client profitable and is the evidence complete". Where every
  // cent went is a Display column and, for one row, the record sheet.
  const hidden = new Set([
    "marginBand",
    "model-cost",
    "message-cost",
    "embedding-cost",
    "source-evidence",
  ]);
  return columns.map((column) =>
    column.id && hidden.has(column.id)
      ? { ...column, meta: { ...column.meta, defaultHidden: true } }
      : column,
  );
}

export type AdminMoneyBillingCostsProps = {
  actorRole: PlatformRole;
  authorized: boolean;
  /**
   * The audit-write outcome for a role-boundary refusal, handed straight to `MoneySurfaceGuard`.
   * Absent on every arm that is not a refusal; the guard treats absence as "not recorded", which
   * is the safe direction for a page that cannot see its own audit result.
   */
  refusalRecord?: MoneyRefusalRecord;
  enabled: boolean;
  initialCostRows?: readonly unknown[];
};

export function AdminMoneyBillingCosts({
  actorRole,
  authorized,
  refusalRecord,
  enabled,
  initialCostRows,
}: AdminMoneyBillingCostsProps) {
  const canRead = enabled && authorized && actorRole !== "success";
  const [rows, setRows] = useState<CostRow[]>(() =>
    initialCostRows === undefined ? [] : normalizeCostRows(initialCostRows),
  );
  const [loading, setLoading] = useState(canRead && initialCostRows === undefined);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<CostRow | null>(null);
  const columns = useMemo(() => costColumns(), []);

  useEffect(() => {
    if (!canRead || initialCostRows !== undefined) return;
    const controller = new AbortController();
    void fetchCostRows(controller.signal)
      .then((next) => {
        setRows(next);
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setLoadError(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [canRead, initialCostRows]);

  /*
   * The chip's word comes from every row or from none of them.
   *
   * This used to read the first labelled row -- `rows.find((row) => row.dataLabel !== null)` -- and
   * pair it with "is every row labelled?". A fully seeded page holding one demo tenant and one test
   * tenant answers yes to the second, so the chip printed whichever row the query returned first
   * and asserted over the title that the entire cost ledger is demo when half of it is a test
   * tenant. `wholePageProvenanceKind` returns `null` there, and the sentence names both words.
   */
  const pageProvenanceKind = wholePageProvenanceKind(rows, seedingOf);
  const labelledWords = seededRowWords(rows, seedingOf);
  const recordedRevenue = rows.reduce((total, row) => total + (row.revenueCents ?? 0), 0);
  const hasRecordedRevenue = rows.some((row) => row.revenueCents !== null);

  // The sub-page inherits its parent's furniture -- a way back to Revenue and a strip of figures --
  // so it reads as the economics tab of the revenue screen rather than as a separate product.
  const tiles: FigureStripItem[] = [
    { label: "Clients covered", value: new Set(rows.map((row) => row.tenantId)).size },
    { label: "Periods with every source", value: rows.filter((row) => row.complete).length },
    {
      absent: "No period records a revenue figure yet",
      format: "money",
      label: "Recorded revenue",
      value: hasRecordedRevenue ? recordedRevenue : null,
    },
  ];

  return (
    <ListPage
      /*
       * Through `moneyPageHeader` for the reason its docstring gives: the guard below wraps this
       * page's children, so on a refusal this description promised cost-against-revenue figures
       * the reader was not shown, and this back-link pointed at `/admin/billing`, which refuses
       * the same reader. The two Money routes that carry a header action pointed at each other's
       * refusals.
       */
      {...moneyPageHeader({
        actions: (
          <a
            className="inline-flex items-center gap-[var(--s-1)] text-[length:var(--t-body)] font-medium text-[var(--muted)] underline-offset-[var(--s-1)] hover:text-[var(--ink)] hover:underline"
            href="/admin/billing"
          >
            <ChevronLeft aria-hidden className="size-[var(--s-4)]" />
            Revenue and subscriptions
          </a>
        ),
        authorized: authorized && actorRole !== "success",
        description: "Cost against revenue per billing period. Margin appears only where every required source is present.",
        enabled,
      })}
      // The whole-page claim is the chip; the mixed-rows claim stays a sentence and the table
      // keeps labelling the row. Never both -- `assertOneProvenanceClaim` enforces it.
      provenance={
        pageProvenanceKind !== null || labelledWords.length === 0
          ? undefined
          : `${labelledWords.join(" and ")} rows are labelled in the table and excluded from analytics.`
      }
      provenanceKind={pageProvenanceKind ?? undefined}
      // A strip of zeros over an empty table claims three measurements that were never made. With
      // no rows the empty state is the whole answer, so the strip stays off the page.
      stats={canRead && !loading && !loadError && rows.length > 0 ? (
        <FigureStrip items={tiles} label="Cost evidence summary" />
      ) : undefined}
      title="Cost evidence"
    >
      <MoneySurfaceGuard
        actorRole={actorRole}
        authorized={authorized && actorRole !== "success"}
        enabled={enabled}
        refusalRecord={refusalRecord}
        surface="billing"
      >
        <DataTable
          ariaLabel="Cost evidence"
          columns={columns}
          data={rows}
          emptyState={(
            <DataState
              body="A row appears after a billing period has source-backed revenue and cost evidence."
              kind="empty"
              title="No cost evidence yet"
            />
          )}
          error={loadError ? {
            title: "Cost evidence could not load",
            body: "Cost evidence could not be loaded.",
            retry: () => {
              setLoadError(false);
              setLoading(true);
              void fetchCostRows()
                .then((next) => {
                  setRows(next);
                  setLoading(false);
                })
                .catch(() => {
                  setLoadError(true);
                  setLoading(false);
                });
            },
          } : undefined}
          exportResource={COST_EXPORT}
          facets={[{
            columnId: "marginBand",
            title: "Margin",
            options: Object.values(MARGIN_BANDS).map((label) => ({ label, value: label })),
          }]}
          getRowId={(row) => row.rowKey}
          // Incomplete evidence is the lifecycle this page turns on, and it reads as two bands
          // rather than as a pill repeated down a column. Incomplete sits first: it is the band
          // that has work in it.
          footerNote="Every figure here is what SetterFi recorded for the period. Nothing on this page is reconciled against the payment provider."
          groupBy={evidenceBand}
          groups={EVIDENCE_GROUPS}
          loading={loading}
          onRowClick={setSelected}
          ordering="periods with a missing source first"
          pagination={{ mode: "offset", pageSize: 25 }}
          rowLabel={{ singular: "cost period", plural: "cost periods" }}
          search={{ columnId: "business", placeholder: "Search business" }}
          testRow={(row) => row.dataLabel !== null}
          testRowLabel={seededRowLabel(labelledWords)}
          variant="ledger"
        />

        {/* The row's whole point is the arithmetic behind one Margin cell, and the three cost
            sources that produce it are Display-hidden columns. The sheet is where they belong. */}
        <RecordSheet
          onOpenChange={(open) => { if (!open) setSelected(null); }}
          open={selected !== null}
          sections={selected ? [
            {
              title: "Revenue and margin",
              body: (
                <dl className="grid gap-[var(--s-3)] sm:grid-cols-2">
                  <KeyValue
                    label="Revenue"
                    layout="stacked"
                    value={selected.revenueCents === null
                      ? "Not recorded"
                      : MARGIN_FORMAT.format(selected.revenueCents / 100)}
                  />
                  <KeyValue
                    label="Margin"
                    layout="stacked"
                    value={costMarginValue(selected) === null
                      ? "Not shown"
                      : MARGIN_FORMAT.format((costMarginValue(selected) as number) / 100)}
                  />
                </dl>
              ),
            },
            {
              title: "Cost sources",
              body: (
                <dl className="grid gap-[var(--s-3)] sm:grid-cols-2">
                  <KeyValue label="Model" layout="stacked" value={sourceAmount(selected.modelCostCents)} />
                  <KeyValue label="Messaging" layout="stacked" value={sourceAmount(selected.messagingCostCents)} />
                  <KeyValue label="Embedding" layout="stacked" value={sourceAmount(selected.embeddingCostCents)} />
                  <KeyValue
                    label="Missing sources"
                    layout="stacked"
                    value={selected.missingSources ?? "None"}
                  />
                </dl>
              ),
            },
            {
              title: "Evidence",
              body: (
                <dl className="grid gap-[var(--s-3)] sm:grid-cols-2">
                  <KeyValue label="Period" layout="stacked" value={costPeriodLabel(selected)} />
                  <KeyValue
                    label="Source evidence recorded"
                    layout="stacked"
                    value={selected.sourceEvidenceAt
                      ? workspaceDateFormat.format(new Date(selected.sourceEvidenceAt))
                      : "Not recorded"}
                  />
                </dl>
              ),
            },
          ] : []}
          state={selected ? {
            kind: "verdict",
            label: selected.complete ? "Every source present" : "Sources incomplete",
            tone: selected.complete ? "good" : "warning",
          } : undefined}
          subtitle={selected ? costPeriodLabel(selected) : undefined}
          technical={selected ? [
            { label: "Rollup ID", value: selected.rollupId },
            { label: "Account ID", value: selected.tenantId },
          ] : undefined}
          title={selected?.businessName ?? ""}
        />
      </MoneySurfaceGuard>
    </ListPage>
  );
}
