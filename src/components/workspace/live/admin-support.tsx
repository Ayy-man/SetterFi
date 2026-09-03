"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { CellQuiet } from "@/components/kit/cell-quiet";
import { CellTwoLine } from "@/components/kit/cell-two-line";
import { ConfirmFlow, type Result } from "@/components/kit/confirm-flow";
import { DataState } from "@/components/kit/data-state";
import { DataTable, type DataTableGroup } from "@/components/kit/data-table";
import { DataTableFacetedFilter } from "@/components/kit/data-table-faceted-filter";
import { ExportMenu } from "@/components/kit/export-menu";
import { RecordSheet } from "@/components/kit/record-sheet";
import { SegmentedControl } from "@/components/kit/segmented-control";
import { STATE_TONE_TO_TONE, Status } from "@/components/kit/atomics";
import type { StateTone } from "@/components/kit/state-badge";
import { StatStrip, type StatStripItem } from "@/components/kit/stat-strip";
import { ListPage } from "@/components/kit/templates/list-page";
import { Transcript } from "@/components/kit/transcript";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { wholePageProvenanceKind } from "@/components/kit/provenance-chip";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import type { UserRole } from "@/lib/auth/claims";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { workspaceTimestampFormat } from "@/lib/format/datetime";
import { useQueryState } from "@/lib/query-state";
import type {
  PlatformSupportThreadRead,
  SupportBook,
  SupportStatus,
} from "@/lib/repositories/support";
import { withWorkspaceNavCounts, workspaceNavigationFor } from "@/lib/workspace-navigation";
import {
  platformSupportThreadView,
  reassignmentControlState,
} from "./support-view-models";

type AdminSupportProps = {
  actorId: string;
  actorRole: Extract<UserRole, "owner" | "admin" | "success">;
  enabled: boolean;
};

type ReassignmentReceipt = {
  state?: unknown;
  tenantId?: unknown;
  successOwner?: unknown;
  audit?: { id?: unknown; actionKey?: unknown } | null;
};

type AssigneeOption = { value: string; label: string };

/*
 * Screen 5a took the "Attention" label away from this destination and gave it to the merged Inbox
 * at /admin/alerts, which is the queue it always described. This surface is the coach-to-platform
 * request queue and now says so, because one label pointing at two different queues is what the
 * merge existed to fix.
 */
const CRUMBS = [
  { label: "Run" },
  { label: "Client requests" },
] as const;

/**
 * `book` is what the server is asked for. `unassigned` is a narrowing of the whole queue rather
 * than a third query: the projection knows who owns a thread, not that nobody does.
 */
const BOOK_VIEWS = [
  { key: "all", label: "All clients", book: "all" },
  { key: "mine", label: "My clients", book: "mine" },
  { key: "unassigned", label: "Unassigned", book: "all" },
] as const;

type BookView = (typeof BOOK_VIEWS)[number]["key"];

function isBookView(value: string | null): value is BookView {
  return BOOK_VIEWS.some((view) => view.key === value);
}

/**
 * The queue bands by what is holding each request up, so the state pill on every row becomes the
 * header the rows sit under. Order is the order a reader works them: unanswered first, parked
 * next, done last.
 */
const QUEUE_BANDS: readonly DataTableGroup<PlatformSupportThreadRead>[] = [
  {
    id: "open",
    label: "Open",
    annotation: "nobody on the team has answered yet",
    tone: "warning",
  },
  {
    id: "waiting_on_coach",
    label: "Waiting on coach",
    annotation: "the clock is on the coach, not on the team",
    tone: "waiting",
  },
  {
    id: "resolved",
    label: "Resolved",
    annotation: "no longer waiting on anyone",
    tone: "good",
  },
];

