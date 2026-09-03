"use client";

/**
 * The owner Brain, rehaul face.
 *
 * The chrome is the artboard's: a 30px title, the published-version pill beside it, the two
 * dangerous verbs on the right, and a `?tab=` underline row. Everything below the row is the
 * surface the live page already builds, wrapped rather than reinvented, with the explainer
 * sentences pulled out of the page and handed to the context eye.
 *
 * This file adds no read of its own. Every figure comes out of `AdminBrainInitialState` exactly as
 * `admin/brain/page.tsx` loads it, and every action is the same `brain-api-client` call the live
 * surface makes.
 *
 * What the drawing asks for that the platform cannot say, and what stands in its place:
 *
 * - **"Draft reaches 8 agents."** No query on this page counts coaches or agents, and
 *   `docs/DESIGN.md` forbids printing a figure the code cannot produce. The first tile carries the
 *   published version instead, which is the fact the other two are read against.
 * - **"46/48 passed" and the eval trend line.** The state holds one gate verdict for one draft:
 *   a run id, its blocking cases and its warnings. There is no pass total and no run history, so
 *   the tile counts blocking cases and the trend chart is absent rather than drawn from nothing.
 * - **The per-row "Diff" link.** The diff is computed per entity, not per section, so the change
 *   column says what moved in that section and the entity list sits under the table.
 */

import { useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  Figure as KitFigure,
  MonoMeta,
  Prose,
  STATE_TONE_TO_TONE,
  Status,
  Surface,
  SurfaceHeader,
} from "@/components/kit/atomics";
import { Callout } from "@/components/kit/callout";
import { absentValue } from "@/components/kit/columns";
import { DataState } from "@/components/kit/data-state";
import { DataTable } from "@/components/kit/data-table";
import { ExportMenu } from "@/components/kit/export-menu";
import { Field } from "@/components/kit/field";
import { KeyValue } from "@/components/kit/key-value";
import { LoggedButton } from "@/components/kit/logged-button";
import { RecordSheet } from "@/components/kit/record-sheet";
import type { StateTone } from "@/components/kit/state-badge";
import { TechnicalDetail } from "@/components/kit/technical-detail";
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
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import {
  CARD_TABLE,
  Figure,
  Pill,
  RehaulTabs,
  StatusDot,
} from "@/components/workspace/rehaul/_primitives";
import { createBrainApiClient } from "@/components/workspace/live/brain-api-client";
import { missionFieldCopy } from "@/components/workspace/live/mission-fields";
import {
  draftDiffView,
  evalGateView,
  importReviewView,
  objectionListView,
  publishReceiptView,
  reasonControlView,
  rollbackReceiptView,
  type AdminBrainInitialState,
  type BrainEvalView,
  type BrainImportRowView,
  type BrainObjectionView,
  type BrainPublishResponse,
  type ObjectionCategoryFilter,
} from "@/components/workspace/live/brain-view-models";
import type { ColumnDef } from "@tanstack/react-table";
import type { ImportDisposition } from "@/lib/brain/contracts";
import { FIGURE_BINDING_FIELDS } from "@/lib/brain/import/flags";
import { QUALIFICATION_OUTCOME_COPY } from "@/lib/copy/states";
import { workspaceCountFormat, workspaceDateTimeFormat } from "@/lib/format/datetime";

const api = createBrainApiClient();

export const OWNER_BRAIN_TABS = [
  "overview",
  "review",
  "defaults",
  "knowledge",
  "versions",
  "evals",
  "diagnostics",
] as const;

export type OwnerBrainTab = (typeof OWNER_BRAIN_TABS)[number];

export function ownerBrainTab(value: string | null | undefined): OwnerBrainTab {
  return OWNER_BRAIN_TABS.includes(value as OwnerBrainTab) ? (value as OwnerBrainTab) : "overview";
}

export type OwnerBrainProps = {
  initialState: AdminBrainInitialState;
  tab: OwnerBrainTab;
  /** The Evals surface, rendered on the server and folded in from `/admin/brain/testing`. */
  evals?: ReactNode;
};

type KnowledgeRow = AdminBrainInitialState["knowledge"][number];
type ReviewDecision = {
  disposition: ImportDisposition | null;
  reviewedFlagIds: string[];
  bindings: Record<string, string>;
  bareTokens: Record<string, string>;
};

