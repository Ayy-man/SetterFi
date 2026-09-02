"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { identityColumn } from "@/components/kit/columns";
import { ConfirmFlow, LoggedPill, type Result } from "@/components/kit/confirm-flow";
import { CellQuiet } from "@/components/kit/cell-quiet";
import { DataState } from "@/components/kit/data-state";
import { DataTable, type RowAction } from "@/components/kit/data-table";
import type { ExportMenuProps } from "@/components/kit/export-menu";
import { KeyValue } from "@/components/kit/key-value";
import { LoggedButton } from "@/components/kit/logged-button";
import { RecordSheet } from "@/components/kit/record-sheet";
import { Status } from "@/components/kit/atomics";
import { TechnicalDetail } from "@/components/kit/technical-detail";
import { ConsoleStatDeck } from "@/components/kit/console-stat-deck";
import { type StatStripItem } from "@/components/kit/stat-strip";
import { seededRowLabel, seededRowWords } from "@/components/kit/provenance-chip";
import { ListPage } from "@/components/kit/templates/list-page";
import { AUDIT_ACTIONS, type AuditActionKey } from "@/lib/audit/actions";
import { workspaceTimestampFormat } from "@/lib/format/datetime";
import { workspaceNavigationFor } from "@/lib/workspace-navigation";

import { MoneySurfaceGuard } from "@/components/workspace/live/admin-money-shell";

import type { CorrectionEvidence } from "@/components/workspace/live/view-models";

type PlatformRole = "owner" | "admin" | "success";
type Decision = "approved" | "rejected";

type AdminMoneyCorrectionsProps = {
  actorRole: PlatformRole;
  enabled: boolean;
  initialCorrections?: readonly CorrectionEvidence[];
  readFailure?: { code: string; reason: string } | null;
};

const CRUMBS = [
  { label: "Money", href: "/admin/billing" },
  { label: "Corrections" },
] as const;

const EXPORT_COLUMNS = [
  "requestId",
  "tenantId",
  "billableEventId",
  "quantityDelta",
  "reason",
  "requestedAt",
  "requestAuditId",
  "decision",
  "decisionReason",
  "decisionId",
  "decisionAuditId",
  "offsetEventId",
  /*
   * The server arm already supported this column -- `handler.ts` lists `dataLabel` for
   * `billing-corrections` and its cursor selects `tenant:tenants(name,is_demo)` -- and this list
   * is passed as the export's `columns` parameter, so asking for a narrower set was what dropped
   * the label on the way out. The screen and the file have to agree: a CSV without the marker
   * turns a seeded dispute into an indistinguishable real one the moment it leaves the product,
   * and the file outlives the session that would have explained it.
   */
  "dataLabel",
] as const;

function eraseColumnValue<TData, TValue>(column: ColumnDef<TData, TValue>) {
  return column as unknown as ColumnDef<TData>;
}

function formatRequestedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time not recorded"
    : workspaceTimestampFormat.format(date);
}

function bookedCallLabel(value: number) {
  const count = Math.abs(value);
  return `${count} booked ${count === 1 ? "call" : "calls"}`;
}

function requestTitle(row: CorrectionEvidence) {
  if (row.quantityDelta < 0) return `Decrease by ${bookedCallLabel(row.quantityDelta)}`;
  if (row.quantityDelta > 0) return `Increase by ${bookedCallLabel(row.quantityDelta)}`;
  return "Review booked call count";
}

/**
 * The latest word on the request, and who said it.
 *
 * Screen 4c reuses one column for both, because on a decided row "what did we decide" is the
 * sentence a reader wants and the coach's original claim has already been answered. The author is
 * named in the prefix rather than left to the band above, so the string is still unambiguous in
 * search results and in the CSV, where no band header travels with it.
 */
function latestReason(row: CorrectionEvidence) {
  if (row.decision === null) return row.reason;
  const verdict = row.decision === "approved" ? "Approved" : "Rejected";
  return row.decisionReason?.trim()
    ? `${verdict}: ${row.decisionReason.trim()}`
    // The column is `not null` in the schema, so this is a read that did not carry it, never a
    // decision somebody took without saying why. It says which of the two it is.
    : `${verdict}, decision reason not carried by this read`;
}

