"use client";

/**
 * The owner Brain, redesigned 2026-09-06.
 *
 * One configuration workspace with the test conversation beside it. The rail on the left holds
 * the five things the owner can change (Behavior, Qualification, Knowledge, Safety, Models); the
 * editor in the middle shows one of them; the pane on the right runs a real turn against any coach
 * on the draft or the live version and shows the evidence under every reply. Three views take the
 * whole width because they are work, not settings: reviewing imports, the test suite, and the
 * assembled prompt. History is a drawer and publishing is a sheet, both reached from the header.
 *
 * Every field carries a scope tag so the owner knows who a change reaches: ALL (every agent,
 * always), DEFAULT (a coach can override it from their offer), COACH (comes from the coach's
 * offer), SYSTEM (enforced in code and shown read-only).
 *
 * Every figure comes out of `AdminBrainInitialState` as `admin/brain/page.tsx` loads it, plus the
 * coach and model lists that page now hands over. The Brain draft, evals, publish and rollback go
 * through `brain-api-client`; the test turn, platform content and assembled prompt go through
 * `owner-brain-api`. The design source is `design/brain/build.mjs`.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  MonoMeta,
  STATE_TONE_TO_TONE,
  Segmented,
  Status,
  Surface,
} from "@/components/kit/atomics";
import { Callout } from "@/components/kit/callout";
import { DataState } from "@/components/kit/data-state";
import { ExportMenu } from "@/components/kit/export-menu";
import { Field } from "@/components/kit/field";
import { KeyValue } from "@/components/kit/key-value";
import { LoggedButton } from "@/components/kit/logged-button";
import { RecordSheet } from "@/components/kit/record-sheet";
import type { StateTone } from "@/components/kit/state-badge";
import { TechnicalDetail } from "@/components/kit/technical-detail";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import { Pill, RehaulTabs, StatusDot } from "@/components/workspace/rehaul/_primitives";
import {
  createOwnerBrainApi,
  emptyPlatformContent,
  ownerBrainApiFailure,
  TEST_CHANNELS,
  type AssembledPromptView,
  type OwnerBrainApi,
  type PlatformContentFields,
  type PlatformContentView,
  type TestChannel,
  type TestRevision,
  type TestTurnResult,
} from "@/components/workspace/rehaul/owner-brain-api";
import { createBrainApiClient } from "@/components/workspace/live/brain-api-client";
import { missionFieldCopy } from "@/components/workspace/live/mission-fields";
import {
  draftDiffView,
  evalGateView,
  importReviewView,
  publishReceiptView,
  reasonControlView,
  rollbackReceiptView,
  type AdminBrainInitialState,
  type BrainEvalView,
  type BrainImportRowView,
  type BrainObjectionView,
  type BrainPublishResponse,
} from "@/components/workspace/live/brain-view-models";
import type { ImportDisposition } from "@/lib/brain/contracts";
import { FIGURE_BINDING_FIELDS } from "@/lib/brain/import/flags";
import { OWNER_BRAIN_SECTIONS, type OwnerBrainTab } from "@/lib/console-tabs";
import { QUALIFICATION_OUTCOME_COPY } from "@/lib/copy/states";
import { channelLengthLimits } from "@/lib/engine/output-checks";
import { MODERATOR_CLASSES, type ModeratorClass } from "@/lib/engine/types";
import { workspaceCountFormat, workspaceDateTimeFormat } from "@/lib/format/datetime";

const brainApi = createBrainApiClient();

/* --------------------------------------------------------------------------------------------
 * Props and the small view types the page hands over
 * ------------------------------------------------------------------------------------------ */

export type OwnerBrainCoach = { id: string; name: string; isDemo: boolean };

export type OwnerBrainModel = {
  id: string;
  label: string;
  model: string;
  role: "generator" | "moderator" | null;
  active: boolean;
  moderatorUnavailableCount: number;
};

export type OwnerBrainProps = {
  initialState: AdminBrainInitialState;
  tab: OwnerBrainTab;
  /** The eval evidence surface, rendered on the server and shown inside the Test suite view. */
  evals?: ReactNode;
  /** Every coach tenant the owner may test against, demo tenants included and labelled. */
  coaches?: readonly OwnerBrainCoach[];
  /** Every model configuration, active or parked. */
  models?: readonly OwnerBrainModel[];
  /** Test seam for the redesign's routes. */
  api?: OwnerBrainApi;
};

type KnowledgeRow = AdminBrainInitialState["knowledge"][number];
type ReviewDecision = {
  disposition: ImportDisposition | null;
  tenantId: string | null;
  reviewedFlagIds: string[];
  bindings: Record<string, string>;
  bareTokens: Record<string, string>;
  responseTemplate: string;
  dropReason: string;
};

type TestMessage =
  | { id: string; role: "lead"; text: string }
  | { id: string; role: "agent"; text: string; result: TestTurnResult };

type Scope = "ALL" | "DEFAULT" | "COACH" | "SYSTEM";

const SCOPE_COPY: Record<Scope, string> = {
  ALL: "Every agent, always",
  DEFAULT: "Coach can override",
  COACH: "From their offer",
  SYSTEM: "Enforced in code",
};

const SECTION_LABEL: Record<OwnerBrainTab, string> = {
  behavior: "Behavior",
  qualification: "Qualification",
  knowledge: "Knowledge",
  safety: "Safety",
  models: "Models",
  review: "Review imports",
  suite: "Test suite",
  prompt: "Inspect prompt",
};

/** Which draft entity type each rail section edits, for the amber "differs from live" dot. */
const SECTION_ENTITY: Partial<Record<OwnerBrainTab, string>> = {
  behavior: "mission",
  qualification: "qualification_rule",
  knowledge: "knowledge_entry",
  safety: "compliance_rule",
};

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
  "Coaches can tighten qualification from their offer, with a higher revenue floor or a narrower funding range, but they cannot loosen it.",
  "No Brain table records who changed a row, so nothing here names one. Attribution for every edit is in the audit log.",
  "A test turn runs against test data and never reaches a real lead, but the turn itself is recorded.",
].join(" ");

/** What each changed entity type is called, in the reader's words rather than its column name. */
const ENTITY_LABEL: Readonly<Record<string, string>> = {
  mission: "Behavior",
  qualification_rule: "Qualification rule",
  compliance_rule: "Compliance phrase",
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
    body: "The answer speaks as a named person or carries personal detail, which cannot be shared across every coach's agent. Rewrite it before approving.",
  },
  unbound_figure: {
    title: "A figure with nothing behind it",
    body: "The answer states a number that is not bound to a platform field, so the agent could send a figure nothing published. Bind it before approving.",
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
    body: "The source row was filed under several categories, so retrieval cannot tell which question it answers. Pick one and rewrite.",
  },
  prose_shape: {
    title: "Written as prose, not an answer",
    body: "The row reads as an article rather than something the agent can send as a reply.",
  },
  brand_name: {
    title: "Names the client's business",
    body: "The answer names one business, so it cannot be shared across every coach's agent. Rewrite it to speak for the coach.",
  },
  social_handle: {
    title: "Carries a social handle",
    body: "The answer points at one account, which cannot be shared across every coach's agent.",
  },
  proof_claim: {
    title: "Makes a results claim",
    body: "The answer claims an outcome nothing published backs. Remove the claim or bind it to a coach field.",
  },
};

const HELD_REPLY_COPY: Record<ModeratorClass, string> = {
  NUM: "A number nothing published backs",
  CLAIM: "A guarantee or an outcome claim",
  ECHO: "Repeats a figure the lead typed",
  LINK: "A link nothing published backs",
  SCOPE: "Outside the coach's programme",
  LEN: "Too long for the channel",
  JUDGE: "The moderator model refused it",
  REVOKE: "The lead withdrew consent",
};