/**
 * Every status enum is mapped here, once. Nothing raw reaches a cell.
 *
 * Three states exist and these are they: `support_threads.status` is
 * `open | waiting_on_coach | resolved` (`20260817000001_phase1_demo_path.sql:714`), checked
 * 2026-09-01. `AdminRequests.dc.html` draws two more -- "Needs a decision" and "With billing" --
 * and neither is a column. They are not omissions to restore: "Needs a decision" is `open` seen
 * from the operator's side rather than a distinct state, and "With billing" is a routing fact
 * about who is holding the thread, which nothing on the row records. Adding either as a label
 * over the same three values would tell a reader the queue knows something it does not.
 *
 * Written down because a drawn state with no comment is a row the next audit re-derives from the
 * artboard and files as missing, which is what happened to the state pill below.
 */
const SUPPORT_STATE = {
  // Open is "nobody has answered yet", which is a wait, not a notice. It rendered in `--info`
  // blue against amber and green siblings, and blue this close to `--accent` reads as a selected
  // row rather than as a state.
  open: { label: "Open", tone: "warning" },
  waiting_on_coach: { label: "Waiting on coach", tone: "warning" },
  resolved: { label: "Resolved", tone: "good" },
} as const satisfies Record<SupportStatus, { label: string; tone: StateTone }>;

const STATUS_OPTIONS = Object.entries(SUPPORT_STATE)
  .map(([value, state]) => ({ value, label: state.label }));

/**
 * The status filter is the kit's dashed facet chip in controlled mode.
 *
 * It stays a URL parameter rather than a table column filter because the queue is fetched per
 * status and the CSV export carries the same scope; only the control changed. Three pages were
 * offering three different controls for one idea (tabs, a native select, a dropdown), so this is
 * now the one filter idiom and the tab pair above it is the one scope idiom. The chip is
 * multi-select and the URL holds a single status, so the last value pressed is the one kept.
 */