function disputedFigure(row: CorrectionEvidence) {
  if (row.quantityDelta < 0) return `${bookedCallLabel(row.quantityDelta)} removed`;
  if (row.quantityDelta > 0) return `${bookedCallLabel(row.quantityDelta)} added`;
  return "No numeric change requested";
}

/** The one place an enum becomes copy on this page. */
const DIRECTION_COPY = {
  increase: "Increase requested",
  decrease: "Decrease requested",
  review: "Review only",
} as const;

function requestDirection(row: CorrectionEvidence) {
  if (row.quantityDelta > 0) return DIRECTION_COPY.increase;
  if (row.quantityDelta < 0) return DIRECTION_COPY.decrease;
  return DIRECTION_COPY.review;
}

/**
 * Open first: the band with work in it leads the table. A decided request stays on the page rather
 * than vanishing, because "what did we decide, and when" is the question the coach asks next.
 */
const DECISION_GROUPS = [
  {
    annotation: "the billed count stands until one of these is decided",
    id: "Needs decision",
    label: "Needs decision",
    tone: "warning",
  },
  {
    annotation: "an offset event carries the adjustment; the billable event is unchanged",
    id: "Approved",
    label: "Approved",
    tone: "neutral",
  },
  {
    annotation: "the reason is stored; the billed count did not change",
    id: "Rejected",
    label: "Rejected",
    tone: "neutral",
  },
] as const;

function decisionBand(row: CorrectionEvidence) {
  if (row.decision === "approved") return "Approved";
  if (row.decision === "rejected") return "Rejected";
  return "Needs decision";
}

function actionKey(decision: Decision): AuditActionKey {
  return decision === "approved"
    ? "billing.correction.approved"
    : "billing.correction.rejected";
}

function readResult(payload: Record<string, unknown>, decision: Decision, requestId: string): {
  decisionId: string;
  decisionAuditId: number;
  offsetEventId: string | null;
} | null {
  const result = payload.result as Record<string, unknown> | undefined;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  if (
    result.state !== decision
    || result.requestId !== requestId
    || typeof result?.decisionId !== "string"
    || !Number.isSafeInteger(result.decisionAuditId)
  ) {
    return null;
  }
  if (decision === "approved" && typeof result.offsetEventId !== "string") return null;
  if (decision === "rejected" && result.offsetEventId !== undefined && result.offsetEventId !== null) {
    return null;
  }
  return {
    decisionId: result.decisionId,
    decisionAuditId: result.decisionAuditId as number,
    offsetEventId: typeof result.offsetEventId === "string" ? result.offsetEventId : null,
  };
}

async function decideCorrection(
  row: CorrectionEvidence,
  decision: Decision,
  reason: string,
): Promise<{ ok: true; value: CorrectionEvidence; auditId: number } | { ok: false; message: string }> {
  try {
    const response = await fetch("/api/platform/billing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "decide_correction",
        tenantId: row.tenantId,
        requestId: row.requestId,
        decision,
        reason,
      }),
    });
    if (!response.ok) {
      return { ok: false, message: "The correction decision could not be recorded." };
    }
    const payload = await response.json() as Record<string, unknown>;
    const receipt = readResult(payload, decision, row.requestId);
    if (!receipt) {
      return { ok: false, message: "The correction decision receipt could not be verified." };
    }
    return {
      ok: true,
      auditId: receipt.decisionAuditId,
      value: {
        ...row,
        decision,
        // The words that were just written, so the row reads back what was decided without a
        // refetch. The server stores this same string; nothing here invents one.
        decisionReason: reason,
        decisionId: receipt.decisionId,
        decisionAuditId: receipt.decisionAuditId,
        offsetEventId: receipt.offsetEventId,
      },
    };
  } catch {
    return { ok: false, message: "The correction decision could not be recorded." };
  }
}

/**
 * The coach is the identity of a dispute. Two requests of the same shape ("Decrease by 1 booked
 * call") are indistinguishable without it, and the decision this page exists for -- approve or
 * reject -- is a decision about a coach, not about a request type.
 */
export function correctionCoachLabel(row: CorrectionEvidence) {
  return row.businessName ?? "Coach name not recorded";
}

