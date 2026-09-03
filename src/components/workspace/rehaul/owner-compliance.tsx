"use client";

/**
 * The owner Compliance screen, rehaul face.
 *
 * Three tabs off `?tab=`, one table each for the first two, and a rule list for the third. Every
 * row here comes from the same three reads the live surface receives -- suppression entries,
 * suppression tombstones, contacts -- and this file adds no query of its own. The reading logic
 * (labels, confirmation state, counts, the filter predicate) lives in `owner-compliance-filters`
 * so it can be tested without a render.
 *
 * What the drawing asks for that the platform cannot say, and what stands in its place:
 *
 * - The drawing puts a retry beside a failed confirmation. Nothing on this page can retry one:
 *   the reconciler is a job route, and the only action the page is handed is contact deletion.
 *   So a failed row is drawn amber and says "Failed", and no button pretends otherwise.
 * - The drawing's Source column names a carrier or a person. A suppression row stores the enum
 *   that recorded it and nothing about who, so the column carries that enum in plain words.
 * - Every explainer sentence the live surface printed under a heading is gone from the page. The
 *   ones a reader still needs are handed to the eye; the one rule the table cannot show, that a
 *   confirmation turns amber once it has waited a week, is a single line in the table's footer.
 */

import {
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";

import type { StateTone } from "@/components/kit/state-badge";

import { ConfirmFlow, type Result } from "@/components/kit/confirm-flow";
import { DataState } from "@/components/kit/data-state";
import { DataTable, everyRowIsTest } from "@/components/kit/data-table";
import { DataTableFacetedFilter } from "@/components/kit/data-table-faceted-filter";
import { ExportMenu } from "@/components/kit/export-menu";
import { Search } from "@/components/kit/icons";
import { RecordSheet } from "@/components/kit/record-sheet";
import { MonoMeta, STATE_TONE_TO_TONE, Status, StatusAbsent } from "@/components/kit/atomics";
import { Button } from "@/components/ui/button";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import {
  CARD_TABLE,
  CardTable,
  Pill,
  RehaulTabs,
  StatusDot,
} from "@/components/workspace/rehaul/_primitives";
import {
  AMBER_AFTER_DAYS,
  blockCounts,
  channelLabel,
  clientLabel,
  clientOptions,
  complianceRecords,
  COUNT_FILTERS,
  identifierLabel,
  INITIAL_BLOCK_FILTERS,
  matchesBlockFilters,
  reasonOptions,
  recordConfirmation,
  sourceLabel,
  type BlockFilters,
  type CountFilter,
} from "@/components/workspace/rehaul/owner-compliance-filters";
import {
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
import { displayName } from "@/lib/format/display-name";

export type OwnerComplianceProps = {
  initialContacts: readonly ComplianceContact[];
  suppressions: readonly LiveSuppressionRow[];
  tombstones: readonly SuppressionTombstoneRow[];
  impersonation?: { sessionId: string; tenantId: string } | null;
  actions: AdminDeletionActions;
};

type TabId = "blocks" | "contacts" | "message-rules";

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

const IDENTITY_WIDTH = "w-[calc(var(--drawer-w)*0.7)] max-w-[calc(var(--drawer-w)*0.7)]";

const CHIP_BASE = "inline-flex h-[28px] cursor-pointer items-center gap-[6px] rounded-full border px-[10px] text-[12.5px]";
const CHIP_OFF = "border-[var(--line)] bg-transparent text-[var(--muted)]";
const CHIP_ON = "border-[var(--accent-edge)] bg-[var(--accent-wash)] text-[var(--accent-text)]";

/**
 * The dot a count chip carries. Three of the five buckets are a state a reader tracks by colour,
 * and the other two are sizes rather than states, so they carry the figure alone.
 */
const COUNT_DOT: Partial<Record<CountFilter, "good" | "amber" | "bad">> = {
  awaiting: "amber",
  confirmed: "good",
  failed: "bad",
};

/**
 * The browser's clock, subscribed to rather than read during render.
 *
 * How long a confirmation has waited and what counts as the last thirty days are both answers
 * about the moment a reader is looking, and a server render has no such moment: reading the clock
 * in the render body makes the server's markup disagree with the browser's across a day boundary.
 * The server snapshot is `null`, which the table reads as "say nothing about elapsed time", and
 * the reading is taken when a screen first subscribes, so a console left open overnight picks up
 * the new day on its next mount rather than answering with yesterday's.
 */
const clockListeners = new Set<() => void>();
let clientNow: number | null = null;

function subscribeToClock(listener: () => void) {
  const first = clockListeners.size === 0;
  clockListeners.add(listener);
  if (first) {
    clientNow = Date.now();
    for (const notify of clockListeners) notify();
  }
  return () => {
    clockListeners.delete(listener);
  };
}

function useClientNow() {
  return useSyncExternalStore(subscribeToClock, () => clientNow, () => null);
}

function humanize(value: string) {
  return value
    .replaceAll(/[._-]+/g, " ")
    .replace(/^./, (character) => character.toLocaleUpperCase());
}

function displayTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time unavailable"
    : workspaceDateTimeYearFormat.format(date);
}

function pipelineState(value: string): { label: string; tone: StateTone } {
  if (Object.prototype.hasOwnProperty.call(PIPELINE_STAGE_COPY, value)) {
    return PIPELINE_STAGE_COPY[value as keyof typeof PIPELINE_STAGE_COPY];
  }
  return { label: humanize(value), tone: "neutral" };
}

function provenanceLabel(isDemo: boolean, isTest: boolean): ReactNode {
  if (!isDemo && !isTest) return null;
  const label = isDemo && isTest ? "Demo, test data" : isDemo ? "Demo data" : "Test data";
  return (
    <Status className="shrink-0" label={label} tone={isDemo ? "waiting" : "neutral"} treatment="bare" />
  );
}

/**
 * A count chip: the figure and the filter in one control.
 *
 * The tiles this replaces printed the same five numbers above the table and then left the reader
 * to find the rows behind one of them by hand. Pressing the number is now the way to see them, so
 * the count and the filter can never disagree.
 */
function CountChip({
  active,
  count,
  dot,
  label,
  onSelect,
}: {
  active: boolean;
  count: number;
  dot?: "good" | "amber" | "bad";
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      aria-label={`${workspaceCountFormat.format(count)} ${label}`}
      aria-pressed={active}
      className={`${CHIP_BASE} ${active ? CHIP_ON : CHIP_OFF}`}
      data-slot="count-chip"
      onClick={onSelect}
      type="button"
    >
      {dot ? <StatusDot tone={dot} /> : null}
      <span className="font-mono tabular-nums">{workspaceCountFormat.format(count)}</span>
      {label}
    </button>
  );
}

function ToggleChip({
  active,
  label,
  onSelect,
}: {
  active: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`${CHIP_BASE} ${active ? CHIP_ON : CHIP_OFF}`}
      data-slot="toggle-chip"
      onClick={onSelect}
      type="button"
    >
      {label}
    </button>
  );
}

