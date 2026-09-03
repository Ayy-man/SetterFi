"use client";

/**
 * The owner Compliance screen, rehaul face.
 *
 * Three tabs off `?tab=`, one table each for the first two, and a rule list for the third. Every
 * row here comes from the same three reads the live surface receives -- suppression entries,
 * suppression tombstones, contacts -- and this file adds no query of its own.
 *
 * What the drawing asks for that the platform cannot say, and what stands in its place:
 *
 * - The drawing puts a retry beside a failed confirmation. Nothing on this page can retry one:
 *   the reconciler is a job route, and the only action the page is handed is contact deletion.
 *   So a failed row is drawn amber and says "Failed", and no button pretends otherwise.
 * - The drawing's Source column names a carrier or a person. A suppression row stores the enum
 *   that recorded it and nothing about who, so the column carries that enum in plain words.
 * - Every explainer sentence the live surface printed under a heading is gone from the page. The
 *   ones a reader still needs are handed to the eye.
 */

import { useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";

import { ConfirmFlow, type Result } from "@/components/kit/confirm-flow";
import { DataState } from "@/components/kit/data-state";
import { DataTable, everyRowIsTest } from "@/components/kit/data-table";
import { ExportMenu } from "@/components/kit/export-menu";
import { RecordSheet } from "@/components/kit/record-sheet";
import { MonoMeta, STATE_TONE_TO_TONE, Status, StatusAbsent } from "@/components/kit/atomics";
import type { StateTone } from "@/components/kit/state-badge";
import { Button } from "@/components/ui/button";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import {
  CARD_TABLE,
  CardTable,
  Figure,
  Pill,
  RehaulTabs,
  StatusDot,
} from "@/components/workspace/rehaul/_primitives";
import {
  complianceAffirmativeLabel,
  deleteFlowState,
  INITIAL_DELETE_FLOW_STATE,
} from "@/components/workspace/live/view-models";
import type {
  AdminDeletionActions,
  ComplianceContact,
  ComplianceRecord,
  LiveSuppressionRow,
  SuppressionTombstoneRow,
} from "@/components/workspace/live/admin-compliance";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { PIPELINE_STAGE_COPY } from "@/lib/copy/states";
import { workspaceCountFormat, workspaceDateTimeYearFormat } from "@/lib/format/datetime";

export type OwnerComplianceProps = {
  initialContacts: readonly ComplianceContact[];
  suppressions: readonly LiveSuppressionRow[];
  tombstones: readonly SuppressionTombstoneRow[];
  impersonation?: { sessionId: string; tenantId: string } | null;
  actions: AdminDeletionActions;
};

type TabId = "blocks" | "contacts" | "message-rules";
type BlockFilter = "all" | "failed" | "stop" | "manual";

const TAB_IDS: readonly TabId[] = ["blocks", "contacts", "message-rules"];

/**
 * The sentences the page no longer prints. Two are claims about the send path rather than about
 * this screen, and two are the honest edge of a capped read; all four matter to somebody deciding
 * whether to trust what the table shows, and none of them belongs under a heading.
 */
export const OWNER_COMPLIANCE_EYE_COPY = [
  "A block is checked at send time, before anything the agent decided: a blocked identity is refused, and only the STOP and HELP acknowledgements carriers require still go out.",
  "A block survives everything, including deleting the contact it came from, which is why a deletion record keeps its own row here.",
  "The message rules are what the send path checks. They are not the whole of what a carrier asks of a sender: sender identification is not enforced here, and the rules about what the agent may claim are checked in The Brain before a draft ever becomes a message.",
  "Only the two hundred most recently recorded blocks, deletion records and contacts are loaded, so search here looks at those and no further.",
].join(" ");

/**
 * The five rules an outbound message passes, in the order `src/lib/sends/send-to-lead.ts` applies
 * them, cut to a title and the value each rule settles. The sentences that used to sit under each
 * title are gone rather than moved: the value pill is the whole claim a reader needs at a glance.
 */
export const MESSAGE_RULES: readonly { title: string; value: string }[] = [
  { title: "Stop means stop, on every channel", value: "Matched before the model" },
  { title: "A block outlives the contact it came from", value: "Checked at send" },
  { title: "No consent basis, no message", value: "Refused, not queued" },
  { title: "Quiet hours defer, they do not drop", value: "Deferred to the next window" },
  { title: "Carrier control replies are published copy", value: "Publication receipt required" },
];

/**
 * Why a block exists, in the words the table has room for. The six keys are the whole of
 * `suppression_source_chk`; an unrecognised value falls back to the humanised enum.
 */
const BLOCK_REASON: Record<string, string> = {
  complaint: "A complaint was recorded",
  deletion: "Kept from a permanent deletion",
  import: "Imported from a do-not-contact list",
  manual: "Recorded by hand",
  stop_intent: "Asked to stop in their own words",
  stop_keyword: "Replied STOP",
};

/** What recorded the block, in plain words. The row stores an enum and nobody's name. */
const BLOCK_SOURCE: Record<string, string> = {
  complaint: "Complaint",
  deletion: "Deletion",
  import: "Imported list",
  manual: "By hand",
  stop_intent: "Intent match",
  stop_keyword: "Keyword match",
};

const IDENTITY_WIDTH = "w-[calc(var(--drawer-w)*0.7)] max-w-[calc(var(--drawer-w)*0.7)]";

function humanize(value: string) {
  return value
    .replaceAll(/[._-]+/g, " ")
    .replace(/^./, (character) => character.toLocaleUpperCase());
}

export function channelLabel(channel: string) {
  return channel.toLowerCase() === "sms" ? "SMS" : humanize(channel);
}

/** The source enum never carries a vendor, and the guard keeps one from reaching a reader if it ever does. */
export function sourceLabel(source: string) {
  if (source.toLowerCase().includes("ghl")) return "SMS";
  return BLOCK_SOURCE[source] ?? humanize(source);
}

function identifierLabel(value: string | null) {
  return value ? `•••• ${value}` : "No display suffix";
}

function displayTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time unavailable"
    : workspaceDateTimeYearFormat.format(date);
}