function correctionColumns(): ColumnDef<CorrectionEvidence>[] {
  return [
    eraseColumnValue(identityColumn<CorrectionEvidence, string>({
      id: "coach",
      header: "Coach",
      accessor: correctionCoachLabel,
    })),
    {
      id: "request",
      accessorFn: requestTitle,
      header: "Request",
      meta: { cellKind: "secondary", label: "Request", minWidth: 180 },
    },
    {
      id: "reason",
      accessorFn: latestReason,
      header: "Reason",
      meta: { cellKind: "secondary", label: "Reason" },
    },
    {
      id: "requestedAt",
      accessorFn: (row) => formatRequestedAt(row.requestedAt),
      cell: ({ row }) => {
        const label = formatRequestedAt(row.original.requestedAt);
        return label === "Time not recorded"
          ? <CellQuiet>no request time recorded</CellQuiet>
          : label;
      },
      header: "Requested",
      meta: { cellKind: "secondary", label: "Requested" },
    },
    {
      // This column used to print "Needs decision" on every row, because the page only ever showed
      // open requests. Decided requests are on the page now, so the state is a band header and the
      // value ships hidden behind Display rather than as a pill that says what the band says.
      id: "state",
      accessorFn: decisionBand,
      header: "State",
      meta: { cellKind: "secondary", defaultHidden: true, label: "State" },
    },
    {
      id: "direction",
      accessorFn: requestDirection,
      filterFn: "arrIncludesSome",
      header: "Direction",
      meta: { cellKind: "secondary", defaultHidden: true, label: "Direction" },
    },
    {
      // Visible, per 4c. What is in dispute is the whole subject of the row, and burying the size
      // of it behind Display left three of five columns describing the request and none of them
      // saying how big it was.
      id: "disputedFigure",
      accessorFn: disputedFigure,
      cell: ({ row }) => (
        row.original.quantityDelta === 0
          ? <CellQuiet>no numeric change requested</CellQuiet>
          : (
            <span className="font-mono text-[12.5px] leading-[1.35] tabular-nums text-[var(--ink)]">
              {disputedFigure(row.original)}
            </span>
          )
      ),
      header: "Disputed",
      meta: { cellKind: "secondary", label: "Disputed" },
    },
  ];
}

function localExportRows(rows: readonly CorrectionEvidence[]) {
  return rows.map((row) => ({
    requestId: row.requestId,
    tenantId: row.tenantId,
    billableEventId: row.billableEventId,
    quantityDelta: row.quantityDelta,
    reason: row.reason,
    requestedAt: row.requestedAt,
    requestAuditId: row.requestAuditId,
    decision: row.decision,
    decisionReason: row.decisionReason ?? null,
    decisionId: row.decisionId,
    decisionAuditId: row.decisionAuditId,
    offsetEventId: row.offsetEventId,
    // The success reviewer's export is built here in the browser rather than by the export
    // resource, so it carries the label only if this mapping does.
    dataLabel: row.dataLabel ?? null,
  }));
}

