"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useReducer, useRef, useState, type ReactNode } from "react";

import { Callout } from "@/components/kit/callout";
import { CellQuiet } from "@/components/kit/cell-quiet";
import { ConfirmFlow, type Result } from "@/components/kit/confirm-flow";
import { DataState } from "@/components/kit/data-state";
import { DataTable, everyRowIsTest } from "@/components/kit/data-table";
import { ExportMenu } from "@/components/kit/export-menu";
import { PageHeader } from "@/components/kit/page-header";
import { RecordSheet } from "@/components/kit/record-sheet";
import {
  MonoMeta,
  STATE_TONE_TO_TONE,
  SettingGroup,
  SettingRow,
  Status,
  StatusAbsent,
  type Tone,
} from "@/components/kit/atomics";
import type { StateTone } from "@/components/kit/state-badge";
import { ConsoleStatDeck } from "@/components/kit/console-stat-deck";
import { type StatStripItem } from "@/components/kit/stat-strip";
import { DetailPage } from "@/components/kit/templates/detail-page";
import { Button } from "@/components/ui/button";
import { wholePageProvenanceKind } from "@/components/kit/provenance-chip";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { PIPELINE_STAGE_COPY } from "@/lib/copy/states";
import type { DeletionPreview, DeleteLeadResult } from "@/lib/deletion/contracts";
import { workspaceCountFormat, workspaceDateTimeYearFormat } from "@/lib/format/datetime";
import {
  complianceAffirmativeLabel,
  deleteFlowState,
  INITIAL_DELETE_FLOW_STATE,
} from "./view-models";

export type ComplianceContact = {
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  pipelineStage: string;
  lastSeenAt: string;
  isDemo: boolean;
  isTest: boolean;
};

export type LiveSuppressionRow = {
  id: string;
  tenantName: string;
  contactName: string | null;
  channel: string;
  identifierLast4: string | null;
  source: string;
  /** `suppression_entries.reason`, required by the table's own check for a hand-recorded block. */
  reason: string | null;
  providerSyncState: string;
  providerSyncedAt: string | null;
  createdAt: string;
  isDemo: boolean;
  isTest: boolean;
};

export type SuppressionTombstoneRow = {
  id: string;
  tenantName: string;
  channel: string;
  identifierLast4: string | null;
  deletionAuditId: number;
  createdAt: string;
  isDemo: boolean;
};

// `started` marks a refusal raised after the deletion began, so the caller must not claim nothing changed.
type ActionReply<T> = { ok: true; value: T } | { ok: false; error: string; started?: true };

export type AdminDeletionActions = {
  preview(input: { tenantId: string; contactId: string }): Promise<ActionReply<DeletionPreview>>;
  remove(input: {
    tenantId: string;
    contactId: string;
    reason: string;
    previewToken: string;
    idempotencyKey: string;
    retry: import("@/lib/deletion/contracts").DeletionRetryReceipt | null;
  }): Promise<ActionReply<DeleteLeadResult>>;
};

const CRUMBS = [
  { label: "Brain", href: "/admin/brain" },
  { label: "Compliance" },
] as const;

// DataTable gives an identity column the same width as every other column, and these rows carry a
// provenance label beside the name, so the name is widened locally to stay readable.
const IDENTITY_WIDTH = "w-[calc(var(--drawer-w)*0.7)] max-w-[calc(var(--drawer-w)*0.7)]";

const PAGE_DESCRIPTION =
  "Contact blocks and the deletion records they outlive. A block survives everything, including deleting the contact it came from.";

/**
 * The second line of the header, and it is a claim about the send path rather than about this
 * page: `src/lib/sends/send-to-lead.ts` checks the deletion tombstone and then the live block
 * before any contact-dependent eligibility, and refuses the send. Control replies -- the STOP and
 * HELP acknowledgements a carrier requires -- are the one purpose that still goes out, which is
 * why the sentence says so instead of claiming nothing ever sends.
 */
const ENFORCEMENT_NOTE =
  "Checked at send time, before anything the agent decided: a blocked identity is refused, and only the STOP and HELP acknowledgements carriers require still go out.";