const KNOWLEDGE_MODE_COPY: Record<string, string> = {
  inline: "Every published answer is in the prompt",
  retrieved: "Top matches are retrieved per message",
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

function shortHash(value: string) {
  return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value || "no hash";
}

function initialReview(rows: readonly BrainImportRowView[]): Record<string, ReviewDecision> {
  return Object.fromEntries(rows.map((row) => [row.id, {
    disposition: row.disposition,
    tenantId: null,
    reviewedFlagIds: row.flags.filter((flag) => flag.resolved).map((flag) => flag.id),
    bindings: {} as Record<string, string>,
    bareTokens: {} as Record<string, string>,
    responseTemplate: row.responseTemplate,
    dropReason: "",
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

/* --------------------------------------------------------------------------------------------
 * Small pieces the redesign draws that the kit does not carry
 * ------------------------------------------------------------------------------------------ */

/** ALL / DEFAULT / COACH / SYSTEM, the 10px mono tag beside every field title. */
function ScopeTag({ scope }: { scope: Scope }) {
  const face = scope === "ALL"
    ? "bg-[var(--accent-wash)] text-[color:var(--accent-text)]"
    : scope === "COACH"
      ? "border border-[var(--good-line)] text-[color:var(--good-text)]"
      : scope === "SYSTEM"
        ? "border border-[var(--line-soft)] bg-[var(--well)] text-[color:var(--faint)]"
        : "border border-[var(--line-input)] text-[color:var(--muted)]";
  return (
    <span
      className={`mono inline-flex shrink-0 items-center rounded-[4px] px-[6px] py-[1px] text-[10px] leading-[1.4] ${face}`}
      data-scope={scope}
      data-slot="scope-tag"
      title={SCOPE_COPY[scope]}
    >
      {scope}
    </span>
  );
}

/** The 10px mono chip under a test reply and beside a list row. */
function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "crit" }) {
  const face = tone === "good"
    ? "border border-[var(--good-line)] text-[color:var(--good-text)]"
    : tone === "warn"
      ? "bg-[var(--warning-wash)] text-[color:var(--warning-text)]"
      : tone === "crit"
        ? "bg-[var(--critical-wash)] text-[color:var(--critical-text)]"
        : "border border-[var(--line-input)] text-[color:var(--faint)]";
  return (
    <span className={`mono inline-flex max-w-full items-center truncate rounded-[4px] px-[6px] py-[2px] text-[10px] leading-[1.4] ${face}`} data-slot="chip">
      {children}
    </span>
  );
}

function Over({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`text-[11px] font-[600] tracking-[0.085em] text-[color:var(--faint)] ${className}`}>
      {children}
    </div>
  );
}

function SectionHead({ right, sub, title }: { right?: ReactNode; sub: string; title: string }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-[var(--s-3)]">
      <div className="flex min-w-0 flex-col gap-[4px]">
        <h2 className="m-0 text-[16px] leading-[1.35] font-[600] tracking-[-0.008em] text-[color:var(--ink)]">{title}</h2>
        <p className="m-0 text-[13px] text-[color:var(--muted)]">{sub}</p>
      </div>
      {right ? <div className="flex flex-wrap items-center gap-[8px]">{right}</div> : null}
    </div>
  );
}

function ListCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col overflow-hidden rounded-[11px] border border-[var(--line)] bg-[var(--card)] ${className}`}>
      {children}
    </div>
  );
}

function ListRow({ children, className = "", onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  const face = `flex items-center gap-[12px] border-b border-[var(--line-soft)] px-[14px] py-[12px] text-left last:border-b-0 ${className}`;
  if (onClick) {
    return (
      <button className={`${face} w-full hover:bg-[var(--row-hover)]`} onClick={onClick} type="button">
        {children}
      </button>
    );
  }
  return <div className={face}>{children}</div>;
}

/** A titled block: the field's name, its scope tag, an optional note, and the control under it. */
function FieldBlock({
  children,
  hint,
  locked,
  note,
  scope,
  title,
}: {
  children: ReactNode;
  hint?: string;
  locked?: boolean;
  note?: string;
  scope: Scope;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-[8px]">
      <div className="flex flex-wrap items-center gap-[8px]">
        <span className="text-[14px] leading-[1.3] font-[500] text-[color:var(--ink)]">{title}</span>
        <ScopeTag scope={scope} />
        {locked ? <MonoMeta className="text-[color:var(--faint)]">read only</MonoMeta> : null}
        {note ? <span className="text-[12px] text-[color:var(--faint)]">{note}</span> : null}
      </div>
      {hint ? <p className="m-0 -mt-[4px] text-[12px] text-[color:var(--faint)]">{hint}</p> : null}
      {children}
    </div>
  );
}

/** The read-only well a SYSTEM value sits in. */
function LockedText({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[8px] border border-[var(--line-soft)] bg-[var(--well)] px-[14px] py-[12px] text-[15px] leading-[1.55] text-[color:var(--muted)]">
      {children}
    </div>
  );
}

function ScopeLegend() {
  return (
    <div className="flex flex-col gap-[6px] rounded-[11px] border border-[var(--line-soft)] bg-[var(--well)] px-[10px] py-[12px]">
      <Over>HOW SETTINGS APPLY</Over>
      {(Object.keys(SCOPE_COPY) as Scope[]).map((scope) => (
        <div className="flex items-center gap-[8px] text-[12px] text-[color:var(--body)]" key={scope}>
          <ScopeTag scope={scope} />
          {SCOPE_COPY[scope]}
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------------------------------
 * The screen
 * ------------------------------------------------------------------------------------------ */

export function OwnerBrain({
  api,
  coaches = [],
  evals,
  initialState,
  models = [],
  tab,
}: OwnerBrainProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const ownerApi = useMemo(() => api ?? createOwnerBrainApi(), [api]);

  const [state, setState] = useState(initialState);
  const [review, setReview] = useState(() => initialReview(initialState.importRows));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [publishReason, setPublishReason] = useState("");
  const [publishReasonTouched, setPublishReasonTouched] = useState(false);
  const [rollbackReason, setRollbackReason] = useState("");
  const [rollbackReasonTouched, setRollbackReasonTouched] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(initialState.snapshots[1]?.version ?? null);
  const [publishResponse, setPublishResponse] = useState<BrainPublishResponse | null>(null);
  const [rollbackResponse, setRollbackResponse] = useState<unknown>(null);
  const [decidedRows, setDecidedRows] = useState<Record<string, "accepted" | "rejected">>({});
  const [selectedImportId, setSelectedImportId] = useState<string | null>(null);
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeFilter, setKnowledgeFilter] = useState<"all" | "published" | "draft">("all");
  const [knowledgeSheet, setKnowledgeSheet] = useState<KnowledgeRow | null>(null);
  const [objectionSheet, setObjectionSheet] = useState<BrainObjectionView | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Platform content: the sentences the engine reads outside the Brain draft.
  const [platform, setPlatform] = useState<PlatformContentView | null>(null);
  const [platformEdit, setPlatformEdit] = useState<PlatformContentFields | null>(null);
  const [platformError, setPlatformError] = useState<string | null>(null);
  const [platformSavedAt, setPlatformSavedAt] = useState<string | null>(null);
  const [platformReason, setPlatformReason] = useState("");

  // The test conversation.
  const defaultCoach = coaches.find((coach) => coach.isDemo) ?? coaches[0] ?? null;
  const [testCoachId, setTestCoachId] = useState<string>(defaultCoach?.id ?? "");
  const [testChannel, setTestChannel] = useState<TestChannel>("sms");
  const [testRevision, setTestRevision] = useState<TestRevision>("draft");
  const [testMessages, setTestMessages] = useState<TestMessage[]>([]);
  const [testDraft, setTestDraft] = useState("");
  const [testError, setTestError] = useState<string | null>(null);
  const testEndRef = useRef<HTMLDivElement | null>(null);

  // The assembled prompt.
  const [promptCoachId, setPromptCoachId] = useState<string>(defaultCoach?.id ?? "");
  const [promptRevision, setPromptRevision] = useState<TestRevision>("draft");
  const promptKey = `${promptCoachId}:${promptRevision}`;
  const [promptResult, setPromptResult] = useState<{ key: string; view: AssembledPromptView | null; error: string | null } | null>(null);
  const prompt = promptResult?.key === promptKey ? promptResult.view : null;
  const promptError = promptResult?.key === promptKey ? promptResult.error : null;
  const [openBlocks, setOpenBlocks] = useState<Record<string, boolean>>({});
  const [promptCopied, setPromptCopied] = useState(false);

  const gate = evalGateView(state.eval);
  const publishReceipt = publishReceiptView(publishResponse);
  const rollbackReceipt = rollbackReceiptView(rollbackResponse);
  const diff = useMemo(
    () => draftDiffView(state.currentSnapshotPayload, state.draft?.payload ?? null),
    [state.currentSnapshotPayload, state.draft],
  );
  const currentVersion = state.snapshots[0]?.version ?? 0;
  const pendingRows = state.importRows.filter((row) => row.decision === "pending" && !decidedRows[row.id]);
  const pendingReviewCount = pendingRows.length;
  // The live count comes from the snapshot's own entries when the page could read them: the
  // `status` column says "published" for rows the publish RPC never copied.
  const publishedKnowledgeCount = state.knowledgePublish?.inLiveSnapshot
    ?? state.knowledge.filter((row) => row.status === "published").length;
  const draftKnowledgeCount = state.knowledgePublish?.draftAwaitingPublish
    ?? state.knowledge.length - publishedKnowledgeCount;
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
        ? "Run the test suite for this draft first."
        : !gate.canPublish
          ? `${state.eval.blockers.length} safety ${state.eval.blockers.length === 1 ? "issue blocks" : "issues block"} publishing.`
          : !publishReasonControl.enabled
            ? "Add a note for history below."
            : null;
  const publishDisabled = publishBlocker !== null || busy !== null;
  const qualificationReady = state.qualificationApproved && state.qualificationSource === "platform";

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
  const knowledgeMode = state.draft?.payload.knowledgeMode === "retrieved"
    ? "retrieved"
    : state.snapshots[0]?.knowledgeMode ?? "inline";

  const mission = useCallback(
    (label: string) => state.mission.find((item) => item.label === label),
    [state.mission],
  );

  function setMissionText(label: string, text: string) {
    setState((current) => ({
      ...current,
      mission: current.mission.map((row) => row.label === label ? { ...row, text } : row),
    }));
  }

  function tabHref(next: OwnerBrainTab) {
    const query = new URLSearchParams(searchParams?.toString() ?? "");
    query.set("tab", next);
    return `${pathname}?${query.toString()}`;
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

  /* ---------------------------------------------------------------------------------------
   * Platform content
   * ------------------------------------------------------------------------------------- */

  const needsPlatform = tab === "behavior" || tab === "safety";
  useEffect(() => {
    if (!needsPlatform || platform !== null || platformError !== null) return;
    let cancelled = false;
    ownerApi.readPlatformContent()
      .then((view) => {
        if (cancelled) return;
        setPlatform(view);
        setPlatformEdit(view.draft ?? view.live);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setPlatformError(ownerBrainApiFailure(cause));
      });
    return () => { cancelled = true; };
  }, [needsPlatform, ownerApi, platform, platformError]);

  const platformDirty = platform !== null && platformEdit !== null
    && JSON.stringify(platformEdit) !== JSON.stringify(platform.draft ?? platform.live);
  const platformDraftPending = Boolean(platform?.draft && platform.draftHash);

  function updatePlatform(update: Partial<PlatformContentFields>) {
    setPlatformEdit((current) => ({ ...(current ?? emptyPlatformContent()), ...update }));
  }

  async function savePlatformDraft() {
    if (!platformEdit) return;
    await runAction("platform", async () => {
      const view = await ownerApi.savePlatformContentDraft(platformEdit);
      setPlatform(view);
      setPlatformEdit(view.draft ?? view.live);
      setPlatformSavedAt(new Date().toISOString());
    });
  }

  async function approvePlatform() {
    if (!platform?.draftHash || !reasonControlView(platformReason).enabled) return;
    await runAction("platform-approve", async () => {
      const view = await ownerApi.approvePlatformContent({ expectedDraftHash: platform.draftHash!, reason: platformReason.trim() });
      setPlatform(view);
      setPlatformEdit(view.draft ?? view.live);
      setPlatformReason("");
    });
  }

  /* ---------------------------------------------------------------------------------------
   * Import review
   * ------------------------------------------------------------------------------------- */

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

  function nextPendingAfter(rowId: string) {
    const remaining = pendingRows.filter((row) => row.id !== rowId);
    return remaining[0]?.id ?? null;
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
      await ownerApi.acceptImportItem({
        batchId: row.batchId,
        itemId: row.id,
        sourceRef: row.sourceRef,
        disposition: decision.disposition!,
        tenantId: decision.disposition === "tenant_specific" ? decision.tenantId : null,
        edit: decision.responseTemplate.trim() !== row.responseTemplate.trim()
          ? { responseTemplate: decision.responseTemplate.trim() }
          : null,
        resolvedFlagIds: resolvedFlagIds(row),
        numberBindings,
        bareXResolutions,
      });
      setDecidedRows((current) => ({ ...current, [row.id]: "accepted" }));
      setSelectedImportId(nextPendingAfter(row.id));
      router.refresh();
    });
  }

  async function reject(row: BrainImportRowView) {
    const decision = review[row.id];
    if (!decision?.dropReason.trim()) return;
    await runAction(`reject:${row.id}`, async () => {
      await ownerApi.rejectImportItem({ batchId: row.batchId, itemId: row.id, reason: decision.dropReason.trim() });
      setDecidedRows((current) => ({ ...current, [row.id]: "rejected" }));
      setSelectedImportId(nextPendingAfter(row.id));
      router.refresh();
    });
  }

  /* ---------------------------------------------------------------------------------------
   * Draft, evals, publish, rollback
   * ------------------------------------------------------------------------------------- */

  async function createDraft() {
    await runAction("draft", async () => {
      const payload = await brainApi.createDraft(draftPayload(state));
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
      const payload = await brainApi.runEval({ draftId: state.draft!.id, contentHash: state.draft!.contentHash });
      setState((current) => ({ ...current, eval: persistedEval(payload) }));
    });
  }

  async function publish() {
    if (!state.draft || !state.eval.runId || !reasonControlView(publishReason).enabled) return;
    await runAction("publish", async () => {
      const response = await brainApi.publish({
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
      const response = await brainApi.rollback({
        expectedCurrentVersion: currentVersion,
        selectedVersion,
        reason: rollbackReason,
      });
      setRollbackResponse(response);
      router.refresh();
    });
  }

  /* ---------------------------------------------------------------------------------------
   * Test conversation
   * ------------------------------------------------------------------------------------- */

  async function sendTestTurn() {
    const message = testDraft.trim();
    if (!message || !testCoachId || busy !== null) return;
    const history = testMessages.map((item) => ({
      role: item.role === "lead" ? "user" as const : "assistant" as const,
      content: item.text,
    }));
    const leadId = `lead-${Date.now()}`;
    setTestMessages((current) => [...current, { id: leadId, role: "lead", text: message }]);
    setTestDraft("");
    setTestError(null);
    setBusy("test-turn");
    try {
      const result = await ownerApi.runTestTurn({
        coachTenantId: testCoachId,
        revision: testRevision,
        channel: testChannel,
        message,
        history,
      });
      setTestMessages((current) => [...current, { id: `agent-${Date.now()}`, role: "agent", text: result.reply, result }]);
    } catch (cause) {
      setTestError(ownerBrainApiFailure(cause));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (!testMessages.length) return;
    const end = testEndRef.current;
    if (end && typeof end.scrollIntoView === "function") end.scrollIntoView({ block: "end" });
  }, [testMessages.length]);

  /* ---------------------------------------------------------------------------------------
   * Assembled prompt
   * ------------------------------------------------------------------------------------- */

  useEffect(() => {
    if (tab !== "prompt" || !promptCoachId) return;
    let cancelled = false;
    const key = `${promptCoachId}:${promptRevision}`;
    ownerApi.readAssembledPrompt({ coachTenantId: promptCoachId, revision: promptRevision })
      .then((view) => {
        if (cancelled) return;
        setPromptResult({ key, view, error: null });
        setOpenBlocks(Object.fromEntries(view.blocks.map((block, index) => [block.label || String(index), index === 0])));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setPromptResult({ key, view: null, error: ownerBrainApiFailure(cause) });
      });
    return () => { cancelled = true; };
  }, [ownerApi, promptCoachId, promptRevision, tab]);

  async function copyPrompt() {
    if (!prompt) return;
    const text = prompt.blocks.map((block) => `${block.label} ${block.title}\n${block.text}`).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setPromptCopied(true);
      window.setTimeout(() => setPromptCopied(false), 1500);
    } catch {
      setPromptResult({ key: promptKey, view: prompt, error: "The prompt could not be copied to the clipboard." });
    }
  }

  /* ---------------------------------------------------------------------------------------
   * Editors
   * ------------------------------------------------------------------------------------- */

  const draftSavedMeta = state.draft
    ? <MonoMeta className="text-[color:var(--faint)]">Draft saved {displayTime(state.draft.createdAt)}</MonoMeta>
    : <MonoMeta className="text-[color:var(--faint)]">No saved draft</MonoMeta>;

  const saveDraftControl = (
    <div className="flex flex-col items-end gap-[2px]">
      <Button disabled={busy !== null} onClick={() => void createDraft()} type="button" variant="outline">
        {busy === "draft" ? "Saving draft" : "Save draft"}
      </Button>
      {/*
        * Not a `LoggedButton`: `AUDIT_ACTIONS` has no key for a draft revision and
        * `src/lib/audit/actions.ts` is not this page's file to add one to. The microcopy is the
        * part a reader needs, so it goes beside the button on its own.
        */}
      <MonoMeta aria-label="Draft revision recorded in the audit log">Logged</MonoMeta>
    </div>
  );

  const platformControls = platform ? (
    <div className="flex flex-wrap items-center gap-[8px]">
      {platformSavedAt ? <MonoMeta className="text-[color:var(--faint)]">Saved {displayTime(platformSavedAt)}</MonoMeta> : null}
      <Button
        disabled={!platformDirty || busy !== null}
        onClick={() => void savePlatformDraft()}
        type="button"
        variant="outline"
      >
        {busy === "platform" ? "Saving" : "Save platform text"}
      </Button>
      {platformDraftPending ? (
        <div className="flex flex-wrap items-end gap-[8px]">
          <Input
            aria-label="Why approve the platform text"
            className="w-[220px]"
            onChange={(event) => setPlatformReason(event.target.value)}
            placeholder="Why, for history"
            value={platformReason}
          />
          <div className="flex flex-col items-end gap-[2px]">
            <Button
              disabled={busy !== null || !platform.canApprove || !reasonControlView(platformReason).enabled}
              onClick={() => void approvePlatform()}
              title={platform.canApprove ? undefined : `Blocked: ${platform.blockers.join(", ")}`}
              type="button"
              variant="outline"
            >
              {busy === "platform-approve" ? "Approving" : "Approve for every agent"}
            </Button>
            <MonoMeta aria-label="Approval recorded in the audit log">Logged</MonoMeta>
          </div>
        </div>
      ) : null}
    </div>
  ) : null;
  const platformBlockerNote = platform && platformDraftPending && !platform.canApprove ? (
    <p className="m-0 text-[12px] text-[color:var(--muted)]" data-slot="platform-blocker">
      Approval is blocked until these slots are filled: {platform.blockers.join(", ")}. They have no editor here yet.
    </p>
  ) : null;

  function platformField(key: keyof Omit<PlatformContentFields, "heldReplies">, title: string, hint: string) {
    if (platformError) {
      return (
        <FieldBlock scope="ALL" title={title}>
          <LockedText>{platformError}</LockedText>
        </FieldBlock>
      );
    }
    if (!platformEdit) {
      return (
        <FieldBlock scope="ALL" title={title}>
          <LockedText>Loading the approved text</LockedText>
        </FieldBlock>
      );
    }
    const live = platform?.live[key] ?? "";
    const note = platform && platform.approved === null
      ? "seed text, not approved yet"
      : platformEdit[key] !== live
        ? "differs from the live text"
        : undefined;
    return (
      <FieldBlock hint={hint} note={note} scope="ALL" title={title}>
        <Textarea
          aria-label={title}
          onChange={(event) => updatePlatform({ [key]: event.target.value } as Partial<PlatformContentFields>)}
          rows={3}
          value={platformEdit[key]}
        />
      </FieldBlock>
    );
  }

  function missionField(label: string, scope: Scope, title?: string, hint?: string, note?: string) {
    const item = mission(label);
    const copy = missionFieldCopy(label);
    if (!item) {
      return (
        <FieldBlock scope={scope} title={title ?? copy.title}>
          <LockedText>No saved value. The draft has no {copy.title.toLowerCase()} field.</LockedText>
        </FieldBlock>
      );
    }
    return (
      <FieldBlock hint={hint ?? copy.help} note={note} scope={scope} title={title ?? copy.title}>
        <Textarea
          aria-label={title ?? copy.title}
          onChange={(event) => setMissionText(label, event.target.value)}
          rows={3}
          value={item.text}
        />
      </FieldBlock>
    );
  }

  const behaviorEditor = (
    <>
      <SectionHead
        right={<>{draftSavedMeta}{saveDraftControl}{platformControls}</>}
        sub="What the agent is, how it sounds, and when it books, keeps qualifying, or hands over."
        title="Behavior"
      />
      {missionField("identity", "ALL")}
      {platformField(
        "automatedExperienceDisclosure",
        "First-message disclosure",
        "Sent once, in front of the agent's first reply. Required by policy; wording is yours.",
      )}
      {missionField("goal", "ALL")}
      {missionField("tone", "DEFAULT")}
      {platformField(
        "roleBoundary",
        "Where the agent stops",
        "What the agent stays inside, and what it leaves to a person.",
      )}
      {platformBlockerNote}
      <p className="m-0 text-[12px] text-[color:var(--faint)]">
        Booking rules live in <Link className="text-[color:var(--accent-text)] no-underline" href={tabHref("qualification")}>Qualification</Link>; what the agent must never say lives in <Link className="text-[color:var(--accent-text)] no-underline" href={tabHref("safety")}>Safety</Link>.
      </p>
    </>
  );

  const qualificationEditor = (
    <>
      <SectionHead
        right={<>{draftSavedMeta}{saveDraftControl}</>}
        sub="What the agent checks, in order, and the rules that decide book, nurture or decline."
        title="Qualification"
      />
      {missionField("criteria", "ALL")}
      <div className="flex flex-col gap-[8px]">
        <div className="flex flex-wrap items-center justify-between gap-[8px]">
          <Over>RULES · FIRST MATCH WINS</Over>
          <div className="flex items-center gap-[8px]">
            <Status
              label={qualificationReady ? "Approved" : "Draft, unapproved"}
              tone={qualificationReady ? "good" : "draft"}
              treatment="bare"
            />
            <ExportMenu
              filename="setterfi-brain-qualification"
              label="Export rules"
              mode="local"
              rows={state.qualification}
            />
          </div>
        </div>
        {state.qualification.length ? (
          <ListCard>
            {state.qualification.map((rule) => {
              const copy = QUALIFICATION_OUTCOME_COPY[rule.outcome as keyof typeof QUALIFICATION_OUTCOME_COPY];
              const tone = copy?.tone === "good" ? "good" : copy?.tone === "warning" ? "warn" : copy?.tone === "critical" ? "crit" : "neutral";
              return (
                <ListRow key={rule.id}>
                  <MonoMeta className="w-[28px] shrink-0 text-[11px] text-[color:var(--faint)]">{rule.position}</MonoMeta>
                  <span className="min-w-0 flex-1 text-[14px] font-[500] text-[color:var(--ink)]">{rule.label}</span>
                  <Chip tone={tone}>{copy?.label ?? humanize(rule.outcome)}</Chip>
                  <ScopeTag scope="ALL" />
                </ListRow>
              );
            })}
          </ListCard>
        ) : (
          <DataState body="Add a qualification rule to define the first decision row." kind="empty" title="No qualification rules" />
        )}
      </div>
      {missionField("dq", "DEFAULT", "How to close when a lead is declined")}
    </>
  );

  const knowledgeRows = useMemo(() => {
    const query = knowledgeQuery.trim().toLowerCase();
    return state.knowledge.filter((row) => {
      if (knowledgeFilter !== "all" && row.status !== knowledgeFilter) return false;
      if (!query) return true;
      return `${row.inboundMessage} ${row.responseTemplate} ${row.category}`.toLowerCase().includes(query);
    });
  }, [knowledgeFilter, knowledgeQuery, state.knowledge]);

  const knowledgeEditor = (
    <>
      <SectionHead
        right={
          <>
            <div className="flex flex-col items-end gap-[2px]">
              <Button
                disabled={busy !== null}
                onClick={() => void runAction("import", async () => { await brainApi.importConfigured(); router.refresh(); })}
                type="button"
                variant="outline"
              >
                {busy === "import" ? "Importing" : "Import"}
              </Button>
              <MonoMeta aria-label="Import batch recorded in the audit log">Logged</MonoMeta>
            </div>
            <Button
              nativeButton={false}
              render={<Link href={tabHref("review")} />}
              variant={pendingReviewCount ? "default" : "outline"}
            >
              {pendingReviewCount
                ? `Review ${workspaceCountFormat.format(pendingReviewCount)} ${pendingReviewCount === 1 ? "import" : "imports"}`
                : "Review imports"}
            </Button>
          </>
        }
        sub="Approved answers the agent may use, and how it handles objections."
        title="Knowledge"
      />
      <div className="flex flex-wrap items-center gap-[8px]">
        <Input
          aria-label="Search answers"
          className="min-w-[200px] flex-1"
          onChange={(event) => setKnowledgeQuery(event.target.value)}
          placeholder="Search answers"
          value={knowledgeQuery}
        />
        <Segmented
          label="Knowledge filter"
          onValueChange={(next) => setKnowledgeFilter(next as "all" | "published" | "draft")}
          options={[
            { key: "all", label: "All", count: state.knowledge.length },
            { key: "published", label: "Live", count: publishedKnowledgeCount },
            { key: "draft", label: "Draft", count: draftKnowledgeCount },
          ]}
          value={knowledgeFilter}
        />
        <ExportMenu
          filename="setterfi-brain-knowledge"
          label="Export answers"
          mode="server"
          query={{ reason: "", status: "all", order: "created_desc", columns: ["id", "category", "source", "sourceRef", "disposition", "status", "question", "responseTemplate"] }}
          resource="brain-knowledge-entries"
        />
      </div>
      {knowledgeRows.length ? (
        <ListCard>
          {knowledgeRows.map((row) => (
            <ListRow key={row.id} onClick={() => setKnowledgeSheet(row)}>
              <StatusDot tone={row.status === "published" ? "good" : "amber"} />
              <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                <span className="truncate text-[14px] font-[500] text-[color:var(--ink)]">{row.inboundMessage || "No inbound message saved"}</span>
                <span className="truncate text-[12px] text-[color:var(--muted)]">
                  {row.status === "published"
                    ? row.responseTemplate || "No response template saved"
                    : `Not yet published. Drafted ${displayTime(row.updatedAt ?? null)}.`}
                </span>
              </span>
              <Chip>{humanize(row.category)}</Chip>
              {row.status !== "published" ? <Chip tone="warn">Draft</Chip> : null}
              <ScopeTag scope="ALL" />
            </ListRow>
          ))}
        </ListCard>
      ) : (
        <DataState
          body={state.knowledge.length ? "No answer matches this search." : "Approve an import row to populate shared knowledge."}
          kind="empty"
          title={state.knowledge.length ? "No matching answers" : "No answers yet"}
        />
      )}
      <div className="flex flex-col gap-[8px]">
        <div className="flex flex-wrap items-center justify-between gap-[8px]">
          <Over>OBJECTIONS</Over>
          <ExportMenu
            filename="setterfi-brain-objections"
            label="Export objections"
            mode="server"
            query={{ reason: "", status: "all", order: "created_desc", columns: ["id", "label", "category", "hardGate", "status", "matchKeywords", "response", "publishedAt"] }}
            resource="brain-objections"
          />
        </div>
        {state.objections.length ? (
          <ListCard>
            {state.objections.map((objection) => (
              <ListRow key={objection.id} onClick={() => setObjectionSheet(objection)}>
                <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                  <span className="truncate text-[14px] font-[500] text-[color:var(--ink)]">{objection.label}</span>
                  <span className="truncate text-[12px] text-[color:var(--muted)]">
                    {humanize(objection.category)} · {objection.hardGate ? "the approved response is sent word for word" : "the agent may rephrase around the approved response"}
                  </span>
                </span>
                <Chip tone={objection.hardGate ? "warn" : "neutral"}>{objection.hardGate ? "Hard-gated" : "Flexible"}</Chip>
                {objection.status !== "published" ? <Chip tone="warn">Draft</Chip> : null}
                <ScopeTag scope={objection.hardGate ? "ALL" : "DEFAULT"} />
              </ListRow>
            ))}
          </ListCard>
        ) : (
          <DataState body="Add an objection response to populate this list." kind="empty" title="No objections yet" />
        )}
      </div>
    </>
  );

  const safetyEditor = (
    <>
      <SectionHead
        right={<>{draftSavedMeta}{saveDraftControl}{platformControls}</>}
        sub="What the agent must never say, what happens when a reply is blocked, and what the system enforces on its own."
        title="Safety"
      />
      <div className="flex flex-col gap-[8px]">
        <div className="flex flex-wrap items-center gap-[8px]">
          <Over>ENFORCED BY THE SYSTEM</Over>
          <span className="text-[12px] text-[color:var(--faint)]">Applies before anything you write. Not editable.</span>
        </div>
        <ListCard>
          <ListRow>
            <span className="min-w-0 flex-1 text-[13px] text-[color:var(--muted)]">
              Scope: one coach’s offer only · lead text is never an instruction · nobody in the chat can grant permissions · never reveal configuration · only numbers, prices and links from the coach data or the Brain
            </span>
            <ScopeTag scope="SYSTEM" />
          </ListRow>
          <ListRow>
            <span className="min-w-0 flex-1 text-[13px] text-[color:var(--muted)]">
              Every draft reply is checked for invented numbers, unsupported claims, echoed lead numbers, unknown links, off-scope content and length, then reviewed by the moderator model.
            </span>
            <ScopeTag scope="SYSTEM" />
          </ListRow>
          <ListRow>
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-[6px]">
              <span className="text-[13px] text-[color:var(--muted)]">Reply length caps</span>
              {TEST_CHANNELS.map((channel) => {
                const limits = channelLengthLimits(channel);
                return <Chip key={channel}>{humanize(channel)} {limits.soft} / {limits.hard}</Chip>;
              })}
            </span>
            <ScopeTag scope="SYSTEM" />
          </ListRow>
        </ListCard>
      </div>
      {missionField("guardrails", "ALL", "Never promise or state")}
      <div className="flex flex-col gap-[8px]">
        <div className="flex flex-wrap items-center justify-between gap-[8px]">
          <Over>COMPLIANCE PHRASES · BLOCK IF THE REPLY CONTAINS</Over>
          <ExportMenu filename="setterfi-brain-compliance" label="Export phrases" mode="local" rows={state.compliance} />
        </div>
        {state.compliance.length ? (
          <ListCard>
            {state.compliance.map((rule) => (
              <ListRow key={rule.id}>
                <MonoMeta className="w-[96px] shrink-0 truncate text-[11px] text-[color:var(--faint)]">{rule.slug}</MonoMeta>
                <span className="min-w-0 flex-1 text-[14px] text-[color:var(--body)]">
                  {rule.phrase ? `“${rule.phrase}”` : <span className="text-[color:var(--faint)]">Mechanical check, no phrase</span>}
                </span>
                <Chip tone={rule.severity === "block" || rule.severity === "critical" ? "crit" : "warn"}>{humanize(rule.severity)}</Chip>
                <ScopeTag scope="ALL" />
              </ListRow>
            ))}
          </ListCard>
        ) : (
          <DataState body="Add a compliance phrase before publishing this configuration." kind="empty" title="No compliance phrases" />
        )}
      </div>
      <div className="flex flex-col gap-[8px]">
        <Over>WHAT THE LEAD SEES WHEN A REPLY IS BLOCKED</Over>
        <p className="m-0 -mt-[4px] text-[12px] text-[color:var(--faint)]">One holding message per reason. Sent instead of the blocked reply while a person is notified.</p>
        {platformError ? (
          <LockedText>{platformError}</LockedText>
        ) : !platformEdit ? (
          <LockedText>Loading the approved text</LockedText>
        ) : (
          <ListCard>
            {MODERATOR_CLASSES.map((cls) => (
              <div className="flex flex-col gap-[6px] border-b border-[var(--line-soft)] px-[14px] py-[12px] last:border-b-0" key={cls}>
                <div className="flex flex-wrap items-center gap-[8px]">
                  <MonoMeta className="w-[64px] shrink-0 text-[11px] text-[color:var(--faint)]">{cls}</MonoMeta>
                  <span className="min-w-0 flex-1 text-[12px] text-[color:var(--muted)]">{HELD_REPLY_COPY[cls]}</span>
                  <ScopeTag scope="ALL" />
                </div>
                <Textarea
                  aria-label={`Holding message for ${cls}`}
                  onChange={(event) => updatePlatform({ heldReplies: { ...platformEdit.heldReplies, [cls]: event.target.value } })}
                  rows={2}
                  value={platformEdit.heldReplies[cls]}
                />
              </div>
            ))}
          </ListCard>
        )}
        {platformBlockerNote}
      </div>
    </>
  );

  const activeGenerator = models.find((model) => model.active && model.role === "generator") ?? null;
  const activeModerator = models.find((model) => model.active && model.role === "moderator") ?? null;
  const parked = models.filter((model) => !model.active);

  function modelCard(role: string, model: OwnerBrainModel | null, sub: string) {
    return (
      <div className="flex flex-1 flex-col gap-[12px] rounded-[11px] border border-[var(--line)] bg-[var(--card)] p-[16px]">
        <Over>{role}</Over>
        <div className="flex min-h-[40px] items-center justify-between rounded-[8px] border border-[var(--line-input)] bg-[var(--well)] px-[12px] text-[14px] font-[500] text-[color:var(--ink)]">
          {model ? model.label : <span className="text-[color:var(--faint)]">No active configuration</span>}
        </div>
        <p className="m-0 text-[12px] text-[color:var(--muted)]">{model ? sub : "Nothing sends until one is active."}</p>
        <div className="flex flex-wrap gap-[6px]">
          {model ? <Chip tone="good">Live</Chip> : <Chip tone="warn">None</Chip>}
          {model ? <Chip>{model.model}</Chip> : null}
          {model?.role === "moderator" ? <Chip>{workspaceCountFormat.format(model.moderatorUnavailableCount)} unavailable</Chip> : null}
          <ScopeTag scope="ALL" />
        </div>
      </div>
    );
  }

  const modelsEditor = (
    <>
      <SectionHead
        sub="The model that writes replies and the model that reviews them. Changing either needs a test-suite pass before publish."
        title="Models"
      />
      <div className="flex flex-col gap-[16px] md:flex-row">
        {modelCard("WRITES REPLIES", activeGenerator, "Drafts every reply to a lead.")}
        {modelCard("REVIEWS REPLIES", activeModerator, "Sees the draft reply, the coach data and the compliance phrases. Blocks or approves.")}
      </div>
      <div className="flex flex-col gap-[8px]">
        <div className="flex flex-wrap items-center justify-between gap-[8px]">
          <Over>CHALLENGERS</Over>
          <Link className="text-[12px] text-[color:var(--accent-text)] no-underline" href={tabHref("suite")}>Compare on the test suite</Link>
        </div>
        {parked.length ? (
          <ListCard>
            {parked.map((model) => (
              <ListRow key={model.id}>
                <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                  <span className="truncate text-[14px] font-[500] text-[color:var(--ink)]">{model.label}</span>
                  <span className="text-[12px] text-[color:var(--muted)]">Parked. Never sends to a lead until promoted from the test suite.</span>
                </span>
                <Chip>{model.model}</Chip>
                <Chip>Parked</Chip>
              </ListRow>
            ))}
          </ListCard>
        ) : (
          <DataState body="Every configuration is active. Add one to compare it on the test suite." kind="empty" title="No parked configuration" />
        )}
      </div>
      <div className="flex flex-col gap-[8px]">
        <button
          aria-expanded={advancedOpen}
          className="flex items-center gap-[8px] text-left"
          onClick={() => setAdvancedOpen((open) => !open)}
          type="button"
        >
          <Over>ADVANCED</Over>
          <span aria-hidden="true" className="text-[11px] text-[color:var(--faint)]">{advancedOpen ? "▲" : "▼"}</span>
        </button>
        {advancedOpen ? (
          <ListCard>
            <ListRow>
              <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                <span className="text-[14px] font-[500] text-[color:var(--ink)]">Knowledge mode</span>
                <span className="text-[12px] text-[color:var(--muted)]">{KNOWLEDGE_MODE_COPY[knowledgeMode] ?? humanize(knowledgeMode)}</span>
              </span>
              <Chip>{knowledgeMode}</Chip>
              <ScopeTag scope="SYSTEM" />
            </ListRow>
            <ListRow>
              <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                <span className="text-[14px] font-[500] text-[color:var(--ink)]">Platform tokens on the live version</span>
                <span className="text-[12px] text-[color:var(--muted)]">What the shared prompt costs before any coach data or knowledge is added.</span>
              </span>
              <Chip>{state.snapshots[0] ? `${workspaceCountFormat.format(state.snapshots[0].platformTokens)} tokens` : "no live version"}</Chip>
              <ScopeTag scope="SYSTEM" />
            </ListRow>
          </ListCard>
        ) : (
          <p className="m-0 text-[12px] text-[color:var(--faint)]">Knowledge mode and prompt size. Collapsed because nobody should be touching these weekly.</p>
        )}
      </div>
    </>
  );

  /* ---------------------------------------------------------------------------------------
   * Full-width views
   * ------------------------------------------------------------------------------------- */

  const backToEditing = (
    <Button nativeButton={false} render={<Link href={tabHref("behavior")} />} variant="outline">
      Back to editing
    </Button>
  );

  const reviewRows = state.importRows.filter((row) => row.decision === "pending" || decidedRows[row.id]);
  const cleanRows = pendingRows.filter((row) => row.flags.every((flag) => flag.resolved));
  const selectedImport = reviewRows.find((row) => row.id === selectedImportId) ?? pendingRows[0] ?? null;

  function rowWhy(row: BrainImportRowView) {
    const decided = decidedRows[row.id] ?? (row.decision !== "pending" ? row.decision : null);
    if (decided === "accepted") return { label: "Approved to draft", tone: "good" as const };
    if (decided === "rejected") return { label: "Dropped", tone: "neutral" as const };
    const blocking = row.flags.find((flag) => !flag.resolved);
    return blocking ? { label: flagCopy(blocking.code).title, tone: "warn" as const } : { label: "Clean", tone: "good" as const };
  }

  const reviewView = (
    <div className="flex min-h-0 flex-1 flex-col gap-[20px]">
      <SectionHead
        right={
          <>
            <Status label={importSummary.label} tone={STATE_TONE_TO_TONE[importSummary.tone]} treatment="bare" />
            <ExportMenu filename="setterfi-brain-import-items" label="Export import rows" mode="server" query={{ reason: "", order: "created_desc", columns: ["id", "batchId", "sourceRef", "operation", "decision", "disposition", "flagCount", "decidedAt"] }} resource="brain-import-items" />
            <Button nativeButton={false} render={<Link href={tabHref("knowledge")} />} variant="outline">Back to Knowledge</Button>
          </>
        }
        sub={state.batch
          ? `${workspaceCountFormat.format(pendingReviewCount)} ${pendingReviewCount === 1 ? "answer" : "answers"} from the last import. Approve, edit, or drop each one.`
          : "Run an import to fill this queue."}
        title="Review imports"
      />
      {reviewRows.length ? (
        <div className="flex min-h-0 flex-1 flex-col gap-[16px] lg:flex-row">
          <div className="flex w-full shrink-0 flex-col gap-[8px] lg:w-[300px]">
            <div className="flex flex-wrap gap-[6px]">
              <Chip tone="warn">Needs a look {workspaceCountFormat.format(pendingRows.length - cleanRows.length)}</Chip>
              <Chip tone="good">Clean {workspaceCountFormat.format(cleanRows.length)}</Chip>
              <Chip>Decided {workspaceCountFormat.format(reviewRows.length - pendingRows.length)}</Chip>
            </div>
            <ListCard>
              {reviewRows.map((row) => {
                const why = rowWhy(row);
                const selected = selectedImport?.id === row.id;
                return (
                  <button
                    aria-current={selected ? "true" : undefined}
                    className={`flex flex-col gap-[2px] border-b border-[var(--line-soft)] px-[12px] py-[10px] text-left last:border-b-0 hover:bg-[var(--row-hover)] ${selected ? "bg-[var(--row-selected)]" : ""}`}
                    key={row.id}
                    onClick={() => setSelectedImportId(row.id)}
                    type="button"
                  >
                    <span className="truncate text-[13px] font-[500] text-[color:var(--ink)]">{row.inboundMessage || "Source shape needs review"}</span>
                    <span className={`truncate text-[11px] ${why.tone === "good" ? "text-[color:var(--good-text)]" : why.tone === "warn" ? "text-[color:var(--warning-text)]" : "text-[color:var(--faint)]"}`}>{why.label}</span>
                  </button>
                );
              })}
            </ListCard>
            <MonoMeta className="text-center text-[11px] text-[color:var(--faint)]">{workspaceCountFormat.format(reviewRows.length)} in this batch</MonoMeta>
          </div>
          {selectedImport ? (() => {
            const row = selectedImport;
            const decision = review[row.id] ?? initialReview([row])[row.id];
            const item = importReviewView(row, { disposition: decision.disposition, resolvedFlagIds: resolvedFlagIds(row) });
            const decided = decidedRows[row.id] ?? (row.decision !== "pending" ? row.decision : null);
            const blocking = row.flags.filter((flag) => !flag.resolved && !decision.reviewedFlagIds.includes(flag.id)
              && !(flag.code === "unbound_figure" && decision.bindings[flag.id])
              && !(flag.code === "bare_x" && decision.bareTokens[flag.id]));
            const edited = decision.responseTemplate.trim() !== row.responseTemplate.trim();
            const needsTenant = decision.disposition === "tenant_specific" && !decision.tenantId;
            const canApprove = !decided && item.canAccept && !needsTenant && busy === null
              && (row.flags.length === 0 || edited || row.flags.every((flag) => flag.code === "unbound_figure" || flag.code === "bare_x"));
            return (
              <div className="flex min-w-0 flex-1 flex-col gap-[16px]">
                {blocking.length ? (
                  <div className="flex items-start gap-[10px] rounded-[8px] bg-[var(--warning-wash)] px-[14px] py-[12px]" role="status">
                    <StatusDot className="mt-[6px]" tone="amber" />
                    <span className="text-[13px] text-[color:var(--body)]">
                      <strong className="font-[600] text-[color:var(--ink)]">{flagCopy(blocking[0].code).title}.</strong> {flagCopy(blocking[0].code).body}
                      {blocking.length > 1 ? ` ${blocking.length - 1} more ${blocking.length === 2 ? "issue" : "issues"} below.` : ""}
                    </span>
                  </div>
                ) : decided ? (
                  <Status label={decided === "accepted" ? "Approved to draft" : "Dropped"} tone={decided === "accepted" ? "good" : "neutral"} />
                ) : (
                  <Status label="Clean, ready to approve" tone="good" treatment="bare" />
                )}
                <FieldBlock scope="ALL" title="Lead asks">
                  <LockedText>{row.inboundMessage || "No inbound message was saved."}</LockedText>
                </FieldBlock>
                <FieldBlock
                  note={edited ? "edited" : row.flags.length ? "edit before approving" : undefined}
                  scope="ALL"
                  title="Agent answers"
                >
                  <Textarea
                    aria-label="Agent answers"
                    disabled={decided !== null}
                    onChange={(event) => updateReview(row.id, { responseTemplate: event.target.value })}
                    rows={4}
                    value={decision.responseTemplate}
                  />
                </FieldBlock>

                {row.flags.map((flag) => {
                  const copy = flagCopy(flag.code);
                  const resolved = flag.resolved
                    || decision.reviewedFlagIds.includes(flag.id)
                    || (flag.code === "unbound_figure" && Boolean(decision.bindings[flag.id]))
                    || (flag.code === "bare_x" && Boolean(decision.bareTokens[flag.id]));
                  return (
                    <Surface className="flex flex-col gap-[var(--s-3)]" key={flag.id} variant="well">
                      <div className="flex flex-wrap items-baseline justify-between gap-[var(--s-2)]">
                        <span className="text-[14px] font-[500] text-[color:var(--ink)]">{copy.title}</span>
                        {/*
                          * Amber on both arms until acceptance returns: nothing ticked here is
                          * persisted until `accept()` runs, so the only green is the one the
                          * server confirmed, `flag.resolved` off the loaded row.
                          */}
                        <Status
                          label={flag.resolved ? "Resolved" : resolved ? "Marked, not saved" : "Blocking"}
                          tone={flag.resolved ? "good" : "warning"}
                          treatment="bare"
                        />
                      </div>
                      {flag.code === "unbound_figure" ? (
                        <label className="flex flex-col gap-[var(--s-1)]">
                          <span className="t-row">Bind the figure to</span>
                          <Select
                            disabled={decided !== null}
                            onValueChange={(value) => updateReview(row.id, { bindings: { ...decision.bindings, [flag.id]: value ?? "" } })}
                            value={decision.bindings[flag.id] ?? ""}
                          >
                            <SelectTrigger aria-label="Figure binding" className="w-full">
                              <SelectValue placeholder="Choose a coach field" />
                            </SelectTrigger>
                            <SelectContent align="start">
                              {FIGURE_BINDING_FIELDS.map((field) => <SelectItem key={field} value={field}>{humanize(field)}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </label>
                      ) : flag.code === "bare_x" ? (
                        <Field label="Link token">
                          <Input
                            disabled={decided !== null}
                            onChange={(event) => updateReview(row.id, { bareTokens: { ...decision.bareTokens, [flag.id]: event.target.value } })}
                            value={decision.bareTokens[flag.id] ?? ""}
                          />
                        </Field>
                      ) : (
                        <label className="flex items-start gap-[var(--s-2)]">
                          <Checkbox
                            checked={flag.resolved || decision.reviewedFlagIds.includes(flag.id)}
                            disabled={decided !== null || flag.code === "source_shape" || flag.code === "unknown_placeholder"}
                            onCheckedChange={() => toggleReviewed(row.id, flag.id)}
                          />
                          <span className="t-muted">
                            {flag.code === "source_shape" || flag.code === "unknown_placeholder"
                              ? "Source rewrite required"
                              : "Rewritten above and reviewed"}
                          </span>
                        </label>
                      )}
                      <TechnicalDetail items={[{ label: "Issue code", value: flag.code }, { label: "Field", value: flag.field }, { label: "Offset", value: String(flag.offset), mono: false }]} />
                    </Surface>
                  );
                })}

                <div className="flex flex-wrap items-center gap-[8px]">
                  <Select
                    disabled={decided !== null}
                    onValueChange={(value) => updateReview(row.id, { disposition: (value || null) as ImportDisposition | null })}
                    value={decision.disposition ?? ""}
                  >
                    <SelectTrigger aria-label="Disposition" className="w-[220px]">
                      <SelectValue placeholder="Who this answer reaches" />
                    </SelectTrigger>
                    <SelectContent align="start">
                      <SelectItem value="shared">Every coach’s agent</SelectItem>
                      <SelectItem value="tenant_specific">One coach only</SelectItem>
                      <SelectItem value="needs_rewrite">Needs a rewrite first</SelectItem>
                    </SelectContent>
                  </Select>
                  {decision.disposition === "tenant_specific" ? (
                    <Select
                      disabled={decided !== null}
                      onValueChange={(value) => updateReview(row.id, { tenantId: value || null })}
                      value={decision.tenantId ?? ""}
                    >
                      <SelectTrigger aria-label="Coach" className="w-[220px]">
                        <SelectValue placeholder="Choose the coach" />
                      </SelectTrigger>
                      <SelectContent align="start">
                        {coaches.map((coach) => (
                          <SelectItem key={coach.id} value={coach.id}>{coach.name}{coach.isDemo ? " (test)" : ""}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  <div className="flex-1" />
                  <Button
                    disabled={decided !== null || busy !== null}
                    onClick={() => setSelectedImportId(nextPendingAfter(row.id))}
                    type="button"
                    variant="outline"
                  >
                    Skip
                  </Button>
                  <LoggedButton
                    actionKey="brain.import.accepted"
                    disabled={!canApprove}
                    onClick={() => void accept(row)}
                    variant="primary"
                  >
                    {decided === "accepted" ? "Approved" : busy === `accept:${row.id}` ? "Approving" : "Approve to draft"}
                  </LoggedButton>
                </div>
                {!decided && row.flags.length > 0 && !edited && !row.flags.every((flag) => flag.code === "unbound_figure" || flag.code === "bare_x") ? (
                  <p className="m-0 text-[12px] text-[color:var(--muted)]" data-slot="approve-blocker">
                    Edit the answer before approving: a flagged row cannot be released with its source text unchanged.
                  </p>
                ) : null}
                {!decided ? (
                  <div className="flex flex-wrap items-end gap-[8px] rounded-[8px] border border-[var(--line-soft)] bg-[var(--well)] px-[12px] py-[10px]">
                    <Field hint="Recorded with the decision." label="Why drop it">
                      <Input
                        onChange={(event) => updateReview(row.id, { dropReason: event.target.value })}
                        value={decision.dropReason}
                      />
                    </Field>
                    <div className="flex flex-col items-end gap-[2px]">
                      <Button
                        disabled={!decision.dropReason.trim() || busy !== null}
                        onClick={() => void reject(row)}
                        type="button"
                        variant="outline"
                      >
                        {busy === `reject:${row.id}` ? "Dropping" : "Drop"}
                      </Button>
                      <MonoMeta aria-label="Drop recorded in the audit log">Logged</MonoMeta>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })() : null}
        </div>
      ) : (
        <DataState body="Run an import to populate the review queue." kind="empty" title="No import rows" />
      )}
    </div>
  );

  const suiteView = (
    <div className="flex min-h-0 flex-1 flex-col gap-[20px]">
      <SectionHead
        right={
          <>
            {backToEditing}
            <Button disabled={!state.draft || busy !== null} onClick={() => void runEval()} type="button" variant={state.draft ? "default" : "outline"}>
              {busy === "eval" ? "Running on draft" : "Run again on draft"}
            </Button>
          </>
        }
        sub="Saved conversations run against this exact draft. A failing case blocks publish until it passes."
        title="Test suite"
      />
      <div className="grid grid-cols-1 gap-[12px] md:grid-cols-3">
        <div className="flex flex-col gap-[4px] rounded-[11px] border border-[var(--line)] bg-[var(--card)] px-[16px] py-[14px]">
          <Over>BLOCKING CASES</Over>
          <span className={`mono text-[30px] leading-none font-[600] tracking-[-0.022em] ${state.eval.state === "blocked" ? "text-[color:var(--critical-text)]" : "text-[color:var(--ink)]"}`}>
            {workspaceCountFormat.format(state.eval.blockers.length)}
          </span>
        </div>
        <div className="flex flex-col gap-[4px] rounded-[11px] border border-[var(--line)] bg-[var(--card)] px-[16px] py-[14px]">
          <Over>ON THIS DRAFT</Over>
          <span className="mt-[8px] text-[14px] text-[color:var(--body)]">
            {state.eval.state === "not_run_for_this_version"
              ? "Not run for this version"
              : state.eval.state === "blocked"
                ? "Blocked"
                : "Ready to publish"}
          </span>
        </div>
        <div className="flex flex-col gap-[4px] rounded-[11px] border border-[var(--line)] bg-[var(--card)] px-[16px] py-[14px]">
          <Over>DRAFT</Over>
          <MonoMeta className="mt-[8px] text-[color:var(--body)]">
            {state.draft ? `${shortHash(state.draft.contentHash)} · saved ${displayTime(state.draft.createdAt)}` : "No saved draft"}
          </MonoMeta>
        </div>
      </div>
      {gate.details.length ? (
        <ListCard>
          {gate.details.map((detail) => {
            const [suite, caseKey] = detail.split(" · ");
            return (
              <ListRow key={detail}>
                <MonoMeta className="w-[120px] shrink-0 truncate text-[11px] text-[color:var(--faint)]">{caseKey ?? "case"}</MonoMeta>
                <span className="min-w-0 flex-1 text-[14px] font-[500] text-[color:var(--ink)]">{humanize(suite ?? detail)}</span>
                <Chip tone="crit">FAIL</Chip>
              </ListRow>
            );
          })}
        </ListCard>
      ) : null}
      {evals ?? (
        <DataState body="Turn on Brain evals to read the saved test-arm evidence." kind="empty" title="Evals are not enabled" />
      )}
    </div>
  );

  const coachSelect = (value: string, onChange: (next: string) => void, label: string) => (
    <Select onValueChange={(next) => onChange(next ?? "")} value={value}>
      <SelectTrigger aria-label={label} className="min-w-[180px]">
        <SelectValue placeholder={coaches.length ? "Choose a coach" : "No coach to test against"} />
      </SelectTrigger>
      <SelectContent align="start">
        {coaches.map((coach) => (
          <SelectItem key={coach.id} value={coach.id}>{coach.name}{coach.isDemo ? " · test" : ""}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const revisionSwitch = (value: TestRevision, onChange: (next: TestRevision) => void, label: string) => (
    <Segmented
      label={label}
      onValueChange={(next) => onChange(next as TestRevision)}
      options={[
        { key: "draft", label: "Draft", tone: "draft" },
        { key: "live", label: currentVersion ? `Live v${currentVersion}` : "Live" },
      ]}
      value={value}
    />
  );

  const promptView = (
    <div className="flex min-h-0 flex-1 flex-col gap-[20px]">
      <SectionHead
        right={
          <>
            {coachSelect(promptCoachId, setPromptCoachId, "Coach for the prompt")}
            {revisionSwitch(promptRevision, setPromptRevision, "Prompt revision")}
            <Button disabled={!prompt} onClick={() => void copyPrompt()} type="button" variant="outline">
              {promptCopied ? "Copied" : "Copy"}
            </Button>
            {backToEditing}
          </>
        }
        sub="Exactly what the writer model receives for this coach and revision. Read-only; edit the source section instead."
        title="Assembled prompt"
      />
      {promptError ? (
        <DataState body={promptError} kind="unavailable" title="The prompt could not be assembled" />
      ) : !promptCoachId ? (
        <DataState body="Add a coach tenant to assemble a prompt for it." kind="empty" title="No coach to assemble for" />
      ) : !prompt ? (
        <DataState kind="loading" rows={4} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-[8px]">
            <Chip>{prompt.tokens === null ? "tokens not counted" : `${workspaceCountFormat.format(prompt.tokens)} tokens`}</Chip>
            <Chip>hash {shortHash(prompt.promptHash)}</Chip>
            {prompt.knowledgeMode ? <Chip>knowledge: {prompt.knowledgeMode}</Chip> : null}
            <span className="text-[12px] text-[color:var(--faint)]">Blocks in the order the model reads them.</span>
          </div>
          {prompt.blocks.map((block, index) => {
            const key = block.label || String(index);
            const open = openBlocks[key] ?? false;
            const scope: Scope = block.source === "system" || block.source === "runtime" ? "SYSTEM" : block.source === "coach" ? "COACH" : "ALL";
            return (
              <div className="overflow-hidden rounded-[11px] border border-[var(--line)] bg-[var(--card)]" key={key}>
                <button
                  aria-expanded={open}
                  className="flex w-full items-center gap-[10px] border-b border-[var(--line-soft)] px-[14px] py-[10px] text-left"
                  onClick={() => setOpenBlocks((current) => ({ ...current, [key]: !open }))}
                  type="button"
                >
                  <MonoMeta className="w-[56px] shrink-0 text-[11px] text-[color:var(--faint)]">{block.label}</MonoMeta>
                  <span className="min-w-0 flex-1 text-[13px] font-[500] text-[color:var(--ink)]">{block.title}</span>
                  <ScopeTag scope={scope} />
                  <span aria-hidden="true" className="text-[11px] text-[color:var(--faint)]">{open ? "▲" : "▼"}</span>
                </button>
                {open ? (
                  <pre className="mono m-0 overflow-x-auto px-[14px] py-[12px] text-[11.5px] leading-[1.6] whitespace-pre-wrap text-[color:var(--muted)]">{block.text}</pre>
                ) : null}
              </div>
            );
          })}
        </>
      )}
    </div>
  );

  /* ---------------------------------------------------------------------------------------
   * The test pane
   * ------------------------------------------------------------------------------------- */

  const testCoach = coaches.find((coach) => coach.id === testCoachId) ?? null;

  function replyChips(result: TestTurnResult) {
    const chips: ReactNode[] = [];
    const { evidence } = result;
    if (result.held) chips.push(<Chip key="held" tone="warn">Held{result.heldClass ? ` · ${result.heldClass}` : ""}</Chip>);
    const failed = evidence.safety.checks.filter((check) => !check.passed);
    if (evidence.safety.checks.length) {
      chips.push(
        <Chip key="safety" tone={failed.length ? "crit" : "good"}>
          {failed.length ? `Safety: ${failed.map((check) => check.ruleId ?? check.class).join(", ")}` : `Safety: ${evidence.safety.checks.length} checks passed`}
        </Chip>,
      );
    }
    evidence.citations.slice(0, 2).forEach((citation) => {
      chips.push(<Chip key={`cite-${citation.entryId}`}>Knowledge: “{citation.question || citation.entryId}”</Chip>);
    });
    if (evidence.qualification.ruleId) {
      chips.push(<Chip key="rule" tone="good">Rule: {evidence.qualification.ruleId}{evidence.qualification.outcome ? ` · ${evidence.qualification.outcome}` : ""}</Chip>);
    }
    if (evidence.qualification.step !== null && evidence.qualification.of !== null) {
      chips.push(<Chip key="step">Step {evidence.qualification.step} of {evidence.qualification.of}</Chip>);
    }
    if (evidence.channelLength.chars !== null) {
      const over = evidence.channelLength.soft !== null && evidence.channelLength.chars > evidence.channelLength.soft;
      chips.push(<Chip key="len" tone={over ? "warn" : "neutral"}>{evidence.channelLength.chars} chars · {humanize(testChannel)} {over ? "over soft cap" : "ok"}</Chip>);
    }
    if (evidence.safety.moderator.verdict) {
      chips.push(<Chip key="mod">Moderator: {evidence.safety.moderator.verdict}{evidence.safety.moderator.ms !== null ? ` ${(evidence.safety.moderator.ms / 1000).toFixed(1)}s` : ""}</Chip>);
    }
    return chips;
  }

  const testPane = (
    <aside
      aria-label="Test conversation"
      className="flex min-h-[480px] w-full shrink-0 flex-col border-t border-[var(--line)] bg-[var(--canvas)] xl:min-h-0 xl:w-[380px] xl:border-t-0 xl:border-l"
      data-slot="brain-test-pane"
    >
      <div className="flex flex-col gap-[10px] border-b border-[var(--line-soft)] px-[16px] pt-[16px] pb-[12px]">
        <div className="flex items-center justify-between">
          <span className="text-[14px] font-[600] text-[color:var(--ink)]">Test conversation</span>
          <div className="flex gap-[12px] text-[12px]">
            <Link className="text-[color:var(--faint)] no-underline hover:text-[color:var(--ink)]" href={tabHref("suite")}>Test suite</Link>
            <button
              className="text-[color:var(--faint)] hover:text-[color:var(--ink)]"
              disabled={!testMessages.length}
              onClick={() => { setTestMessages([]); setTestError(null); }}
              type="button"
            >
              Reset
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-[6px]">
          {coachSelect(testCoachId, (next) => { setTestCoachId(next); setTestMessages([]); }, "Coach to test as")}
          <Select onValueChange={(next) => setTestChannel((next ?? "sms") as TestChannel)} value={testChannel}>
            <SelectTrigger aria-label="Channel" className="w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              {TEST_CHANNELS.map((channel) => <SelectItem key={channel} value={channel}>{humanize(channel)}</SelectItem>)}
            </SelectContent>
          </Select>
          {revisionSwitch(testRevision, (next) => { setTestRevision(next); setTestMessages([]); }, "Test revision")}
        </div>
        {testCoach ? (
          <div className="flex items-center justify-between gap-[8px] rounded-[6px] border border-[var(--line-soft)] bg-[var(--well)] px-[10px] py-[8px]">
            <span className="min-w-0 truncate text-[12px] text-[color:var(--muted)]">
              {testCoach.isDemo ? "Test tenant · " : ""}This coach’s offer, prices and voice are added on top of the Brain.
            </span>
            <ScopeTag scope="COACH" />
          </div>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-[12px] overflow-y-auto px-[16px] py-[16px]">
        {testMessages.length === 0 ? (
          <p className="m-0 text-[12.5px] text-[color:var(--faint)]">
            Reply as the lead and the agent answers with the {testRevision === "draft" ? "draft" : "live"} Brain. Nothing here reaches a real lead.
          </p>
        ) : null}
        {testMessages.map((item) => item.role === "lead" ? (
          <div
            className="max-w-[280px] self-end rounded-[12px_12px_4px_12px] border border-[var(--accent-edge)] bg-[var(--accent-wash-strong)] px-[12px] py-[10px] text-[13px] leading-[1.5] text-[color:var(--ink)]"
            key={item.id}
          >
            {item.text}
          </div>
        ) : (
          <div className="flex max-w-[300px] flex-col gap-[6px] self-start" key={item.id}>
            <div className="rounded-[12px_12px_12px_4px] border border-[var(--line-strong)] bg-[var(--raised)] px-[12px] py-[10px] text-[13px] leading-[1.5] text-[color:var(--body)] shadow-[var(--shadow-card)]">
              {item.text || <span className="text-[color:var(--faint)]">No reply text was returned.</span>}
            </div>
            <div className="flex flex-wrap gap-[4px] pl-[2px]">{replyChips(item.result)}</div>
          </div>
        ))}
        {busy === "test-turn" ? <MonoMeta className="self-start text-[color:var(--faint)]">Agent is replying</MonoMeta> : null}
        {testError ? (
          <div role="alert">
            <Callout body={testError} title="The test turn did not run" tone="critical" />
          </div>
        ) : null}
        <div ref={testEndRef} />
      </div>
      <form
        className="flex flex-col gap-[10px] border-t border-[var(--line-soft)] px-[16px] pt-[12px] pb-[16px]"
        onSubmit={(event) => { event.preventDefault(); void sendTestTurn(); }}
      >
        <div className="flex gap-[8px]">
          <Input
            aria-label="Reply as the lead"
            className="min-w-0 flex-1"
            disabled={!testCoachId}
            onChange={(event) => setTestDraft(event.target.value)}
            placeholder="Reply as the lead"
            value={testDraft}
          />
          <Button disabled={!testDraft.trim() || !testCoachId || busy !== null} type="submit" variant="outline">
            Send
          </Button>
        </div>
        <div className="flex items-center justify-between text-[12px] text-[color:var(--faint)]">
          <span>
            {testRevision === "draft"
              ? `Testing draft · ${workspaceCountFormat.format(diff.changes.length)} unpublished ${diff.changes.length === 1 ? "change" : "changes"}`
              : currentVersion ? `Testing live v${currentVersion}` : "No live version yet"}
          </span>
          <MonoMeta aria-label="Test turns are recorded">Logged</MonoMeta>
        </div>
      </form>
    </aside>
  );

  /* ---------------------------------------------------------------------------------------
   * History drawer and publish sheet
   * ------------------------------------------------------------------------------------- */

  const historySheet = (
    <Sheet onOpenChange={setHistoryOpen} open={historyOpen}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-[520px]" side="right">
        <SheetHeader className="border-b border-[var(--line)] px-[24px] py-[20px]">
          <SheetTitle className="text-[16px] font-[600] text-[color:var(--ink)]">History</SheetTitle>
          <SheetDescription className="text-[13px] text-[color:var(--muted)]">Every publish and rollback, and what each one carried.</SheetDescription>
          <div className="mt-[8px] flex flex-wrap gap-[8px]">
            <ExportMenu filename="setterfi-brain-versions" label="Export versions" mode="server" query={{ reason: "", order: "version_desc", columns: ["id", "version", "contentHash", "sourceHash", "knowledgeMode", "platformTokens", "publishedAt", "rollbackOfSnapshotId"] }} resource="brain-snapshots" />
            <ExportMenu filename="setterfi-brain-diffs" label="Export version diffs" mode="server" query={{ reason: "", order: "version_desc", columns: ["version", "contentHash", "sourceHash", "knowledgeMode", "publishedAt", "rollbackOfSnapshotId"] }} resource="brain-snapshot-diffs" />
          </div>
        </SheetHeader>
        {state.snapshots.length ? (
          <ul className="m-0 list-none p-0">
            {state.snapshots.map((snapshot) => (
              <li className="flex items-start gap-[14px] border-b border-[var(--line-soft)] px-[24px] py-[14px]" key={snapshot.id}>
                <MonoMeta className={`w-[32px] shrink-0 pt-[2px] text-[12px] ${snapshot.version === currentVersion ? "text-[color:var(--ink)]" : "text-[color:var(--faint)]"}`}>v{snapshot.version}</MonoMeta>
                <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
                  <div className="flex flex-wrap items-center gap-[8px]">
                    <span className="text-[14px] font-[500] text-[color:var(--ink)]">
                      {snapshot.rollbackOfSnapshotId ? "Rollback" : "Published"}
                    </span>
                    {snapshot.version === currentVersion ? <Chip tone="good">Live on every agent</Chip> : null}
                  </div>
                  <span className="text-[12px] text-[color:var(--muted)]">
                    {displayTime(snapshot.publishedAt)} · {humanize(snapshot.knowledgeMode)} · {workspaceCountFormat.format(snapshot.platformTokens)} tokens
                  </span>
                  <TechnicalDetail items={[
                    { label: "Snapshot ID", value: snapshot.id },
                    { label: "Content hash", value: snapshot.contentHash },
                    { label: "Source hash", value: snapshot.sourceHash },
                    ...(snapshot.rollbackOfSnapshotId ? [{ label: "Rollback source ID", value: snapshot.rollbackOfSnapshotId }] : []),
                  ]} />
                </div>
                {snapshot.version < currentVersion ? (
                  <label className="inline-flex shrink-0 items-center gap-[6px] text-[12px] text-[color:var(--accent-text)]">
                    <input
                      checked={selectedVersion === snapshot.version}
                      className="size-[14px] accent-[var(--accent)]"
                      name="rollback-target"
                      onChange={() => setSelectedVersion(snapshot.version)}
                      type="radio"
                    />
                    Restore
                  </label>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-[24px] py-[20px]">
            <DataState body="Publish the first version to start the history." kind="empty" title="No published versions" />
          </div>
        )}
        <div className="flex flex-col gap-[12px] border-t border-[var(--line)] px-[24px] py-[16px]">
          <Status
            label={rollbackReceipt.logged ? rollbackReceipt.label : selectedVersion ? `Restoring v${selectedVersion} makes a new version with its content` : "Pick a version to restore"}
            tone={rollbackReceipt.rolledBack ? "good" : selectedVersion ? "warning" : "neutral"}
            treatment="bare"
          />
          <Field
            error={rollbackReasonTouched ? reasonControlView(rollbackReason).error ?? undefined : undefined}
            hint="Recorded against the appended version. Nothing is deleted."
            label="Why restore it"
          >
            <Textarea
              onBlur={() => setRollbackReasonTouched(true)}
              onChange={(event) => { setRollbackReasonTouched(true); setRollbackReason(event.target.value); }}
              rows={2}
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
            {busy === "rollback" ? "Restoring" : rollbackReceipt.logged ? rollbackReceipt.label : selectedVersion ? `Restore v${selectedVersion}` : "Restore"}
          </LoggedButton>
        </div>
      </SheetContent>
    </Sheet>
  );

  const publishSheet = (
    <Dialog onOpenChange={setPublishOpen} open={publishOpen}>
      <DialogContent className="max-h-[90vh] w-[min(640px,calc(100vw-32px))] gap-0 overflow-y-auto p-0 sm:max-w-[640px]">
        <DialogHeader className="border-b border-[var(--line)] px-[24px] py-[20px]">
          <DialogTitle className="text-[16px] font-[600] tracking-[-0.008em] text-[color:var(--ink)]">Review & publish</DialogTitle>
          <DialogDescription className="text-[13px] text-[color:var(--muted)]">
            {currentVersion ? `The draft becomes v${currentVersion + 1} on every agent.` : "The draft becomes the first live version on every agent."} Typing never changes live agents; this does.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-[20px] px-[24px] py-[20px]">
          <div className="flex flex-col gap-[8px]">
            <div className="flex flex-wrap items-center justify-between gap-[8px]">
              <Over>{currentVersion ? `${workspaceCountFormat.format(diff.changes.length).toUpperCase()} CHANGES SINCE V${currentVersion}` : "WHAT THE FIRST VERSION CARRIES"}</Over>
              <ExportMenu
                filename="setterfi-brain-publish-preview"
                label="Export publish preview"
                mode="local"
                rows={sectionRows.map((row) => ({ section: row.title, live: row.live, draft: row.total, change: row.changeLabel }))}
              />
            </div>
            <ListCard>
              {diff.changes.length ? diff.changes.map((change) => (
                <ListRow key={`${change.entityType}:${change.entityId}`}>
                  <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                    <span className="text-[14px] font-[500] text-[color:var(--ink)]">{ENTITY_LABEL[change.entityType] ?? humanize(change.entityType)}</span>
                    <MonoMeta className="text-[color:var(--muted)]">{change.kind}</MonoMeta>
                  </span>
                  <ScopeTag scope="ALL" />
                </ListRow>
              )) : sectionRows.map((row) => (
                <ListRow key={row.title}>
                  <span className="min-w-0 flex-1 text-[14px] text-[color:var(--body)]">{row.title}</span>
                  <MonoMeta className="text-[color:var(--muted)]">{workspaceCountFormat.format(row.live)} live · {workspaceCountFormat.format(row.total)} in draft</MonoMeta>
                  {row.changeTone === "neutral" ? <Chip>{row.changeLabel}</Chip> : <Chip tone="warn">{row.changeLabel}</Chip>}
                </ListRow>
              ))}
            </ListCard>
            {diff.impactKeys.length ? (
              <ul className="m-0 list-none p-0 text-[12.5px] text-[color:var(--muted)]">
                {diff.impactKeys.map((key, index) => <li key={key}>{diff.impactLines[index]}</li>)}
              </ul>
            ) : null}
          </div>
          <div className="flex flex-col gap-[8px]">
            <Over>BEFORE IT GOES LIVE</Over>
            <ListCard>
              <ListRow>
                <StatusDot tone={!state.draft ? "amber" : "good"} />
                <span className="min-w-0 flex-1 text-[14px] text-[color:var(--body)]">
                  {state.draft ? `Draft saved ${displayTime(state.draft.createdAt)}` : "No saved draft yet"}
                </span>
                {!state.draft ? (
                  <Button disabled={busy !== null} onClick={() => void createDraft()} size="sm" type="button" variant="outline">
                    {busy === "draft" ? "Saving" : "Save draft"}
                  </Button>
                ) : null}
              </ListRow>
              <ListRow>
                <StatusDot tone={state.eval.state === "ready" ? "good" : state.eval.state === "blocked" ? "bad" : "amber"} />
                <span className="min-w-0 flex-1 text-[14px] text-[color:var(--body)]">
                  {state.eval.state === "ready"
                    ? "Test suite passed on this exact draft"
                    : state.eval.state === "blocked"
                      ? `Test suite: ${workspaceCountFormat.format(state.eval.blockers.length)} blocking ${state.eval.blockers.length === 1 ? "case" : "cases"} on this draft`
                      : "Test suite has not run on this draft"}
                </span>
                {state.eval.state === "blocked" ? (
                  <Link className="text-[12px] text-[color:var(--accent-text)] no-underline" href={tabHref("suite")} onClick={() => setPublishOpen(false)}>Open</Link>
                ) : state.eval.state === "not_run_for_this_version" && state.draft ? (
                  <Button disabled={busy !== null} onClick={() => void runEval()} size="sm" type="button" variant="outline">
                    {busy === "eval" ? "Running" : "Run now"}
                  </Button>
                ) : null}
              </ListRow>
              <ListRow>
                <StatusDot tone={coaches.length ? "good" : "grey"} />
                <span className="min-w-0 flex-1 text-[14px] text-[color:var(--body)]">
                  {coaches.length
                    ? `Reaches ${workspaceCountFormat.format(coaches.length)} ${coaches.length === 1 ? "agent" : "agents"}${coaches.some((coach) => coach.isDemo) ? `, ${workspaceCountFormat.format(coaches.filter((coach) => coach.isDemo).length)} of them test tenants` : ""}`
                    : "No coach tenant exists yet"}
                </span>
              </ListRow>
            </ListCard>
          </div>
          <Field
            error={publishReasonTouched ? publishReasonControl.error ?? undefined : undefined}
            hint="Recorded against the published version."
            label="Note for history"
          >
            <Textarea
              onBlur={() => setPublishReasonTouched(true)}
              onChange={(event) => { setPublishReasonTouched(true); setPublishReason(event.target.value); }}
              placeholder="Why this change, in one line"
              rows={2}
              value={publishReason}
            />
          </Field>
          {publishBlocker ? (
            <p className="m-0 text-[12px] text-[color:var(--muted)]" data-slot="publish-blocker">{publishBlocker}</p>
          ) : null}
          {publishReceipt.logged ? (
            <Status label={publishReceipt.label} tone="good" />
          ) : null}
        </div>
        <DialogFooter className="flex-row items-center justify-between border-t border-[var(--line)] px-[24px] py-[16px]">
          <span className="text-[12px] text-[color:var(--faint)]">
            {currentVersion ? `Roll back to v${currentVersion} any time from History.` : "Every version stays in History."}
          </span>
          <div className="flex gap-[8px]">
            <Button onClick={() => setPublishOpen(false)} type="button" variant="outline">Keep editing</Button>
            <LoggedButton
              actionKey="brain.published"
              disabled={publishDisabled}
              onClick={() => void publish()}
              variant="primary"
            >
              {busy === "publish" ? "Publishing" : currentVersion ? `Publish v${currentVersion + 1}` : "Publish to all agents"}
            </LoggedButton>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  /* ---------------------------------------------------------------------------------------
   * Assembly
   * ------------------------------------------------------------------------------------- */

  const isSection = (OWNER_BRAIN_SECTIONS as readonly string[]).includes(tab);
  const editor = tab === "behavior"
    ? behaviorEditor
    : tab === "qualification"
      ? qualificationEditor
      : tab === "knowledge"
        ? knowledgeEditor
        : tab === "safety"
          ? safetyEditor
          : modelsEditor;
  const fullWidth = tab === "review" ? reviewView : tab === "suite" ? suiteView : tab === "prompt" ? promptView : null;

  const rail = (
    <nav
      aria-label="Configure"
      className="hidden w-[220px] shrink-0 flex-col gap-[4px] border-r border-[var(--line)] px-[12px] py-[20px] xl:flex"
      data-slot="brain-rail"
    >
      <Over className="px-[10px] pb-[8px]">CONFIGURE</Over>
      {OWNER_BRAIN_SECTIONS.map((section) => {
        const on = tab === section;
        const entity = SECTION_ENTITY[section];
        const differs = entity ? (changesByType[entity] ?? 0) > 0 : false;
        return (
          <Link
            aria-current={on ? "page" : undefined}
            className={`flex h-[36px] items-center justify-between rounded-[6px] px-[10px] text-[13.5px] font-[500] no-underline hover:no-underline ${on ? "bg-[var(--card-top)] text-[color:var(--ink)]" : "text-[color:var(--body)] hover:bg-[var(--row-hover)]"}`}
            href={tabHref(section)}
            key={section}
          >
            {SECTION_LABEL[section]}
            {section === "knowledge" ? (
              <MonoMeta className="text-[11px] text-[color:var(--faint)]">
                {workspaceCountFormat.format(state.knowledge.length)}{pendingReviewCount ? ` · ${workspaceCountFormat.format(pendingReviewCount)} to review` : ""}
              </MonoMeta>
            ) : differs ? (
              <StatusDot tone="amber" />
            ) : null}
          </Link>
        );
      })}
      <div className="flex-1" />
      <ScopeLegend />
    </nav>
  );

  const railTabs = (
    <RehaulTabs
      className="xl:hidden"
      items={OWNER_BRAIN_SECTIONS.map((section) => ({
        active: tab === section,
        href: tabHref(section),
        label: SECTION_LABEL[section],
        ...(section === "knowledge" && pendingReviewCount ? { count: pendingReviewCount } : {}),
      }))}
      label="Brain sections"
    />
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-[14px]" data-slot="owner-brain">
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

      <div className="flex flex-wrap items-center gap-[12px]">
        <h1 className="m-0 text-[30px] leading-[1.1] font-[600] tracking-[-0.02em] text-[color:var(--ink)]">
          The Brain
        </h1>
        {currentVersion ? (
          <Pill tone="good">
            <StatusDot tone="good" />
            Live v{currentVersion}
          </Pill>
        ) : (
          <Pill tone="amber">
            <StatusDot tone="amber" />
            No published version
          </Pill>
        )}
        {diff.changes.length ? (
          <Pill tone="amber">
            <StatusDot tone="amber" />
            Draft · {workspaceCountFormat.format(diff.changes.length)} {diff.changes.length === 1 ? "change" : "changes"}
          </Pill>
        ) : state.draft ? (
          <Pill>Draft saved {displayTime(state.draft.createdAt)}</Pill>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-[8px]">
          <Button onClick={() => setHistoryOpen(true)} type="button" variant="outline">History</Button>
          <Button
            aria-current={tab === "prompt" ? "page" : undefined}
            nativeButton={false}
            render={<Link href={tabHref("prompt")} />}
            variant="outline"
          >
            Inspect prompt
          </Button>
          <Button onClick={() => setPublishOpen(true)} type="button">
            Review & publish
          </Button>
          <ContextEye copy={OWNER_BRAIN_EYE_COPY} placement="header" screen="owner-brain" />
        </div>
      </div>

      {isSection ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--pane)] xl:flex-row">
          {rail}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="px-[20px] pt-[16px] xl:hidden">{railTabs}</div>
            <div className="flex min-w-0 flex-1 flex-col gap-[20px] px-[20px] py-[24px] xl:px-[28px]" data-slot="brain-editor">
              {editor}
            </div>
          </div>
          {testPane}
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-[14px] border border-[var(--line)] bg-[var(--pane)] px-[20px] py-[24px] xl:px-[28px]">
          {fullWidth}
        </div>
      )}

      {historySheet}
      {publishSheet}

      <RecordSheet
        onOpenChange={(open) => { if (!open) setKnowledgeSheet(null); }}
        open={knowledgeSheet !== null}
        sections={knowledgeSheet ? [
          { title: "Lead asks", body: <p className="t-muted m-0">{knowledgeSheet.inboundMessage || "No inbound message was saved."}</p> },
          { title: "Agent answers", body: <p className="t-muted m-0">{knowledgeSheet.responseTemplate || "No response template was saved."}</p> },
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
            title: "Approved response",
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