const KNOWLEDGE_GROUPS = [
  { id: "published", label: "Published, live on every agent" },
  { id: "draft", label: "Draft, not yet published" },
] as const;

const OBJECTION_GATE_GROUPS = [
  { id: "gated", label: "Hard-gated, figures bound to platform rules" },
  { id: "ungated", label: "Not gated" },
] as const;

/**
 * Every sentence this page used to print under a heading, in one place.
 *
 * The rehaul rule is that a screen carries a heading, a figure, a table or a control and nothing
 * else, so these are handed to the eye rather than deleted: a reader who needs to know what a
 * publish reaches can still ask for it.
 */
export const OWNER_BRAIN_EYE_COPY = [
  "Every coach's agent reads this one shared configuration, so a publish reaches all of them at once, from their next reply onward.",
  "An imported row joins the draft only once it is accepted, and it stays draft until the exact version is evaluated and published.",
  "The evaluation must match this exact saved draft before publishing, and the reason you type is recorded against the published version.",
  "A rollback appends the selected payload as a new version and keeps the prior history. It reaches every agent exactly as a publish does.",
  "No Brain table records who changed a row, so nothing here names one. Attribution for every edit is in the audit log.",
  "A synthetic test turn runs against test data and never reaches a real lead, but the turn itself is recorded.",
].join(" ");

/** What each changed entity type is called, in the reader's words rather than its column name. */
const ENTITY_LABEL: Readonly<Record<string, string>> = {
  mission: "Mission field",
  qualification_rule: "Qualification rule",
  compliance_rule: "Compliance rule",
  knowledge_entry: "Knowledge entry",
  placeholder_definition: "Placeholder definition",
  placeholder_resolution: "Placeholder resolution",
};

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

/**
 * One row of "what a publish would change", per part of the Brain.
 *
 * `live` and `total` are counted off the loaded rows. The change cell is derived from the entity
 * diff where the draft payload carries that entity type, and from the live-versus-total gap where
 * it does not: objections are not compiled into the draft payload, so the honest thing that part
 * can say is how many of its rows have not reached an agent yet.
 */
export type BrainSectionRow = {
  title: string;
  live: number;
  total: number;
  changed: number;
  changeLabel: string;
  changeTone: "neutral" | "amber" | "good";
};

export function brainSectionRows(
  state: AdminBrainInitialState,
  changesByType: Readonly<Record<string, number>>,
): BrainSectionRow[] {
  const publishedKnowledge = state.knowledge.filter((row) => row.status === "published").length;
  const publishedObjections = state.objections.filter((row) => row.status === "published").length;
  const sections: Array<{ title: string; live: number; total: number; entityType?: string }> = [
    { title: "Answers to questions leads ask", live: publishedKnowledge, total: state.knowledge.length, entityType: "knowledge_entry" },
    { title: "Objections and how they are handled", live: publishedObjections, total: state.objections.length },
    { title: "Qualification rules", live: state.qualification.length, total: state.qualification.length, entityType: "qualification_rule" },
    { title: "Compliance phrases", live: state.compliance.length, total: state.compliance.length, entityType: "compliance_rule" },
    { title: "Mission and voice", live: state.mission.length, total: state.mission.length, entityType: "mission" },
  ];

  return sections.map((section) => {
    const changed = section.entityType ? changesByType[section.entityType] ?? 0 : 0;
    const waiting = Math.max(0, section.total - section.live);
    if (changed > 0) {
      return {
        ...section,
        changed,
        changeLabel: `${workspaceCountFormat.format(changed)} ${changed === 1 ? "entity differs" : "entities differ"}`,
        changeTone: "amber" as const,
      };
    }
    if (waiting > 0) {
      return {
        ...section,
        changed,
        changeLabel: `${workspaceCountFormat.format(waiting)} not live yet`,
        changeTone: "amber" as const,
      };
    }
    return { ...section, changed, changeLabel: "No change", changeTone: "neutral" as const };
  });
}

/** A panel's body. `panel` gives up its own padding to whatever it contains, so this puts it back. */
function PanelBody({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`min-w-0 px-[var(--s-4)] py-[var(--s-4)] ${className}`}>{children}</div>;
}