/**
 * The rules an outbound message actually passes, in the order `src/lib/sends/send-to-lead.ts`
 * applies them.
 *
 * Every sentence here was checked against that file and the modules it calls, because a compliance
 * page is the one surface where a described control that does not exist is worse than no page at
 * all -- somebody reads it, believes the platform is doing the checking, and stops doing it
 * themselves. Where the code and the canvas disagreed, the code won:
 *
 *   - The canvas draws an "Identification" row. Nothing in the send path enforces that an outbound
 *     message identifies the business, so there is no row for it and the note below says the list
 *     is what the send path checks rather than everything a carrier asks of a sender.
 *   - The canvas draws "No prohibited categories". The content checks that catch a claim or an
 *     out-of-scope request run in the ENGINE, before a draft ever becomes a send, so they belong on
 *     the Brain's surface and are not restated here as if the send path re-checked them.
 *
 * The rows carry no counts. `send_refusals` is not read by this page, and a row saying "0 blocked
 * this month" that came from nowhere would be the invented figure this panel exists to avoid.
 */
const MESSAGE_RULES: readonly {
  title: string;
  description: string;
  value: string;
}[] = [
  {
    title: "Stop means stop, on every channel",
    description:
      "Fifteen keywords and eleven phrasings of the same intent are matched before any model or prompt work, and STOP is recognised on every channel because revocation follows the person rather than the phone number. The block commits locally first and stays authoritative even when the provider read-back fails.",
    value: "Matched before the model",
  },
  {
    title: "A block outlives the contact it came from",
    description:
      "The deletion tombstone is checked ahead of the live block and ahead of anything that depends on the contact record, so deleting a lead cannot resurrect their consent. Only the STOP and HELP acknowledgements a carrier requires still go out.",
    value: "Checked at send",
  },
  {
    title: "No consent basis, no message",
    description:
      "Every non-control purpose has to resolve a consent basis for this contact, this channel and this moment before dispatch. A message with none is refused rather than queued, and the refusal is recorded.",
    value: "Refused, not queued",
  },
  {
    title: "Quiet hours defer, they do not drop",
    description:
      "A message that lands inside quiet hours is scheduled for the next allowed window against the lead's own timezone, and the deferral records which timezone it used. A human replying in a live thread can override it once, and is asked to confirm first.",
    value: "Deferred to the next window",
  },
  {
    title: "Carrier control replies are published copy, not defaults",
    description:
      "The STOP, HELP and START acknowledgements are per-workspace artifacts, and one stays unusable until a human publication receipt binds its version and the hash of its body. An unpublished or tampered reply refuses the send instead of falling back to placeholder wording.",
    value: "Publication receipt required",
  },
];

function MessageRulesPanel() {
  return (
    <div className="flex min-w-0 flex-col gap-[var(--s-4)]">
      <p className="m-0 max-w-[var(--measure-prose)] text-[length:var(--t-body)] leading-[1.55] text-[color:var(--muted)]">
        What an outbound message has to pass before it leaves, in the order the send path checks it.
        Each of these is a check in the code rather than a policy written down somewhere: a message
        that fails one is refused or deferred, never sent and logged afterwards.
      </p>
      <SettingGroup>
        {MESSAGE_RULES.map((rule) => (
          <SettingRow
            align="start"
            control={<Status label={rule.value} tone="good" treatment="bare" />}
            description={rule.description}
            key={rule.title}
            title={rule.title}
          />
        ))}
      </SettingGroup>
      {/*
        The honest edge of the list. A compliance page that stops at five rows without saying what
        is NOT on it invites the reader to assume the five are everything, which is how a sender
        ends up believing the platform is checking something nobody wrote.
      */}
      <p className="m-0 max-w-[var(--measure-prose)] text-[11.5px] leading-[1.45] text-[color:var(--faint)]">
        This is what the send path checks. It is not the whole of what a carrier asks of a sender:
        sender identification is not enforced here, and the rules about what the agent may claim are
        checked in The Brain before a draft ever becomes a message.
      </p>
    </div>
  );
}

export function ComplianceHeader() {
  return <PageHeader crumbs={CRUMBS} description={PAGE_DESCRIPTION} title="Compliance" />;
}

function displayTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time unavailable"
    : workspaceDateTimeYearFormat.format(date);
}

function humanize(value: string) {
  return value
    .replaceAll(/[._-]+/g, " ")
    .replace(/^./, (character) => character.toLocaleUpperCase());
}

function channelLabel(channel: string) {
  if (channel.toLowerCase() === "sms") return "Text messages (SMS)";
  return humanize(channel);
}

function sourceLabel(source: string) {
  return source.toLowerCase().includes("ghl")
    ? "Text messages (SMS)"
    : humanize(source);
}

