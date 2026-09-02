"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  Figure,
  MonoMeta,
  Prose,
  STATE_TONE_TO_TONE,
  Status,
} from "@/components/kit/atomics";
import { CoachScale } from "@/components/coach-scale";
import { CellQuiet } from "@/components/kit/cell-quiet";
import { CellTwoLine } from "@/components/kit/cell-two-line";
import {
  ConfirmFlow,
  type ImpactGroup,
  type Result,
} from "@/components/kit/confirm-flow";
import { DataState } from "@/components/kit/data-state";
import { DataTable } from "@/components/kit/data-table";
import { LoggedButton } from "@/components/kit/logged-button";
import { RecordSheet, type RecordSheetField } from "@/components/kit/record-sheet";
import { StateBadge, type StateTone } from "@/components/kit/state-badge";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import type {
  DeletionPreview,
  DeletionRetryReceipt,
  DeleteLeadResult,
} from "@/lib/deletion/contracts";
import {
  COACH_FOOTNOTE_CLASS,
  COACH_READING_CLASS,
  COACH_ROW_NAME_CLASS,
  LEAD_FACT_LABELS,
} from "@/components/workspace/live/coach-type";
import { leadSearchScope, STAGE_LABELS } from "@/components/workspace/live/lead-search";
import { workspaceCountFormat, workspaceDateTimeFormat } from "@/lib/format/datetime";
import type {
  ContactIdentityDetail,
  ContactRead,
  DuplicateCandidateView,
} from "@/lib/repositories/contacts";
import {
  deriveCandidateMergeTruth,
  deriveContactUndoTruth,
} from "@/components/workspace/live/view-models";

type IdentityLoadState =
  | { status: "idle" | "loading"; detail: null; error: null }
  | { status: "ready"; detail: ContactIdentityDetail; error: null }
  | { status: "error"; detail: null; error: string };

type MergeSource = "provider_asserted" | "lead_asserted" | "human_asserted";

type UndoTarget = {
  contactId: string;
  winnerId: string;
  auditRowId: number;
};

type ActionReceipt = {
  id: number;
  action: "contact.merged" | "contact.unmerged";
};

export type CoachContactsProps = {
  contacts: readonly ContactRead[];
  fixtureMode?: boolean;
  impersonation?: { sessionId: string; tenantId: string } | null;
  onContactDeleted: (contactId: string) => void;
  onContactMerged: (winnerId: string, loserId: string) => void;
  onContactUnmerged: (contactId: string) => void;
  onSelectedChange: (contactId: string | null) => void;
  selectedId: string | null;
  tableVisible?: boolean;
};

/**
 * The frame the leads list sits in, and the density it runs at.
 *
 * **The panel.** The canvas draws the coach's lead list inside a card -- the deck panel's own
 * geometry, `24px 24px 17px 17px` with the `--card-top` to `--card` gradient -- rather than as
 * rows on the bare page. `.coach-panel` is that face, declared once in `coach.css`, so the list
 * and coach Home's figures are visibly the same object. The `DataTable` inside keeps its `quiet`
 * variant and therefore takes no card face of its own: two nested cards would draw two boxes, and
 * the quiet variant is also the only one that renders `rowTone`, which is what tints the row
 * holding a stage the product has no copy for.
 *
 * **The density.** The console's table is 12px of horizontal padding on a 54px row at 12.5px
 * type, and that is the density round-1 demo feedback called hard to read. The canvas sets the
 * coach table at 19px 26px, so `--cell-x` moves to 26px, the fixed row height is released to
 * `auto` and the vertical rhythm comes from the padding itself -- a fixed height and a padding
 * both would fight, and the padding is the value the canvas actually states.
 *
 * The three `[&_...]` overrides exist because `CellTwoLine` and the table's own cell rule write
 * absolute sizes: 14px for a lead's name, 10.5px for the channel under it, 12.5px for every other
 * cell. Those are the console's sizes, they are not tokens, and nothing about the coach shell
 * reaches them. Overriding them here moves this table and no other -- `CellTwoLine` is shared with
 * the admin console, where 14px is correct and must not move.
 */
const COACH_TABLE_PANEL_CLASS = [
  "coach-panel min-w-0",
  "[--cell-x:26px] [--d-row-quiet:auto]",
  "[&_td]:py-[19px] [&_td]:text-[16px] [&_td]:leading-[1.45]",
  "[&_[data-slot=cell-two-line-primary]]:text-[17px] [&_[data-slot=cell-two-line-primary]]:leading-[1.35]",
  "[&_[data-slot=cell-two-line-subline]]:text-[15px] [&_[data-slot=cell-two-line-subline]]:leading-[1.4]",
].join(" ");

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function identityDetail(value: unknown): ContactIdentityDetail {
  if (!isRecord(value) || typeof value.contactId !== "string" || typeof value.name !== "string" ||
    typeof value.isDemo !== "boolean" || typeof value.isTest !== "boolean" ||
    !Array.isArray(value.identities) || !Array.isArray(value.candidates) ||
    !isRecord(value.mergeState)) {
    throw new Error("IDENTITY_DETAIL_INVALID");
  }
  return value as ContactIdentityDetail;
}