function blockReason(row: LiveSuppressionRow) {
  const base = BLOCK_REASON[row.source] ?? humanize(row.source);
  const recorded = row.reason?.trim();
  return recorded ? `${base} (${recorded})` : base;
}

/**
 * One list, two kinds. A tombstone is the same promise after the contact behind it was forgotten,
 * so it sits in this table under its own source rather than behind a tab nobody thinks to open.
 */
export function complianceRecords(
  suppressions: readonly LiveSuppressionRow[],
  tombstones: readonly SuppressionTombstoneRow[],
): ComplianceRecord[] {
  return [
    ...suppressions.map((row): ComplianceRecord => ({
      id: `block:${row.id}`,
      kind: "block",
      tenantName: row.tenantName,
      channel: row.channel,
      contactName: row.contactName,
      identifierLast4: row.identifierLast4,
      reason: blockReason(row),
      recordedAt: row.createdAt,
      isDemo: row.isDemo,
      isTest: row.isTest,
      source: row.source,
      providerSyncState: row.providerSyncState,
      providerSyncedAt: row.providerSyncedAt,
      deletionAuditId: null,
    })),
    ...tombstones.map((row): ComplianceRecord => ({
      id: `deleted:${row.id}`,
      kind: "deleted",
      tenantName: row.tenantName,
      channel: row.channel,
      contactName: null,
      identifierLast4: row.identifierLast4,
      reason: BLOCK_REASON.deletion,
      recordedAt: row.createdAt,
      isDemo: row.isDemo,
      isTest: false,
      source: "deletion",
      providerSyncState: null,
      providerSyncedAt: null,
      deletionAuditId: row.deletionAuditId,
    })),
  ];
}

/**
 * The column is called Confirmation, so its values do not repeat the word. A block no provider has
 * to confirm is an absence rather than a state, and a tombstone is enforced here and never sent.
 */
export function recordConfirmation(
  row: { providerSyncState: string | null; providerSyncedAt: string | null },
): { label: string; tone: StateTone; kind: "lifecycle" | "none" } {
  if (row.providerSyncState === null) {
    return { label: "Not required", tone: "neutral", kind: "none" };
  }
  const confirmed = complianceAffirmativeLabel({
    kind: "provider_confirmation",
    providerSyncState: row.providerSyncState,
    providerSyncedAt: row.providerSyncedAt,
  });
  if (confirmed) return { label: "Confirmed", tone: "good", kind: "lifecycle" };
  if (row.providerSyncState === "failed") return { label: "Failed", tone: "critical", kind: "lifecycle" };
  if (row.providerSyncState === "not_applicable") {
    return { label: "Not required", tone: "neutral", kind: "none" };
  }
  return { label: "Pending", tone: "warning", kind: "lifecycle" };
}