/**
 * Why a block exists, in the words the operator needs rather than the enum the row stores. The
 * six keys are the whole of `suppression_source_chk` in
 * `supabase/migrations/20260817000001_phase1_demo_path.sql`; an unrecognised value falls back to
 * the humanised enum rather than to an invented sentence.
 */
const BLOCK_REASON: Record<string, string> = {
  stop_keyword: "Replied STOP. Nothing sends to them again",
  stop_intent: "Asked to stop in their own words. Nothing sends to them again",
  manual: "Recorded by hand",
  import: "Imported from an existing do-not-contact list",
  complaint: "A complaint was recorded against this identity",
  deletion: "Kept from a permanent contact deletion",
};

function blockReason(row: LiveSuppressionRow) {
  const base = BLOCK_REASON[row.source] ?? humanize(row.source);
  const recorded = row.reason?.trim();
  // The table's own check requires a reason for a hand-recorded block, so when one exists it is
  // the real answer and the enum phrase is only its heading. Parentheses rather than a colon,
  // because two of the six bases are already two sentences and a colon after a full stop reads
  // as a fault rather than as a join.
  return recorded ? `${base} (${recorded})` : base;
}

function deletionReason(row: SuppressionTombstoneRow) {
  return `Permanent deletion, recorded as audit #${row.deletionAuditId}. The block on this ${channelLabel(row.channel).toLocaleLowerCase()} identity remains`;
}

/**
 * One list, two bands. The tombstone is not a different kind of thing from a block -- it is the
 * same promise after the contact behind it was forgotten -- so it belongs in the same table under
 * its own heading rather than behind a tab an operator has to think to open.
 */
export type ComplianceRecord = {
  id: string;
  kind: "block" | "deleted";
  tenantName: string;
  channel: string;
  contactName: string | null;
  identifierLast4: string | null;
  reason: string;
  recordedAt: string;
  isDemo: boolean;
  isTest: boolean;
  source: string;
  providerSyncState: string | null;
  providerSyncedAt: string | null;
  deletionAuditId: number | null;
};

/**
 * The two bands, and each one carries the sentence its label used to try to smuggle into
 * parentheses. "Deleted contacts (the block survives)" was a heading arguing with itself; the
 * annotation is where that argument belongs, and it is a standing fact about every row under it.
 */
const RECORD_GROUPS = [
  {
    annotation: "held against the identity, not against the contact record",
    id: "block",
    label: "Current blocks",
    tone: "good",
  },
  {
    annotation: "the contact record is gone, the block it left behind is not",
    id: "deleted",
    label: "Deleted contacts",
    tone: "neutral",
  },
] as const satisfies readonly { annotation: string; id: string; label: string; tone: Tone }[];

/**
 * Both compliance reads take the two hundred most recent rows, so search and the counts under the
 * table describe that window and not the whole history. A page that says "12 records" over a
 * capped read invites the reader to conclude there are twelve, which on this page of all pages is
 * the wrong thing to leave them believing.
 */
const RECORDS_FOOTER_NOTE =
  "Only the two hundred most recently recorded of each kind are loaded, so search here looks at those and no further.";

const CONTACTS_FOOTER_NOTE =
  "Only the two hundred most recently seen contacts are loaded, so search here looks at those and no further.";