function SectionHead({ aside, title }: { aside?: ReactNode; title: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-[var(--s-3)]">
      <h2 className="m-0 text-[15px] leading-[1.2] font-[600] text-[color:var(--ink)]">{title}</h2>
      {aside}
    </div>
  );
}

function CardHead({ aside, pill, title }: { aside?: ReactNode; pill?: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-[10px] border-b border-[var(--line)] px-[14px] py-[10px]">
      <span className="text-[13px] font-[600] text-[color:var(--ink)]">{title}</span>
      {pill ? <span className="ml-auto">{pill}</span> : null}
      {aside ? <span className={pill ? "" : "ml-auto"}>{aside}</span> : null}
    </div>
  );
}

function Tile({
  caption,
  figure,
  label,
  tone,
}: {
  caption: string;
  figure: ReactNode;
  label: string;
  tone?: "amber";
}) {
  return (
    <div
      className={[
        "rounded-[14px] border bg-[linear-gradient(180deg,var(--card-top),var(--card))] px-[18px] py-[16px] shadow-[var(--shadow-card)]",
        tone === "amber" ? "border-[var(--warning-line)]" : "border-[var(--line)]",
      ].join(" ")}
    >
      <div className="text-[12.5px] font-[500] text-[color:var(--faint)]">{label}</div>
      <Figure
        className={["mt-[6px] text-[34px]", tone === "amber" ? "text-[var(--warning-text)]" : "text-[color:var(--ink)]"].join(" ")}
        size="md"
      >
        {figure}
      </Figure>
      <div className="mt-[6px] text-[12.5px] font-[400] text-[color:var(--faint)]">{caption}</div>
    </div>
  );
}

const TAB_LABELS: Record<OwnerBrainTab, string> = {
  defaults: "Agent defaults",
  diagnostics: "Diagnostics",
  evals: "Evals",
  knowledge: "Knowledge",
  overview: "Overview",
  review: "Import review",
  versions: "Versions",
};