function pipelineState(value: string): { label: string; tone: StateTone } {
  if (Object.prototype.hasOwnProperty.call(PIPELINE_STAGE_COPY, value)) {
    return PIPELINE_STAGE_COPY[value as keyof typeof PIPELINE_STAGE_COPY];
  }
  return { label: humanize(value), tone: "neutral" };
}

/** The seg filter over the blocks table. STOP covers both ways a person can say it. */
export function matchesBlockFilter(row: ComplianceRecord, filter: BlockFilter) {
  if (filter === "all") return true;
  if (filter === "failed") return row.providerSyncState === "failed";
  if (filter === "stop") return row.source === "stop_keyword" || row.source === "stop_intent";
  return row.source === "manual";
}

export function matchesSearch(row: ComplianceRecord, query: string) {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return true;
  return [
    row.contactName ?? "",
    identifierLabel(row.identifierLast4),
    row.tenantName,
    row.reason,
    channelLabel(row.channel),
    sourceLabel(row.source),
  ].some((value) => value.toLocaleLowerCase().includes(term));
}

function provenanceLabel(isDemo: boolean, isTest: boolean): ReactNode {
  if (!isDemo && !isTest) return null;
  const label = isDemo && isTest ? "Demo, test data" : isDemo ? "Demo data" : "Test data";
  return (
    <Status className="shrink-0" label={label} tone={isDemo ? "waiting" : "neutral"} treatment="bare" />
  );
}