function complianceRecords(
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
      reason: deletionReason(row),
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

function identifierLabel(value: string | null) {
  return value ? `•••• ${value}` : "No display suffix";
}

// One label per row, not two: a row that is both seeded demo data and test data still needs to
// read as "not real analytics" at a glance, and two pills per row buries the name they sit beside.
function provenanceLabels(isDemo: boolean, isTest: boolean): ReactNode {
  if (!isDemo && !isTest) return null;
  const label = isDemo && isTest
    ? "Demo, test data"
    : isDemo
      ? "Demo data"
      : "Test data";
  return (
    /*
      The seeded-data marker. It stays a real, worded status rather than a quiet chip: a test row
      that does not say it is a test row is the segregation rule broken, and this page is the one
      place an operator decides what is real.
    */
    <Status
      className="shrink-0"
      label={label}
      tone={isDemo ? "waiting" : "neutral"}
      treatment="bare"
    />
  );
}

/**
 * The column is called Confirmation, so its values do not repeat the word: "Confirmation pending"
 * under a "Confirmation" header reads as a stutter, and the state is still exactly as honest.
 * A block a provider never has to confirm is an absence, not a state, so it gets no pill.
 */
function providerState(
  row: { providerSyncState: string; providerSyncedAt: string | null },
): { label: string; tone: StateTone; kind: "lifecycle" | "none" } {
  const confirmed = complianceAffirmativeLabel({
    kind: "provider_confirmation",
    providerSyncState: row.providerSyncState,
    providerSyncedAt: row.providerSyncedAt,
  });
  if (confirmed) return { label: confirmed, tone: "good", kind: "lifecycle" };
  if (row.providerSyncState === "failed") {
    return { label: "Failed", tone: "critical", kind: "lifecycle" };
  }
  if (row.providerSyncState === "not_applicable") {
    return { label: "Not required", tone: "neutral", kind: "none" };
  }
  return { label: "Pending", tone: "warning", kind: "lifecycle" };
}

/**
 * A tombstone has nothing to confirm: it is enforced locally, in the send path, and no provider
 * ever receipts it. That is an absence rather than a pending state, so it says so rather than
 * borrowing the amber a live block wears while its provider catches up.
 */
function recordConfirmation(row: ComplianceRecord) {
  if (row.providerSyncState === null) {
    return { label: "Not required", tone: "neutral" as StateTone, kind: "none" as const };
  }
  return providerState({
    providerSyncState: row.providerSyncState,
    providerSyncedAt: row.providerSyncedAt,
  });
}

function pipelineState(value: string): { label: string; tone: StateTone } {
  if (Object.prototype.hasOwnProperty.call(PIPELINE_STAGE_COPY, value)) {
    return PIPELINE_STAGE_COPY[value as keyof typeof PIPELINE_STAGE_COPY];
  }
  return { label: humanize(value), tone: "neutral" };
}

/**
 * `showProvenance` is false once every row on the page is seeded: the chip would repeat on every
 * line and say nothing about how the rows differ, so the page-level line carries the disclosure
 * instead. This is the same rule `DataTable` applies to its own test-row chip.
 */
function IdentityCell({
  isDemo,
  isTest,
  label,
  showProvenance = true,
}: {
  isDemo: boolean;
  isTest: boolean;
  label: string;
  showProvenance?: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-[var(--s-2)] whitespace-normal">
      <span className="min-w-0 truncate font-medium text-[var(--ink)]">{label}</span>
      {showProvenance ? provenanceLabels(isDemo, isTest) : null}
    </span>
  );
}

/**
 * The identity of a compliance record. A tombstone has no contact to name -- that is the point of
 * it -- so the cell says the contact is gone in words and shows the display suffix that is all we
 * still hold, rather than printing a blank or an id.
 */
function RecordIdentityCell({
  record,
  showProvenance,
}: {
  record: ComplianceRecord;
  showProvenance: boolean;
}) {
  if (record.kind === "deleted") {
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-[var(--s-2)] whitespace-normal">
        <Status label="Contact deleted" tone="neutral" treatment="bare" />
        {record.identifierLast4
          ? <MonoMeta>{identifierLabel(record.identifierLast4)}</MonoMeta>
          : <CellQuiet>no display suffix stored</CellQuiet>}
        {showProvenance ? provenanceLabels(record.isDemo, record.isTest) : null}
      </span>
    );
  }
  return (
    <IdentityCell
      isDemo={record.isDemo}
      isTest={record.isTest}
      label={record.contactName ?? "Contact unavailable"}
      showProvenance={showProvenance}
    />
  );
}

function SectionIntro({ body }: { body: string }) {
  return (
    <p className="m-0 max-w-[var(--measure-wide)] text-[length:var(--t-body)] leading-[var(--t-body-lh)] text-[var(--muted)]">
      {body}
    </p>
  );
}

/*
 * A zero here is a real measured zero and it is the good news -- no blocks failed to confirm --
 * so `no-events` is the availability it carries: that arm is what `stat-strip.tsx` documents as
 * "read, and the answer is genuinely none", against `read-failed`, which is "nobody knows". The
 * panel prints the zero and puts the reason beside it in words.
 *
 * It used to withhold the digit entirely and print only the words, on the reasoning that a bare
 * grey 0 reads as a broken counter. That reasoning held while these were `FigureStrip` tiles,
 * which have one absent case covering both a failed read and a measured none -- so a 0 there
 * genuinely could not be told from a gap. A console deck panel states the availability in its own
 * sentence underneath, so the digit is no longer ambiguous, and the whole console now reads the
 * same way: Affiliates has printed `0` with its entry count beside it since it moved.
 */