export function OwnerBrain({ evals, initialState, tab }: OwnerBrainProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [state, setState] = useState(initialState);
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
  const [testMessage, setTestMessage] = useState("");
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

  const changesByType = useMemo(
    () => diff.changes.reduce<Record<string, number>>((totals, change) => ({
      ...totals,
      [change.entityType]: (totals[change.entityType] ?? 0) + 1,
    }), {}),
    [diff.changes],
  );
  const sectionRows = useMemo(
    () => brainSectionRows(state, changesByType),
    [state, changesByType],
  );

  function tabHref(next: OwnerBrainTab) {
    const query = new URLSearchParams(searchParams?.toString() ?? "");
    query.set("tab", next);
    return `${pathname}?${query.toString()}`;
  }

  const qualificationColumns = useMemo<ColumnDef<AdminBrainInitialState["qualification"][number]>[]>(() => [
    { accessorKey: "position", header: "Position", meta: { label: "Position" } },
    { accessorKey: "label", header: "Rule", meta: { cellKind: "identity", label: "Rule" } },
    {
      accessorKey: "outcome",
      cell: ({ row }) => {
        const copy = QUALIFICATION_OUTCOME_COPY[row.original.outcome as keyof typeof QUALIFICATION_OUTCOME_COPY];
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
    setReview((current) => ({ ...current, [rowId]: { ...current[rowId], ...update } }));
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
        draft: {
          id: value.revision!.id!,
          contentHash: value.revision!.contentHash!,
          payload: value.revision!.payload!,
          createdAt: new Date().toISOString(),
        },
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

  const overviewTab = (
    <div className="grid min-h-0 grid-cols-1 gap-[16px] xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="flex min-w-0 flex-col gap-[16px]">
        <div className="grid grid-cols-1 gap-[16px] md:grid-cols-3">
          <Tile
            caption={currentVersion ? displayTime(state.snapshots[0]?.publishedAt ?? null) : "no version has reached an agent"}
            figure={currentVersion ? `v${currentVersion}` : "none"}
            label="Live right now"
            tone={currentVersion ? undefined : "amber"}
          />
          <Tile
            caption={
              hardGateCount
                ? `entries · ${workspaceCountFormat.format(hardGateCount)} hard-gated objections`
                : "entries · no objection is gated yet"
            }
            figure={workspaceCountFormat.format(publishedKnowledgeCount)}
            label="Live knowledge"
          />
          <Tile
            caption={state.batch ? "rows from the last import" : "no import has run"}
            figure={workspaceCountFormat.format(pendingReviewCount)}
            label="Awaiting review"
            tone={pendingReviewCount ? "amber" : undefined}
          />
        </div>

        <div className={`${CARD_TABLE.card} flex min-w-0 flex-1 flex-col`}>
          <CardHead
            aside={
              /*
               * The publish-preview rows are computed on this page from the loaded state, so the
               * export is local: no server resource returns "live versus draft per section".
               */
              <ExportMenu
                filename="setterfi-brain-publish-preview"
                label="Export publish preview"
                mode="local"
                rows={sectionRows.map((row) => ({
                  section: row.title,
                  live: row.live,
                  draft: row.total,
                  change: row.changeLabel,
                }))}
              />
            }
            pill={
              state.draft ? (
                <Pill tone="amber">
                  <StatusDot tone="amber" />
                  Draft saved {displayTime(state.draft.createdAt)}
                </Pill>
              ) : (
                <Pill>No saved draft</Pill>
              )
            }
            title="What a publish would change"
          />
          <div className="overflow-x-auto">
            <table className={CARD_TABLE.table}>
              <thead>
                <tr>
                  <th className={CARD_TABLE.th}>Section</th>
                  <th className={`${CARD_TABLE.th} text-right`}>Live</th>
                  <th className={`${CARD_TABLE.th} text-right`}>Draft</th>
                  <th className={CARD_TABLE.th}>Change</th>
                </tr>
              </thead>
              <tbody>
                {sectionRows.map((row) => (
                  <tr key={row.title}>
                    <td className={`${CARD_TABLE.td} font-[500] text-[color:var(--ink)]`}>{row.title}</td>
                    <td className={`${CARD_TABLE.td} ${CARD_TABLE.num}`}>{workspaceCountFormat.format(row.live)}</td>
                    <td className={`${CARD_TABLE.td} ${CARD_TABLE.num}`}>{workspaceCountFormat.format(row.total)}</td>
                    <td className={CARD_TABLE.td}>
                      {row.changeTone === "neutral" ? (
                        <span className="text-[12px] text-[color:var(--faint)]">{row.changeLabel}</span>
                      ) : (
                        <Pill tone="amber">
                          <StatusDot tone="amber" />
                          {row.changeLabel}
                        </Pill>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-[10px] px-[14px] py-[12px]">
            <Status
              label={importSummary.label}
              tone={STATE_TONE_TO_TONE[importSummary.tone]}
              treatment="bare"
            />
            <div className="ml-auto flex flex-col items-end gap-[2px]">
              <Button
                disabled={busy !== null}
                onClick={() => void createDraft()}
                type="button"
                variant="outline"
              >
                {busy === "draft" ? "Saving draft" : "Save draft from current rows"}
              </Button>
              {/*
                * Not a `LoggedButton`: `AUDIT_ACTIONS` has no key for a draft revision and
                * `src/lib/audit/actions.ts` is not this page's file to add one to. The microcopy
                * is the part a reader needs, so it goes beside the button on its own.
                */}
              <MonoMeta aria-label="Draft revision recorded in the audit log">Logged</MonoMeta>
            </div>
          </div>
        </div>

        {diff.changes.length || diff.impactKeys.length ? (
          <div className={`${CARD_TABLE.card} min-w-0`}>
            <CardHead title="What it reaches" />
            <ul className="m-0 list-none p-0">
              {diff.changes.map((change) => (
                <li
                  className="flex items-center gap-[10px] border-b border-[var(--line-soft)] px-[14px] py-[10px] last:border-b-0"
                  key={`${change.entityType}:${change.entityId}`}
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] text-[color:var(--body)]">
                    {ENTITY_LABEL[change.entityType] ?? humanize(change.entityType)}
                  </span>
                  <MonoMeta>{change.kind}</MonoMeta>
                </li>
              ))}
              {diff.impactKeys.map((key, index) => (
                <li className="border-b border-[var(--line-soft)] px-[14px] py-[10px] last:border-b-0" key={key}>
                  <MonoMeta className="block">{key}</MonoMeta>
                  <span className="mt-[2px] block text-[12.5px] text-[color:var(--muted)]">
                    {diff.impactLines[index]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-[14px] rounded-[14px] border border-[var(--line)] bg-[linear-gradient(180deg,var(--card-top),var(--card))] px-[20px] py-[18px] shadow-[var(--shadow-card)]">
        <div>
          <div className="text-[12.5px] font-[500] text-[color:var(--faint)]">
            Evals on this draft
          </div>
          <div className="mt-[6px] flex items-baseline gap-[8px]">
            <Figure
              className={`text-[34px] ${state.eval.state === "blocked" ? "text-[var(--warning-text)]" : "text-[color:var(--ink)]"}`}
              size="md"
            >
              {workspaceCountFormat.format(state.eval.blockers.length)}
            </Figure>
            <span className="font-mono text-[12px] text-[color:var(--muted)]">
              {state.eval.state === "not_run_for_this_version"
                ? "not run for this version"
                : state.eval.state === "blocked"
                  ? "blocking cases"
                  : "blocking cases · ready"}
            </span>
          </div>
        </div>

        {/*
          The artboard draws an eval trend line here. `AdminBrainInitialState` carries one gate
          verdict for one draft and no run history at all, so there is no series to draw and the
          chart is absent rather than invented.
        */}

        <div className="flex flex-col text-[13px]">
          {gate.details.length ? (
            gate.details.map((detail) => {
              const [suite, caseKey] = detail.split(" · ");
              return (
                <div
                  className="flex items-center gap-[10px] border-b border-[var(--line-soft)] py-[9px] last:border-b-0"
                  key={detail}
                >
                  <StatusDot tone={state.eval.state === "blocked" ? "bad" : "amber"} />
                  <span className="min-w-0 flex-1 truncate text-[color:var(--body)]">{humanize(suite ?? detail)}</span>
                  <span className="font-mono text-[12px] text-[color:var(--faint)]">{caseKey ?? "case"}</span>
                </div>
              );
            })
          ) : (
            <div className="flex items-center gap-[10px] py-[9px]">
              <StatusDot tone={state.eval.state === "ready" ? "good" : "grey"} />
              <span className="flex-1 text-[color:var(--body)]">
                {state.eval.state === "ready"
                  ? "No suite failed on this draft"
                  : "No saved run matches this draft"}
              </span>
            </div>
          )}
        </div>

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

        <div className="mt-auto rounded-[11px] border border-[var(--line-soft)] bg-[var(--well)] px-[14px] py-[12px]">
          <div className="text-[12.5px] font-[500] text-[color:var(--faint)]">Try a turn</div>
          <div className="mt-[6px] flex flex-wrap items-center gap-[8px]">
            <Input
              aria-label="Synthetic test turn"
              className="min-w-0 flex-1"
              onChange={(event) => setTestMessage(event.target.value)}
              placeholder="Type a message a lead might send"
              value={testMessage}
            />
            <Button
              disabled={!testMessage.trim() || busy !== null}
              onClick={() => void runAction("agent", async () => { await api.runAgent(testMessage); router.refresh(); })}
              type="button"
              variant="outline"
            >
              {busy === "agent" ? "Running" : "Run"}
            </Button>
          </div>
        </div>
        <MonoMeta className="block">Logged</MonoMeta>
      </div>
    </div>
  );

  const reviewTab = (
    <div className="relative flex min-w-0 flex-col gap-[var(--s-4)]">
      <SectionHead
        aside={
          <div className="flex flex-col items-end gap-[2px]">
            <Button
              disabled={busy !== null}
              onClick={() => void runAction("import", async () => { await api.importConfigured(); router.refresh(); })}
              type="button"
              variant="outline"
            >
              {busy === "import" ? "Importing" : "Import now"}
            </Button>
            <MonoMeta aria-label="Import batch recorded in the audit log">Logged</MonoMeta>
          </div>
        }
        title="Knowledge import review"
      />
      <div className="flex flex-wrap items-end gap-[var(--s-3)]">
        <Status label={importSummary.label} tone={STATE_TONE_TO_TONE[importSummary.tone]} />
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
                            {/*
                              * Amber on both arms until acceptance returns. `resolved` is true as
                              * soon as a checkbox is ticked or a binding chosen, and none of that
                              * is persisted until `accept()` runs, so the only green here is the
                              * one the server confirmed: `flag.resolved` off the loaded row.
                              */}
                            <Status
                              label={flag.resolved ? "Resolved" : resolved ? "Marked, not saved" : "Blocking"}
                              tone={flag.resolved ? "good" : "warning"}
                              treatment="bare"
                            />
                          </div>
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
                          <Field label="Link token">
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
          title={<span id="mission-title">Mission draft</span>}
          trailing={<Status label="Draft, not published" tone="draft" />}
        />
        <ul className="m-0 list-none p-0">
          {state.mission.map((item, index) => {
            const copy = missionFieldCopy(item.label);
            return (
              <li
                className="@container/mission-row border-b border-[var(--line-soft)] px-[var(--s-4)] py-[var(--s-4)] last:border-b-0"
                key={item.id}
              >
                <div className="grid min-w-0 gap-[var(--s-3)] @min-[640px]/mission-row:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                  <div className="min-w-0">
                    <h3 className="t-row">{copy.title}</h3>
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
        <SectionHead
          aside={
            <Status
              label={qualificationReady ? "Approved" : "Draft, unapproved"}
              tone={qualificationReady ? "good" : "draft"}
            />
          }
          title="Qualification decision matrix"
        />
        <DataTable
          ariaLabel="Qualification rules"
          columns={qualificationColumns}
          data={state.qualification}
          emptyState={<DataState body="Add a qualification rule to define the first decision row." kind="empty" title="No qualification rules" />}
          exportResource={{ filename: "setterfi-brain-qualification", mode: "local", rows: state.qualification }}
          getRowId={(row) => row.id}
          rowLabel={{ singular: "rule", plural: "rules" }}
          search={{ placeholder: "Search rules" }}
        />
      </section>

      <section className="flex min-w-0 flex-col gap-[var(--s-3)]">
        <SectionHead
          aside={<Status label="Draft, not published" tone="draft" />}
          title="Compliance draft"
        />
        <DataTable
          ariaLabel="Compliance rules"
          columns={complianceColumns}
          data={state.compliance}
          emptyState={<DataState body="Add a compliance rule before publishing this configuration." kind="empty" title="No compliance rules" />}
          exportResource={{ filename: "setterfi-brain-compliance", mode: "local", rows: state.compliance }}
          getRowId={(row) => row.id}
          groupBy={(row) => row.severity}
          rowLabel={{ singular: "rule", plural: "rules" }}
          search={{ placeholder: "Search rules" }}
          ungroupedLabel="Severity not recorded"
        />
      </section>
    </div>
  );

  const knowledgeTab = (
    <div className="relative flex min-w-0 flex-col gap-[var(--s-6)]">
      <section className="flex min-w-0 flex-col gap-[var(--s-3)]">
        <SectionHead title="Knowledge draft" />
        <DataTable
          ariaLabel="Brain knowledge entries"
          columns={knowledgeColumns}
          data={state.knowledge}
          emptyState={<DataState body="Accept an import row to populate shared knowledge." kind="empty" title="No knowledge entries" />}
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
        <SectionHead title="Objections" />
        <Callout
          body={hardGateCount
            ? `${hardGateCount} of ${state.objections.length} ${state.objections.length === 1 ? "objection is" : "objections are"} hard-gated.`
            : "No objection is hard-gated yet."}
          title="Hard-gated objections"
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
          emptyState={<DataState body={objections.emptyLabel ?? "Add an objection response to populate this view."} kind="empty" title="No objections in this view" />}
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
                className="@container/snapshot-row border-b border-[var(--line-soft)] px-[var(--s-4)] py-[var(--s-3)] last:border-b-0"
                key={snapshot.id}
              >
                <article className="grid min-w-0 gap-[var(--s-3)] @min-[560px]/snapshot-row:grid-cols-[auto_minmax(0,1fr)_auto] @min-[560px]/snapshot-row:items-start">
                  <KitFigure
                    className="self-start rounded-[var(--r-input)] bg-[var(--quiet)] px-[var(--s-2)] py-[var(--s-1)]"
                    size="sm"
                  >
                    v{snapshot.version}
                  </KitFigure>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-[var(--s-2)]">
                      <span className="text-[length:var(--t-row)] font-[var(--t-row-w)] text-[color:var(--ink)]">
                        {snapshot.rollbackOfSnapshotId ? "Rollback version" : "Published version"}
                      </span>
                      {snapshot.version === currentVersion ? (
                        <Status label="Live on every agent" tone="good" treatment="bare" />
                      ) : null}
                    </div>
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

      <Surface aria-labelledby="rollback-title" className="min-w-0" variant="panel">
        <SurfaceHeader
          overline="Blast radius"
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
        <SurfaceHeader overline="Test data" title={<span id="test-turn-title">Synthetic test turn</span>} />
        <PanelBody className="flex flex-col gap-[var(--s-3)]">
          <Field label="Synthetic test turn">
            <Input
              onChange={(event) => setTestMessage(event.target.value)}
              placeholder="Type a message a lead might send"
              value={testMessage}
            />
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

  const evalsTab = evals ?? (
    <DataState
      body="Turn on Brain evals to read the saved test-arm evidence."
      kind="empty"
      title="Evals are not enabled"
    />
  );

  const body = tab === "review"
    ? reviewTab
    : tab === "defaults"
      ? defaultsTab
      : tab === "knowledge"
        ? knowledgeTab
        : tab === "versions"
          ? versionsTab
          : tab === "evals"
            ? evalsTab
            : tab === "diagnostics"
              ? diagnosticsTab
              : overviewTab;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-[14px]">
      {error ? (
        <div className="shrink-0" role="alert">
          <Callout
            body={
              <>
                Nothing was saved.
                <TechnicalDetail className="mt-[var(--s-2)]" items={[{ label: "Response detail", value: error }]} />
              </>
            }
            title="The request did not complete"
            tone="critical"
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-[12px]">
        <h1 className="m-0 text-[30px] leading-[1.1] font-[600] tracking-[-0.02em] text-[color:var(--ink)]">
          The Brain
        </h1>
        <span className="mb-[3px]">
          {currentVersion ? (
            <Pill tone="good">
              <StatusDot tone="good" />
              Published v{currentVersion} · {displayTime(state.snapshots[0]?.publishedAt ?? null)}
            </Pill>
          ) : (
            <Pill tone="amber">
              <StatusDot tone="amber" />
              No published version
            </Pill>
          )}
        </span>
        <div className="ml-auto flex items-center gap-[8px]">
          <Button
            disabled={!state.draft || busy !== null}
            onClick={() => void runEval()}
            type="button"
            variant="outline"
          >
            {busy === "eval" ? "Running evals" : "Run evals"}
          </Button>
          <LoggedButton
            actionKey="brain.published"
            disabled={publishDisabled}
            onClick={() => void publish()}
            variant="primary"
          >
            {busy === "publish" ? "Publishing The Brain" : "Publish to all agents"}
          </LoggedButton>
        </div>
      </div>

      {publishBlocker ? (
        <p className="m-0 text-right text-[12px] text-[color:var(--muted)]" data-slot="publish-blocker">
          {publishBlocker}
        </p>
      ) : null}

      <RehaulTabs
        items={OWNER_BRAIN_TABS.map((id) => ({
          active: tab === id,
          href: tabHref(id),
          label: TAB_LABELS[id],
          ...(id === "review" && pendingReviewCount ? { count: pendingReviewCount } : {}),
          ...(id === "knowledge" && state.knowledge.length ? { count: state.knowledge.length, countTone: "neutral" as const } : {}),
          ...(id === "versions" && state.snapshots.length ? { count: state.snapshots.length, countTone: "neutral" as const } : {}),
        }))}
        label="Brain sections"
      />

      <div className="min-h-0 min-w-0 flex-1">{body}</div>

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

      <ContextEye copy={OWNER_BRAIN_EYE_COPY} screen="owner-brain" />
    </div>
  );
}