function SegFilter({
  items,
  label,
  onSelect,
  value,
}: {
  items: readonly { id: BlockFilter; label: string }[];
  label: string;
  onSelect: (next: BlockFilter) => void;
  value: BlockFilter;
}) {
  return (
    <div
      aria-label={label}
      className="inline-flex rounded-lg border border-[var(--line-input)] bg-[var(--card)] p-0.5"
      role="group"
    >
      {items.map((item) => (
        <button
          aria-pressed={item.id === value}
          className={[
            "inline-flex cursor-pointer items-center justify-center rounded-md px-2.5 py-[5px] text-[12.5px]",
            item.id === value
              ? "bg-[var(--accent-wash-strong)] font-medium text-[var(--accent-text)]"
              : "text-[var(--muted)]",
          ].join(" ")}
          key={item.id}
          onClick={() => onSelect(item.id)}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function Tile({ label, tone, value }: { label: string; tone?: "warning"; value: string }) {
  return (
    <div
      className={[
        "flex items-baseline gap-[12px] rounded-[14px] border px-[18px] py-[14px] shadow-[var(--shadow-card)]",
        tone === "warning"
          ? "border-[var(--warning-line)] bg-[var(--warning-wash)]"
          : "border-[var(--line)] bg-[var(--card)]",
      ].join(" ")}
    >
      <Figure className={tone === "warning" ? "text-[var(--warning-text)]" : "text-[var(--ink)]"} size="md">
        {value}
      </Figure>
      <div className="text-[12.5px] font-[500] text-[color:var(--faint)]">{label}</div>
    </div>
  );
}

function ConfirmationCell({ record }: { record: ComplianceRecord }) {
  const state = recordConfirmation(record);
  if (state.kind === "none") return <StatusAbsent label={state.label} />;
  return (
    <Pill tone={state.tone === "critical" ? "amber" : state.tone === "good" ? "good" : "neutral"}>
      <StatusDot tone={state.tone === "critical" ? "bad" : state.tone === "good" ? "good" : "amber"} />
      {state.label}
    </Pill>
  );
}

export function OwnerCompliance({
  actions,
  impersonation = null,
  initialContacts,
  suppressions,
  tombstones,
}: OwnerComplianceProps) {
  const pathname = usePathname();
  const params = useSearchParams();
  const requestedTab = params.get("tab");
  const tab: TabId = TAB_IDS.includes(requestedTab as TabId) ? (requestedTab as TabId) : "blocks";

  const [contacts, setContacts] = useState([...initialContacts]);
  const [filter, setFilter] = useState<BlockFilter>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ComplianceContact | null>(null);
  const [contactSheet, setContactSheet] = useState<ComplianceContact | null>(null);
  const [flow, dispatch] = useReducer(deleteFlowState, INITIAL_DELETE_FLOW_STATE);
  const [announcement, setAnnouncement] = useState("");
  const idempotencyKey = useRef<string | null>(null);

  async function openPreview(contact: ComplianceContact) {
    idempotencyKey.current = `admin-contact-delete:${contact.id}:${Date.now()}`;
    setContactSheet(null);
    setSelected(contact);
    dispatch({ type: "open" });
    try {
      const response = await actions.preview({ tenantId: contact.tenantId, contactId: contact.id });
      dispatch(response.ok
        ? { type: "preview_loaded", preview: response.value }
        : { type: "preview_failed", error: response.error });
    } catch {
      dispatch({ type: "preview_failed", error: "The deletion preview could not be loaded." });
    }
  }

  async function executeDeletion(input: { reason?: string }): Promise<Result> {
    if (!selected || !flow.preview || !idempotencyKey.current || impersonation) {
      return { ok: false, message: "A fresh deletion preview is required." };
    }
    try {
      const response = await actions.remove({
        tenantId: selected.tenantId,
        contactId: selected.id,
        reason: input.reason?.trim() ?? "",
        previewToken: flow.preview.token,
        idempotencyKey: idempotencyKey.current,
        retry: flow.kind === "failed" ? flow.retry : null,
      });
      if (!response.ok) {
        if (response.started) return { ok: false, partial: true, message: response.error };
        dispatch({ type: "preview_failed", error: response.error });
        return { ok: false, message: response.error };
      }
      const next = deleteFlowState(flow, { type: "result", result: response.value });
      dispatch({ type: "result", result: response.value });
      if (response.value.kind === "incomplete") {
        return {
          ok: false,
          partial: true,
          message: next.error ?? "The deletion outcome could not be confirmed.",
        };
      }
      if (response.value.kind !== "deleted") {
        return { ok: false, message: next.error ?? "The contact was not deleted." };
      }
      setContacts((current) => current.filter((contact) => contact.id !== selected.id));
      setAnnouncement(`${selected.name} was deleted after the required checks completed.`);
      return { ok: true, receipt: { actionKey: "contact.delete", auditId: response.value.auditId } };
    } catch {
      return {
        ok: false,
        partial: true,
        message: "The deletion request did not return a result, so some steps may have run.",
      };
    }
  }

  function closeDeletion() {
    dispatch({ type: "cancel" });
    idempotencyKey.current = null;
    setSelected(null);
  }

  const records = useMemo(
    () => complianceRecords(suppressions, tombstones),
    [suppressions, tombstones],
  );
  const visibleRecords = useMemo(
    () => records.filter((row) => matchesBlockFilter(row, filter) && matchesSearch(row, search)),
    [filter, records, search],
  );

  const pendingConfirmations = suppressions.filter(
    (row) => recordConfirmation(row).tone === "warning",
  ).length;
  const failedConfirmations = suppressions.filter(
    (row) => row.providerSyncState === "failed",
  ).length;

  const headerState = failedConfirmations > 0
    ? {
      amber: true,
      label: `${workspaceCountFormat.format(failedConfirmations)} confirmation${failedConfirmations === 1 ? "" : "s"} failed`,
    }
    : pendingConfirmations > 0
      ? {
        amber: true,
        label: `${workspaceCountFormat.format(pendingConfirmations)} awaiting confirmation`,
      }
      : suppressions.length > 0
        ? { amber: false, label: "Every block confirmed" }
        : { amber: false, label: "No blocks recorded" };

  const everyRowIsSeeded = [
    { count: suppressions.length, all: everyRowIsTest(suppressions, (row) => row.isDemo || row.isTest) },
    { count: tombstones.length, all: everyRowIsTest(tombstones, (row) => row.isDemo) },
    { count: contacts.length, all: everyRowIsTest(contacts, (row) => row.isDemo || row.isTest) },
  ].every((set) => set.count === 0 || set.all);

  const contactColumns = useMemo<ColumnDef<ComplianceContact>[]>(() => [
    {
      accessorKey: "name",
      header: "Contact",
      meta: {
        cellKind: "identity",
        label: "Contact",
        cellClassName: IDENTITY_WIDTH,
        headerClassName: IDENTITY_WIDTH,
      },
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-[var(--s-2)] whitespace-normal">
          <span className="min-w-0 truncate font-medium text-[var(--ink)]">{row.original.name}</span>
          {everyRowIsSeeded ? null : provenanceLabel(row.original.isDemo, row.original.isTest)}
        </span>
      ),
    },
    { accessorKey: "tenantName", header: "Workspace", meta: { label: "Workspace" } },
    {
      accessorFn: (row) => pipelineState(row.pipelineStage).label,
      header: "Pipeline stage",
      id: "pipelineStage",
      meta: { cellKind: "state", label: "Pipeline stage" },
      cell: ({ row }) => {
        const state = pipelineState(row.original.pipelineStage);
        return <Status label={state.label} tone={STATE_TONE_TO_TONE[state.tone]} treatment="bare" />;
      },
    },
    {
      accessorFn: (row) => displayTime(row.lastSeenAt),
      header: "Last seen",
      id: "lastSeen",
      meta: { cellKind: "secondary", label: "Last seen" },
    },
  ], [everyRowIsSeeded]);

  const deletionImpact = selected && flow.preview
    ? (() => {
      const counts = flow.preview.counts;
      const providerDeletes = flow.preview.providerEffects.filter(
        (effect) => effect.kind === "provider_contact_delete",
      );
      const providerKeeps = flow.preview.providerEffects.filter(
        (effect) => effect.kind === "thread_scope_limitation",
      );
      const deletes = (label: string, value: number) => ({
        label,
        value: `${workspaceCountFormat.format(value)} deleted`,
      });
      return [
        {
          title: "What this deletes",
          rows: [
            { label: "Contact record", value: `${selected.name} in ${selected.tenantName}, deleted` },
            deletes("Merged duplicate records", counts.mergedContacts),
            deletes("Handles and phone numbers", counts.identities),
            deletes("Conversation threads", counts.conversations),
            deletes("Messages", counts.messages),
            deletes("Message traces", counts.messageTraces),
            deletes("Appointments", counts.appointments),
            deletes("Follow-ups", counts.followups),
            deletes("Contact notes", counts.contactNotes),
            deletes("Unmatched objections", counts.unmatchedObjections),
            ...providerDeletes.map((effect) => ({
              label: effect.label,
              value: `${workspaceCountFormat.format(effect.targetCount)} connected contact record${effect.targetCount === 1 ? "" : "s"} deleted`,
            })),
          ],
        },
        {
          title: "What survives, on purpose",
          note: "The block keeps the promise “never message me again” after the record it came from is gone. None of this can be undone.",
          rows: [
            {
              label: "The block on every handle and number",
              value: "kept, stored as a hash the send path checks before anything goes out",
            },
            {
              label: "Billing already decided",
              value: `${workspaceCountFormat.format(counts.billableEventsDetached)} kept, detached from the deleted appointment`,
            },
            {
              label: "Eval cases built from these messages",
              value: `${workspaceCountFormat.format(counts.evalCasesSevered)} kept, quarantined with their source severed`,
            },
            {
              label: "Merge history in the audit log",
              value: `${workspaceCountFormat.format(counts.mergeAuditsRedacted)} kept, redacted`,
            },
            ...providerKeeps.map((effect) => ({ label: effect.label, value: effect.explanation })),
            { label: "This deletion", value: "recorded in the audit log with your reason" },
          ],
        },
      ];
    })()
    : [];

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-[16px]">
      <div className="flex items-end gap-[12px]">
        <h1 className="m-0 text-[30px] leading-[1.1] font-[600] tracking-[-0.02em] text-[color:var(--ink)]">
          Compliance
        </h1>
        <Pill className="mb-[3px]" tone={headerState.amber ? "amber" : "neutral"}>
          <StatusDot tone={headerState.amber ? "amber" : "good"} />
          {headerState.label}
        </Pill>
        {impersonation ? (
          <Pill className="mb-[3px]" tone="amber">
            <StatusDot tone="amber" />
            Read-only workspace view
          </Pill>
        ) : null}
        <div className="ml-auto flex items-center gap-[8px]">
          {impersonation ? null : (
            <ExportMenu
              filename="setterfi-suppression-tombstones"
              label="Export every deletion record"
              mode="server"
              query={{ order: "created_desc", reason: "" }}
              resource="suppression-tombstones"
            />
          )}
        </div>
      </div>

      <RehaulTabs
        items={[
          { active: tab === "blocks", href: `${pathname}?tab=blocks`, label: "Blocks" },
          { active: tab === "contacts", href: `${pathname}?tab=contacts`, label: "Contacts" },
          {
            active: tab === "message-rules",
            href: `${pathname}?tab=message-rules`,
            label: "Message rules",
          },
        ]}
        label="Compliance sections"
      />

      <div aria-live="polite" className={announcement ? "shrink-0 text-[13px] text-[var(--good)]" : "sr-only"}>
        {announcement}
      </div>

      {tab === "blocks" ? (
        <>
          <div className="grid grid-cols-1 gap-[16px] md:grid-cols-2 xl:grid-cols-4">
            <Tile label="current blocks" value={workspaceCountFormat.format(suppressions.length)} />
            <Tile
              label="awaiting confirmation"
              value={workspaceCountFormat.format(pendingConfirmations)}
            />
            <Tile
              label="confirmation failed"
              tone={failedConfirmations > 0 ? "warning" : undefined}
              value={workspaceCountFormat.format(failedConfirmations)}
            />
            <Tile label="kept after deletion" value={workspaceCountFormat.format(tombstones.length)} />
          </div>

          <CardTable className="min-h-0">
            <div className="flex items-center gap-[8px] border-b border-[var(--line)] px-[14px] py-[10px]">
              <SegFilter
                items={[
                  { id: "all", label: "All" },
                  { id: "failed", label: "Failed" },
                  { id: "stop", label: "STOP" },
                  { id: "manual", label: "By hand" },
                ]}
                label="Which blocks this table shows"
                onSelect={setFilter}
                value={filter}
              />
              <input
                aria-label="Search contact, workspace or reason"
                className="ml-auto h-[30px] w-[260px] rounded-lg border border-[var(--line-input)] bg-[var(--card)] px-[10px] text-[13px] text-[var(--ink)] placeholder:text-[var(--faint)]"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search contact, workspace or reason"
                type="search"
                value={search}
              />
            </div>
            {visibleRecords.length === 0 ? (
              <div className="px-[14px] py-[20px]">
                <DataState
                  body={records.length === 0
                    ? "A block is recorded here after an opt-out or another verified compliance event."
                    : "Clear the filter or the search term to see the rest."}
                  kind="empty"
                  title={records.length === 0 ? "No contact blocks recorded" : "No blocks match this filter"}
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table aria-label="Contact blocks and deletion records" className={CARD_TABLE.table}>
                  <thead>
                    <tr>
                      <th className={CARD_TABLE.th}>Contact</th>
                      <th className={CARD_TABLE.th}>Channel</th>
                      <th className={CARD_TABLE.th}>Workspace</th>
                      <th className={CARD_TABLE.th}>Why</th>
                      <th className={CARD_TABLE.th}>Confirmation</th>
                      <th className={CARD_TABLE.th}>Recorded</th>
                      <th className={CARD_TABLE.th}>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRecords.map((row) => (
                      <tr
                        className={row.providerSyncState === "failed" ? "bg-[var(--warning-wash)]" : undefined}
                        key={row.id}
                      >
                        <td className={`${CARD_TABLE.td} font-medium text-[var(--ink)]`}>
                          {row.kind === "deleted" ? (
                            <span className="flex items-center gap-[8px]">
                              <Status label="Contact deleted" tone="neutral" treatment="bare" />
                              <MonoMeta>{identifierLabel(row.identifierLast4)}</MonoMeta>
                            </span>
                          ) : (
                            <span className="flex items-center gap-[8px]">
                              {row.contactName ?? (
                                <span className="font-mono">{identifierLabel(row.identifierLast4)}</span>
                              )}
                              {everyRowIsSeeded ? null : provenanceLabel(row.isDemo, row.isTest)}
                            </span>
                          )}
                        </td>
                        <td className={CARD_TABLE.td}>{channelLabel(row.channel)}</td>
                        <td className={CARD_TABLE.td}>{row.tenantName}</td>
                        <td className={`${CARD_TABLE.td} text-[var(--muted)]`}>{row.reason}</td>
                        <td className={CARD_TABLE.td}>
                          <ConfirmationCell record={row} />
                        </td>
                        <td className={`${CARD_TABLE.td} font-mono text-[var(--meta)]`}>
                          {displayTime(row.recordedAt)}
                        </td>
                        <td className={`${CARD_TABLE.td} text-[var(--faint)]`}>{sourceLabel(row.source)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardTable>
        </>
      ) : null}

      {tab === "contacts" ? (
        <DataTable
          ariaLabel="Contacts available for deletion"
          columns={contactColumns}
          data={contacts}
          emptyState={(
            <DataState
              body="Contacts appear here when this workspace has records eligible for a privacy action."
              kind="empty"
              title="No contacts available"
            />
          )}
          exportResource={{
            filename: "setterfi-compliance-contacts",
            mode: "local",
            rows: contacts.map((contact) => ({
              id: contact.id,
              tenantId: contact.tenantId,
              tenantName: contact.tenantName,
              name: contact.name,
              pipelineStage: contact.pipelineStage,
              lastSeenAt: contact.lastSeenAt,
              isDemo: contact.isDemo,
              isTest: contact.isTest,
            })),
          }}
          getRowId={(row) => row.id}
          onRowClick={setContactSheet}
          ordering="most recently seen first"
          rowActions={(row) => [{
            id: "delete",
            label: "Delete contact",
            tone: "critical" as const,
            disabled: Boolean(impersonation),
            logged: impersonation
              ? "Read-only while viewing another workspace"
              : AUDIT_ACTIONS["contact.delete"].microcopy,
            onSelect: () => void openPreview(row),
          }]}
          rowActionsLabel={(row) => `Actions for ${row.name}`}
          rowLabel={{ singular: "contact", plural: "contacts" }}
          search={{ placeholder: "Search contact, workspace, or stage" }}
          variant="ledger"
        />
      ) : null}

      {tab === "message-rules" ? (
        <CardTable>
          <ul className="m-0 list-none p-0">
            {MESSAGE_RULES.map((rule) => (
              <li
                className="flex items-center gap-[12px] border-b border-[var(--line-soft)] px-[16px] py-[14px] last:border-b-0"
                key={rule.title}
              >
                <span className="min-w-0 flex-1 text-[13.5px] font-[500] text-[color:var(--ink)]">
                  {rule.title}
                </span>
                <Pill tone="neutral">{rule.value}</Pill>
              </li>
            ))}
          </ul>
        </CardTable>
      ) : null}

      <RecordSheet
        destructive={contactSheet && !impersonation ? {
          label: "Delete contact",
          onClick: () => { if (contactSheet) void openPreview(contactSheet); },
        } : undefined}
        logged={impersonation ? undefined : AUDIT_ACTIONS["contact.delete"].microcopy}
        onOpenChange={(open) => { if (!open) setContactSheet(null); }}
        open={contactSheet !== null}
        sections={contactSheet ? [{
          title: "Contact",
          fields: [
            { label: "Workspace", value: contactSheet.tenantName },
            { label: "Pipeline stage", value: pipelineState(contactSheet.pipelineStage).label },
            { label: "Last seen", value: displayTime(contactSheet.lastSeenAt) },
          ],
        }] : []}
        subtitle={contactSheet ? contactSheet.tenantName : undefined}
        technical={contactSheet ? [
          { label: "Contact ID", value: contactSheet.id, mono: true },
          { label: "Workspace ID", value: contactSheet.tenantId, mono: true },
        ] : undefined}
        title={contactSheet?.name ?? ""}
      />

      {selected && flow.kind === "previewing" ? (
        <section aria-label="Deletion preview" className="max-w-[var(--measure-prose)]">
          <DataState kind="loading" rows={1} />
        </section>
      ) : null}

      {selected && flow.kind === "failed" && !flow.preview ? (
        <section className="flex max-w-[var(--measure-prose)] flex-col items-start gap-[var(--s-2)]">
          <DataState
            body={flow.error ?? "The deletion preview could not be loaded."}
            kind="unavailable"
            retry={() => void openPreview(selected)}
            title="Deletion preview could not load"
          />
          <Button onClick={closeDeletion} type="button" variant="ghost">Cancel deletion</Button>
        </section>
      ) : null}

      <ConfirmFlow
        action="contact.delete"
        confirmLabel="Delete permanently"
        destructive
        impact={deletionImpact}
        onConfirm={executeDeletion}
        onOpenChange={(open) => { if (!open) closeDeletion(); }}
        open={Boolean(selected && flow.preview)}
        reason={{
          required: true,
          label: "Privacy-request reason",
          hint: "Record the request and how its source was verified.",
        }}
        title={selected ? `Delete ${selected.name}` : "Delete contact"}
        typeToConfirm={{
          word: "DELETE",
          label: "Type DELETE to confirm",
          hint: "There is no undo and no recovery: the records above are gone the moment this runs.",
        }}
      />

      <ContextEye copy={OWNER_COMPLIANCE_EYE_COPY} screen="owner-compliance" />
    </div>
  );
}