async function fetchIdentityDetail(contactId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/contacts/${encodeURIComponent(contactId)}/identities`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error("Identity details could not be loaded.");
  return identityDetail(await response.json());
}

function actionReceipt(value: unknown, expected: ActionReceipt["action"]): ActionReceipt {
  if (!isRecord(value) || !isRecord(value.audit) || value.audit.action !== expected ||
    !Number.isSafeInteger(value.audit.id) || Number(value.audit.id) <= 0) {
    throw new Error("AUDIT_RECEIPT_INVALID");
  }
  return { action: expected, id: Number(value.audit.id) };
}

function deletionPreview(value: unknown): DeletionPreview {
  if (!isRecord(value) || typeof value.contactId !== "string" || typeof value.token !== "string" ||
    typeof value.expiresAt !== "string" || !isRecord(value.counts) || !isRecord(value.receipt) ||
    !Array.isArray(value.providerEffects)) {
    throw new Error("DELETION_PREVIEW_INVALID");
  }
  return value as DeletionPreview;
}

function deleteLeadResult(value: unknown): DeleteLeadResult {
  if (!isRecord(value) || !["refused", "incomplete", "deleted"].includes(String(value.kind))) {
    throw new Error("DELETION_RESULT_INVALID");
  }
  return value as DeleteLeadResult;
}

function displayTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : workspaceDateTimeFormat.format(date);
}

const AGE_UNITS = [
  { label: "minute", seconds: 60 },
  { label: "hour", seconds: 3_600 },
  { label: "day", seconds: 86_400 },
  { label: "month", seconds: 2_592_000 },
  { label: "year", seconds: 31_536_000 },
];

/**
 * How long ago, in the coarsest unit that still separates two leads. Coarse on purpose: the
 * column is read for staleness rather than for a duration, and a string accurate to the second
 * would render one value on the server and a different one a moment later in the browser for no
 * gain. An unreadable timestamp has no age, which is the caller's cue to say so in words.
 */
function relativeAge(value: string, now: number = Date.now()) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  const seconds = Math.max(0, Math.round((now - parsed) / 1_000));
  if (seconds < AGE_UNITS[0].seconds) return "just now";
  let unit = AGE_UNITS[0];
  for (const candidate of AGE_UNITS) {
    if (seconds >= candidate.seconds) unit = candidate;
  }
  const count = Math.floor(seconds / unit.seconds);
  return `${count} ${unit.label}${count === 1 ? "" : "s"} ago`;
}

function channelLabel(channel: ContactRead["channels"][number]["channel"] | undefined) {
  if (!channel) return "No channel";
  if (channel === "sms") return "Text messages (SMS)";
  if (channel === "messenger") return "Facebook Messenger";
  if (channel === "webchat") return "Web chat";
  return channel.charAt(0).toLocaleUpperCase() + channel.slice(1);
}

/**
 * The stored consent state said in words a coach can act on. Every one of them says what may be
 * sent rather than naming the enum, and an unrecognised value says it is unrecognised instead of
 * being folded into a permissive default: this row decides whether a message is legal to send.
 */
const CONSENT_COPY: Record<string, string> = {
  conversation: "reply window open",
  none: "no consent recorded",
  opted_in: "opted in",
  reply_only: "replies only",
  suppressed: "opted out",
  unverified: "not verified",
};

function consentCopy(state: string) {
  return CONSENT_COPY[state] ?? "consent state unrecognised";
}

function outcomeCopy(outcome: string | null) {
  if (outcome === "BOOK") return { label: "Ready to book", tone: "good" as const };
  if (outcome === "SOFT_DQ") return { label: "Not a fit yet", tone: "warning" as const };
  if (outcome === "HARD_DQ") return { label: "Not a fit", tone: "critical" as const };
  return { label: "Decision pending", tone: "neutral" as const };
}

/*
 * The stage words come from `lead-search.ts` rather than from a copy kept here.
 *
 * There were three of these maps -- this one, `coach-pipeline.tsx`, and the one the search reads
 * -- all spelling the same seven stages, and nothing made them agree. Renaming two stages to the
 * artboard's words meant editing three files or shipping a table whose Stage column, whose board
 * column heading and whose search haystack each said something different about the same lead. One
 * map, imported, is the only version of that which cannot drift.
 *
 * The unknown fallback stays local because it is this table's own answer: a stage nothing has a
 * label for is a row somebody has to look at, and the cell says so rather than printing the raw
 * enum at a coach.
 */
function stageLabel(stage: string) {
  return STAGE_LABELS[stage] ?? "Stage needs review";
}

/**
 * Stage is the axis this page is read along, so it is the one status treatment the table spends,
 * and every cell carries the words beside the dot rather than the hue alone. `info` is reserved
 * for a stage genuinely still in motion; a stage that means "nothing further is happening" stays
 * neutral rather than borrowing a colour it has not earned. An unrecognised stage is amber because
 * it is something a person has to go look at, not a settled state.
 */
const STAGE_TONE: Record<string, StateTone> = {
  new_lead: "neutral",
  qualifying: "info",
  booked: "good",
  qualified_no_buy: "critical",
  long_term_followup: "neutral",
  no_show: "warning",
  disqualified: "critical",
};

function stageTone(stage: string): StateTone {
  return STAGE_TONE[stage] ?? "warning";
}

/**
 * `bare` and never `pill`: this is a dense table, where a column of lozenges out-weighs the rows
 * it annotates. Never `glow` either -- the product's single glow belongs to the attention dot, and
 * it is not on this page.
 */
function StageMark({ stage }: { stage: string }) {
  return (
    <Status
      className="min-w-0"
      label={stageLabel(stage)}
      tone={STATE_TONE_TO_TONE[stageTone(stage)]}
      treatment="bare"
    />
  );
}

/**
 * The deletion dialog's two bands, built from the counts the preview already carries.
 *
 * The dialog used to list four cascade counts and stop, which is accurate and half the story: a
 * coach confirming an irreversible delete was not told that billing history and eval cases stay.
 * Neither is a leak. `finalize_contact_deletion_intent` keeps the billable event and stamps
 * `appointment_detached_at`, and keeps the eval case while nulling every source pointer and
 * setting `provenance_severed` and `quarantined`; the merge audits are redacted rather than
 * dropped. Saying so is the difference between a survivor a coach was warned about and one they
 * discover later in an export.
 *
 * The bands are the shape `admin-compliance.tsx` already uses for the same action on the admin
 * side, so the two deletion dialogs read as one design. Nothing is derived here that the preview
 * did not return: `src/lib/deletion/preview.ts` cross-checks these counts against the RPC's own,
 * and a row this list invented would have no such check behind it.
 */
export function deletionImpact(preview: DeletionPreview, leadName: string): readonly ImpactGroup[] {
  const counts = preview.counts;
  const deleted = (label: string, value: number) => ({
    label,
    value: `${workspaceCountFormat.format(value)} deleted`,
  });
  const kept = (label: string, value: number, how: string) => ({
    label,
    value: `${workspaceCountFormat.format(value)} kept, ${how}`,
  });

  return [
    {
      title: "What this deletes",
      rows: [
        { label: "This lead", value: `${leadName}, deleted` },
        deleted("Merged duplicate records", counts.mergedContacts),
        deleted("Handles and phone numbers", counts.identities),
        deleted("Conversation threads", counts.conversations),
        deleted("Messages", counts.messages),
        deleted("Records of how the agent answered", counts.messageTraces),
        deleted("Appointments", counts.appointments),
        deleted("Follow-ups", counts.followups),
        deleted("Notes on this lead", counts.contactNotes),
        deleted("Objections logged from these messages", counts.unmatchedObjections),
      ],
    },
    {
      title: "What survives, on purpose",
      note: "These are kept deliberately rather than left behind by a partial delete, and none of it can be undone.",
      rows: [
        kept(
          "Billing already decided",
          counts.billableEventsDetached,
          "detached from the deleted appointment",
        ),
        kept(
          "Test cases built from these messages",
          counts.evalCasesSevered,
          "quarantined with every link back to this lead removed",
        ),
        kept("Merge history in the audit log", counts.mergeAuditsRedacted, "redacted"),
        { label: "This deletion", value: "recorded in the audit log with your reason" },
      ],
    },
  ];
}

function technicalCode(error: unknown) {
  return error instanceof Error ? error.message : "LEADS_ACTION_FAILED";
}

function actionIdempotencyKey(...parts: Array<number | string>) {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  return [...parts, random].join(":");
}

type DetailRow = {
  label: string;
  value: ReactNode;
  /** A figure, a date or a score: set in mono so the drawer's values line up like the table's. */
  figure?: boolean;
};

/**
 * The per-row detail sits in a well, which is the recessed region inside the drawer's face rather
 * than a second card. The values carry the reading weight.
 *
 * The labels were mono uppercase on `--overline` at the console's label size. On the coach side
 * that role does not exist: a drawer a coach opens to read one lead's answers is the last place to
 * spend the product's smallest, widest-tracked type, so the key is sentence case at 13px in
 * `--muted` and the value stays the loud half of the pair.
 */
function KeyValueList({ rows }: { rows: readonly DetailRow[] }) {
  return (
    <dl className={`surface-well grid grid-cols-[minmax(var(--s-12),1fr)_2fr] items-baseline gap-x-[var(--s-3)] gap-y-[var(--s-3)] ${COACH_READING_CLASS}`}>
      {rows.map((row) => (
        <div className="contents" key={row.label}>
          <dt className="text-[13px] leading-[1.4] text-[color:var(--muted)]">{row.label}</dt>
          <dd
            className={row.figure
              ? "mono min-w-0 break-words text-[12.5px] leading-[1.35] tabular-nums text-[var(--ink)]"
              : "min-w-0 break-words text-[var(--ink)]"}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function CoachContacts({
  ...props
}: CoachContactsProps) {
  return <CoachContactsForSelection key={props.selectedId ?? "no-contact"} {...props} />;
}

function CoachContactsForSelection({
  contacts,
  fixtureMode = false,
  impersonation = null,
  onContactDeleted,
  onContactMerged,
  onContactUnmerged,
  onSelectedChange,
  selectedId,
  tableVisible = true,
}: CoachContactsProps) {
  const selected = contacts.find((contact) => contact.id === selectedId) ?? null;
  const [identityState, setIdentityState] = useState<IdentityLoadState>(() => selected && !fixtureMode
    ? { detail: null, error: null, status: "loading" }
    : { detail: null, error: null, status: "idle" });
  const [mergeCandidateId, setMergeCandidateId] = useState("");
  const [mergeSource, setMergeSource] = useState<MergeSource | "">("");
  const [mergeReason, setMergeReason] = useState("");
  const [mergeConfirmed, setMergeConfirmed] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [undoTarget, setUndoTarget] = useState<UndoTarget | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const [receipt, setReceipt] = useState<ActionReceipt | null>(null);
  const [deletePreview, setDeletePreview] = useState<DeletionPreview | null>(null);
  const [deleteOperation, setDeleteOperation] = useState<{
    idempotencyKey: string;
    retry: DeletionRetryReceipt | null;
  } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);

  useEffect(() => {
    if (!selected || fixtureMode) return;

    const controller = new AbortController();
    void fetchIdentityDetail(selected.id, controller.signal).then(async (detail) => {
      let undo = deriveContactUndoTruth(detail, Boolean(impersonation));
      const mergedCandidate = detail.candidates.find((candidate) => candidate.state === "merged");
      if (!undo && mergedCandidate) {
        const mergedDetail = await fetchIdentityDetail(
          mergedCandidate.otherContact.id,
          controller.signal,
        );
        undo = deriveContactUndoTruth(mergedDetail, Boolean(impersonation));
      }
      if (controller.signal.aborted) return;
      setIdentityState({ detail, error: null, status: "ready" });
      setUndoTarget(undo);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setIdentityState({
        detail: null,
        error: error instanceof Error ? error.message : "Identity details could not be loaded.",
        status: "error",
      });
    });
    return () => controller.abort();
  }, [fixtureMode, impersonation, selected]);

  const columns = useMemo<ColumnDef<ContactRead>[]>(() => [
    /*
     * No selection column. `Leads.dc.html` draws no checkbox anywhere, and nothing on this page
     * ever read the selection -- there is no bulk verb behind it, so every row carried a control
     * whose only effect was to tick itself. The column and the 24px it claimed are gone.
     */
    {
      /*
       * The name over what the lead wants, which is what `Leads.dc.html` stacks in this cell:
       * "Adriana Salas" over "Wants $50,000". It used to be the masked channel handle, and the
       * swap is the right way round for two reasons -- the channel is now a visible column of its
       * own, so the handle's job was already done twice, and the funding goal is the single fact
       * a coach scanning this list is sorting people by. `contact.goal` is already on the row;
       * `leadExportRows` reads it, so this is a swap rather than a schema gap.
       *
       * No monogram. The artboard draws none, and the reason is what the row spends its width on:
       * the two initials of a lead's name say nothing the name beside them does not already say.
       */
      accessorKey: "name",
      /*
       * "Name", not "Lead". The page is already titled "Your leads" and every row in it is one,
       * so a column headed Lead spends its width restating the table's own subject; the artboard
       * heads it with the thing actually in the cell.
       */
      header: "Name",
      cell: ({ row }) => (
        <CellTwoLine
          absentSubline="goal not captured"
          primary={row.original.name}
          subline={row.original.goal ? `Wants ${row.original.goal}` : undefined}
        />
      ),
      meta: {
        cellKind: "identity",
        label: "Lead",
        multiline: true,
      },
    },
    /*
     * Credit, goal, timeline and decision ship behind Display. 6b opens on the identity stack,
     * the one piece of evidence that dates it, and the answer -- three columns, not seven -- and
     * a table that opens on seven makes the reader find the answer instead of reading it. None of
     * them is dropped: the Display menu still has all four, and the export carries every field
     * whether or not a column is on screen.
     */
    {
      /*
       * Where the lead came from, as a column of its own, off by default.
       *
       * `Leads.dc.html` heads a column "Where they came from" and puts the channel in it, and it
       * is one of the four columns the table opens with. It used to ship behind Display, on the
       * grounds that the identity stack under the name already carried the channel; that stack
       * now carries the funding goal instead, so the argument for hiding this went with it and
       * the column the artboard draws is the one on screen.
       *
       * The accessor prints the channel's full name rather than the two-letter short form the
       * subline uses: a column header has room for "Instagram" and a sorted column of "IG" and
       * "WA" is a puzzle. A lead with no saved channel sorts as empty and the cell says so, which
       * is the same absence the subline states -- never a dash, per the table kit's rule.
       */
      id: "channel",
      accessorFn: (contact) => contact.channels.at(0) ? channelLabel(contact.channels[0]!.channel) : "",
      header: "Where they came from",
      cell: ({ row }) => {
        const channel = row.original.channels.at(0);
        return channel ? channelLabel(channel.channel) : <CellQuiet>no channel saved</CellQuiet>;
      },
      meta: { cellKind: "secondary", label: "Where they came from", cellClassName: "text-[length:var(--t-row)]" },
    },
    {
      id: "credit",
      accessorFn: (contact) => contact.credit ?? "",
      header: LEAD_FACT_LABELS.credit,
      cell: ({ row }) => row.original.credit
        ? <Figure size="sm">{row.original.credit}</Figure>
        : <CellQuiet>not captured</CellQuiet>,
      meta: { defaultHidden: true, label: LEAD_FACT_LABELS.credit, cellClassName: "text-[length:var(--t-row)]" },
    },
    {
      id: "goal",
      accessorFn: (contact) => contact.goal ?? "",
      header: LEAD_FACT_LABELS.goal,
      cell: ({ row }) => row.original.goal
        ? <Figure size="sm">{row.original.goal}</Figure>
        : <CellQuiet>not captured</CellQuiet>,
      meta: { defaultHidden: true, label: LEAD_FACT_LABELS.goal, cellClassName: "text-[length:var(--t-row)]" },
    },
    {
      id: "timeline",
      accessorFn: (contact) => contact.timeline ?? "",
      header: LEAD_FACT_LABELS.timeline,
      cell: ({ row }) => row.original.timeline ?? <CellQuiet>not captured</CellQuiet>,
      meta: { defaultHidden: true, label: LEAD_FACT_LABELS.timeline, cellClassName: "text-[length:var(--t-row)]" },
    },
    {
      /*
       * Plain words, not a second pill. Stage on the right is the one status treatment this table
       * spends, and the artifact's row carries exactly one; a decision chip beside a stage chip
       * put two lozenge columns on the same line and neither read as the status.
       */
      id: "decision",
      accessorFn: (contact) => outcomeCopy(contact.outcome).label,
      header: LEAD_FACT_LABELS.outcome,
      meta: { cellKind: "secondary", defaultHidden: true, label: LEAD_FACT_LABELS.outcome, cellClassName: "text-[length:var(--t-row)]" },
    },
    {
      /*
       * "Last message", and the relative phrase alone, which is both halves of what
       * `Leads.dc.html` draws here. The absolute timestamp was the figure and the age was the
       * subline under it; the coach reads this column to find out how stale a lead is, and the
       * date was the half they had to do arithmetic on to answer that. The exact instant is still
       * on the record sheet and in the export, so nothing is lost -- it is just no longer the
       * thing this column leads with. The row still sorts on the real timestamp.
       *
       * When the stored value will not parse there is no age to state, so the cell says what is
       * missing rather than printing a date it could not read.
       */
      id: "lastActivity",
      accessorFn: (contact) => contact.lastActivityAt,
      header: "Last message",
      cell: ({ row }) => {
        const age = relativeAge(row.original.lastActivityAt);
        return age ?? <CellQuiet>no activity recorded</CellQuiet>;
      },
      meta: { cellKind: "secondary", label: "Last message" },
    },
    {
      /*
       * The answer, far right and last before the row's chevron: every other column is evidence
       * for it. It is a bare dot and the words, never a pill -- 6b draws its one status per row
       * exactly that way, and a column of tinted lozenges out-weighs the rows it annotates.
       */
      id: "stage",
      accessorFn: (contact) => stageLabel(contact.pipelineStage),
      header: "Stage",
      cell: ({ row }) => <StageMark stage={row.original.pipelineStage} />,
      meta: { cellKind: "state", label: "Stage", cellClassName: "text-[length:var(--t-row)]" },
    },
  ], []);

  const selectedCandidate = identityState.status === "ready"
    ? identityState.detail.candidates.find((candidate) => candidate.id === mergeCandidateId) ?? null
    : null;
  const mergeTruth = selectedCandidate
    ? deriveCandidateMergeTruth(selectedCandidate, Boolean(impersonation))
    : { canMerge: false, reason: null };

  async function mergeSelectedCandidate() {
    if (!selected || !selectedCandidate || !mergeTruth.canMerge || !mergeSource ||
      !mergeReason.trim() || !mergeConfirmed || actionPending) return;
    setActionPending(true);
    setActionError("");
    setReceipt(null);
    try {
      const response = await fetch(`/api/contacts/${encodeURIComponent(selected.id)}/merge`, {
        body: JSON.stringify({
          evidenceId: selectedCandidate.id,
          idempotencyKey: actionIdempotencyKey("contact-merge", selected.id, selectedCandidate.id),
          loserId: selectedCandidate.otherContact.id,
          reason: mergeReason.trim(),
          source: mergeSource,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : "Contact merge was refused.");
      }
      const persistedReceipt = actionReceipt(payload, "contact.merged");
      const [winnerDetail, loserDetail] = await Promise.all([
        fetchIdentityDetail(selected.id),
        fetchIdentityDetail(selectedCandidate.otherContact.id),
      ]);
      const candidateReadBack = winnerDetail.candidates.find(
        (candidate) => candidate.id === selectedCandidate.id,
      );
      const undo = deriveContactUndoTruth(loserDetail, Boolean(impersonation));
      if (candidateReadBack?.state !== "merged" || !undo ||
        undo.auditRowId !== persistedReceipt.id) {
        throw new Error("The merge receipt could not be reconciled with saved contact state.");
      }
      setIdentityState({ detail: winnerDetail, error: null, status: "ready" });
      setUndoTarget(undo);
      setReceipt(persistedReceipt);
      onContactMerged(selected.id, selectedCandidate.otherContact.id);
      setMergeOpen(false);
      setMergeCandidateId("");
      setMergeSource("");
      setMergeReason("");
      setMergeConfirmed(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Contact merge was refused.");
    } finally {
      setActionPending(false);
    }
  }

  async function undoMerge(input: { reason?: string }): Promise<Result> {
    if (!selected || !undoTarget || !input.reason?.trim() || actionPending || impersonation) {
      return { message: "This merge cannot be restored from the current view.", ok: false };
    }
    setActionPending(true);
    setActionError("");
    setReceipt(null);
    try {
      const response = await fetch(
        `/api/contacts/${encodeURIComponent(undoTarget.contactId)}/unmerge`,
        {
          body: JSON.stringify({
            idempotencyKey: actionIdempotencyKey("contact-unmerge", undoTarget.auditRowId),
            mergeAuditId: undoTarget.auditRowId,
            reason: input.reason.trim(),
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : "Contact merge undo was refused.");
      }
      const persistedReceipt = actionReceipt(payload, "contact.unmerged");
      const selectedDetail = await fetchIdentityDetail(selected.id);
      const restoredDetail = selected.id === undoTarget.contactId
        ? selectedDetail
        : await fetchIdentityDetail(undoTarget.contactId);
      if (restoredDetail.mergeState.status !== "active" || restoredDetail.undo !== null) {
        throw new Error("The undo receipt could not be reconciled with saved contact state.");
      }
      setIdentityState({ detail: selectedDetail, error: null, status: "ready" });
      setUndoTarget(null);
      setReceipt(persistedReceipt);
      onContactUnmerged(undoTarget.contactId);
      return {
        ok: true,
        receipt: { actionKey: "contact.unmerged", auditId: persistedReceipt.id },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Contact merge undo was refused.";
      setActionError(message);
      return { message, ok: false };
    } finally {
      setActionPending(false);
    }
  }

  async function openDeletionPreview() {
    if (!selected || impersonation || deletePending) return;
    setDeletePending(true);
    setActionError("");
    try {
      const response = await fetch(
        `/api/contacts/${encodeURIComponent(selected.id)}/deletion-preview`,
        {
          body: "{}",
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      const payload: unknown = await response.json();
      // The preview endpoint answers 404 with "Not found." when lead deletion is not released.
      // A refusal and an unreleased verb are different facts, so they get different sentences.
      if (response.status === 404) {
        throw new Error(
          "Deleting a lead is not enabled in this environment. Nothing was deleted, and no lead was messaged.",
        );
      }
      if (!response.ok || !isRecord(payload)) throw new Error("Deletion preview was refused.");
      setDeletePreview(deletionPreview(payload.preview));
      setDeleteOperation({
        idempotencyKey: actionIdempotencyKey("contact-delete", selected.id),
        retry: null,
      });
      setDeleteOpen(true);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Deletion preview was refused.");
    } finally {
      setDeletePending(false);
    }
  }

  async function confirmDeletion(input: { reason?: string }): Promise<Result> {
    if (!selected || !deletePreview || !deleteOperation || !input.reason?.trim() || impersonation) {
      return { message: "This deletion cannot continue from the current view.", ok: false };
    }
    try {
      const response = await fetch(`/api/contacts/${encodeURIComponent(selected.id)}`, {
        body: JSON.stringify({
          idempotencyKey: deleteOperation.idempotencyKey,
          previewToken: deletePreview.token,
          reason: input.reason.trim(),
          retry: deleteOperation.retry,
        }),
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      });
      const payload: unknown = await response.json();
      if (!isRecord(payload)) throw new Error("Deletion result could not be read.");
      const result = deleteLeadResult(payload.result);
      if (!response.ok || result.kind !== "deleted") {
        if (result.kind === "incomplete") {
          setDeleteOperation((current) => current ? { ...current, retry: result.retry } : current);
        }
        const reason = result.kind === "incomplete"
          ? result.reason
          : "The deletion was refused.";
        return { message: reason, ok: false };
      }
      onContactDeleted(selected.id);
      onSelectedChange(null);
      setDeleteOperation(null);
      setDeletePreview(null);
      return {
        ok: true,
        receipt: { actionKey: "contact.delete", auditId: result.auditId },
      };
    } catch (error) {
      return {
        message: error instanceof Error ? error.message : "The deletion was refused.",
        ok: false,
      };
    }
  }

  const identityBody = identityState.status === "loading" ? (
    <DataState kind="loading" rows={3} />
  ) : identityState.status === "error" ? (
    <DataState
      body="Retry by closing and reopening this lead. No contact action was completed."
      code={technicalCode(new Error(identityState.error))}
      kind="error"
      retry={() => onSelectedChange(null)}
      title="Identity details could not load"
    />
  ) : identityState.status === "ready" ? (
    <div className="flex flex-col gap-[var(--s-4)]">
      {/*
        Hairline-separated rows rather than a wrap of chips. The artifact's opened contact answers
        "how do I reach this person, and are we allowed to", so each channel prints its whole
        address in mono -- unmasked here, because the coach opened this record deliberately -- with
        the consent state in words beside it. A row of chips could carry the channel name and
        nothing else, which is the half of the question nobody was asking.
      */}
      <ul className="m-0 flex list-none flex-col p-0">
        {identityState.detail.identities.length ? identityState.detail.identities.map((identity) => (
          <li
            className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-[var(--s-3)] gap-y-[var(--s-1)] border-b border-[var(--line-soft)] py-[var(--s-2)] last:border-b-0"
            data-testid="contact-channel-row"
            key={identity.id}
          >
            <div className="flex min-w-0 flex-col gap-[2px]">
              <span className={COACH_ROW_NAME_CLASS}>{identity.channelLabel}</span>
              <MonoMeta className="break-all">{identity.address}</MonoMeta>
            </div>
            <MonoMeta className="shrink-0">{consentCopy(identity.consentState)}</MonoMeta>
          </li>
        )) : <li className={`${COACH_READING_CLASS} text-[var(--muted)]`}>No saved contact channels.</li>}
      </ul>
      <div className="flex flex-col gap-[var(--s-3)]">
        {identityState.detail.candidates.length ? identityState.detail.candidates.map(
          (candidate: DuplicateCandidateView) => {
            const truth = deriveCandidateMergeTruth(candidate, Boolean(impersonation));
            return (
              <article className="surface-well min-w-0" key={candidate.id}>
                <div className="flex items-start justify-between gap-[var(--s-3)]">
                  <div>
                    <p className={COACH_ROW_NAME_CLASS}>Possible duplicate</p>
                    <p className={`mt-[var(--s-1)] ${COACH_READING_CLASS} text-[var(--body)]`}>
                      {candidate.otherContact.name}
                    </p>
                  </div>
                  <StateBadge
                    kind="tag"
                    label={candidate.state === "open" ? "Review needed" : "Reviewed"}
                    tone={candidate.state === "open" ? "warning" : "neutral"}
                  />
                </div>
                <Prose className={`mt-[var(--s-2)] ${COACH_READING_CLASS} text-[var(--muted)]`}>
                  Histories remain separate until a merge succeeds and is read back.
                </Prose>
                {truth.reason ? (
                  <p className={`mt-[var(--s-2)] ${COACH_READING_CLASS} text-[var(--critical)]`}>{truth.reason}</p>
                ) : null}
                {truth.canMerge ? (
                  <Button
                    className="mt-[var(--s-3)]"
                    onClick={() => {
                      setMergeCandidateId(candidate.id);
                      setMergeSource("");
                      setMergeReason("");
                      setMergeConfirmed(false);
                      setActionError("");
                      setMergeOpen(true);
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Review merge
                  </Button>
                ) : null}
              </article>
            );
          },
        ) : <p className={`${COACH_READING_CLASS} text-[var(--muted)]`}>No possible duplicates need review.</p>}
      </div>
      {undoTarget ? (
        <div className="surface-well min-w-0">
          <p className={COACH_ROW_NAME_CLASS}>
            Reversible merge · audit {undoTarget.auditRowId}
          </p>
          <Prose className={`mt-[var(--s-1)] ${COACH_READING_CLASS} text-[var(--muted)]`}>
            Restore the two separate histories from the recorded merge.
          </Prose>
          <Button
            className="mt-[var(--s-3)]"
            onClick={() => setUndoOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            Undo merge
          </Button>
        </div>
      ) : null}
      {receipt ? (
        <p className={`${COACH_READING_CLASS} text-[var(--good)]`} role="status">
          {AUDIT_ACTIONS[receipt.action].microcopy}.
        </p>
      ) : null}
      {actionError ? <p className={`${COACH_READING_CLASS} text-[var(--critical)]`} role="alert">{actionError}</p> : null}
    </div>
  ) : (
    <p className={`${COACH_READING_CLASS} text-[var(--muted)]`}>Open a live lead to review contact channels.</p>
  );

  /*
   * The artifact's DETAILS panel, on the drawer's own field grid rather than a hand-rolled one.
   * The grid is what gives every value a fixed key column and, more importantly, prints a real
   * absence -- "not captured yet" in faint italic -- instead of the string "Not captured" sitting
   * in ink where a value goes, which read as a captured value whose content was the words "Not
   * captured".
   *
   * The artifact's THREADS and REPLIES rows are not here: nothing in `ContactRead` or the identity
   * detail counts threads or replies, and a plausible number is worse than a missing row.
   */
  const detailFields: RecordSheetField[] = selected ? [
    // The same four names the columns and the Inbox rail use, from the same constant. The drawer
    // held literals through the rename and so said "Credit range" over a column headed "Credit",
    // which is the two-names-for-one-number failure `LEAD_FACT_LABELS` exists to prevent, on one
    // screen rather than across two.
    { absence: "not captured yet", label: LEAD_FACT_LABELS.credit, value: selected.credit },
    { absence: "not captured yet", label: LEAD_FACT_LABELS.goal, value: selected.goal },
    { absence: "not captured yet", label: LEAD_FACT_LABELS.timeline, value: selected.timeline },
    { label: LEAD_FACT_LABELS.outcome, value: outcomeCopy(selected.outcome).label },
    { label: "Last activity", mono: true, value: displayTime(selected.lastActivityAt) },
    {
      // Two different facts, so two different sentences: the coach-level opt-out is a standing
      // instruction, and "no opt-out recorded" is not the same claim as consent to message.
      label: "Do not contact",
      value: selected.optedOut ? "Yes, this lead opted out" : "No opt-out recorded",
    },
    { absence: "not captured yet", label: "Timezone", value: selected.timezone },
  ] : [];

  const recordSections = selected ? [
    { fields: detailFields, title: "Details" },
    { body: identityBody, title: "Channels and duplicate review" },
  ] : [];

  return (
    <div
      data-filtered-count={tableVisible ? contacts.length : undefined}
      data-leads-view={tableVisible ? "table" : undefined}
    >
      {/*
        What the search above this table actually reads, printed from the list `filterLeads`
        iterates rather than typed here, so the two cannot drift apart. Round 3's artifact titles
        this screen "search by anything a lead ever said" and no backend can honour it: a lead's
        messages are not on `ContactRead`, this page loads none, and nothing indexes message text
        for search. A search box that quietly greps names while the page promises transcripts
        turns an empty result into evidence a lead never said something.
      */}
      {tableVisible ? (
        <Prose
          className={`mb-[var(--s-3)] ${COACH_FOOTNOTE_CLASS}`}
          data-lead-search-scope="true"
        >
          {leadSearchScope()}
        </Prose>
      ) : null}

      {tableVisible ? <div className={COACH_TABLE_PANEL_CLASS}><DataTable
        ariaLabel="Leads table"
        columns={columns}
        data={contacts}
        emptyState={(
          <DataState
            body="Clear a filter or search for another lead."
            kind="empty"
            title="No leads match this view"
          />
        )}
        footerNote="Order is when a lead was last seen on a channel SetterFi records, which is not a ranking of who is waiting on the coach: nothing here stores a reply promise."
        getRowId={(contact) => contact.id}
        /*
         * The rows arrive ordered by last activity from the repository, so the table opens on that
         * same sort rather than leaving every header looking unsorted while the footer claims an
         * order. Sorting on the displayed value also keeps the claim true for a lead whose stored
         * activity time and displayed one differ.
         */
        initialSorting={[{ desc: true, id: "lastActivity" }]}
        onRowOpen={(contact) => onSelectedChange(contact.id)}
        ordering="most recent activity first"
        pagination={{ mode: "offset", pageSize: 50 }}
        rowLabel={{ plural: "leads", singular: "lead" }}
        scale="coach"
        /*
         * The only attention row this table has: a stored stage the product has no copy for, which
         * the stage cell already says out loud as "Stage needs review". It is a row a person has
         * to go look at, and it is rare, which is what a tinted row is for. Nothing else here
         * qualifies -- "no show" and "not a fit" are outcomes the lead reached, not rows that are
         * wrong, and tinting a whole outcome would paint most of the table.
         */
        rowTone={(contact) => (stageLabel(contact.pipelineStage) === "Stage needs review"
          ? "warning"
          : undefined)}
        /*
         * No `selection`. `Leads.dc.html` draws no checkbox on any row, and the one bulk verb
         * behind the column was "Export selected JSON" -- a narrower version of the table's own
         * export, which is unconditional and still here, so the hard rule that every table exports
         * CSV/JSON is untouched. What went is a checkbox on every row of the list a coach scrolls
         * most, in service of an export they can already take whole.
         */
        variant="quiet"
      /></div> : null}

      {selected ? (
        <RecordSheet
          destructive={impersonation ? undefined : {
            label: deletePending
              ? "Loading deletion preview"
              : `Preview permanent deletion · ${AUDIT_ACTIONS["contact.delete.preview"].microcopy}`,
            onClick: deletePending ? undefined : () => void openDeletionPreview(),
          }}
          onOpenChange={(open) => {
            if (!open) onSelectedChange(null);
          }}
          open
          primaryAction={{
            href: `/coach/conversations?contact=${encodeURIComponent(selected.id)}`,
            label: "Open the thread",
          }}
          sections={recordSections}
          /*
           * The stage is the drawer's own state pill now, so the subtitle can be what the artifact
           * puts under the name: how this person is reached. It was carrying both, which put the
           * stage in muted 12px prose while the pill slot above it sat empty.
           */
          state={{
            kind: "lifecycle",
            label: stageLabel(selected.pipelineStage),
            tone: stageTone(selected.pipelineStage),
          }}
          subtitle={selected.channels.at(0)
            ? `${selected.channels[0]!.address} · ${channelLabel(selected.channels[0]!.channel)}`
            : "No contact channel saved"}
          technical={[
            { label: "Contact ID", value: selected.id },
            { label: "Pipeline value", value: selected.pipelineStage },
            { label: "Last activity value", value: selected.lastActivityAt },
          ]}
          title={selected.name}
        />
      ) : null}

      <AlertDialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <AlertDialogContent className="max-h-[calc(100dvh-var(--s-8))] max-w-[var(--drawer-w)] overflow-y-auto rounded-[var(--r-panel)] bg-[var(--raised)] p-[var(--s-5)] shadow-[var(--shadow-raised)]">
          {/*
            Radix mounts this content to `document.body`, which is outside the
            `[data-shell-role="coach"]` element every coach token is declared on. So the three
            controls below that read the coach scale through `COACH_READING_CLASS` were resolving
            `--coach-body` to nothing -- and an undefined custom property does not fall back, it
            makes the browser drop the whole `font-size` declaration. The Select trigger, the
            confirmation checkbox's label and the error line therefore rendered at whatever `body`
            inherits, on a destructive merge a coach is meant to confirm by reading it.

            `CoachScale` restamps the scope inside the portal, and `className="contents"` so the
            wrapper adds no box of its own -- `AlertDialogContent` lays its own children out. This
            is the pattern `coach-measurement.tsx:986` already uses inside its `DialogContent`, and
            it is stamped at the callsite rather than in `ui/alert-dialog.tsx` because admin mounts
            the same primitive and must not inherit the coach's density.
          */}
          <CoachScale className="contents">
          <AlertDialogHeader>
            <AlertDialogTitle>Review contact merge</AlertDialogTitle>
            <AlertDialogDescription>
              Compare the two separate histories, then record who confirmed they belong together.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {selected && selectedCandidate ? (
            <div className="flex flex-col gap-[var(--s-4)]">
              <KeyValueList rows={[
                { label: "Keep", value: selected.name },
                { label: "Merge into it", value: selectedCandidate.otherContact.name },
              ]} />
              <div className="flex flex-col gap-[var(--s-2)]">
                <Label id="merge-source-label">How was this confirmed?</Label>
                <Select
                  onValueChange={(value) => setMergeSource((value ?? "") as MergeSource | "")}
                  value={mergeSource || null}
                >
                  <SelectTrigger
                    aria-labelledby="merge-source-label"
                    className={`w-full rounded-[var(--r-input)] border-[var(--line-strong)] bg-[var(--card)] ${COACH_READING_CLASS} text-[var(--ink)]`}
                  >
                    <SelectValue placeholder="Choose the confirmed source" />
                  </SelectTrigger>
                  <SelectContent align="start">
                    <SelectItem value="provider_asserted">The connected service confirmed it</SelectItem>
                    <SelectItem value="lead_asserted">The lead confirmed it</SelectItem>
                    <SelectItem value="human_asserted">I confirmed it after review</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-[var(--s-2)]">
                <Label htmlFor="merge-reason">Reason</Label>
                <Textarea
                  id="merge-reason"
                  onChange={(event) => setMergeReason(event.currentTarget.value)}
                  placeholder="Why these two histories belong to one person"
                  value={mergeReason}
                />
              </div>
              <label className={`flex items-start gap-[var(--s-2)] ${COACH_READING_CLASS} text-[var(--body)]`}>
                <Checkbox
                  checked={mergeConfirmed}
                  onCheckedChange={(checked) => setMergeConfirmed(Boolean(checked))}
                />
                <span>I checked both separate histories and confirm this directional merge.</span>
              </label>
              {actionError ? <p className={`${COACH_READING_CLASS} text-[var(--critical)]`} role="alert">{actionError}</p> : null}
              <div className="flex flex-wrap justify-end gap-[var(--s-2)]">
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <LoggedButton
                  actionKey="contact.merged"
                  disabled={!mergeTruth.canMerge || !mergeSource || !mergeReason.trim() ||
                    !mergeConfirmed || actionPending}
                  onClick={() => void mergeSelectedCandidate()}
                >
                  {actionPending ? "Merging contacts" : "Merge contacts"}
                </LoggedButton>
              </div>
            </div>
          ) : null}
          </CoachScale>
        </AlertDialogContent>
      </AlertDialog>

      {undoTarget ? (
        <>
        {/* The kit names this prop action. It resolves the same actionKey="contact.unmerged" registry entry. */}
        <ConfirmFlow
          action="contact.unmerged"
          confirmLabel="Undo merge"
          impact={[
            { label: "Change", value: "Restore two separate contact histories" },
            { label: "Source", value: `Recorded merge receipt ${undoTarget.auditRowId}` },
          ]}
          onConfirm={undoMerge}
          onOpenChange={setUndoOpen}
          open={undoOpen}
          title="Undo this contact merge?"
        />
        </>
      ) : null}

      {selected && deletePreview ? (
        <ConfirmFlow
          action="contact.delete"
          confirmLabel="Delete permanently"
          destructive
          impact={deletionImpact(deletePreview, selected.name)}
          onConfirm={confirmDeletion}
          onOpenChange={(open) => {
            setDeleteOpen(open);
            if (!open) {
              setDeleteOperation(null);
              setDeletePreview(null);
            }
          }}
          open={deleteOpen}
          title="Delete this lead permanently?"
        />
      ) : null}
    </div>
  );
}
