"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import {
  Figure,
  MonoMeta,
  Overline,
  Prose,
  STATE_TONE_TO_TONE,
  SettingGroup,
  SettingRow,
  Status,
  Surface,
  SurfaceHeader,
} from "@/components/kit/atomics";
import { Callout } from "@/components/kit/callout";
import { absentValue } from "@/components/kit/columns";
import { ChevronDown } from "@/components/kit/icons";
import { DataState } from "@/components/kit/data-state";
import { DataTable } from "@/components/kit/data-table";
import { ExportMenu } from "@/components/kit/export-menu";
import { Field } from "@/components/kit/field";
import { KeyValue } from "@/components/kit/key-value";
import { LoggedButton } from "@/components/kit/logged-button";
import { RecordSheet } from "@/components/kit/record-sheet";
import { ConsoleStatDeck } from "@/components/kit/console-stat-deck";
import { type StatStripItem } from "@/components/kit/stat-strip";
import type { StateTone } from "@/components/kit/state-badge";
import { TechnicalDetail } from "@/components/kit/technical-detail";
import { DetailPage } from "@/components/kit/templates/detail-page";
import { ViewSwitch } from "@/components/kit/view-switch";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ImportDisposition } from "@/lib/brain/contracts";
import { FIGURE_BINDING_FIELDS } from "@/lib/brain/import/flags";
import { QUALIFICATION_OUTCOME_COPY } from "@/lib/copy/states";
import { workspaceCountFormat, workspaceDateTimeFormat } from "@/lib/format/datetime";

import { createBrainApiClient } from "./brain-api-client";
import { missionFieldCopy } from "./mission-fields";
import {
  draftDiffView,
  evalGateView,
  importReviewView,
  publishReceiptView,
  reasonControlView,
  rollbackReceiptView,
  objectionListView,
  type AdminBrainInitialState,
  type BrainEvalView,
  type BrainFieldChange,
  type BrainImportRowView,
  type BrainObjectionView,
  type BrainPublishResponse,
  type ObjectionCategoryFilter,
} from "./brain-view-models";

type AdminBrainProps = { initialState: AdminBrainInitialState };
type BrainTab = "overview" | "review" | "defaults" | "knowledge" | "versions" | "diagnostics";
type KnowledgeRow = AdminBrainInitialState["knowledge"][number];
type ReviewDecision = {
  disposition: ImportDisposition | null;
  reviewedFlagIds: string[];
  bindings: Record<string, string>;
  bareTokens: Record<string, string>;
};

const api = createBrainApiClient();

// Published first: the band order is the reading order, and "what is live" is the question this
// table is opened with.
const KNOWLEDGE_GROUPS = [
  { id: "published", label: "Published, live on every agent" },
  { id: "draft", label: "Draft, not yet published" },
] as const;

// Gated first, for the same reason. A gated objection's answer is bound to the platform's
// pricing, guarantee, and outcome rules and cannot be reworded by a coach or invented by the
// agent, so it is the band that carries the risk.
const OBJECTION_GATE_GROUPS = [
  { id: "gated", label: "Hard-gated, figures bound to platform rules" },
  { id: "ungated", label: "Not gated" },
] as const;

const PAGE_DESCRIPTION =
  "Review, evaluate, publish, and roll back the shared platform configuration from saved evidence.";

/**
 * What a changed entity actually reaches, in the reader's terms.
 *
 * The blast-radius panel exists so nobody presses Publish without knowing what moves, and a diff
 * that reads `Changed knowledge_entry` says what the row is called rather than what happens when
 * it ships. These sentences are authored copy about mechanism, not derived data: each one names
 * the part of the agent that reads that entity type. A type with no entry here falls back to
 * saying nothing rather than to an invented consequence.
 */
const ENTITY_REACH: Readonly<Record<string, { label: string; reach: string }>> = {
  mission: {
    label: "Mission field",
    reach: "Compiled into the shared mission every agent opens a conversation from.",
  },
  qualification_rule: {
    label: "Qualification rule",
    reach: "Read on every lead, in position order, until a row matches.",
  },
  compliance_rule: {
    label: "Compliance rule",
    reach: "Every reply is re-checked against it before it is sent.",
  },
  knowledge_entry: {
    label: "Knowledge entry",
    reach: "Retrieved as grounding when a lead asks a question it answers.",
  },
  placeholder_definition: {
    label: "Placeholder definition",
    reach: "Changes the shape of the values rendered into answers per coach.",
  },
  placeholder_resolution: {
    label: "Placeholder resolution",
    reach: "Changes which value each coach's agent renders into an answer.",
  },
};

/**
 * Every blocking flag, said in words rather than as its column name.
 *
 * `unbound_figure` and `bare_x` had controls beside them and no sentence explaining why the
 * control was there, and the other five had neither. The row kit's rule -- an explanation on
 * every row -- is the reason this map exists: a reviewer deciding whether a row is safe to accept
 * needs to know what the detector found, not the identifier it found it under.
 */
const FLAG_COPY: Readonly<Record<string, { title: string; body: string }>> = {
  source_shape: {
    title: "Source shape is wrong",
    body: "The source row is not shaped like a question and an answer, so it cannot be reviewed here. Fix it at the source and import again.",
  },
  first_person_pii: {
    title: "First-person or personal detail",
    body: "The answer speaks as a named person or carries personal detail, which cannot be shared across every coach's agent.",
  },
  unbound_figure: {
    title: "A figure with nothing behind it",
    body: "The answer states a number that is not bound to a platform field, so the agent could send a figure nothing published. Bind it before accepting.",
  },
  unknown_placeholder: {
    title: "Placeholder is not defined",
    body: "The answer uses a placeholder the platform cannot resolve, so it would render as raw text to a lead. Fix it at the source and import again.",
  },
  bare_x: {
    title: "A bare link stand-in",
    body: "The answer carries a placeholder link instead of an approved destination. Give it the approved token so the agent sends a real one.",
  },
  multi_category: {
    title: "Belongs to more than one category",
    body: "The source row was filed under several categories, so retrieval cannot tell which question it answers.",
  },
  prose_shape: {
    title: "Written as prose, not an answer",
    body: "The row reads as an article rather than something the agent can send as a reply.",
  },
};

function humanize(value: string) {
  const words = value.trim().replace(/[_-]+/g, " ").toLowerCase();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "Not recorded";
}

/**
 * What the entity said before, and what it will say after. Screen 1i's minus and plus lines.
 *
 * This was the one thing on 1i the page was throwing away rather than refusing: `draftDiffView`
 * holds both payload objects while it walks them, so the before and after text is derived from
 * stored snapshots and never authored. Everything else the artifact draws on this screen -- the
 * coach count, the "238 conversations used v19" window -- stays absent, because those are figures
 * no query here produces.
 *
 * The sign is the carrier, not the colour: a reader who cannot separate the two lines by hue still
 * reads a minus and a plus, and the panel's accent budget is already spent on the publish gate.
 *
 * A field holding an object or an array gets the same two lines, serialized, behind a disclosure
 * that is shut by default -- open on the reader's word, not pasted into the flow of a sentence.
 * This branch used to say the before and after "are in the export", which was false: no export
 * this page offers carries a payload, so a reader checking a changed `matchKeywords` was sent to a
 * document that does not hold it. `entityFieldChanges` had both sides in hand throughout.
 */