function CorrectionQueue({
  actorRole,
  initialCorrections,
}: Pick<AdminMoneyCorrectionsProps, "actorRole" | "initialCorrections">) {
  const [corrections, setCorrections] = useState<CorrectionEvidence[]>([
    ...(initialCorrections ?? []),
  ]);
  const [selected, setSelected] = useState<CorrectionEvidence | null>(null);
  const [pendingRow, setPendingRow] = useState<CorrectionEvidence | null>(null);
  const [pendingDecision, setPendingDecision] = useState<Decision | null>(null);
  const [decisionFinished, setDecisionFinished] = useState(false);
  const columns = useMemo(() => correctionColumns(), []);
  const openRequests = corrections.filter((row) => row.decision === null);
  const canDecide = actorRole === "owner" || actorRole === "admin";

  function openDecision(row: CorrectionEvidence, decision: Decision) {
    setDecisionFinished(false);
    setPendingRow(row);
    setPendingDecision(decision);
  }

  function changeDecisionOpen(open: boolean) {
    if (open) return;
    setPendingDecision(null);
    setPendingRow(null);
    if (decisionFinished) setSelected(null);
  }

  async function confirmDecision(input: { reason?: string }): Promise<Result> {
    if (!pendingRow || !pendingDecision || !input.reason) {
      return { ok: false, message: "Add a decision reason before continuing." };
    }
    const result = await decideCorrection(pendingRow, pendingDecision, input.reason);
    if (!result.ok) return result;
    setCorrections((current) => current.map((row) => (
      row.requestId === pendingRow.requestId ? result.value : row
    )));
    setDecisionFinished(true);
    return {
      ok: true,
      receipt: { actionKey: actionKey(pendingDecision), auditId: result.auditId },
    };
  }

  const exportResource: ExportMenuProps = actorRole === "success"
    ? {
        mode: "local",
        filename: "setterfi-billing-corrections",
        rows: localExportRows(corrections),
      }
    : {
        mode: "server",
        filename: "setterfi-billing-corrections",
        resource: "billing-corrections",
        query: {
          reason: "Billing correction queue review",
          order: "created_desc",
          columns: [...EXPORT_COLUMNS],
        },
      };

  const selectedAction = pendingDecision ? actionKey(pendingDecision) : null;

  // Two tiles, both of which change what the admin does next: how much is waiting, and how many
  // coaches are waiting on it. Direction stays a facet and a Display column -- a third of the strip
  // spent on "Increases requested 0" on a page with two rows said nothing.
  /*
   * Three counts about the same queue, so they take one strip rather than three tiles. "Coaches
   * waiting" is deliberately distinct from "open requests": one coach can raise several disputes,
   * and an admin deciding whether to chase somebody needs the number of people, not the number of
   * rows.
   */
  /*
   * The same three counts, carried as `StatStripItem` rather than `FigureStripItem` for the
   * console port. The reason is the one `figure-strip.tsx` documents about itself: its `null`
   * collapses "could not be read" and "read, and the answer is genuinely none" into one absence,
   * and on this queue those are different facts. An empty open queue is a measured zero and the
   * good case -- it should print `0` with its own sentence, not the word "Nothing open" in the
   * ink an unreadable figure would use.
   */
  const openCoaches = new Set(openRequests.map((row) => row.tenantId)).size;
  const decidedCount = corrections.length - openRequests.length;
  const countTile = (
    label: string,
    value: number,
    zeroNote: string,
    note?: string,
  ): StatStripItem => ({
    label,
    note,
    availability: value === 0
      ? { kind: "no-events", note: zeroNote }
      : { kind: "value", value, format: "count" },
  });
  const tiles: StatStripItem[] = [
    countTile("Open requests", openRequests.length, "Nothing is open. Every dispute raised has been decided."),
    countTile("Coaches waiting", openCoaches, "Nobody is waiting on a decision right now."),
    countTile(
      "Decided",
      decidedCount,
      "No dispute has been decided yet.",
      "Approved and rejected, still on the page",
    ),
  ];

  // A decided request is evidence, not work: it opens and reads, and offers no second decision.
  const rowActions = (row: CorrectionEvidence): readonly RowAction[] => canDecide && row.decision === null ? [
    {
      id: "approve",
      label: "Approve",
      logged: AUDIT_ACTIONS["billing.correction.approved"].microcopy,
      onSelect: () => openDecision(row, "approved"),
    },
    {
      id: "reject",
      label: "Reject",
      tone: "critical",
      logged: AUDIT_ACTIONS["billing.correction.rejected"].microcopy,
      onSelect: () => openDecision(row, "rejected"),
    },
  ] : [];

  return (
    <ListPage
      actions={actorRole === "success" ? (
        <Status label="Read only" tone="neutral" treatment="bare" />
      ) : undefined}
      description="Coach disputes against billable call evidence, and the receipt-backed decision."
      /*
       * Verified against the schema before it was written: `billing_correction_decisions` has a
       * `shape_chk` constraint requiring `offset_event_id` on every approval, and nothing in the
       * decision path updates `billable_events`. The sentence is a fact about the write, not a
       * reassurance.
       */
      note="Approving writes an offset event against the billed count. The original billable event is never edited."
      /*
       * "Open requests" is the one panel that fills. It is the only figure on the page that is
       * somebody's queue -- coaches waiting is the same queue counted by person, and Decided is
       * finished work -- and a console screen spends its fill once.
       */
      stats={(
        <ConsoleStatDeck
          ariaLabel="Open correction summary"
          heroLabel="Open requests"
          items={tiles}
        />
      )}
      title="Corrections"
    >
      <DataTable
        ariaLabel="Billing correction requests"
        columns={columns}
        data={corrections}
        emptyState={(
          <DataState
            body="A request appears here after a coach disputes a booked call count."
            kind="empty"
            title="No correction requests"
          />
        )}
        exportResource={exportResource}
        facets={[{
          columnId: "direction",
          title: "Direction",
          options: Object.values(DIRECTION_COPY).map((label) => ({ label, value: label })),
        }]}
        getRowId={(row) => row.requestId}
        footerNote="Inside a band the rows sit in the order the correction projection returned them, so the top row is not the one that has waited longest."
        groupBy={decisionBand}
        groups={DECISION_GROUPS}
        onRowOpen={setSelected}
        rowActions={canDecide ? rowActions : undefined}
        rowActionsLabel={(row) => `Actions for ${correctionCoachLabel(row)}`}
        ordering="needs decision first"
        rowLabel={{ singular: "request", plural: "requests" }}
        /*
         * Per row, never a page chip. The queue is genuinely mixed -- the demo tenant files
         * correction requests alongside real coaches -- and `provenance-chip.tsx` refuses a
         * whole-page claim on a mixed page for the reason that matters in both directions: a chip
         * over the title saying "demo workspace data" would tell a reader that real billing
         * disputes on the same table are seeded.
         *
         * This is the surface where the labelling rule stops being a disclosure nicety. Approving
         * a correction credits a coach's bill, so an unlabelled seeded dispute is a row an admin
         * approves against a claim nobody made.
         */
        testRow={(row) => (row.dataLabel ?? null) !== null}
        testRowLabel={seededRowLabel(seededRowWords(
          corrections,
          (row) => (row.dataLabel ?? null) === null ? null : "demo",
        ))}
        search={{ placeholder: "Search coach or reason" }}
        variant="ledger"
      />

      <RecordSheet
        logged={AUDIT_ACTIONS["billing.correction.approved"].microcopy}
        onOpenChange={(open) => {
          if (!open && !pendingDecision) setSelected(null);
        }}
        open={Boolean(selected)}
        sections={selected ? [
          {
            title: "The dispute",
            body: <p className="m-0 max-w-[var(--measure-prose)] text-[var(--body)]">{selected.reason}</p>,
          },
          ...(selected.decision === null ? [] : [{
            title: selected.decision === "approved" ? "Approved, and why" : "Rejected, and why",
            body: (
              <div className="grid gap-[var(--s-2)]">
                <p className="m-0 max-w-[var(--measure-prose)] text-[var(--body)]">
                  {selected.decisionReason?.trim()
                    ? selected.decisionReason
                    : "The stored decision reason was not carried by this read. It is on the audit receipt below."}
                </p>
                {selected.decision === "approved" ? (
                  <p className="t-muted m-0 max-w-[var(--measure-prose)]">
                    An offset event carries this adjustment. The original billable event is unchanged.
                  </p>
                ) : null}
              </div>
            ),
          }]),
          {
            title: "Disputed figure",
            body: (
              <dl className="grid gap-[var(--s-3)]">
                <KeyValue label="Requested adjustment" layout="stacked" value={disputedFigure(selected)} />
                <KeyValue label="Requested" layout="stacked" value={formatRequestedAt(selected.requestedAt)} />
              </dl>
            ),
          },
          {
            title: "Evidence",
            body: (
              <div className="grid gap-[var(--s-2)]">
                <LoggedPill actionKey="billing.correction.requested" />
                {selected.decision === null ? null : (
                  <LoggedPill actionKey={actionKey(selected.decision)} />
                )}
                {/*
                  * Screen 4d draws a corroboration list -- invite accepted, call length, lead
                  * origin, device overlap. None of those facts reach this projection: the request
                  * carries a `billable_event_id` and nothing joins the appointment or its origin
                  * to it. The section states what is genuinely attached rather than drawing five
                  * ticks nobody measured.
                  */}
                <p className="m-0 max-w-[var(--measure-prose)] text-[var(--muted)]">
                  A billable event reference and an audit receipt are attached to this request. The
                  call itself is not summarised here: no attendance, origin or duration evidence is
                  joined to a correction yet.
                </p>
              </div>
            ),
          },
          ...(canDecide && selected.decision === null ? [{
            title: "Decision",
            body: (
              <div className="flex flex-wrap gap-[var(--s-2)]">
                <LoggedButton
                  actionKey="billing.correction.approved"
                  onClick={() => openDecision(selected, "approved")}
                  variant="primary"
                >
                  Approve
                </LoggedButton>
                <LoggedButton
                  actionKey="billing.correction.rejected"
                  onClick={() => openDecision(selected, "rejected")}
                  variant="danger"
                >
                  Reject
                </LoggedButton>
              </div>
            ),
          }] : []),
        ] : []}
        state={selected ? {
          kind: "verdict",
          label: decisionBand(selected),
          // A decision already taken is settled, not good news: an approval and a rejection are
          // both the end of the work, so neither takes the good tone.
          tone: selected.decision === null ? "warning" : "neutral",
        } : undefined}
        subtitle={selected ? `${requestTitle(selected)}, ${formatRequestedAt(selected.requestedAt)}` : undefined}
        technical={selected ? [
          { label: "Request ID", value: selected.requestId },
          { label: "Coach account ID", value: selected.tenantId },
          { label: "Billable event ID", value: selected.billableEventId },
          { label: "Request audit receipt", value: String(selected.requestAuditId) },
          { label: "Requested at", value: selected.requestedAt },
          ...(selected.decisionId ? [{ label: "Decision ID", value: selected.decisionId }] : []),
          ...(selected.decisionAuditId === null
            ? []
            : [{ label: "Decision audit receipt", value: String(selected.decisionAuditId) }]),
          ...(selected.offsetEventId
            ? [{ label: "Offset event ID", value: selected.offsetEventId }]
            : []),
        ] : undefined}
        title={selected ? correctionCoachLabel(selected) : "Correction request"}
      />

      {pendingRow && pendingDecision && selectedAction ? (
        <ConfirmFlow
          action={selectedAction}
          confirmLabel={pendingDecision === "approved" ? "Approve correction" : "Reject correction"}
          destructive={pendingDecision === "rejected"}
          impact={[
            { label: "Coach", value: correctionCoachLabel(pendingRow) },
            { label: "Requested adjustment", value: disputedFigure(pendingRow) },
            { label: "Coach's reason", value: pendingRow.reason },
            { label: "Decision", value: pendingDecision === "approved" ? "Approve" : "Reject" },
          ]}
          onConfirm={confirmDecision}
          onOpenChange={changeDecisionOpen}
          open
          /*
           * 4d labels this field "goes to the coach verbatim". It does not: `coach_billing_
           * projection` returns correction *candidates* only, and no coach surface reads
           * `billing_correction_decisions.reason`. Claiming delivery the product cannot make would
           * have an admin write "as explained" and assume it landed, so the hint says where the
           * words actually go and where they do not.
           */
          consequence={pendingDecision === "approved"
            ? "Approving writes an offset event against the billed count and stores your reason. The original billable event is not edited."
            : "Rejecting stores your reason against the request. The billed count does not change."}
          reason={{
            required: true,
            label: "Decision reason",
            hint: "Explain the evidence behind this decision. It is stored with the decision and on the audit receipt. No coach-facing screen shows it yet, so tell the coach separately.",
          }}
          title={pendingDecision === "approved" ? "Approve correction" : "Reject correction"}
        />
      ) : null}
    </ListPage>
  );
}

export function AdminMoneyCorrections({
  actorRole,
  enabled,
  initialCorrections = [],
  readFailure = null,
}: AdminMoneyCorrectionsProps) {
  return (
    <AppShell
      activePath="/admin/corrections"
      crumbs={CRUMBS}
      nav={workspaceNavigationFor("admin")}
      role="admin"
    >
      <MoneySurfaceGuard authorized enabled={enabled} surface="corrections">
        {readFailure ? (
          <ListPage
            description="Coach disputes against billable call evidence, and the receipt-backed decision."
            title="Corrections"
          >
            <DataState
              body={readFailure.reason}
              kind="unavailable"
              title="Billing corrections could not load"
            />
            <TechnicalDetail
              className="mt-[var(--s-3)]"
              items={[{ label: "Error code", value: readFailure.code }]}
            />
          </ListPage>
        ) : (
          <CorrectionQueue actorRole={actorRole} initialCorrections={initialCorrections} />
        )}
      </MoneySurfaceGuard>
    </AppShell>
  );
}
