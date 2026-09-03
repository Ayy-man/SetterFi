"use client";

/**
 * The client half of the platform measurement surface.
 *
 * Every table here is the kit's DataTable, so the header stays sticky and unfilled and the rows
 * keep the shared cell contract. Column definitions carry render functions, which cannot cross
 * the server boundary, so they live here, and each table receives only the rows the role
 * projection already produced, never the raw snapshot.
 */

import type { ColumnDef } from "@tanstack/react-table";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { CellQuiet } from "@/components/kit/cell-quiet";
import { DataTable } from "@/components/kit/data-table";
import { identityColumn, numberColumn } from "@/components/kit/columns";
import type { ExportMenuProps } from "@/components/kit/export-menu";
import { RecordSheet } from "@/components/kit/record-sheet";
import { Overline, Prose, STATE_TONE_TO_TONE, Status } from "@/components/kit/atomics";
import type { StateTone } from "@/components/kit/state-badge";
import type { TechnicalDetailItem } from "@/components/kit/technical-detail";
import { ATTENTION_NOW, ATTENTION_SOON } from "@/lib/copy/states";

const HUMAN_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

const DAYS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function humanDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Date not recorded" : HUMAN_DATE.format(parsed);
}

function humanLabel(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

export type GuardrailRuleRow = {
  ruleKey: string;
  label: string;
  fires: number;
  blocks: number;
  holds: number;
};

export type FollowupRow = {
  touchNo: number;
  sent: number;
  replied: number;
  crossChannel: number;
  exhausted: number;
};

export type ProvisioningRow = {
  stepKey: string;
  state: string;
  stateLabel: string;
  stateTone: StateTone;
  attempts: number;
  failures: number;
  medianDaysToClear: number | null;
};

export type SubscriptionRow = {
  client: string;
  tenantId: string;
  subscriptionId: string;
  status: string;
  stripePriceId: string;
  periodStart: string;
  periodEnd: string;
};

type MeasurementTableProps<T> = {
  ariaLabel: string;
  columns: ColumnDef<T>[];
  description: string;
  exportResource: ExportMenuProps;
  /** What the snapshot's own order is, in the reader's words. */
  ordering?: string;
  /** What that order, or the snapshot behind it, cannot tell them. */
  footerNote?: string;
  getRowId: (row: T) => string;
  id: string;
  rows: readonly T[];
  rowLabel: { singular: string; plural: string };
  technical: (row: T) => { title: string; items: TechnicalDetailItem[] };
  title: string;
};

function MeasurementTable<T>({
  ariaLabel,
  columns,
  description,
  exportResource,
  footerNote,
  getRowId,
  id,
  ordering,
  rows,
  rowLabel,
  technical,
  title,
}: MeasurementTableProps<T>) {
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const openRow = rows.find((row) => getRowId(row) === openRowId) ?? null;
  const record = openRow ? technical(openRow) : null;

  return (
    <section className="flex flex-col gap-[var(--s-3)]">
      {/*
        The heading sits on the canvas and the table sits under it on the 6a ledger face, so the
        overline and the explanation stay outside the frame and the rows, the header band and the
        footer count share one surface. The heading is not repeated inside it: the table's own
        aria label carries the name for anyone who reaches the grid without the heading.
      */}
      <div className="flex min-w-0 flex-col gap-[var(--s-1)]">
        <Overline className="block">Measurement</Overline>
        <h2 className="m-0 text-[length:var(--t-section-title)] leading-[var(--t-section-title-lh)] font-[600] tracking-[var(--t-section-title-tr)] text-[color:var(--ink)]" id={id}>
          {title}
        </h2>
        <Prose className="m-0 text-[12.5px] leading-[1.5] text-[color:var(--muted)]" measure="wide">
          {description}
        </Prose>
      </div>
      <DataTable
        ariaLabel={ariaLabel}
        columns={columns}
        data={rows}
        emptyState={<span className="text-body text-[var(--muted)]">No rows were recorded in this snapshot.</span>}
        exportResource={exportResource}
        footerNote={footerNote}
        getRowId={getRowId}
        onRowOpen={(row) => setOpenRowId(getRowId(row))}
        ordering={ordering}
        rowLabel={rowLabel}
        variant="ledger"
      />
      {record ? (
        <RecordSheet
          onOpenChange={(next) => { if (!next) setOpenRowId(null); }}
          open
          sections={[]}
          subtitle="Recorded evidence behind this row."
          technical={record.items}
          title={record.title}
        />
      ) : null}
    </section>
  );
}

/**
 * The home page's queue of work that needs a person.
 *
 * It was four cards. Cards gave every category the same visual weight, so "1 past due
 * subscription" and "9 exhausted cadences" looked equally urgent, and the set had no export while
 * every other table in the console does. As a grouped table it reads in the order the operator
 * works: the two bands say how soon, the rows say what, and the count sits in a mono column the
 * eye can run down.
 *
 * A category with nothing in it is not a row. A zero row is a claim that something was checked and
 * found empty, which is true, but it belongs in the empty state's own sentence rather than as four
 * rows of noise above the real work.
 */
export type AttentionRow = {
  id: string;
  title: string;
  count: number;
  band: string;
  href: string;
  note: string;
  /**
   * Why this row is waiting, in one clause beside the name.
   *
   * The canvas puts a sentence on every queue row and it is the row's whole value: "Past due
   * subscriptions / 1 / Review accounts" says what to do without ever saying what happened, so a
   * reader has to open the row to learn whether it is one card that expired or a dunning cycle
   * that ran out. The count and the next step were already here; the cause was not.
   */
  reason?: string;
};

function eraseColumnValue<TData, TValue>(column: ColumnDef<TData, TValue>) {
  return column as unknown as ColumnDef<TData>;
}

export function AttentionQueueTable({
  checked,
  rows,
}: {
  /** Every category examined, named so an empty queue can say what it looked at. */
  checked: readonly string[];
  rows: readonly AttentionRow[];
}): ReactNode {
  const router = useRouter();

  const columns = useMemo<ColumnDef<AttentionRow>[]>(() => [
    eraseColumnValue(identityColumn<AttentionRow, string>({
      id: "title",
      header: "What needs a person",
      accessor: (row) => row.title,
      secondary: (row) => row.reason ?? null,
    })),
    eraseColumnValue(numberColumn<AttentionRow>({
      id: "count",
      header: "Count",
      accessor: (row) => row.count,
    })),
    { accessorFn: (row) => row.note, header: "Next step", id: "next-step" },
  ], []);

  const openRow = useCallback(
    (row: AttentionRow) => { router.push(row.href); },
    [router],
  );

  return (
    <DataTable
      ariaLabel="Work that needs a person"
      columns={columns}
      data={rows}
      emptyState={(
        <div className="flex flex-col gap-[var(--s-1)]">
          <span className="t-row">Nothing needs a person right now</span>
          <span className="t-faint">Checked {checked.join(", ").toLocaleLowerCase()}.</span>
        </div>
      )}
      exportResource={{
        filename: "setterfi-attention-queue",
        mode: "local",
        rows: rows.map((row) => ({
          category: row.title,
          count: row.count,
          urgency: row.band,
          nextStep: row.note,
        })),
      }}
      getRowId={(row) => row.id}
      groupBy={(row) => row.band}
      groups={[{ id: ATTENTION_NOW, label: ATTENTION_NOW }, { id: ATTENTION_SOON, label: ATTENTION_SOON }]}
      onRowClick={openRow}
      rowLabel={{ singular: "item", plural: "items" }}
    />
  );
}

export function GuardrailRulesTable({
  exportResource,
  rows,
}: {
  exportResource: ExportMenuProps;
  rows: readonly GuardrailRuleRow[];
}): ReactNode {
  const columns = useMemo<ColumnDef<GuardrailRuleRow>[]>(() => [
    { accessorFn: (row) => humanLabel(row.label), header: "Rule", id: "rule", meta: { cellKind: "identity" } },
    { accessorKey: "fires", header: "Fires" },
    { accessorKey: "blocks", header: "Blocks" },
    { accessorKey: "holds", header: "Holds" },
  ], []);

  return (
    <MeasurementTable
      ariaLabel="Guardrail rules"
      columns={columns}
      description="Fires, blocks, and holding replies recorded in this measurement snapshot."
      exportResource={exportResource}
      getRowId={(row) => row.ruleKey}
      id="admin-guardrails-heading"
      rowLabel={{ singular: "rule", plural: "rules" }}
      rows={rows}
      technical={(row) => ({
        title: humanLabel(row.label),
        items: [{ label: "Rule key", value: row.ruleKey, mono: true }],
      })}
      title="Guardrail rules"
    />
  );
}

export function FollowupPerformanceTable({
  exportResource,
  rows,
}: {
  exportResource: ExportMenuProps;
  rows: readonly FollowupRow[];
}): ReactNode {
  const columns = useMemo<ColumnDef<FollowupRow>[]>(() => [
    { accessorFn: (row) => `Touch ${row.touchNo}`, header: "Touch", id: "touch", meta: { cellKind: "identity" } },
    { accessorKey: "sent", header: "Sent" },
    { accessorKey: "replied", header: "Replied" },
    { accessorKey: "crossChannel", header: "Cross-channel" },
    { accessorKey: "exhausted", header: "Exhausted" },
  ], []);

  return (
    <MeasurementTable
      ariaLabel="Follow-up performance"
      columns={columns}
      description="Replies use the registered seven-day attribution window and recorded channel identity."
      exportResource={exportResource}
      getRowId={(row) => String(row.touchNo)}
      id="admin-followups-heading"
      rowLabel={{ singular: "touch", plural: "touches" }}
      rows={rows}
      technical={(row) => ({
        title: `Touch ${row.touchNo}`,
        items: [{ label: "Touch number", value: String(row.touchNo) }],
      })}
      title="Follow-up performance"
    />
  );
}

export function ProvisioningPerformanceTable({
  exportResource,
  rows,
}: {
  exportResource: ExportMenuProps;
  rows: readonly ProvisioningRow[];
}): ReactNode {
  const columns = useMemo<ColumnDef<ProvisioningRow>[]>(() => [
    { accessorFn: (row) => humanLabel(row.stepKey), header: "Step", id: "step", meta: { cellKind: "identity" } },
    {
      cell: ({ row }) => (
        <Status label={row.original.stateLabel} tone={STATE_TONE_TO_TONE[row.original.stateTone]} treatment="bare" />
      ),
      header: "State",
      id: "state",
      meta: { cellKind: "state" },
    },
    { accessorKey: "attempts", header: "Attempts" },
    { accessorKey: "failures", header: "Failures" },
    {
      accessorFn: (row) => row.medianDaysToClear === null
        ? "Not recorded"
        : DAYS.format(Math.round(row.medianDaysToClear * 10) / 10),
      /*
        A step nothing has cleared yet has no median, and that is a measurement this snapshot never
        took rather than a zero-day clearance. The cell says which of the two it is.
      */
      cell: ({ row }) => (row.original.medianDaysToClear === null
        ? <CellQuiet>nothing has cleared this step yet</CellQuiet>
        : DAYS.format(Math.round(row.original.medianDaysToClear * 10) / 10)),
      header: "Median days to clear",
      id: "medianDaysToClear",
    },
  ], []);

  return (
    <MeasurementTable
      ariaLabel="Provisioning performance"
      columns={columns}
      description="States and elapsed day measures come from recorded attempts."
      exportResource={exportResource}
      /*
        The one sentence a reader of this table needs while looking at it. Every other number here
        counts something that finished; a step still awaiting a carrier or a coach has not, and the
        elapsed measure beside it is the wait so far and not an estimate of the wait remaining.
      */
      footerNote="Elapsed days are measured from recorded attempts. A step still waiting has no predicted clearance date, here or anywhere else."
      getRowId={(row) => `${row.stepKey}:${row.state}`}
      id="admin-provisioning-heading"
      rowLabel={{ singular: "step", plural: "steps" }}
      rows={rows}
      technical={(row) => ({
        title: humanLabel(row.stepKey),
        items: [
          { label: "Step key", value: row.stepKey, mono: true },
          { label: "Recorded state", value: row.state, mono: true },
        ],
      })}
      title="Provisioning performance"
    />
  );
}

export function SubscriptionsTable({
  exportResource,
  rows,
}: {
  exportResource: ExportMenuProps;
  rows: readonly SubscriptionRow[];
}): ReactNode {
  const columns = useMemo<ColumnDef<SubscriptionRow>[]>(() => [
    { accessorKey: "client", header: "Client", meta: { cellKind: "identity" } },
    { accessorFn: (row) => humanLabel(row.status), header: "State", id: "status" },
    { accessorFn: (row) => humanDate(row.periodStart), header: "Period start", id: "periodStart" },
    { accessorFn: (row) => humanDate(row.periodEnd), header: "Period end", id: "periodEnd" },
  ], []);

  return (
    <MeasurementTable
      ariaLabel="Subscriptions"
      columns={columns}
      description="The local subscription mirror is read here, so a provider interruption does not take this view down."
      exportResource={exportResource}
      getRowId={(row) => row.subscriptionId}
      id="admin-subscriptions-heading"
      rowLabel={{ singular: "subscription", plural: "subscriptions" }}
      rows={rows}
      technical={(row) => ({
        title: row.client,
        items: [
          { label: "Client", value: row.tenantId, mono: true },
          { label: "Subscription", value: row.subscriptionId, mono: true },
          { label: "Price reference", value: row.stripePriceId, mono: true },
          { label: "Period", value: `${row.periodStart} to ${row.periodEnd}`, mono: true },
        ],
      })}
      title="Subscriptions"
    />
  );
}