function countTile(label: string, value: number, note: string): StatStripItem {
  return {
    label,
    availability: value === 0
      ? { kind: "no-events", note }
      : { kind: "value", value, format: "count" },
  };
}

export function AdminCompliance({
  initialContacts,
  suppressions,
  tombstones,
  impersonation = null,
  actions,
}: {
  initialContacts: readonly ComplianceContact[];
  suppressions: readonly LiveSuppressionRow[];
  tombstones: readonly SuppressionTombstoneRow[];
  impersonation?: { sessionId: string; tenantId: string } | null;
  actions: AdminDeletionActions;
}) {
  const [contacts, setContacts] = useState([...initialContacts]);
  const [selected, setSelected] = useState<ComplianceContact | null>(null);
  const [recordSheet, setRecordSheet] = useState<ComplianceRecord | null>(null);
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
      const response = await actions.preview({
        tenantId: contact.tenantId,
        contactId: contact.id,
      });
      dispatch(response.ok
        ? { type: "preview_loaded", preview: response.value }
        : { type: "preview_failed", error: response.error });
    } catch {
      dispatch({
        type: "preview_failed",
        error: "The deletion preview could not be loaded.",
      });
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
        return {
          ok: false,
          message: next.error ?? "The contact was not deleted.",
        };
      }

      setContacts((current) => current.filter((contact) => contact.id !== selected.id));
      setAnnouncement(`${selected.name} was deleted after the required checks completed.`);
      return {
        ok: true,
        receipt: {
          actionKey: "contact.delete",
          auditId: response.value.auditId,
        },
      };
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

  const pendingConfirmations = suppressions.filter(
    (row) => providerState(row).tone === "warning",
  ).length;
  const failedConfirmations = suppressions.filter(
    (row) => row.providerSyncState === "failed",
  ).length;

  const headerState = failedConfirmations > 0
    ? {
      kind: "lifecycle" as const,
      label: `${failedConfirmations} confirmation${failedConfirmations === 1 ? "" : "s"} failed`,
      tone: "critical" as StateTone,
    }
    : pendingConfirmations > 0
      ? {
        kind: "lifecycle" as const,
        label: `${pendingConfirmations} awaiting confirmation`,
        tone: "warning" as StateTone,
      }
      : suppressions.length > 0
        ? { kind: "lifecycle" as const, label: "Every block confirmed", tone: "good" as StateTone }
        : { kind: "lifecycle" as const, label: "No blocks recorded", tone: "neutral" as StateTone };

  const records = useMemo(
    () => complianceRecords(suppressions, tombstones),
    [suppressions, tombstones],
  );
  const blockedWorkspaces = new Set(suppressions.map((row) => row.tenantName)).size;
  const blockTiles: StatStripItem[] = [
    {
      label: "Current blocks",
      note: suppressions.length === 0
        ? undefined
        : `across ${workspaceCountFormat.format(blockedWorkspaces)} ${blockedWorkspaces === 1 ? "workspace" : "workspaces"}`,
      availability: suppressions.length === 0
        ? { kind: "no-events", note: "No block has been recorded yet." }
        : { kind: "value", value: suppressions.length, format: "count" },
    },
    countTile("Awaiting confirmation", pendingConfirmations, "Nothing is waiting on a provider."),
    countTile("Confirmation failed", failedConfirmations, "No block has failed to confirm."),
    countTile("Deleted contacts, block kept", tombstones.length, "No deletion record has been written."),
  ];

  // Every row on the page seeded means the per-row chip stops distinguishing anything, so the
  // page says it once under the title and the identity cells go back to being names.
  const seededSets = [
    { count: suppressions.length, all: everyRowIsTest(suppressions, (row) => row.isDemo || row.isTest) },
    { count: tombstones.length, all: everyRowIsTest(tombstones, (row) => row.isDemo) },
    { count: contacts.length, all: everyRowIsTest(contacts, (row) => row.isDemo || row.isTest) },
  ];
  const everyRowIsSeeded = seededSets.some((set) => set.count > 0)
    && seededSets.every((set) => set.count === 0 || set.all);

  /*
   * The chip carries one word and this page's three tables mark rows two ways -- `isDemo` for a
   * seeded workspace and `isTest` for a tenant marked as test data. Where every row across all
   * three is seeded the same way the chip is exact; where the page mixes them it stays on the
   * sentence, which is the only form that is true of both halves.
   */
  const pageProvenanceKind = wholePageProvenanceKind(
    [
      ...suppressions.map((row) => ({ isDemo: row.isDemo, isTest: row.isTest })),
      ...tombstones.map((row) => ({ isDemo: row.isDemo, isTest: false })),
      ...contacts.map((row) => ({ isDemo: row.isDemo, isTest: row.isTest })),
    ],
    (row) => (row.isTest ? "test" : row.isDemo ? "demo" : null),
  );

  const recordColumns = useMemo<ColumnDef<ComplianceRecord>[]>(() => [
    {
      accessorFn: (row) => row.contactName ?? identifierLabel(row.identifierLast4),
      header: "Contact",
      id: "contact",
      cell: ({ row }) => (
        <RecordIdentityCell record={row.original} showProvenance={!everyRowIsSeeded} />
      ),
      meta: {
        cellKind: "identity",
        label: "Contact",
        cellClassName: IDENTITY_WIDTH,
        headerClassName: IDENTITY_WIDTH,
      },
    },
    {
      accessorFn: (row) => channelLabel(row.channel),
      header: "Channel",
      id: "channel",
      meta: { label: "Channel" },
    },
    {
      accessorKey: "tenantName",
      header: "Workspace",
      meta: { label: "Workspace" },
    },
    {
      // The column the whole page is for. A block with no stated cause is a block nobody can
      // defend later, so the sentence rides the row rather than hiding in the record sheet.
      accessorKey: "reason",
      header: "Why",
      id: "reason",
      meta: { label: "Why", minWidth: 260 },
      cell: ({ row }) => (
        <span className="block whitespace-normal text-[color:var(--muted)]">{row.original.reason}</span>
      ),
    },
    {
      accessorFn: (row) => recordConfirmation(row).label,
      header: "Confirmation",
      id: "confirmation",
      meta: { cellKind: "state", label: "Confirmation" },
      cell: ({ row }) => {
        const state = recordConfirmation(row.original);
        return state.kind === "none"
          ? <StatusAbsent label={state.label} />
          : <Status label={state.label} tone={STATE_TONE_TO_TONE[state.tone]} treatment="bare" />;
      },
    },
    {
      accessorFn: (row) => displayTime(row.recordedAt),
      header: "Recorded",
      id: "recorded",
      meta: { cellKind: "secondary", label: "Recorded" },
    },
    {
      accessorFn: (row) => identifierLabel(row.identifierLast4),
      cell: ({ row }) => (row.original.identifierLast4
        ? identifierLabel(row.original.identifierLast4)
        : <CellQuiet>no display suffix stored</CellQuiet>),
      header: "Identifier",
      id: "identifier",
      meta: { defaultHidden: true, label: "Identifier" },
    },
    {
      accessorFn: (row) => sourceLabel(row.source),
      header: "Source",
      id: "source",
      meta: { defaultHidden: true, label: "Source" },
    },
  ], [everyRowIsSeeded]);

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
        <IdentityCell
          isDemo={row.original.isDemo}
          isTest={row.original.isTest}
          label={row.original.name}
          showProvenance={!everyRowIsSeeded}
        />
      ),
    },
    {
      accessorKey: "tenantName",
      header: "Workspace",
      meta: { label: "Workspace" },
    },
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

  /**
   * What the deletion actually does, in two bands, derived from the preview counts and from the
   * deletion RPC itself -- `finalize_contact_deletion_intent` in
   * `supabase/migrations/20260905000010_backend_security_sagas.sql`. Nothing here is copy: the
   * first band is what that function deletes, the second is what it deliberately leaves standing,
   * and a row only exists because a column behind it does.
   */
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
            {
              label: "Contact record",
              value: `${selected.name} in ${selected.tenantName}, deleted`,
            },
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
          note: "The block keeps the promise \u201cnever message me again\u201d after the record it came from is gone. None of this can be undone.",
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
            ...providerKeeps.map((effect) => ({
              label: effect.label,
              value: effect.explanation,
            })),
            { label: "This deletion", value: "recorded in the audit log with your reason" },
          ],
        },
      ];
    })()
    : [];

  const recordsTab = (
    <section className="relative flex min-w-0 flex-col gap-[var(--s-4)]">
      {/*
        * "Current blocks" is the one panel that fills. The other three are read against it -- how
        * many of those blocks are waiting, how many failed, how many outlived their contact -- and
        * a console screen spends its fill once. It is deliberately not "Confirmation failed": that
        * count is usually zero, and drenching a healthy zero is the page shouting about nothing.
        */}
      <ConsoleStatDeck
        ariaLabel="Contact block summary"
        heroLabel="Current blocks"
        items={blockTiles}
      />
      <DataTable
        ariaLabel="Contact blocks and deletion records"
        columns={recordColumns}
        data={records}
        emptyState={(
          <DataState
            body="A block appears here after an opt-out or another verified compliance event, and stays after the contact behind it is deleted."
            kind="empty"
            title="No contact blocks recorded"
          />
        )}
        exportResource={{
          filename: "setterfi-compliance-records",
          mode: "local",
          rows: records.map((row) => ({
            id: row.id,
            kind: row.kind,
            tenantName: row.tenantName,
            contactName: row.contactName,
            channel: row.channel,
            identifierLast4: row.identifierLast4,
            reason: row.reason,
            source: row.source,
            providerSyncState: row.providerSyncState,
            providerSyncedAt: row.providerSyncedAt,
            deletionAuditId: row.deletionAuditId,
            recordedAt: row.recordedAt,
            isDemo: row.isDemo,
            isTest: row.isTest,
          })),
        }}
        facets={[{
          columnId: "confirmation",
          title: "Confirmation",
          options: [...new Set(records.map((row) => recordConfirmation(row).label))]
            .map((label) => ({ label, value: label })),
        }]}
        getRowId={(row) => row.id}
        groups={RECORD_GROUPS.map((group) => ({
          ...group,
          includes: (row: ComplianceRecord) => row.kind === group.id,
        }))}
        footerNote={RECORDS_FOOTER_NOTE}
        onRowClick={setRecordSheet}
        ordering="banded by kind, most recently recorded first inside each band"
        rowLabel={{ singular: "record", plural: "records" }}
        search={{ placeholder: "Search contact, workspace, or reason" }}
        variant="ledger"
      />
      <div className="flex flex-wrap items-center justify-between gap-[var(--s-3)]">
        <SectionIntro body={ENFORCEMENT_NOTE} />
        {/* The table above holds the most recent records; deletion history goes back further than
            the page does, so its full export stays server-side and says which one it is. */}
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
    </section>
  );

  const contactsTab = (
    <section className="relative flex min-w-0 flex-col gap-[var(--s-4)]">
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
        footerNote={CONTACTS_FOOTER_NOTE}
        ordering="most recently seen first"
        rowActionsLabel={(row) => `Actions for ${row.name}`}
        rowLabel={{ singular: "contact", plural: "contacts" }}
        search={{ placeholder: "Search contact, workspace, or stage" }}
        variant="ledger"
      />
      <SectionIntro body="A fresh impact preview and a recorded privacy-request reason are required before permanent deletion." />
    </section>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--s-4)]">
      {impersonation ? (
        <div className="shrink-0" role="status">
          <Callout
            body={(
              <>
                Privacy actions and restricted exports are unavailable while viewing another
                workspace.
                <details className="mt-[var(--s-2)] text-[color:var(--faint)]">
                  <summary className="w-fit cursor-pointer select-none">Technical detail</summary>
                  <dl className="mt-[var(--s-2)] grid gap-[var(--s-1)] [font-family:var(--font-mono)] [font-size:var(--t-mono-meta)]">
                    <div><dt className="inline font-medium">Session ID:</dt> <dd className="inline break-all">{impersonation.sessionId}</dd></div>
                    <div><dt className="inline font-medium">Workspace ID:</dt> <dd className="inline break-all">{impersonation.tenantId}</dd></div>
                  </dl>
                </details>
              </>
            )}
            title="Read-only workspace view"
            tone="warning"
          />
        </div>
      ) : null}

      <div aria-live="polite" className={announcement ? "shrink-0 text-[length:var(--t-body)] text-[var(--good)]" : "sr-only"}>
        {announcement}
      </div>

      <DetailPage
        className={impersonation ? "lg:h-auto" : undefined}
        provenance={everyRowIsSeeded && pageProvenanceKind === null
          ? "Every row on this page is demo or test data, excluded from real analytics"
          : undefined}
        provenanceKind={everyRowIsSeeded ? pageProvenanceKind ?? undefined : undefined}
        state={headerState}
        subtitle={PAGE_DESCRIPTION}
        tabs={[
          // A count of zero is left off rather than rendered: the tab's own body says it is empty,
          // and a grey 0 in the strip reads as a broken count. Deleted contacts are a band inside
          // this table rather than a third tab, because the whole point of a tombstone is that it
          // is the same block after the contact went away.
          {
            id: "blocks",
            label: "Blocks and deletion records",
            content: recordsTab,
            count: records.length || undefined,
          },
          {
            id: "contacts",
            label: "Contacts",
            content: contactsTab,
            count: contacts.length || undefined,
          },
          // No count: five is the number of rules the send path has, not a measurement of
          // anything, and a "5" in the tab strip beside two row counts reads as one.
          {
            id: "message-rules",
            label: "Message rules",
            content: <MessageRulesPanel />,
          },
        ]}
        title="Compliance"
      />

      <RecordSheet
        onOpenChange={(open) => { if (!open) setRecordSheet(null); }}
        open={recordSheet !== null}
        sections={recordSheet ? [
          {
            title: recordSheet.kind === "deleted" ? "Deletion record" : "Block",
            fields: [
              { label: "Workspace", value: recordSheet.tenantName },
              { label: "Channel", value: channelLabel(recordSheet.channel) },
              {
                absence: "no display suffix",
                label: "Identifier",
                mono: true,
                value: recordSheet.identifierLast4
                  ? identifierLabel(recordSheet.identifierLast4)
                  : undefined,
              },
              { label: "Why", value: recordSheet.reason },
              { label: "Source", value: sourceLabel(recordSheet.source) },
              { label: "Recorded", value: displayTime(recordSheet.recordedAt) },
            ],
          },
          {
            title: "Provider confirmation",
            fields: [
              { label: "State", value: recordConfirmation(recordSheet).label },
              {
                absence: recordSheet.kind === "deleted"
                  ? "enforced here, never sent to a provider"
                  : "not confirmed yet",
                label: "Confirmed at",
                value: recordSheet.providerSyncedAt
                  ? displayTime(recordSheet.providerSyncedAt)
                  : undefined,
              },
            ],
          },
        ] : []}
        state={recordSheet ? {
          kind: recordConfirmation(recordSheet).kind,
          label: recordConfirmation(recordSheet).label,
          tone: recordConfirmation(recordSheet).tone,
        } : undefined}
        states={recordSheet ? [
          { kind: "tag", label: channelLabel(recordSheet.channel), tone: "neutral" },
          ...(recordSheet.isDemo || recordSheet.isTest
            ? [{
              kind: "tag" as const,
              label: recordSheet.isDemo ? "Demo data" : "Test data",
              tone: "neutral" as const,
            }]
            : []),
        ] : undefined}
        subtitle={recordSheet
          ? `${channelLabel(recordSheet.channel)}, ${recordSheet.tenantName}`
          : undefined}
        technical={recordSheet ? [
          { label: "Record ID", value: recordSheet.id, mono: true },
          ...(recordSheet.deletionAuditId !== null
            ? [{ label: "Deletion record", value: String(recordSheet.deletionAuditId), mono: true }]
            : []),
          ...(recordSheet.providerSyncState !== null
            ? [{ label: "Provider sync state", value: recordSheet.providerSyncState, mono: true }]
            : []),
        ] : undefined}
        title={recordSheet
          ? recordSheet.contactName ?? (recordSheet.kind === "deleted" ? "Contact deleted" : "Contact unavailable")
          : ""}
      />

      <RecordSheet
        destructive={contactSheet && !impersonation ? {
          label: "Delete contact",
          onClick: () => { if (contactSheet) void openPreview(contactSheet); },
        } : undefined}
        logged={impersonation ? undefined : AUDIT_ACTIONS["contact.delete"].microcopy}
        onOpenChange={(open) => { if (!open) setContactSheet(null); }}
        open={contactSheet !== null}
        sections={contactSheet ? [
          {
            title: "Contact",
            fields: [
              { label: "Workspace", value: contactSheet.tenantName },
              { label: "Pipeline stage", value: pipelineState(contactSheet.pipelineStage).label },
              { label: "Last seen", value: displayTime(contactSheet.lastSeenAt) },
              {
                label: "Data provenance",
                value: provenanceLabels(contactSheet.isDemo, contactSheet.isTest) ?? "Real data",
              },
            ],
          },
          ...(impersonation ? [{
            title: "Privacy actions",
            body: (
              <p className="m-0 text-[length:var(--t-body)] text-[var(--muted)]">
                Deletion is unavailable while viewing another workspace.
              </p>
            ),
          }] : []),
        ] : []}
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
        onOpenChange={(open) => {
          if (!open) closeDeletion();
        }}
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
    </div>
  );
}