function EntityFieldDiff({ fields }: { fields: readonly BrainFieldChange[] }) {
  if (fields.length === 0) return null;
  return (
    <ul className="m-0 mt-[var(--s-2)] list-none space-y-[var(--s-2)] p-0">
      {fields.map((field) => (
        <li className="min-w-0" key={field.field}>
          <MonoMeta className="block">{field.field}</MonoMeta>
          {field.readable ? (
            <>
              <DiffLine sign="−" text={field.before} tone="before" />
              <DiffLine sign="+" text={field.after} tone="after" />
            </>
          ) : (
            <details className="group mt-[2px] min-w-0" data-slot="structured-field-diff">
              <summary className="t-muted flex cursor-pointer list-none items-center gap-[var(--s-2)] [&::-webkit-details-marker]:hidden">
                <span className="min-w-0">
                  This field holds a structured value. Show what it said before and after.
                </span>
                <ChevronDown
                  aria-hidden
                  className="size-[var(--s-4)] shrink-0 transition-transform duration-[var(--duration-quick)] ease-[var(--ease-out)] group-open:rotate-180 motion-reduce:transition-none"
                />
              </summary>
              <div className="mt-[var(--s-2)] flex flex-col gap-[var(--s-2)]">
                <StructuredDiffLine sign="−" text={field.before} tone="before" />
                <StructuredDiffLine sign="+" text={field.after} tone="after" />
              </div>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * What one side of a field says when it is not there, or there and empty. Both renderers read it,
 * so a structured field and a sentence field cannot end up describing the same absence in two
 * different ways.
 */
function diffSideText(text: string | null, tone: "before" | "after") {
  if (text === null) return tone === "before" ? "Not set before this draft." : "Removed by this draft.";
  if (text === "") return tone === "before" ? "Was empty." : "Cleared by this draft.";
  return text;
}

function DiffLine({ sign, text, tone }: { sign: string; text: string | null; tone: "before" | "after" }) {
  return (
    <div className="mt-[2px] flex min-w-0 items-baseline gap-[var(--s-2)]">
      <MonoMeta aria-hidden className="shrink-0">{sign}</MonoMeta>
      <Prose
        className={tone === "before" ? "t-muted line-through" : "text-[color:var(--ink)]"}
        measure="wide"
      >
        {/* An absent side is a fact of its own: the field was not there, which is not "". */}
        {diffSideText(text, tone)}
      </Prose>
    </div>
  );
}

/**
 * The same minus and plus lines for a value that is not a sentence.
 *
 * It carries `DiffLine`'s two tones -- muted for what is going, ink for what is arriving -- and
 * drops only the strikethrough, because a rule drawn through eight lines of JSON stops the reader
 * from reading the thing they opened the disclosure to read. The block scrolls in its own box so a
 * long array never widens the panel.
 */
function StructuredDiffLine({
  sign,
  text,
  tone,
}: {
  sign: string;
  text: string | null;
  tone: "before" | "after";
}) {
  return (
    <div className="flex min-w-0 items-start gap-[var(--s-2)]">
      <MonoMeta aria-hidden className="shrink-0">{sign}</MonoMeta>
      <pre
        className={`mono m-0 min-w-0 flex-1 overflow-x-auto rounded-[var(--r-input)] bg-[var(--quiet)] px-[var(--s-2)] py-[var(--s-1)] text-[12px] leading-[1.4] whitespace-pre ${tone === "before" ? "text-[color:var(--muted)]" : "text-[color:var(--ink)]"}`}
        data-slot={`structured-diff-${tone}`}
      >
        {diffSideText(text, tone)}
      </pre>
    </div>
  );
}

function flagCopy(code: string) {
  return FLAG_COPY[code] ?? {
    title: humanize(code),
    body: "This issue has no written explanation yet. Treat it as blocking until it does.",
  };
}

function displayTime(value: string | null) {
  if (!value) return "Time not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time not recorded" : workspaceDateTimeFormat.format(date);
}

/**
 * A heading for a section whose content is its own bordered object -- a `DataTable`, a grid of
 * panels. It is deliberately not `SurfaceHeader`: that one is a panel's own head, with the panel's
 * padding and its hairline foot, and using it over a free-standing table draws a lid on a box that
 * has none.
 */
function TabHeading({
  aside,
  description,
  overline,
  title,
}: {
  aside?: ReactNode;
  description?: string;
  overline?: string;
  title: string;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-[var(--s-4)]">
      <div className="min-w-0">
        {overline ? <Overline className="mb-[var(--s-1)] block">{overline}</Overline> : null}
        <h2 className="text-section text-[var(--ink)]">{title}</h2>
        {description ? (
          <Prose className="t-muted mt-[var(--s-1)]">{description}</Prose>
        ) : null}
      </div>
      {aside}
    </div>
  );
}

/** A panel's body. `panel` gives up its own padding to whatever it contains, so this puts it back. */
function PanelBody({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 px-[var(--s-4)] py-[var(--s-4)] ${className}`}>{children}</div>
  );
}

function EmptyTable({ title, body }: { title: string; body: string }) {
  return <DataState body={body} kind="empty" title={title} />;
}

function initialReview(rows: readonly BrainImportRowView[]): Record<string, ReviewDecision> {
  return Object.fromEntries(rows.map((row) => [row.id, {
    disposition: row.disposition,
    reviewedFlagIds: row.flags.filter((flag) => flag.resolved).map((flag) => flag.id),
    bindings: {} as Record<string, string>,
    bareTokens: {} as Record<string, string>,
  } satisfies ReviewDecision]));
}

function draftPayload(state: AdminBrainInitialState) {
  const entities = [
    ...state.mission.map((item) => ({ id: item.id, type: "mission", value: { label: item.label, text: item.text } })),
    ...state.qualification.map((item) => ({ id: item.id, type: "qualification_rule", value: { label: item.label, outcome: item.outcome, position: item.position } })),
    ...state.compliance.map((item) => ({ id: item.id, type: "compliance_rule", value: { slug: item.slug, phrase: item.phrase, severity: item.severity } })),
    ...state.knowledge.map((item) => ({ id: item.id, type: "knowledge_entry", value: { category: item.category, inboundMessage: item.inboundMessage, responseTemplate: item.responseTemplate, status: item.status } })),
  ];
  const compiledPlatform = JSON.stringify({
    mission: state.mission,
    qualification: state.qualification,
    compliance: state.compliance,
  });
  return {
    entities,
    compiledPlatform,
    platformTokens: Math.ceil(compiledPlatform.length / 4),
    knowledgeMode: state.draft?.payload.knowledgeMode === "retrieved" ? "retrieved" : "inline",
  };
}

function persistedEval(payload: unknown): BrainEvalView {
  const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const receipt = value.receipt && typeof value.receipt === "object"
    ? value.receipt as Record<string, unknown>
    : {};
  const run = receipt.run && typeof receipt.run === "object" ? receipt.run as Record<string, unknown> : {};
  const results = Array.isArray(receipt.results) ? receipt.results : [];
  const safetySuites = new Set(["compliance_guardrails", "pricing_discipline", "jailbreak_injection", "output_integrity"]);
  const blockers = results.flatMap((result) => {
    if (!result || typeof result !== "object") return [];
    const item = result as Record<string, unknown>;
    if (!safetySuites.has(String(item.suite)) || item.passed === true) return [];
    const trace = item.trace && typeof item.trace === "object" ? item.trace as Record<string, unknown> : {};
    const ruleIds = Array.isArray(trace.ruleIds) ? trace.ruleIds : [];
    return [{
      suite: String(item.suite) as "compliance_guardrails",
      caseKey: String(item.caseKey ?? "unknown-case"),
      ruleId: String(ruleIds[0] ?? "CLAIM-001") as "CLAIM-001",
      reason: "failed" as const,
    }];
  });
  const runId = typeof run.id === "string" ? run.id : null;
  if (!runId) return { state: "not_run_for_this_version", runId: null, blockers: [], warnings: [] };
  return blockers.length
    ? { state: "blocked", runId, blockers, warnings: [] }
    : { state: "ready", runId, blockers: [], warnings: [] };
}

export function AdminBrain({ initialState }: AdminBrainProps) {
  const router = useRouter();
  const [state, setState] = useState(initialState);
  const [tab, setTab] = useState<BrainTab>("overview");
  const [review, setReview] = useState(() => initialReview(initialState.importRows));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishReason, setPublishReason] = useState("");
  const [publishReasonTouched, setPublishReasonTouched] = useState(false);
  const [rollbackReason, setRollbackReason] = useState("");
  const [rollbackReasonTouched, setRollbackReasonTouched] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(initialState.snapshots[1]?.version ?? null);
  const [publishResponse, setPublishResponse] = useState<BrainPublishResponse | null>(null);
  const [rollbackResponse, setRollbackResponse] = useState<unknown>(null);
  const [acceptedRows, setAcceptedRows] = useState<string[]>([]);
  const [testMessage, setTestMessage] = useState("How does the synthetic demo program work?");
  const [objectionFilter, setObjectionFilter] = useState<ObjectionCategoryFilter>("all");
  const [knowledgeSheet, setKnowledgeSheet] = useState<KnowledgeRow | null>(null);
  const [objectionSheet, setObjectionSheet] = useState<BrainObjectionView | null>(null);

  const gate = evalGateView(state.eval);
  const publishReceipt = publishReceiptView(publishResponse);
  const rollbackReceipt = rollbackReceiptView(rollbackResponse);
  const diff = useMemo(
    () => draftDiffView(state.currentSnapshotPayload, state.draft?.payload ?? null),
    [state.currentSnapshotPayload, state.draft],
  );
  const objections = useMemo(
    () => objectionListView(state.objections, objectionFilter),
    [state.objections, objectionFilter],
  );
  const currentVersion = state.snapshots[0]?.version ?? 0;
  const pendingReviewCount = state.importRows.filter((row) => row.decision === "pending").length;
  const hardGateCount = state.objections.filter((row) => row.hardGate).length;
  const publishedKnowledgeCount = state.knowledge.filter((row) => row.status === "published").length;
  const importSummary = !state.batch
    ? { label: "No import run", tone: "neutral" as StateTone }
    : state.batch.completedAt !== null
        && state.batch.status !== "failed"
        && state.batch.receivedCount === state.batch.normalizedCount
        && state.batch.normalizedCount === state.batch.persistedItemCount
      ? { label: `Imported ${state.batch.receivedCount} rows, ${state.batch.flaggedCount} flagged`, tone: "good" as StateTone }
      : { label: `Import incomplete, ${state.batch.persistedItemCount} of ${state.batch.receivedCount} rows saved`, tone: "warning" as StateTone };
  const publishReasonControl = reasonControlView(publishReason);
  // The publish gate is a chain of preconditions. The reader needs the FIRST one that is not met,
  // in the order they would work through them, rendered beside the button rather than in a card
  // on the other side of the page -- a disabled control with no adjacent reason is a dead end.
  const publishBlocker: string | null = publishReceipt.logged
    ? "Already published from this draft."
    : !state.draft
      ? "Create a saved draft first."
      : !state.eval.runId || gate.label === "Not run for this version"
        ? "Run the evaluation for this draft first."
        : !gate.canPublish
          ? `${state.eval.blockers.length} safety ${state.eval.blockers.length === 1 ? "issue blocks" : "issues block"} publishing.`
          : !publishReasonControl.enabled
            ? "Add a publish reason below."
            : null;
  const publishDisabled = publishBlocker !== null || busy !== null;

  const qualificationReady = state.qualificationApproved && state.qualificationSource === "platform";
  const citationGrounded = Boolean(
    state.citation?.verifiedInPrompt
    && state.citation.declaredEntryId
    && state.citation.candidateEntryIds.includes(state.citation.declaredEntryId),
  );
  /*
   * The claim was already page-wide -- a mock import batch means everything the page is reading
   * came from one -- so this moves from a faint sentence under the subtitle to the chip above the
   * title without changing what it asserts. `mock` is a test batch, not a seeded workspace, so it
   * keeps the word `test`.
   */
  const provenanceKind = state.batch?.source === "mock" ? ("test" as const) : undefined;

  const qualificationColumns = useMemo<ColumnDef<AdminBrainInitialState["qualification"][number]>[]>(() => [
    { accessorKey: "position", header: "Position", meta: { label: "Position" } },
    { accessorKey: "label", header: "Rule", meta: { cellKind: "identity", label: "Rule" } },
    {
      accessorKey: "outcome",
      cell: ({ row }) => {
        const copy = QUALIFICATION_OUTCOME_COPY[row.original.outcome as keyof typeof QUALIFICATION_OUTCOME_COPY];
        // Bare, not a pill: a column of lozenges out-weighs the rows it is describing, and this
        // is the only status column left on the page.
        return (
          <Status
            label={copy?.label ?? humanize(row.original.outcome)}
            tone={STATE_TONE_TO_TONE[copy?.tone ?? "neutral"]}
            treatment="bare"
          />
        );
      },
      header: "Outcome",
      meta: { cellKind: "state", label: "Outcome" },
    },
  ], []);

  // Severity is the band these rows are grouped into, so it is not also a column: the header
  // above a run of rows already says "Blocking", and repeating it on every row stops carrying
  // information the moment the second row appears.
  const complianceColumns = useMemo<ColumnDef<AdminBrainInitialState["compliance"][number]>[]>(() => [
    { accessorFn: (row) => humanize(row.slug), header: "Rule", id: "rule", meta: { cellKind: "identity", label: "Rule" } },
    {
      accessorFn: (row) => row.phrase,
      cell: ({ row }) => row.original.phrase ?? absentValue("mechanical check, no phrase"),
      header: "Phrase",
      id: "phrase",
      meta: { label: "Phrase" },
    },
  ], []);

  // Published and draft are the two bands, so status is a group header rather than a repeated
  // pill. That is the whole point of the grouping: a reader sees at a glance how much of the
  // knowledge base is actually live and how much is still waiting on a publish.
  const knowledgeColumns = useMemo<ColumnDef<KnowledgeRow>[]>(() => [
    {
      accessorKey: "inboundMessage",
      cell: ({ row }) => row.original.inboundMessage || absentValue("no inbound message saved"),
      header: "Inbound message",
      meta: { cellKind: "identity", label: "Inbound message" },
    },
    { accessorFn: (row) => humanize(row.category), header: "Category", id: "category", meta: { label: "Category" } },
    {
      accessorFn: (row) => row.responseTemplate,
      cell: ({ row }) => row.original.responseTemplate || absentValue("no response template saved"),
      header: "Response template",
      id: "responseTemplate",
      meta: { defaultHidden: true, label: "Response template" },
    },
  ], []);

  // The hard gate is the band, and it sorts first, so the rows whose answers are bound to
  // platform pricing, guarantee, and outcome rules are the ones a reader lands on. The gate is
  // therefore not also a per-row pill.
  const objectionColumns = useMemo<ColumnDef<BrainObjectionView>[]>(() => [
    { accessorKey: "label", header: "Objection", meta: { cellKind: "identity", label: "Objection" } },
    { accessorFn: (row) => humanize(row.category), header: "Category", id: "category", meta: { label: "Category" } },
    { accessorFn: (row) => humanize(row.status), header: "Status", id: "status", meta: { label: "Status" } },
    {
      accessorFn: (row) => row.matchKeywords.join(", "),
      cell: ({ row }) => row.original.matchKeywords.join(", ") || absentValue("no keywords, pattern only"),
      header: "Keywords",
      id: "keywords",
      meta: { defaultHidden: true, label: "Keywords" },
    },
  ], []);

  function updateReview(rowId: string, update: Partial<ReviewDecision>) {
    setReview((current) => ({
      ...current,
      [rowId]: { ...current[rowId], ...update },
    }));
  }

  function toggleReviewed(rowId: string, flagId: string) {
    const current = review[rowId]?.reviewedFlagIds ?? [];
    updateReview(rowId, {
      reviewedFlagIds: current.includes(flagId)
        ? current.filter((id) => id !== flagId)
        : [...current, flagId],
    });
  }

  function resolvedFlagIds(row: BrainImportRowView) {
    const decision = review[row.id];
    return row.flags.filter((flag) => {
      if (flag.resolved || decision?.reviewedFlagIds.includes(flag.id)) return true;
      if (flag.code === "unbound_figure") return Boolean(decision?.bindings[flag.id]);
      if (flag.code === "bare_x") return Boolean(decision?.bareTokens[flag.id]);
      return false;
    }).map((flag) => flag.id);
  }

  async function runAction(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request did not complete.");
    } finally {
      setBusy(null);
    }
  }

  async function accept(row: BrainImportRowView) {
    const decision = review[row.id];
    if (!decision?.disposition) return;
    const numberBindings = row.flags.filter((flag) => flag.code === "unbound_figure").flatMap((flag) => {
      const binding = decision.bindings[flag.id];
      if (!binding || !flag.figureKind || flag.figureValue === undefined) return [];
      return [{ binding, field: "responseTemplate", kind: flag.figureKind, offset: flag.offset, value: flag.figureValue }];
    });
    const bareXResolutions = row.flags.filter((flag) => flag.code === "bare_x").flatMap((flag) => {
      const token = decision.bareTokens[flag.id];
      return token ? [{ offset: flag.offset, token }] : [];
    });
    await runAction(`accept:${row.id}`, async () => {
      await api.acceptImportItem({
        batchId: row.batchId,
        itemId: row.id,
        sourceRef: row.sourceRef,
        disposition: decision.disposition!,
        resolvedFlagIds: resolvedFlagIds(row),
        numberBindings,
        bareXResolutions,
      });
      setAcceptedRows((current) => [...current, row.id]);
      router.refresh();
    });
  }

  async function createDraft() {
    await runAction("draft", async () => {
      const payload = await api.createDraft(draftPayload(state));
      const value = payload as { revision?: { id?: string; contentHash?: string; payload?: Readonly<Record<string, unknown>> } };
      if (!value.revision?.id || !value.revision.contentHash || !value.revision.payload) {
        throw new Error("BRAIN_DRAFT_RECEIPT_INCOMPLETE");
      }
      setState((current) => ({
        ...current,
        draft: { ...value.revision!, id: value.revision!.id!, contentHash: value.revision!.contentHash!, payload: value.revision!.payload!, createdAt: new Date().toISOString() },
        eval: { state: "not_run_for_this_version", runId: null, blockers: [], warnings: [] },
      }));
      setPublishResponse(null);
    });
  }

  async function runEval() {
    if (!state.draft) return;
    await runAction("eval", async () => {
      const payload = await api.runEval({ draftId: state.draft!.id, contentHash: state.draft!.contentHash });
      setState((current) => ({ ...current, eval: persistedEval(payload) }));
    });
  }

  async function publish() {
    if (!state.draft || !state.eval.runId || !reasonControlView(publishReason).enabled) return;
    await runAction("publish", async () => {
      const response = await api.publish({
        draftId: state.draft!.id,
        evalRunId: state.eval.runId!,
        expectedCurrentVersion: currentVersion,
        reason: publishReason,
      }) as BrainPublishResponse;
      setPublishResponse(response);
      router.refresh();
    });
  }

  async function rollback() {
    if (!selectedVersion || !reasonControlView(rollbackReason).enabled) return;
    await runAction("rollback", async () => {
      const response = await api.rollback({
        expectedCurrentVersion: currentVersion,
        selectedVersion,
        reason: rollbackReason,
      });
      setRollbackResponse(response);
      router.refresh();
    });
  }

  /*
   * Every export on this page is always on screen, and the audited reason lives inside each menu
   * rather than in a page-level field beside them. This page used to hold one shared reason box
   * and render nothing at all until somebody typed in it, so a reader who had not noticed the box
   * saw six tables with no way out of them -- a live break of CLAUDE.md's "every table exports
   * CSV/JSON", because the affordance was missing rather than merely disabled, and nothing on
   * screen said a reason was what was missing. `ExportMenu` already collects the reason, labels it
   * "Required for this export", and holds both download items disabled until it is filled, so the
   * server's requirement (`handler.ts` rejects a platform export with no reason) is enforced in
   * the same place it is explained. `admin-audit-log.tsx` and `admin-testing.tsx` do the same.
   *
   * Each control is named for what it exports, because these sit in pairs and two buttons both
   * reading "Export" is the same as neither of them being named.
   */

  // Four tiles, and every one of them says "not yet" in words rather than printing a zero that
  // reads as a measurement. Nothing here is a percentage or a predicted date: publishing is a
  // discrete event and the page refuses to estimate one.
  /*
   * These stay on `StatStrip` rather than moving to the kit's `FigureStrip`, deliberately.
   * `figure-strip.tsx` documents the boundary: it has one absent case covering both "could not be
   * read" and "read, and the answer is none", and three of these four tiles are on the wrong side
   * of it. "Never published", "No entry is published yet" and "No answer is gated yet" are
   * measured zeroes -- the page read the snapshots, the knowledge and the objections and found
   * none in that state -- and each one is a different sentence from "not readable right now".
   * `admin-brain.test.tsx` pins all three by name.
   */
  const overviewTiles: StatStripItem[] = [
    {
      label: "Published version",
      availability: currentVersion
        ? { kind: "value", value: currentVersion, format: "count" }
        : { kind: "no-events", note: "Never published" },
      note: currentVersion ? `Published ${displayTime(state.snapshots[0]?.publishedAt ?? null)}` : undefined,
    },
    {
      label: "Knowledge live on agents",
      availability: publishedKnowledgeCount
        ? { kind: "value", value: publishedKnowledgeCount, format: "count" }
        : { kind: "no-events", note: "No entry is published yet" },
      note: state.knowledge.length
        ? `${state.knowledge.length - publishedKnowledgeCount} still draft`
        : undefined,
    },
    {
      label: "Hard-gated objections",
      availability: hardGateCount
        ? { kind: "value", value: hardGateCount, format: "count" }
        : { kind: "no-events", note: "No answer is gated yet" },
      // A tile shows one note line, and an explicit `note` replaces the availability's own. So
      // the caption is passed only where there is a figure to caption; where there is none, the
      // "not yet" wording is the more useful of the two and keeps the slot.
      ...(hardGateCount ? { note: "Figures bound to platform rules" } : {}),
    },
    {
      label: "Rows awaiting review",
      availability: pendingReviewCount
        ? { kind: "value", value: pendingReviewCount, format: "count" }
        : { kind: "no-events", note: "Nothing waiting" },
      ...(pendingReviewCount ? { note: "An imported row joins the draft only once accepted" } : {}),
    },
  ];

  const nothingChangedCopy = pendingReviewCount
    ? `Nothing yet. The ${pendingReviewCount} imported ${pendingReviewCount === 1 ? "row is" : "rows are"} still in review and ${pendingReviewCount === 1 ? "joins" : "join"} the draft once accepted.`
    : state.draft
      ? "Nothing. This draft matches the published version."
      : "Nothing. There is no saved draft to compare.";
  const nothingChanged = diff.status === "nothing_changed" || diff.changes.length === 0;

  /*
   * The blast radius, which is the reason this page is dangerous and therefore the reason it is
   * the first thing under the tiles.
   *
   * Publishing is not an edit to a record -- it replaces the one configuration every coach's
   * agent reads, so the two questions worth answering before the button is pressed are what moves
   * and what reads it. They are the panel's two columns. The left one now names the entity in
   * words and says what part of the agent consumes it, because `Changed knowledge_entry` was a
   * column name rather than a consequence; the right one renders `diff.impactLines`, the authored
   * sentences the diff engine already produced and which this page was throwing away in favour of
   * a title-cased key.
   *
   * No coach count and no next version number: neither is derivable here, and `docs/DESIGN.md`
   * forbids rendering a figure the code cannot produce.
   */
  const blastRadiusPanel = (
    <Surface aria-labelledby="blast-radius-title" className="min-w-0" variant="panel">
      <SurfaceHeader
        overline="Blast radius"
        subtitle="Every coach's agent reads this one shared configuration, so a publish reaches all of them at once, from their next reply onward."
        title={<span id="blast-radius-title">What a publish would change</span>}
        trailing={
          <Status
            label={state.draft ? "Draft saved" : "No draft"}
            tone={state.draft ? "draft" : "neutral"}
          />
        }
      />

      <PanelBody className="flex flex-col gap-[var(--s-4)]">
        {/* Version and import provenance are facts SetterFi already holds, so they sit in a well
            in mono rather than becoming two more badges floating over the page. */}
        <Surface
          className="flex flex-wrap items-start gap-x-[var(--s-6)] gap-y-[var(--s-3)]"
          variant="well"
        >
          <div className="min-w-0">
            <Overline className="block">Live right now</Overline>
            {/* A version is a number; the absence of one is not, so it reads as a state rather
                than as a figure saying nothing. The wording is deliberately not the tile's
                "Never published" above -- two different sentences about the same fact would read
                as two facts. */}
            {currentVersion ? (
              <Figure className="mt-[var(--s-1)] block" size="md">
                v{currentVersion}
              </Figure>
            ) : (
              <Status
                className="mt-[var(--s-1)] flex"
                label="Nothing is live yet"
                tone="warning"
                treatment="bare"
              />
            )}
            <MonoMeta className="mt-[2px] block">
              {currentVersion
                ? displayTime(state.snapshots[0]?.publishedAt ?? null)
                : "no version has reached an agent"}
            </MonoMeta>
          </div>
          <div className="min-w-0">
            <Overline className="block">Entities in this draft</Overline>
            <Figure className="mt-[var(--s-1)] block" size="md">
              {diff.changes.length}
            </Figure>
            <MonoMeta className="mt-[2px] block">
              {diff.changes.length === 1 ? "entity differs from live" : "entities differ from live"}
            </MonoMeta>
          </div>
          <div className="min-w-0">
            <Overline className="block">Last import</Overline>
            <Status
              className="mt-[var(--s-1)] flex"
              label={importSummary.label}
              tone={STATE_TONE_TO_TONE[importSummary.tone]}
              treatment="bare"
            />
          </div>
        </Surface>

        <div className="grid min-w-0 gap-[var(--s-4)] @min-[720px]:grid-cols-2">
          <section className="min-w-0">
            <Overline as="h3" className="block">What changes</Overline>
            {nothingChanged ? (
              <Prose className="t-muted mt-[var(--s-2)]">{nothingChangedCopy}</Prose>
            ) : (
              <ul className="m-0 mt-[var(--s-2)] list-none space-y-[var(--s-3)] p-0">
                {diff.changes.map((change) => {
                  const entity = ENTITY_REACH[change.entityType];
                  return (
                    <li className="min-w-0" key={`${change.entityType}:${change.entityId}`}>
                      <div className="flex flex-wrap items-baseline gap-x-[var(--s-2)]">
                        <span className="text-[length:var(--t-row)] font-[var(--t-row-w)] text-[color:var(--ink)]">
                          {entity?.label ?? humanize(change.entityType)}
                        </span>
                        <MonoMeta>{change.kind}</MonoMeta>
                      </div>
                      {/* An explanation on every row: what reads this entity once it ships. */}
                      <Prose className="t-muted mt-[2px]">
                        {entity?.reach ?? "Nothing is written yet about what this entity reaches."}
                      </Prose>
                      <EntityFieldDiff fields={change.fields} />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="min-w-0">
            <Overline as="h3" className="block">What it reaches</Overline>
            {diff.impactLines.length ? (
              <ul className="m-0 mt-[var(--s-2)] list-none space-y-[var(--s-3)] p-0">
                {diff.impactKeys.map((key, index) => (
                  <li className="min-w-0" key={key}>
                    <MonoMeta className="block">{key}</MonoMeta>
                    <Prose className="t-muted mt-[2px]">{diff.impactLines[index]}</Prose>
                  </li>
                ))}
              </ul>
            ) : (
              <Prose className="t-muted mt-[var(--s-2)]">No downstream impact was calculated.</Prose>
            )}
          </section>
        </div>

        {diff.changes.length ? (
          <TechnicalDetail
            items={diff.changes.map((change, index) => ({
              label: `Changed entity ${index + 1}`,
              value: `${change.entityType}:${change.entityId}`,
            }))}
          />
        ) : null}
      </PanelBody>
    </Surface>
  );

  /**
   * What the Brain knows, by part.
   *
   * The canvas draws this as five sections out of `brain_documents`, with a Documents count, a
   * Last edited and an Edited by. Two of those three cannot be built honestly:
   *
   *   - `brain_documents` and `brain_chunks` are labelled in the schema itself as
   *     reserved and unused by the Phase 2 structured-row runtime
   *     (`20260818000001_phase2_brain.sql:130-133`). Counting them would print a Brain of zero
   *     documents while the agents answer from a full one, which is a fabricated emptiness and
   *     exactly as wrong as a fabricated figure. The rows below count the tables the runtime
   *     actually reads, which this page already loads.
   *   - **Edited by has no column.** No Brain table carries an actor; attribution lives in
   *     `audit_log`, and the note under the panel sends the reader there rather than leaving a
   *     column that would have to be filled with something.
   *
   * Each row states what the agent does with that part, because a count with no consequence is a
   * number rather than an answer to "what does the Brain know".
   */
  const corpusRows = [
    {
      title: "Answers to questions leads ask",
      description:
        "Knowledge entries, retrieved against the lead's own message. A published entry is what a grounded reply is allowed to cite; a draft one is written and not running.",
      total: state.knowledge.length,
      live: publishedKnowledgeCount,
    },
    {
      title: "Objections and how they are handled",
      description:
        "One response per objection. A hard-gated objection is answered with the published wording word for word, so the model cannot rephrase a figure or a promise.",
      total: state.objections.length,
      live: state.objections.filter((row) => row.status === "published").length,
    },
    {
      title: "Qualification rules",
      description:
        "What makes a lead worth booking, in order. The agent works down these before it offers a time.",
      total: state.qualification.length,
      live: state.qualification.length,
    },
    {
      title: "Compliance phrases",
      description:
        "Wording the agent is not allowed to produce, checked against every draft before it can leave.",
      total: state.compliance.length,
      live: state.compliance.length,
    },
    {
      title: "Mission and voice",
      description:
        "Who the agent is, what it is for, and the tone it holds. Every reply is written against these before anything else is retrieved.",
      total: state.mission.length,
      live: state.mission.length,
    },
  ];

  const brainCorpusPanel = (
    <Surface aria-labelledby="brain-corpus-title" className="min-w-0" variant="panel">
      <SurfaceHeader
        overline="Corpus"
        subtitle="What is in the Brain, and what each part does when a lead sends a message."
        title={<span id="brain-corpus-title">What the Brain knows</span>}
      />
      <PanelBody className="flex flex-col gap-[var(--s-4)]">
        <SettingGroup>
          {corpusRows.map((row) => (
            <SettingRow
              align="start"
              control={
                row.total === 0
                  ? <Status label="Nothing recorded" tone="neutral" treatment="bare" />
                  : (
                    <MonoMeta>
                      {row.live === row.total
                        ? `${workspaceCountFormat.format(row.total)} live`
                        : `${workspaceCountFormat.format(row.live)} live of ${workspaceCountFormat.format(row.total)}`}
                    </MonoMeta>
                  )
              }
              description={row.description}
              key={row.title}
              title={row.title}
            />
          ))}
        </SettingGroup>
        <Prose className="t-faint" measure="caption">
          No Brain table records who changed a row, so this panel does not name one. Attribution for
          every edit is in the audit log, where it is written when the change is made.
        </Prose>
      </PanelBody>
    </Surface>
  );

  const overviewTab = (
    <div className="relative flex min-w-0 flex-col gap-[var(--s-4)]">
      {/*
        * The published version is the one panel that fills. Everything else on this tab -- what is
        * live, what is gated, what is waiting -- is read against that number, so it is the figure
        * the tab is opened for, and a console screen spends its fill exactly once.
        */}
      <ConsoleStatDeck
        ariaLabel="The Brain at a glance"
        heroLabel="Published version"
        items={overviewTiles}
      />

      {blastRadiusPanel}

      {brainCorpusPanel}

      <div className="grid min-w-0 gap-[var(--s-4)] xl:grid-cols-2">
        <Surface aria-labelledby="evaluation-title" className="min-w-0" variant="panel">
          <SurfaceHeader
            overline="Gate"
            subtitle="The evaluation must match this exact saved draft before publishing."
            title={<span id="evaluation-title">Evaluation for this draft</span>}
            trailing={
              <Status
                label={gate.label}
                tone={gate.canPublish ? "good" : state.eval.state === "blocked" ? "failure" : "warning"}
              />
            }
          />
          <PanelBody className="flex flex-col gap-[var(--s-4)]">
            <Prose className="t-muted">
              {state.eval.state === "not_run_for_this_version"
                ? "No saved run matches this exact draft."
                : state.eval.state === "blocked"
                  ? `${state.eval.blockers.length} safety ${state.eval.blockers.length === 1 ? "issue blocks" : "issues block"} publishing.`
                  : state.eval.warnings.length
                    ? `${state.eval.warnings.length} warning ${state.eval.warnings.length === 1 ? "needs" : "need"} review before publishing.`
                    : "All required suites passed for this draft."}
            </Prose>

            {/*
              The gate's own detail lines -- suite, case, rule, reason -- were computed by
              `evalGateView` and never rendered anywhere, so a blocked publish said how many
              issues there were and never which. They are identifiers, so they are mono.
            */}
            {gate.details.length ? (
              <Surface className="flex flex-col gap-[var(--s-2)]" variant="well">
                <Overline className="block">
                  {state.eval.state === "blocked" ? "Blocking cases" : "Warnings"}
                </Overline>
                {gate.details.map((detail) => (
                  <MonoMeta
                    className="block"
                    key={detail}
                    tone={state.eval.state === "blocked" ? "failure" : "neutral"}
                  >
                    {detail}
                  </MonoMeta>
                ))}
              </Surface>
            ) : null}

            <div className="flex flex-wrap gap-[var(--s-2)]">
              <Button disabled={busy !== null} onClick={() => void createDraft()} type="button" variant="outline">
                {busy === "draft" ? "Creating draft" : "Create saved draft"}
              </Button>
              {/*
                Outline, not filled. The One Fill Rule gives the page's single accent fill to
                Publish in the header, and this button shipped as the shadcn default variant --
                a second solid accent -- under a `data-variant="recommended"` attribute that
                nothing in the codebase styles.
              */}
              <Button disabled={!state.draft || busy !== null} onClick={() => void runEval()} type="button" variant="outline">
                {busy === "eval" ? "Running suites" : "Run checker suites"}
              </Button>
            </div>

            {state.eval.runId ? (
              <TechnicalDetail items={[{ label: "Evaluation run ID", value: state.eval.runId }]} />
            ) : null}
          </PanelBody>
        </Surface>

        <Surface aria-labelledby="publish-title" className="min-w-0" variant="panel">
          <SurfaceHeader
            overline="Reach"
            subtitle="Recorded against the published version and readable in the audit log afterwards."
            title={<span id="publish-title">Publish</span>}
            trailing={
              <Status
                label={publishReceipt.label}
                tone={publishReceipt.published ? "good" : "neutral"}
              />
            }
          />
          <PanelBody className="flex flex-col gap-[var(--s-4)]">
            {/* The button lives in the header, so its reason is repeated where publishing is
                actually being read about. A disabled control whose reason is one screen away is
                a dead end wherever the reader happens to be standing. */}
            {publishBlocker ? (
              <Status label={publishBlocker} tone="warning" />
            ) : (
              <Prose className="t-muted">
                Ready. Publish from the header, and every coach&rsquo;s agent picks this version up
                on its next reply.
              </Prose>
            )}
            <Field
              error={publishReasonTouched ? publishReasonControl.error ?? undefined : undefined}
              hint="Recorded against the published version."
              label="Publish reason"
            >
              <Textarea
                onBlur={() => setPublishReasonTouched(true)}
                onChange={(event) => { setPublishReasonTouched(true); setPublishReason(event.target.value); }}
                value={publishReason}
              />
            </Field>
          </PanelBody>
        </Surface>
      </div>
    </div>
  );

  const reviewTab = (
    <div className="relative flex min-w-0 flex-col gap-[var(--s-4)]">
      <TabHeading
        aside={
          <Button
            disabled={busy !== null}
            onClick={() => void runAction("import", async () => { await api.importConfigured(); router.refresh(); })}
            type="button"
            variant="outline"
          >
            {busy === "import" ? "Importing" : "Import now"}
          </Button>
        }
        description="A row can be accepted after its disposition and every blocking issue are resolved. An imported row reaches the draft only once it is accepted here."
        overline="Queue"
        title="Knowledge import review"
      />
      <div className="flex flex-wrap items-end gap-[var(--s-3)]">
        <Status
          label={importSummary.label}
          tone={STATE_TONE_TO_TONE[importSummary.tone]}
        />
        <div className="flex gap-[var(--s-2)]">
          <ExportMenu filename="setterfi-brain-import-batches" label="Export import batches" mode="server" resource="brain-import-batches" query={{ reason: "", order: "created_desc", columns: ["id", "source", "status", "receivedCount", "normalizedCount", "flaggedCount", "createdAt", "completedAt"] }} />
          <ExportMenu filename="setterfi-brain-import-items" label="Export import rows" mode="server" resource="brain-import-items" query={{ reason: "", order: "created_desc", columns: ["id", "batchId", "sourceRef", "operation", "decision", "disposition", "flagCount", "decidedAt"] }} />
        </div>
      </div>

      {state.importRows.length ? (
        <div className="grid gap-[var(--s-4)] xl:grid-cols-2">
          {state.importRows.map((row) => {
            const decision = review[row.id] ?? { disposition: null, reviewedFlagIds: [], bindings: {}, bareTokens: {} };
            const item = importReviewView(row, { disposition: decision.disposition, resolvedFlagIds: resolvedFlagIds(row) });
            const accepted = row.decision === "accepted" || acceptedRows.includes(row.id);
            return (
              <Surface className="min-w-0" key={row.id} open={!accepted && item.canAccept} variant="panel">
                <SurfaceHeader
                  overline={`${humanize(row.operation)} · ${row.category ? humanize(row.category) : "Category missing"}`}
                  title={row.inboundMessage || "Source shape needs review"}
                  trailing={
                    <Status
                      label={accepted ? "Accepted" : item.canAccept ? "Ready for acceptance" : "Review blocked"}
                      tone={accepted ? "good" : item.canAccept ? "neutral" : "warning"}
                    />
                  }
                />
                <PanelBody className="flex flex-col gap-[var(--s-4)]">
                  <Prose className="t-muted">{row.responseTemplate || "No response template was saved."}</Prose>

                  <label className="flex flex-col gap-[var(--s-1)]">
                    <span className="t-row">Disposition</span>
                    <Select
                      disabled={accepted}
                      onValueChange={(value) => updateReview(row.id, { disposition: (value || null) as ImportDisposition | null })}
                      value={decision.disposition ?? ""}
                    >
                      <SelectTrigger aria-label="Disposition" className="w-full">
                        <SelectValue placeholder="Choose disposition" />
                      </SelectTrigger>
                      <SelectContent align="start">
                        <SelectItem value="shared">Shared</SelectItem>
                        <SelectItem value="tenant_specific">Client-specific</SelectItem>
                        <SelectItem value="needs_rewrite">Needs rewrite</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>

                  {row.flags.map((flag) => {
                    const copy = flagCopy(flag.code);
                    const resolved = flag.resolved
                      || decision.reviewedFlagIds.includes(flag.id)
                      || (flag.code === "unbound_figure" && Boolean(decision.bindings[flag.id]))
                      || (flag.code === "bare_x" && Boolean(decision.bareTokens[flag.id]));
                    return (
                      <Surface className="flex flex-col gap-[var(--s-3)]" key={flag.id} variant="well">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-baseline justify-between gap-[var(--s-2)]">
                            <span className="text-[length:var(--t-row)] font-[var(--t-row-w)] text-[color:var(--ink)]">
                              {copy.title}
                            </span>
                            {/* The state of one issue, in words. Colour never carries it alone. */}
                            <Status
                              label={resolved ? "Resolved" : "Blocking"}
                              tone={resolved ? "good" : "warning"}
                              treatment="bare"
                            />
                          </div>
                          {/* The row kit's rule, applied by hand because this row carries a
                              control the kit's `SettingRow` cannot hold at this width. */}
                          <Prose className="t-muted mt-[2px]">{copy.body}</Prose>
                        </div>

                        {flag.code === "unbound_figure" ? (
                          <label className="flex flex-col gap-[var(--s-1)]">
                            <span className="t-row">Figure binding</span>
                            <Select
                              disabled={accepted}
                              onValueChange={(value) => updateReview(row.id, { bindings: { ...decision.bindings, [flag.id]: value ?? "" } })}
                              value={decision.bindings[flag.id] ?? ""}
                            >
                              <SelectTrigger aria-label="Figure binding" className="w-full">
                                <SelectValue placeholder="Choose binding" />
                              </SelectTrigger>
                              <SelectContent align="start">
                                {FIGURE_BINDING_FIELDS.map((field) => <SelectItem key={field} value={field}>{humanize(field)}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </label>
                        ) : flag.code === "bare_x" ? (
                          <Field hint="Use the approved destination token from Technical detail." label="Link token">
                            <Input
                              disabled={accepted}
                              onChange={(event) => updateReview(row.id, { bareTokens: { ...decision.bareTokens, [flag.id]: event.target.value } })}
                              value={decision.bareTokens[flag.id] ?? ""}
                            />
                          </Field>
                        ) : (
                          <label className="flex items-start gap-[var(--s-2)]">
                            <Checkbox
                              checked={flag.resolved || decision.reviewedFlagIds.includes(flag.id)}
                              disabled={accepted || flag.code === "source_shape" || flag.code === "unknown_placeholder"}
                              onCheckedChange={() => toggleReviewed(row.id, flag.id)}
                            />
                            <span className="t-muted">
                              {flag.code === "source_shape" || flag.code === "unknown_placeholder" ? "Source rewrite required" : "Admin reviewed"}
                            </span>
                          </label>
                        )}

                        <TechnicalDetail items={[{ label: "Issue code", value: flag.code }, { label: "Field", value: flag.field }, { label: "Offset", value: String(flag.offset), mono: false }]} />
                      </Surface>
                    );
                  })}

                  {item.blockingCodes.length ? (
                    <Prose className="t-muted" role="alert">
                      Blocking issues: {item.blockingCodes.map((code) => flagCopy(code).title).join(", ")}
                    </Prose>
                  ) : null}

                  <LoggedButton
                    actionKey="brain.import.accepted"
                    className="self-start"
                    disabled={accepted || !item.canAccept || busy !== null}
                    onClick={() => void accept(row)}
                  >
                    {accepted ? "Accepted" : busy === `accept:${row.id}` ? "Accepting row" : "Accept reviewed row"}
                  </LoggedButton>
                </PanelBody>
              </Surface>
            );
          })}
        </div>
      ) : (
        <DataState body="Run an import to populate the review queue." kind="empty" title="No import rows" />
      )}
    </div>
  );

  const defaultsTab = (
    <div className="relative flex min-w-0 flex-col gap-[var(--s-6)]">
      <Surface aria-labelledby="mission-title" className="min-w-0" variant="panel">
        <SurfaceHeader
          overline="Draft"
          subtitle="These platform fields compile into the shared mission. Edits take effect when you create a saved draft on the Overview tab."
          title={<span id="mission-title">Mission draft</span>}
          trailing={<Status label="Draft, not published" tone="draft" />}
        />
        <ul className="m-0 list-none p-0">
          {state.mission.map((item, index) => {
            const copy = missionFieldCopy(item.label);
            return (
              <li
                className="@container border-b border-[var(--line-soft)] px-[var(--s-4)] py-[var(--s-4)] last:border-b-0"
                key={item.id}
              >
                <div className="grid min-w-0 gap-[var(--s-3)] @min-[640px]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                  <div className="min-w-0">
                    <h3 className="t-row">{copy.title}</h3>
                    {copy.help ? <Prose className="t-muted mt-[var(--s-1)]">{copy.help}</Prose> : null}
                  </div>
                  <Field label={`${copy.title} text`}>
                    <Textarea
                      onChange={(event) => setState((current) => ({ ...current, mission: current.mission.map((row, rowIndex) => rowIndex === index ? { ...row, text: event.target.value } : row) }))}
                      value={item.text}
                    />
                  </Field>
                </div>
              </li>
            );
          })}
        </ul>
      </Surface>

      <section className="flex min-w-0 flex-col gap-[var(--s-3)]">
        <TabHeading
          aside={
            <Status
              label={qualificationReady ? "Approved" : "Draft, unapproved"}
              tone={qualificationReady ? "good" : "draft"}
            />
          }
          description="The first matching saved row determines the outcome."
          overline="Decisions"
          title="Qualification decision matrix"
        />
        <DataTable
          ariaLabel="Qualification rules"
          columns={qualificationColumns}
          data={state.qualification}
          emptyState={<EmptyTable body="Add a qualification rule to define the first decision row." title="No qualification rules" />}
          exportResource={{ filename: "setterfi-brain-qualification", mode: "local", rows: state.qualification }}
          getRowId={(row) => row.id}
          rowLabel={{ singular: "rule", plural: "rules" }}
          search={{ placeholder: "Search rules" }}
        />
      </section>

      <section className="flex min-w-0 flex-col gap-[var(--s-3)]">
        <TabHeading
          aside={<Status label="Draft, not published" tone="draft" />}
          description="Platform rules publish with The Brain and never come from coach free text. Every reply the agent sends is re-checked against them."
          overline="Guardrails"
          title="Compliance draft"
        />
        <DataTable
          ariaLabel="Compliance rules"
          columns={complianceColumns}
          data={state.compliance}
          emptyState={<EmptyTable body="Add a compliance rule before publishing this configuration." title="No compliance rules" />}
          exportResource={{ filename: "setterfi-brain-compliance", mode: "local", rows: state.compliance }}
          getRowId={(row) => row.id}
          groupBy={(row) => row.severity}
          ungroupedLabel="Severity not recorded"
          rowLabel={{ singular: "rule", plural: "rules" }}
          search={{ placeholder: "Search rules" }}
        />
      </section>
    </div>
  );

  const knowledgeTab = (
    <div className="relative flex min-w-0 flex-col gap-[var(--s-6)]">
      <section className="flex min-w-0 flex-col gap-[var(--s-3)]">
        <TabHeading
          description="Accepted shared rows remain draft until the exact version is evaluated and published."
          overline="The Brain"
          title="Knowledge draft"
        />
        <DataTable
          ariaLabel="Brain knowledge entries"
          columns={knowledgeColumns}
          data={state.knowledge}
          emptyState={<EmptyTable body="Accept an import row to populate shared knowledge." title="No knowledge entries" />}
          exportResource={{ filename: "setterfi-brain-knowledge", label: "Export knowledge entries", mode: "server", resource: "brain-knowledge-entries", query: { reason: "", status: "all", order: "created_desc", columns: ["id", "category", "source", "sourceRef", "disposition", "status", "question", "responseTemplate"] } }}
          getRowId={(row) => row.id}
          groupBy={(row) => row.status}
          groups={KNOWLEDGE_GROUPS}
          onRowClick={setKnowledgeSheet}
          rowLabel={{ singular: "entry", plural: "entries" }}
          search={{ placeholder: "Search knowledge" }}
          ungroupedLabel="Status not recorded"
        />
      </section>

      <section className="flex min-w-0 flex-col gap-[var(--s-3)]">
        <TabHeading
          description="A hard gate binds an answer to platform pricing, guarantee, and outcome rules. Published responses are sent as written and the turn is recorded as held safely."
          overline="The Brain"
          title="Objections"
        />
        <Callout
          body={hardGateCount
            ? `${hardGateCount} of ${state.objections.length} ${state.objections.length === 1 ? "objection is" : "objections are"} hard-gated. The agent sends a gated response exactly as written here: it cannot reword a price, a guarantee, or an outcome, and it cannot produce a figure this page has not published.`
            : "No objection is hard-gated yet. Until one is, no pricing, guarantee, or outcome answer is bound to a response written here."}
          title="The agent cannot invent a number"
          tone={hardGateCount ? "good" : "warning"}
        />
        <ViewSwitch
          ariaLabel="Objection category filter"
          onValueChange={(value) => setObjectionFilter(value as ObjectionCategoryFilter)}
          value={objectionFilter}
          views={objections.options.map((option) => ({ key: option.value, label: option.label, count: option.count }))}
        />
        <DataTable
          ariaLabel="Brain objections"
          columns={objectionColumns}
          data={objections.rows}
          emptyState={<EmptyTable body={objections.emptyLabel ?? "Add an objection response to populate this view."} title="No objections in this view" />}
          exportResource={{ filename: "setterfi-brain-objections", label: "Export objections", mode: "server", resource: "brain-objections", query: { reason: "", status: "all", order: "created_desc", columns: ["id", "label", "category", "hardGate", "status", "matchKeywords", "response", "publishedAt"] } }}
          getRowId={(row) => row.id}
          groupBy={(row) => row.hardGate ? "gated" : "ungated"}
          groups={OBJECTION_GATE_GROUPS}
          onRowClick={setObjectionSheet}
          rowLabel={{ singular: "objection", plural: "objections" }}
          search={{ placeholder: "Search objections" }}
        />
      </section>
    </div>
  );

  const versionsTab = (
    <div className="relative flex min-w-0 flex-col gap-[var(--s-4)]">
      <Surface aria-labelledby="versions-title" className="min-w-0" variant="panel">
        <SurfaceHeader
          overline="History"
          subtitle="Every version that has reached an agent, newest first. Nothing here is ever overwritten."
          title={<span id="versions-title">Version history</span>}
          trailing={
            <Status
              label={rollbackReceipt.label}
              tone={rollbackReceipt.rolledBack ? "good" : "neutral"}
            />
          }
        />

        <PanelBody className="flex flex-wrap items-end gap-[var(--s-3)]">
          <div className="flex gap-[var(--s-2)]">
            <ExportMenu filename="setterfi-brain-versions" label="Export versions" mode="server" resource="brain-snapshots" query={{ reason: "", order: "version_desc", columns: ["id", "version", "contentHash", "sourceHash", "knowledgeMode", "platformTokens", "publishedAt", "rollbackOfSnapshotId"] }} />
            <ExportMenu filename="setterfi-brain-diffs" label="Export version diffs" mode="server" resource="brain-snapshot-diffs" query={{ reason: "", order: "version_desc", columns: ["version", "contentHash", "sourceHash", "knowledgeMode", "publishedAt", "rollbackOfSnapshotId"] }} />
          </div>
        </PanelBody>

        {state.snapshots.length ? (
          <ul className="m-0 list-none border-t border-[var(--line)] p-0">
            {state.snapshots.map((snapshot) => (
              <li
                className="@container border-b border-[var(--line-soft)] px-[var(--s-4)] py-[var(--s-3)] last:border-b-0"
                key={snapshot.id}
              >
                <article className="grid min-w-0 gap-[var(--s-3)] @min-[560px]:grid-cols-[auto_minmax(0,1fr)_auto] @min-[560px]:items-start">
                  <Figure
                    className="self-start rounded-[var(--r-input)] bg-[var(--quiet)] px-[var(--s-2)] py-[var(--s-1)]"
                    size="sm"
                  >
                    v{snapshot.version}
                  </Figure>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-[var(--s-2)]">
                      <span className="text-[length:var(--t-row)] font-[var(--t-row-w)] text-[color:var(--ink)]">
                        {snapshot.rollbackOfSnapshotId ? "Rollback version" : "Published version"}
                      </span>
                      {snapshot.version === currentVersion ? (
                        <Status label="Live on every agent" tone="good" treatment="bare" />
                      ) : null}
                    </div>
                    {/* Mode, size and time are the three facts that identify a version, so they
                        are mono on one line rather than a sentence a reader has to parse. */}
                    <div className="mt-[var(--s-1)] flex flex-wrap items-baseline gap-x-[var(--s-3)] gap-y-[2px]">
                      <MonoMeta>{humanize(snapshot.knowledgeMode)}</MonoMeta>
                      <MonoMeta>{snapshot.platformTokens} tokens</MonoMeta>
                      <MonoMeta>{displayTime(snapshot.publishedAt)}</MonoMeta>
                    </div>
                    <TechnicalDetail className="mt-[var(--s-2)]" items={[
                      { label: "Snapshot ID", value: snapshot.id },
                      { label: "Content hash", value: snapshot.contentHash },
                      { label: "Source hash", value: snapshot.sourceHash },
                      ...(snapshot.rollbackOfSnapshotId ? [{ label: "Rollback source ID", value: snapshot.rollbackOfSnapshotId }] : []),
                      { label: "Published timestamp", value: snapshot.publishedAt },
                    ]} />
                  </div>
                  {snapshot.version < currentVersion ? (
                    <label className="t-muted inline-flex shrink-0 items-center gap-[var(--s-2)]">
                      <input
                        checked={selectedVersion === snapshot.version}
                        className="size-[var(--s-4)] accent-[var(--accent)]"
                        name="rollback-target"
                        onChange={() => setSelectedVersion(snapshot.version)}
                        type="radio"
                      />
                      Select target
                    </label>
                  ) : null}
                </article>
              </li>
            ))}
          </ul>
        ) : (
          <PanelBody>
            <DataState body="Publish the first version to start the version history." kind="empty" title="No published versions" />
          </PanelBody>
        )}
      </Surface>

      {/*
        Rollback is its own panel rather than a footer on the history, because it has the same
        blast radius as a publish and reads too easily as an undo when it is stapled to a list.
        It appends rather than deletes, and the subtitle says both things: what it does to the
        history, and who it reaches.
      */}
      <Surface aria-labelledby="rollback-title" className="min-w-0" variant="panel">
        <SurfaceHeader
          overline="Blast radius"
          subtitle="A rollback appends the selected payload as a new version and keeps the prior history. It reaches every coach's agent exactly as a publish does."
          title={<span id="rollback-title">Roll back to an earlier version</span>}
        />
        <PanelBody className="flex flex-col gap-[var(--s-3)]">
          <Status
            label={selectedVersion ? `Target selected: v${selectedVersion}` : "No target selected yet"}
            tone={selectedVersion ? "warning" : "neutral"}
          />
          <Field
            error={rollbackReasonTouched ? reasonControlView(rollbackReason).error ?? undefined : undefined}
            hint="Recorded against the appended version."
            label="Rollback reason"
          >
            <Textarea
              onBlur={() => setRollbackReasonTouched(true)}
              onChange={(event) => { setRollbackReasonTouched(true); setRollbackReason(event.target.value); }}
              value={rollbackReason}
            />
          </Field>
          <LoggedButton
            actionKey="brain.rolled_back"
            className="self-start"
            disabled={!selectedVersion || !reasonControlView(rollbackReason).enabled || busy !== null || rollbackReceipt.logged}
            onClick={() => void rollback()}
            variant="danger"
          >
            {busy === "rollback" ? "Appending rollback" : rollbackReceipt.logged ? rollbackReceipt.label : "Append rollback"}
          </LoggedButton>
        </PanelBody>
      </Surface>
    </div>
  );

  const diagnosticsTab = (
    <div className="relative flex min-w-0 flex-col gap-[var(--s-4)]">
      <Surface aria-labelledby="citation-title" className="min-w-0" variant="panel">
        <SurfaceHeader
          overline="Evidence"
          subtitle="A row is grounded only when the saved trace confirms that its declaration appeared in the prompt."
          title={<span id="citation-title">Verified citation receipt</span>}
          trailing={
            <Status
              label={citationGrounded ? "Grounded" : "Grounding not verified"}
              tone={citationGrounded ? "good" : "warning"}
            />
          }
        />
        <PanelBody className="flex flex-col gap-[var(--s-4)]">
          {state.citation ? (
            <>
              <dl className="grid gap-[var(--s-4)] sm:grid-cols-2">
                <KeyValue label="Declaration" layout="stacked" value={state.citation.declaredEntryId ? "Recorded" : "None"} />
                <KeyValue label="Prompt candidates" layout="stacked" value={state.citation.candidateEntryIds.length} />
                <KeyValue label="Recorded" layout="stacked" value={displayTime(state.citation.createdAt)} />
              </dl>
              <TechnicalDetail items={[
                { label: "Trace ID", value: state.citation.traceId },
                ...(state.citation.declaredEntryId ? [{ label: "Declaration ID", value: state.citation.declaredEntryId }] : []),
                ...state.citation.candidateEntryIds.map((id, index) => ({ label: `Candidate ${index + 1}`, value: id })),
                { label: "Recorded timestamp", value: state.citation.createdAt },
              ]} />
            </>
          ) : (
            <DataState body="Run a synthetic test turn to create citation evidence." kind="empty" title="No saved trace" />
          )}
        </PanelBody>
      </Surface>

      <Surface aria-labelledby="test-turn-title" className="min-w-0" variant="panel">
        <SurfaceHeader
          overline="Test data"
          subtitle="A synthetic turn against the live configuration. It never reaches a real lead, and the trace it writes is excluded from real analytics."
          title={<span id="test-turn-title">Synthetic test turn</span>}
        />
        <PanelBody className="flex flex-col gap-[var(--s-3)]">
          <Field hint="This uses test data and does not reach a real lead." label="Synthetic test turn">
            <Input onChange={(event) => setTestMessage(event.target.value)} value={testMessage} />
          </Field>
          <Button
            className="self-start"
            disabled={!testMessage.trim() || busy !== null}
            onClick={() => void runAction("agent", async () => { await api.runAgent(testMessage); router.refresh(); })}
            type="button"
            variant="outline"
          >
            {busy === "agent" ? "Running test turn" : "Run test turn"}
          </Button>
        </PanelBody>
      </Surface>
    </div>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--s-4)]">
      {error ? (
        <div className="shrink-0" role="alert">
          <Callout
            body={
              <>
                Nothing was saved. The response detail below is the whole of what came back.
                <TechnicalDetail className="mt-[var(--s-2)]" items={[{ label: "Response detail", value: error }]} />
              </>
            }
            title="The request did not complete"
            tone="critical"
          />
        </div>
      ) : null}

      <DetailPage
        actions={
          publishBlocker ? (
            <Prose
              className="t-muted m-0 text-right"
              data-slot="publish-blocker-header"
              measure="caption"
            >
              {publishBlocker}
            </Prose>
          ) : null
        }
        className={error ? "lg:h-auto" : undefined}
        onTabChange={(next) => setTab(next as BrainTab)}
        state={{
          kind: "lifecycle",
          label: currentVersion ? `Published v${currentVersion}` : "No published version",
          tone: currentVersion ? "good" : "warning",
        }}
        primaryAction={{
          disabled: publishDisabled,
          label: busy === "publish" ? "Publishing The Brain" : "Publish to all agents",
          logged: "brain.published",
          onClick: () => void publish(),
        }}
        provenanceKind={provenanceKind}
        subtitle={PAGE_DESCRIPTION}
        tabs={[
          { id: "overview", label: "Overview", content: overviewTab },
          // A count is passed only when there is something to count: a faint grey zero in the tab
          // strip reads as a broken number, and each empty tab says so in its own body.
          { id: "review", label: "Import review", content: reviewTab, ...(pendingReviewCount ? { count: pendingReviewCount } : {}) },
          { id: "defaults", label: "Agent defaults", content: defaultsTab },
          { id: "knowledge", label: "Knowledge", content: knowledgeTab, ...(state.knowledge.length ? { count: state.knowledge.length } : {}) },
          { id: "versions", label: "Versions", content: versionsTab, ...(state.snapshots.length ? { count: state.snapshots.length } : {}) },
          { id: "diagnostics", label: "Diagnostics", content: diagnosticsTab },
        ]}
        title="The Brain"
        value={tab}
      />

      <RecordSheet
        onOpenChange={(open) => { if (!open) setKnowledgeSheet(null); }}
        open={knowledgeSheet !== null}
        sections={knowledgeSheet ? [
          { title: "Inbound message", body: <p className="t-muted m-0">{knowledgeSheet.inboundMessage || "No inbound message was saved."}</p> },
          { title: "Response template", body: <p className="t-muted m-0">{knowledgeSheet.responseTemplate || "No response template was saved."}</p> },
          {
            title: "Publish state",
            fields: [
              { label: "Status", value: humanize(knowledgeSheet.status) },
              { label: "Last saved", value: knowledgeSheet.updatedAt ? displayTime(knowledgeSheet.updatedAt) : undefined, absence: "not recorded" },
              { label: "Published", value: knowledgeSheet.publishedAt ? displayTime(knowledgeSheet.publishedAt) : undefined, absence: "never published" },
            ],
          },
        ] : []}
        state={knowledgeSheet ? { kind: "tag", label: humanize(knowledgeSheet.status), tone: "neutral" } : undefined}
        subtitle={knowledgeSheet ? humanize(knowledgeSheet.category) : undefined}
        technical={knowledgeSheet ? [{ label: "Entry ID", value: knowledgeSheet.id }] : undefined}
        title={knowledgeSheet?.inboundMessage || "Knowledge entry"}
      />

      <RecordSheet
        onOpenChange={(open) => { if (!open) setObjectionSheet(null); }}
        open={objectionSheet !== null}
        sections={objectionSheet ? [
          {
            title: "Published response",
            aside: objectionSheet.hardGate ? "Sent exactly as written" : undefined,
            body: <p className="t-muted m-0">{objectionSheet.response || "No response was saved."}</p>,
          },
          {
            title: "Matching",
            body: (
              <dl className="grid gap-[var(--s-3)] sm:grid-cols-2">
                <KeyValue label="Category" layout="stacked" value={humanize(objectionSheet.category)} />
                <KeyValue label="Gate" layout="stacked" value={objectionSheet.hardGate ? "Hard gate" : "No gate"} />
                <KeyValue label="Keywords" layout="stacked" value={objectionSheet.matchKeywords.join(", ") || "No keywords, pattern only"} />
                <KeyValue label="Status" layout="stacked" value={humanize(objectionSheet.status)} />
              </dl>
            ),
          },
          {
            title: "Publish state",
            fields: [
              { label: "Last saved", value: objectionSheet.updatedAt ? displayTime(objectionSheet.updatedAt) : undefined, absence: "not recorded" },
              { label: "Published", value: objectionSheet.publishedAt ? displayTime(objectionSheet.publishedAt) : undefined, absence: "never published" },
            ],
          },
        ] : []}
        state={objectionSheet ? {
          kind: "lifecycle",
          label: objectionSheet.hardGate ? "Hard gate" : "No gate",
          tone: objectionSheet.hardGate ? "info" : "neutral",
        } : undefined}
        subtitle={objectionSheet ? humanize(objectionSheet.category) : undefined}
        technical={objectionSheet ? [{ label: "Objection ID", value: objectionSheet.id }] : undefined}
        title={objectionSheet?.label ?? ""}
      />
    </div>
  );
}