function ConfirmationCell({ now, record }: { now: number | null; record: ComplianceRecord }) {
  const state = recordConfirmation(record, now);
  if (state.kind === "none") return <StatusAbsent label={state.label} />;
  if (state.tone === "good") {
    return <Pill tone="good"><StatusDot tone="good" />{state.label}</Pill>;
  }
  if (state.tone === "critical") {
    return <Pill tone="amber"><StatusDot tone="bad" />{state.label}</Pill>;
  }
  return (
    <Pill tone={state.tone === "warning" ? "amber" : "neutral"}>
      <StatusDot tone="amber" />
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
  const [filters, setFilters] = useState<BlockFilters>(INITIAL_BLOCK_FILTERS);
  const [selected, setSelected] = useState<ComplianceContact | null>(null);
  const [contactSheet, setContactSheet] = useState<ComplianceContact | null>(null);
  const [flow, dispatch] = useReducer(deleteFlowState, INITIAL_DELETE_FLOW_STATE);
  const [announcement, setAnnouncement] = useState("");
  const idempotencyKey = useRef<string | null>(null);

  /** Null until the browser has a clock, so a pending row says "Pending" and no more until then. */
  const now = useClientNow();

  function updateFilters(patch: Partial<BlockFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
  }

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
      setAnnouncement(`${displayName(selected.name)} was deleted after the required checks completed.`);
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
  const chipCounts = useMemo(() => blockCounts(records), [records]);
  const visibleRecords = useMemo(
    () => records.filter((row) => matchesBlockFilters(row, filters, now)),
    [filters, now, records],
  );
  const reasonFacets = useMemo(
    () => reasonOptions(records).map((reason) => ({ label: reason, value: reason })),
    [records],
  );
  const clientFacets = useMemo(
    () => clientOptions(records).map((client) => ({ label: client, value: client })),
    [records],
  );

  /*
   * Green only where the provider confirmed every block. Zero blocks is a fact about an empty
   * table, not a confirmation, so it takes the grey dot rather than the good one.
   */
  const headerState = chipCounts.failed > 0
    ? {
      amber: true,
      label: `${workspaceCountFormat.format(chipCounts.failed)} confirmation${chipCounts.failed === 1 ? "" : "s"} failed`,
      tone: "amber" as const,
    }
    : chipCounts.awaiting > 0
      ? {
        amber: true,
        label: `${workspaceCountFormat.format(chipCounts.awaiting)} awaiting confirmation`,
        tone: "amber" as const,
      }
      : suppressions.length > 0
        ? { amber: false, label: "Every block confirmed", tone: "good" as const }
        : { amber: false, label: "No blocks recorded", tone: "grey" as const };

  const everyRowIsSeeded = [
    { count: suppressions.length, all: everyRowIsTest(suppressions, (row) => row.isDemo || row.isTest) },
    { count: tombstones.length, all: everyRowIsTest(tombstones, (row) => row.isDemo) },
    { count: contacts.length, all: everyRowIsTest(contacts, (row) => row.isDemo || row.isTest) },
  ].every((set) => set.count === 0 || set.all);

  const contactColumns = useMemo<ColumnDef<ComplianceContact>[]>(() => [
    {
      accessorFn: (row) => displayName(row.name),
      header: "Contact",
      id: "name",
      meta: {
        cellKind: "identity",
        label: "Contact",
        cellClassName: IDENTITY_WIDTH,
        headerClassName: IDENTITY_WIDTH,
      },
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-[var(--s-2)] whitespace-normal">
          <span className="min-w-0 truncate font-medium text-[var(--ink)]">
            {displayName(row.original.name)}
          </span>
          {everyRowIsSeeded ? null : provenanceLabel(row.original.isDemo, row.original.isTest)}
        </span>
      ),
    },
    {
      accessorFn: (row) => displayName(row.tenantName),
      header: "Client",
      id: "tenantName",
      meta: { label: "Client" },
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
              value: `${displayName(selected.name)} in ${displayName(selected.tenantName)}, deleted`,
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
          <StatusDot tone={headerState.tone} />
          {headerState.label}
        </Pill>
        {impersonation ? (
          <Pill className="mb-[3px]" tone="amber">
            <StatusDot tone="amber" />
            Read-only workspace view
          </Pill>
        ) : null}
        {/*
          * The header's trailing control row, and the reason the eye is docked rather than
          * floating: a screen with this row has somewhere for the eye to sit where nothing can be
          * underneath it, and it goes last, after the exports.
          */}
        <div className="ml-auto flex items-center gap-[8px]">
          {/*
            * One Export, two answers. The rows on screen are the first, and the full deletion
            * record is the second rather than a button of its own: the two used to sit side by
            * side reading as two of the same control. The server export stays out of an
            * impersonated session, exactly as it did when it was its own button.
            */}
          <ExportMenu
            also={impersonation ? undefined : {
              filename: "setterfi-suppression-tombstones",
              groupLabel: "Every deletion record",
              mode: "server",
              query: { order: "created_desc", reason: "" },
              resource: "suppression-tombstones",
            }}
            filename="setterfi-contact-blocks"
            groupLabel="Blocks on screen"
            label="Export"
            mode="local"
            rows={visibleRecords.map((row) => ({
              contact: row.contactName ?? identifierLabel(row.identifierLast4),
              channel: channelLabel(row.channel),
              client: row.tenantName,
              reason: row.reason,
              confirmation: recordConfirmation(row, now).label,
              recorded: row.recordedAt,
              source: sourceLabel(row.source),
            }))}
          />
          <ContextEye
            copy={OWNER_COMPLIANCE_EYE_COPY}
            placement="header"
            screen="owner-compliance"
          />
        </div>
      </div>

      <RehaulTabs
        items={[
          {
            active: tab === "blocks",
            count: records.length,
            countTone: "neutral",
            href: `${pathname}?tab=blocks`,
            label: "Blocks",
          },
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
        <CardTable className="min-h-0">
          <div
            className="flex flex-wrap items-center gap-[6px] border-b border-[var(--line)] px-[14px] py-[10px]"
            data-slot="blocks-filters"
          >
            {COUNT_FILTERS.map((item) => (
              <CountChip
                active={filters.count === item.id}
                count={chipCounts[item.id]}
                dot={COUNT_DOT[item.id]}
                key={item.id}
                label={item.label}
                onSelect={() => updateFilters({ count: item.id })}
              />
            ))}
            <span aria-hidden className="mx-[4px] h-[18px] w-px bg-[var(--line)]" />
            {/*
              * The kit's faceted chip rather than a select of our own: a native select is banned
              * on a live surface, and these two read and clear the same way as the ones on Audit
              * and Clients. One value at a time is all the table filters by, so the last thing
              * pressed wins.
              */}
            <DataTableFacetedFilter
              onChange={(next) => updateFilters({ reason: next.at(-1) ?? null })}
              options={reasonFacets}
              title="Reason"
              value={filters.reason === null ? [] : [filters.reason]}
            />
            <DataTableFacetedFilter
              onChange={(next) => updateFilters({ client: next.at(-1) ?? null })}
              options={clientFacets}
              title="Client"
              value={filters.client === null ? [] : [filters.client]}
            />
            <ToggleChip
              active={filters.recent}
              label="Last 30 days"
              onSelect={() => updateFilters({ recent: !filters.recent })}
            />
            <label className="ml-auto flex h-[28px] w-[240px] items-center gap-[8px] rounded-lg border border-[var(--line-input)] bg-[var(--card)] px-[10px]">
              <Search aria-hidden className="size-[14px] text-[var(--faint)]" />
              <input
                aria-label="Search contact, number, client or reason"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--faint)]"
                onChange={(event) => updateFilters({ search: event.target.value })}
                placeholder="Search contact or number"
                type="search"
                value={filters.search}
              />
            </label>
          </div>
          {visibleRecords.length === 0 ? (
            <div className="px-[14px] py-[20px]">
              <DataState
                body={records.length === 0 ? "" : "Clear the filter or the search term to see the rest."}
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
                    <th className={CARD_TABLE.th}>Client</th>
                    <th className={CARD_TABLE.th}>Reason</th>
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
                            <Status label="Deleted contact" tone="neutral" treatment="bare" />
                            <MonoMeta>{identifierLabel(row.identifierLast4)}</MonoMeta>
                          </span>
                        ) : (
                          <span className="flex items-center gap-[8px]">
                            {row.contactName ? displayName(row.contactName) : (
                              <span className="font-mono">{identifierLabel(row.identifierLast4)}</span>
                            )}
                            {everyRowIsSeeded ? null : provenanceLabel(row.isDemo, row.isTest)}
                          </span>
                        )}
                      </td>
                      <td className={CARD_TABLE.td}>{channelLabel(row.channel)}</td>
                      <td className={CARD_TABLE.td}>{clientLabel(row)}</td>
                      <td className={`${CARD_TABLE.td} text-[var(--muted)]`}>{row.reason}</td>
                      <td className={CARD_TABLE.td}>
                        <ConfirmationCell now={now} record={row} />
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
          <div
            className="flex items-center gap-[12px] border-t border-[var(--line-soft)] px-[14px] py-[8px] text-[12px] text-[var(--faint)]"
            data-slot="blocks-footer"
          >
            <span>
              {`A block still awaiting confirmation after ${AMBER_AFTER_DAYS} days is shown amber.`}
            </span>
            <span className="ml-auto">Deletion records live under Export</span>
          </div>
        </CardTable>
      ) : null}

      {tab === "contacts" ? (
        <DataTable
          ariaLabel="Contacts available for deletion"
          columns={contactColumns}
          data={contacts}
          emptyState={(
            <DataState kind="empty" title="No contacts available" />
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
          rowActionsLabel={(row) => `Actions for ${displayName(row.name)}`}
          rowLabel={{ singular: "contact", plural: "contacts" }}
          search={{ placeholder: "Search contact, client, or stage" }}
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
            { label: "Client", value: displayName(contactSheet.tenantName) },
            { label: "Pipeline stage", value: pipelineState(contactSheet.pipelineStage).label },
            { label: "Last seen", value: displayTime(contactSheet.lastSeenAt) },
          ],
        }] : []}
        subtitle={contactSheet ? displayName(contactSheet.tenantName) : undefined}
        technical={contactSheet ? [
          { label: "Contact ID", value: contactSheet.id, mono: true },
          { label: "Workspace ID", value: contactSheet.tenantId, mono: true },
        ] : undefined}
        title={contactSheet ? displayName(contactSheet.name) : ""}
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
        title={selected ? `Delete ${displayName(selected.name)}` : "Delete contact"}
        typeToConfirm={{
          word: "DELETE",
          label: "Type DELETE to confirm",
          hint: "There is no undo and no recovery: the records above are gone the moment this runs.",
        }}
      />
    </div>
  );
}