function StatusFacet({
  onChange,
  value,
}: {
  onChange: (value: string | null) => void;
  value: SupportStatus | "all";
}) {
  return (
    <DataTableFacetedFilter
      onChange={(next) => onChange(next.at(-1) ?? null)}
      options={STATUS_OPTIONS}
      title="Status"
      value={value === "all" ? [] : [value]}
    />
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

function timestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time not recorded" : workspaceTimestampFormat.format(date);
}

/** Age is read as elapsed time, never as a due date the queue cannot promise. */
function ageLabel(value: string, now: number) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  const elapsed = Math.max(0, now - date.getTime());
  const days = Math.floor(elapsed / DAY_MS);
  if (days >= 1) return `${days} ${days === 1 ? "day" : "days"}`;
  const hours = Math.floor(elapsed / (60 * 60 * 1000));
  if (hours >= 1) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const minutes = Math.floor(elapsed / (60 * 1000));
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function statusPresentation(status: SupportStatus): { label: string; tone: StateTone } {
  return SUPPORT_STATE[status] ?? SUPPORT_STATE.open;
}

function assignedLabel(thread: PlatformSupportThreadRead) {
  return thread.assignedTo?.name?.trim()
    || (thread.assignedTo ? "Assigned team member" : "Unassigned");
}

function successOwnerLabel(thread: PlatformSupportThreadRead) {
  return thread.successOwner?.name?.trim()
    || (thread.successOwner ? "Assigned owner" : "Unassigned");
}

/**
 * A refused append is an outcome the composer renders, never a rejected promise: the failure has
 * to land beside the draft that is still in the box, inside the modal the writer is looking at.
 */
type AppendResult = { ok: true } | { ok: false; message: string };

const APPEND_FAILED_MESSAGE = "The message was not saved. The thread is unchanged.";

async function payload(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_RESPONSE");
  return value as Record<string, unknown>;
}

function validStatus(value: string | null): SupportStatus | "all" {
  return value === "open" || value === "waiting_on_coach" || value === "resolved" ? value : "all";
}

/**
 * The drawer's audit line names a person, so it reads the thread's own messages rather than
 * inventing one: the first message is who raised the request, the last is who touched it most
 * recently. A thread with no readable author says so instead of borrowing the success owner's
 * name for a change they may not have made.
 */
function firstAuthor(thread: PlatformSupportThreadRead | null) {
  return thread?.messages.at(0)?.authorName?.trim() || "author not recorded";
}

function lastAuthor(thread: PlatformSupportThreadRead | null) {
  return thread?.messages.at(-1)?.authorName?.trim() || "author not recorded";
}

function threadIsTest(thread: PlatformSupportThreadRead) {
  return thread.isTest || thread.tenantIsDemo;
}

function ThreadConversation({
  actorId,
  busy,
  messageKind,
  onAppendMessage,
  onMessageKindChange,
  selected,
}: {
  actorId: string;
  busy: boolean;
  messageKind: "reply" | "internal_note";
  /** Resolves ok when the message was saved; a refusal carries the sentence to show. */
  onAppendMessage: (body: string) => Promise<AppendResult>;
  onMessageKindChange: (value: "reply" | "internal_note") => void;
  selected: PlatformSupportThreadRead;
}) {
  const view = platformSupportThreadView(selected);
  const [draft, setDraft] = useState("");
  const [appendError, setAppendError] = useState<string | null>(null);

  return (
    <div className="flex min-w-0 flex-col gap-[var(--s-4)]">
      <div className="min-h-[calc(var(--s-12)*4)] overflow-hidden rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--card)]">
        <Transcript
          messages={view.messages.map((message) => ({
            id: message.id,
            author: message.internal ? "system" : message.authorId === actorId ? "human" : "lead",
            authorName: message.internal
              ? "Internal note"
              : message.authorName ?? (message.authorId === actorId ? "You" : "Coach"),
            body: message.body,
            at: timestamp(message.createdAt),
          }))}
          variant="coach"
        />
      </div>

      <form
        className="flex flex-col gap-[var(--s-3)]"
        onSubmit={(event) => {
          event.preventDefault();
          const body = draft.trim();
          if (!body) return;
          /*
           * The append used to reject on a refused write, and nothing here caught it, so a failed
           * reply reached the browser as an unhandled rejection while the only error line the page
           * drew sat outside this modal, where the writer could not read it. The refusal is now a
           * resolved result, reported beside the composer, and the draft survives it.
           */
          setAppendError(null);
          void onAppendMessage(body).then((result) => {
            if (result.ok) {
              setDraft("");
              return;
            }
            setAppendError(result.message);
          });
        }}
      >
        <Select
          label="Message type"
          onValueChange={(value) => {
            if (value === "reply" || value === "internal_note") onMessageKindChange(value);
          }}
          options={[
            { value: "reply", label: "Reply to coach" },
            { value: "internal_note", label: "Staff-only internal note" },
          ]}
          value={messageKind}
        />
        <label className="flex flex-col gap-[var(--s-1)]">
          <span className="t-overline">{messageKind === "internal_note" ? "Internal note" : "Reply"}</span>
          <Textarea
            onChange={(event) => setDraft(event.currentTarget.value)}
            placeholder={messageKind === "internal_note" ? "Add context for staff" : "Write a reply to the coach"}
            value={draft}
          />
        </label>
        {appendError ? (
          <p className="text-body text-[var(--critical)]" role="alert">{appendError}</p>
        ) : null}
        <Button className="self-start" disabled={busy || !draft.trim()} type="submit">
          {busy ? "Saving..." : messageKind === "internal_note" ? "Add internal note" : "Send reply"}
        </Button>
      </form>
    </div>
  );
}

/**
 * Reassignment is the one action this page takes, and the canvas draws two.
 *
 * `AdminRequests.dc.html` pairs "Reassign" with a filled "Make the change" -- an owner applying
 * the coach's request from inside the thread, with a preview of the qualification question it
 * would switch off for that tenant. "Reassign" exists here as "Review owner change" below,
 * confirmation step and all.
 *
 * "Make the change" does not, and it is not a missing button. A support thread carries a subject
 * and messages; nothing on it references the Brain setting a request is about, so there is no
 * link from this row to a thing to toggle. Drawing the control would mean parsing intent out of
 * a coach's prose and writing a tenant override from it -- a privileged, tenant-scoped write
 * inferred from free text, on the surface with the fewest guardrails. The change belongs where
 * the setting is, with its own audit line; the thread is where it gets agreed.
 */
function OwnerPanel({
  assigneeId,
  assigneeOptions,
  busy,
  onAssigneeChange,
  onOpenAssignment,
  ownerChanged,
  selected,
}: {
  assigneeId: string;
  assigneeOptions: readonly AssigneeOption[];
  busy: boolean;
  onAssigneeChange: (value: string) => void;
  onOpenAssignment: () => void;
  ownerChanged: boolean;
  selected: PlatformSupportThreadRead;
}) {
  if (assigneeOptions.length === 0) {
    return (
      <DataState
        body="The client book did not supply a named success owner."
        kind="empty"
        title="No assignee available"
      />
    );
  }

  return (
    <div className="flex flex-col gap-[var(--s-3)]">
      <p className="t-muted m-0">Currently {successOwnerLabel(selected)}.</p>
      <Select
        label="Assignee"
        onValueChange={(value) => {
          if (value) onAssigneeChange(value);
        }}
        options={assigneeOptions}
        placeholder="Choose a named success owner"
        value={assigneeId || null}
      />
      <div className="flex flex-wrap items-center gap-[var(--s-2)]">
        <Button
          disabled={busy || !assigneeId}
          onClick={onOpenAssignment}
          type="button"
          variant="outline"
        >
          Review owner change
        </Button>
        {ownerChanged ? (
          <Status label="Owner changed" tone="good" treatment="bare" />
        ) : null}
      </div>
      <p className="t-faint m-0">{AUDIT_ACTIONS["tenant.success_owner.reassigned"].microcopy}</p>
    </div>
  );
}

/** The support queue and folded Inbox open the same request sheet. */
export function SupportRequestSheet({
  actorId,
  actorRole,
  onOpenChange,
  onReload,
  onThreadChange,
  selected,
  threads,
}: {
  actorId: string;
  actorRole: Extract<UserRole, "owner" | "admin" | "success">;
  onOpenChange: (open: boolean) => void;
  onReload?: () => Promise<void>;
  onThreadChange: (thread: PlatformSupportThreadRead) => void;
  selected: PlatformSupportThreadRead | null;
  threads: readonly PlatformSupportThreadRead[];
}) {
  const [messageKind, setMessageKind] = useState<"reply" | "internal_note">("reply");
  const [assigneeChoice, setAssigneeChoice] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ReassignmentReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const selectedView = selected ? platformSupportThreadView(selected) : null;
  const assigneeOptions = useMemo<AssigneeOption[]>(() => {
    if (actorRole === "success") return [{ value: actorId, label: "You" }];
    const named = new Map<string, string>();
    for (const thread of threads) {
      if (thread.successOwner?.name?.trim()) named.set(thread.successOwner.id, thread.successOwner.name.trim());
    }
    return [...named].map(([value, label]) => ({ value, label }));
  }, [actorId, actorRole, threads]);
  const assigneeId = assigneeChoice
    ?? (actorRole === "success" ? actorId : selected?.successOwner?.name ? selected.successOwner.id : "");
  const assignmentTruth = selectedView ? reassignmentControlState({
    expectedTenant: selectedView.tenantId,
    expectedAssignee: assigneeId,
    receipt,
  }) : null;

  async function appendMessage(body: string): Promise<AppendResult> {
    if (!selected) return { ok: false, message: APPEND_FAILED_MESSAGE };
    setBusy(true);
    try {
      const response = await fetch(`/api/platform/support/threads/${selected.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: messageKind, body }),
      });
      const value = await payload(response);
      if (!response.ok || !value.thread) throw new Error("SUPPORT_WRITE_FAILED");
      onThreadChange(value.thread as PlatformSupportThreadRead);
      return { ok: true };
    } catch {
      return { ok: false, message: APPEND_FAILED_MESSAGE };
    } finally {
      setBusy(false);
    }
  }

  async function confirmAssignment(input: { reason?: string }): Promise<Result> {
    const selectedThread = selected;
    if (!selectedThread || !selectedView || !assigneeId || !input.reason) {
      return { ok: false, message: "Choose a named owner and add a reason." };
    }
    try {
      const response = await fetch(`/api/platform/clients/${selectedView.tenantId}/success-owner`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigneeId, reason: input.reason }),
      });
      const value = await payload(response) as ReassignmentReceipt;
      const truth = reassignmentControlState({
        expectedTenant: selectedView.tenantId,
        expectedAssignee: assigneeId,
        receipt: value,
      });
      if (!response.ok || truth.kind !== "reassigned") {
        return { ok: false, message: "The owner change was not confirmed by the client and audit read-back." };
      }
      setReceipt(value);
      if (onReload) {
        await onReload();
      } else {
        onThreadChange({
          ...selectedThread,
          successOwner: { id: assigneeId, name: assigneeOptions.find((option) => option.value === assigneeId)?.label ?? null },
        });
      }
      return { ok: true, receipt: { auditId: truth.auditId, actionKey: "tenant.success_owner.reassigned" } };
    } catch {
      return { ok: false, message: "The owner change could not be confirmed." };
    }
  }

  return (
    <>
      <RecordSheet
        created={selectedView ? { when: timestamp(selectedView.createdAt), who: firstAuthor(selected) } : undefined}
        lastChange={selectedView ? { when: timestamp(selectedView.updatedAt), who: lastAuthor(selected) } : undefined}
        logged={AUDIT_ACTIONS["tenant.success_owner.reassigned"].microcopy}
        onOpenChange={onOpenChange}
        open={selectedView !== null}
        state={selected ? { kind: "lifecycle", ...statusPresentation(selected.status) } : undefined}
        states={selected ? [
          { kind: "tag", label: platformSupportThreadView(selected).tenantName, tone: "neutral" },
          ...(threadIsTest(selected) ? [{ kind: "tag" as const, label: "Demo data", tone: "neutral" as const }] : []),
        ] : undefined}
        subtitle={selectedView ? `${selectedView.tenantName}, success owner ${selected ? successOwnerLabel(selected) : "Unassigned"}` : undefined}
        tabs={selected && selectedView ? [
          {
            id: "request",
            label: "Request",
            sections: [{
              title: "Messages",
              body: (
                <div className="flex min-w-0 flex-col gap-[var(--s-3)]">
                  <div className="flex justify-end">
                    <ExportMenu filename="setterfi-support-messages" mode="server" query={{ reason: "", threadId: selectedView.id }} resource="support-messages" />
                  </div>
                  <ThreadConversation
                    actorId={actorId}
                    busy={busy}
                    key={selected.id}
                    messageKind={messageKind}
                    onAppendMessage={appendMessage}
                    onMessageKindChange={setMessageKind}
                    selected={selected}
                  />
                </div>
              ),
            }],
          },
          {
            id: "owner",
            label: "Success owner",
            sections: [{
              title: "Success owner",
              body: (
                <OwnerPanel
                  assigneeId={assigneeId}
                  assigneeOptions={assigneeOptions}
                  busy={busy}
                  onAssigneeChange={(value) => { setAssigneeChoice(value); setReceipt(null); }}
                  onOpenAssignment={() => setConfirmOpen(true)}
                  ownerChanged={assignmentTruth?.kind === "reassigned"}
                  selected={selected}
                />
              ),
            }],
          },
        ] : undefined}
        technical={selectedView ? [
          { label: "Thread ID", value: selectedView.id, mono: true },
          { label: "Client ID", value: selectedView.tenantId, mono: true },
        ] : undefined}
        title={selectedView?.subject ?? ""}
      />

      <ConfirmFlow
        action="tenant.success_owner.reassigned"
        confirmLabel={actorRole === "success" ? "Take ownership" : "Change owner"}
        impact={selectedView ? [
          { label: "Client", value: selectedView.tenantName },
          { label: "Current owner", value: selected ? successOwnerLabel(selected) : "Unassigned" },
          { label: "New owner", value: assigneeOptions.find((option) => option.value === assigneeId)?.label ?? "No named owner selected" },
        ] : []}
        onConfirm={confirmAssignment}
        onOpenChange={setConfirmOpen}
        open={confirmOpen}
        reason={{ required: true, label: "Reason", hint: "Explain why this client needs a different success owner." }}
        title="Review success owner change"
      />
    </>
  );
}

export function AdminSupport({ actorId, actorRole, enabled }: AdminSupportProps) {
  const query = useQueryState();
  const requestedView = query.get("view");
  const view: BookView = isBookView(requestedView)
    ? requestedView
    : actorRole === "success" ? "mine" : "all";
  const book: SupportBook = BOOK_VIEWS.find((entry) => entry.key === view)?.book ?? "all";
  const status = validStatus(query.get("status"));
  const [threads, setThreads] = useState<PlatformSupportThreadRead[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Age is measured from the read that produced the rows, so a row never ages while nothing moves.
  const [now, setNow] = useState<number | null>(null);

  const loadThreads = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const searchParams = new URLSearchParams({ book });
      if (status !== "all") searchParams.set("status", status);
      const response = await fetchWithTimeout(`/api/platform/support/threads?${searchParams}`, {
        cache: "no-store",
        signal,
      });
      const value = await payload(response);
      if (!response.ok || !Array.isArray(value.threads)) throw new Error("SUPPORT_READ_FAILED");
      if (signal?.aborted) return;
      const next = value.threads as PlatformSupportThreadRead[];
      setThreads(next);
      setNow(Date.now());
      setSelectedId((current) => current && next.some((row) => row.id === current) ? current : null);
    } catch {
      if (!signal?.aborted) setLoadError("The support queue could not be read.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [book, status]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => loadThreads(controller.signal));
    return () => controller.abort();
  }, [enabled, loadThreads]);

  const selected = useMemo(
    () => threads.find((thread) => thread.id === selectedId) ?? null,
    [selectedId, threads],
  );

  const columns = useMemo<ColumnDef<PlatformSupportThreadRead>[]>(() => [
    // The client is what a success owner scans for and the request is why the row is here, so the
    // two travel stacked in one cell rather than as two columns competing for the same width.
    {
      id: "client",
      accessorFn: (row) => platformSupportThreadView(row).tenantName,
      cell: ({ row }) => {
        const thread = platformSupportThreadView(row.original);
        // The subject is a sentence somebody wrote, so it takes the sans subline rather than the
        // mono one. Mono is for figures and machine events; a request set in 10.5px mono made the
        // queue read as a log.
        return <CellTwoLine primary={thread.tenantName} subline={thread.subject} sublineKind="prose" />;
      },
      header: "Client",
      meta: { cellKind: "identity", label: "Client", minWidth: 320, multiline: true },
    },
    // Still a column so the search and the Display menu can reach the subject on its own; the row
    // already prints it under the client name.
    {
      id: "issue",
      accessorFn: (row) => platformSupportThreadView(row).subject,
      header: "Issue",
      meta: { cellKind: "secondary", defaultHidden: true, label: "Issue", minWidth: 280 },
    },
    {
      id: "owner",
      accessorFn: (row) => successOwnerLabel(row),
      cell: ({ row }) => (row.original.successOwner?.name?.trim()
        ? <span className="text-[var(--body)]">{successOwnerLabel(row.original)}</span>
        : <CellQuiet>nobody owns this</CellQuiet>),
      header: "Owner",
      meta: { cellKind: "secondary", label: "Owner", minWidth: 150 },
    },
    // The one answer each row carries: how long it has been waiting. It sits last because that is
    // where the reader stops.
    {
      id: "age",
      accessorFn: (row) => row.updatedAt,
      cell: ({ row }) => (now === null
        ? <CellQuiet>not read yet</CellQuiet>
        : (
          <span className="tabular-nums text-[var(--muted)]">
            {ageLabel(row.original.updatedAt, now)}
          </span>
        )),
      header: "Age",
      meta: { cellKind: "secondary", label: "Age", minWidth: 96 },
    },
    // Grouping bands the queue by state, so a pill repeating the band header on every row is the
    // column the grouping replaces. It stays declared for Display.
    {
      id: "state",
      accessorFn: (row) => statusPresentation(row.status).label,
      cell: ({ row }) => {
        const state = statusPresentation(row.original.status);
        return <Status label={state.label} tone={STATE_TONE_TO_TONE[state.tone]} treatment="bare" />;
      },
      filterFn: "arrIncludesSome",
      header: "State",
      meta: { cellKind: "state", defaultHidden: true, label: "State" },
    },
    {
      id: "assignedTo",
      accessorFn: (row) => assignedLabel(row),
      header: "Assigned to",
      meta: { cellKind: "secondary", defaultHidden: true, label: "Assigned to" },
    },
    {
      id: "updated",
      accessorFn: (row) => row.updatedAt,
      cell: ({ row }) => (
        <span className="tabular-nums text-[var(--muted)]">{timestamp(row.original.updatedAt)}</span>
      ),
      header: "Updated",
      meta: { cellKind: "secondary", defaultHidden: true, label: "Updated" },
    },
  ], [now]);

  function openThread(thread: PlatformSupportThreadRead) {
    setSelectedId(thread.id);
  }

  // A success owner opens on their own book, so their own view leads the switch.
  const orderedViews = actorRole === "success"
    ? [BOOK_VIEWS[1], BOOK_VIEWS[0], BOOK_VIEWS[2]]
    : [...BOOK_VIEWS];

  // The oldest untouched request is the one a queue exists to surface, so it opens at the top.
  const orderedThreads = useMemo(
    () => [...threads]
      .filter((thread) => view !== "unassigned" || !thread.successOwner?.name?.trim())
      .sort((first, second) => first.updatedAt.localeCompare(second.updatedAt)),
    [threads, view],
  );

  // The chip is a claim about the queue in front of the reader, so it is computed over the
  // threads the current view actually renders rather than over everything the fetch returned.
  const queueProvenanceKind = useMemo(
    () => wholePageProvenanceKind(orderedThreads, (thread) => {
      if (thread.isTest) return "test";
      return thread.tenantIsDemo ? "demo" : null;
    }),
    [orderedThreads],
  );

  const read = !loading || threads.length > 0;
  const unassignedCount = useMemo(
    () => threads.filter((thread) => !thread.successOwner?.name?.trim()).length,
    [threads],
  );
  const segments = orderedViews.map((entry) => (entry.key === "unassigned" && read
    ? { key: entry.key, label: entry.label, count: unassignedCount }
    : { key: entry.key, label: entry.label }));

  // Three figures that change what someone does next: what is unanswered, what is parked on a
  // coach, and what nobody owns. The row count is already in the table footer.
  /*
   * These stay on StatStrip rather than moving to the kit's FigureStrip, deliberately. The
   * distinction below -- a queue nobody has read yet is not a queue of zero -- is exactly the one
   * FigureStrip collapses, since it has a single absent case covering both "unreadable" and
   * "measured none". `figure-strip.tsx` documents that boundary; this is a surface on the wrong
   * side of it.
   */
  const tiles = useMemo<StatStripItem[]>(() => {
    // A queue nobody has read yet is not a queue of zero. Until the server answers, each tile
    // says so rather than claiming three measured zeroes.
    const tile = (label: string, predicate: (thread: PlatformSupportThreadRead) => boolean): StatStripItem => (read
      ? {
        label,
        availability: { kind: "value", value: threads.filter(predicate).length, format: "count" },
      }
      : { label, availability: { kind: "unavailable", note: "The queue has not answered yet." } });

    return [
      tile("Open", (thread) => thread.status === "open"),
      tile("Waiting on coach", (thread) => thread.status === "waiting_on_coach"),
      tile("Unassigned", (thread) => !thread.successOwner?.name?.trim()),
    ];
  }, [read, threads]);

  return (
    <AppShell
      activePath="/admin/support"
      crumbs={CRUMBS}
      /*
       * The rail's number is this page's own number. Resolved threads are not waiting on anyone,
       * so the depth is what is unanswered plus what is parked on a coach -- the same two tiles
       * the strip leads with. A queue that has not been read yet counts nothing rather than
       * claiming an empty rail.
       */
      nav={withWorkspaceNavCounts(workspaceNavigationFor("admin"), {
        "/admin/support": read
          ? threads.filter((thread) => thread.status === "open" || thread.status === "waiting_on_coach").length
          : 0,
      })}
      role="admin"
    >
      <ListPage
        /*
          The canvas's sentence, which says what the page is and names the ownership rule the
          page actually enforces -- every thread carries a `successOwner`, and the Unassigned view
          and tile exist precisely because that rule can be broken. The sentence it replaces
          described the table's ordering and banding, which the bands already annotate on screen
          ("nobody on the team has answered yet"), so nothing is lost by saying the more useful
          thing in the one slot above the fold.
        */
        description="Coaches asking SetterFi to change something. Every one is assigned to a named person on the success team."
        stats={enabled && !loadError ? <StatStrip ariaLabel="Client request queue" items={tiles} /> : undefined}
        /*
         * `threadIsTest` is two different facts folded together -- a thread marked as test and a
         * thread belonging to a demo tenant -- and the chip has one word for them. So the chip
         * ships only where every thread on the page is seeded *and* seeded the same way; a queue
         * mixing the two, or mixing seeded with real, keeps the sentence and the per-row label.
         */
        provenance={queueProvenanceKind === null && threads.some(threadIsTest)
          ? "Demo and test threads are labelled in the row and excluded from real analytics."
          : undefined}
        provenanceKind={queueProvenanceKind ?? undefined}
        scope={enabled ? (
          /* Which book you are reading is a different question from how you are filtering it, so
             the saved views sit above the toolbar and the status chip inside it. */
          <SegmentedControl
            ariaLabel="Client book"
            onValueChange={(value) => query.set("view", value)}
            segments={segments}
            value={view}
          />
        ) : undefined}
        title="Client requests"
      >
        {!enabled ? (
          <DataState
            body="Support reads are not enabled in this environment."
            kind="unavailable"
            title="Support is not enabled"
          />
        ) : (
          <DataTable
            ariaLabel="Support threads"
            columns={columns}
            data={orderedThreads}
            emptyState={(
              <DataState
                body="Change the client book, status, or search to see another part of the queue."
                kind="empty"
                title="No support requests match this view"
              />
            )}
            error={loadError ? {
              body: loadError,
              retry: () => void loadThreads(),
              title: "Support queue unavailable",
            } : undefined}
            exportResource={{
              mode: "server",
              filename: "setterfi-support-threads",
              resource: "support-threads",
              query: {
                reason: "",
                book,
                status: status === "all" ? undefined : status,
              },
            }}
            footerNote="Age is time elapsed since the last message on the thread. It is not a reply promise, and the queue does not hold one."
            getRowId={(row) => row.id}
            groupBy={(row) => row.status}
            groups={QUEUE_BANDS}
            loading={loading}
            onRowOpen={openThread}
            ordering="oldest first"
            pagination={{ mode: "offset", pageSize: 25 }}
            rowLabel={{ singular: "request", plural: "requests" }}
            search={{ placeholder: "Search request, client, or owner" }}
            testRow={threadIsTest}
            testRowLabel="Demo data"
            toolbar={(
              <StatusFacet
                onChange={(value) => query.set("status", value)}
                value={status}
              />
            )}
            /*
             * Not the kit's default "Open row": this queue has a band literally labelled "Open",
             * and a screen reader hearing "Open" for the band and "Open" for the chevron cannot
             * tell a state from a control.
             */
            rowOpenLabel="Open this request"
            /*
             * The row that is wrong: nobody has answered it and nobody owns it, so there is no
             * person the clock belongs to. "Open" alone is a band, not an attention row -- tinting
             * every row in it would paint the band twice and say nothing about any single row.
             */
            rowTone={(thread) => (thread.status === "open" && !thread.successOwner?.name?.trim()
              ? "warning"
              : undefined)}
            variant="quiet"
          />
        )}
      </ListPage>

      <SupportRequestSheet
        actorId={actorId}
        actorRole={actorRole}
        onOpenChange={(open) => { if (!open) setSelectedId(null); }}
        onReload={loadThreads}
        onThreadChange={(thread) => setThreads((current) => current.map((row) => row.id === thread.id ? thread : row))}
        selected={selected}
        threads={threads}
      />
    </AppShell>
  );
}
