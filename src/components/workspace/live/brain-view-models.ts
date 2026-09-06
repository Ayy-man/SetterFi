import type { ImportDisposition } from "@/lib/brain/contracts";
import type { KnowledgeNumberBinding } from "@/lib/brain/contracts";
import type { BrainKnowledgeVariant } from "@/lib/brain/snapshot/knowledge-entity";
import type { BrainImpactKey } from "@/lib/brain/snapshot/diff";
import type { PublishGateIssue, PublishGateWarning } from "@/lib/evals/publish-gate";

export type BrainImportFlagView = {
  id: string;
  code: string;
  severity: "blocking";
  field: string;
  offset: number;
  resolved: boolean;
  figureKind?: "currency" | "percentage" | "score";
  figureValue?: number;
};

export type BrainImportRowView = {
  id: string;
  batchId: string;
  sourceRef: string;
  operation: "new" | "changed" | "unchanged" | "removed";
  category: string;
  inboundMessage: string;
  responseTemplate: string;
  disposition: ImportDisposition | null;
  decision: "pending" | "accepted" | "rejected";
  flags: BrainImportFlagView[];
};

export type BrainImportBatchView = {
  id: string;
  source: "mock" | "notion" | "offline";
  status: "open" | "applied" | "discarded" | "failed";
  receivedCount: number;
  normalizedCount: number;
  flaggedCount: number;
  persistedItemCount: number;
  completedAt: string | null;
};

export type BrainSnapshotView = {
  id: string;
  version: number;
  contentHash: string;
  sourceHash: string;
  knowledgeMode: "inline" | "retrieved";
  platformTokens: number;
  rollbackOfSnapshotId: string | null;
  publishedAt: string;
};

export type BrainDraftView = {
  id: string;
  contentHash: string;
  payload: Readonly<Record<string, unknown>>;
  createdAt: string;
};

export type BrainEvalView =
  | { state: "not_run_for_this_version"; runId: null; blockers: []; warnings: [] }
  | {
      state: "blocked" | "ready";
      runId: string;
      blockers: PublishGateIssue[];
      warnings: PublishGateWarning[];
    };

export type BrainCitationView = {
  traceId: string;
  declaredEntryId: string | null;
  verifiedInPrompt: boolean;
  candidateEntryIds: string[];
  createdAt: string;
} | null;

// The five values Alec asked for. This restates the CHECK constraint in
// `20260826000002_brain_objection_categories.sql` rather than deriving from it, deliberately:
// if the two ever drift, the write fails with a 23514 in the RLS suite instead of a chip
// quietly rendering rows no filter can reach. `hard_gate` is not in this list and never will
// be, because it is an independent boolean on the same row, so an objection can be `pricing` and
// gated at once.
export const OBJECTION_CATEGORIES = ["timing", "clarity", "pricing", "compliance", "partner"] as const;
export type ObjectionCategory = (typeof OBJECTION_CATEGORIES)[number];
export type ObjectionCategoryFilter = "all" | ObjectionCategory;

export type BrainObjectionView = {
  id: string;
  label: string;
  category: ObjectionCategory;
  hardGate: boolean;
  matchKeywords: string[];
  response: string;
  status: string;
  /**
   * When the row was last saved, and when it last went live. Both are optional because they are
   * read straight off the table and a fixture may not carry them; neither is ever synthesised.
   * There is no actor column on `brain_objections`, so the drawer prints times and does not
   * claim a person -- a "who" nobody recorded is worse than no "who" at all.
   */
  updatedAt?: string | null;
  publishedAt?: string | null;
};

export type AdminBrainInitialState = {
  batch: BrainImportBatchView | null;
  importRows: BrainImportRowView[];
  mission: Array<{ id: string; label: string; text: string }>;
  qualification: Array<{ id: string; label: string; outcome: string; position: number }>;
  qualificationApproved: boolean;
  qualificationSource: "platform" | "demo_seed";
  compliance: Array<{ id: string; slug: string; phrase: string | null; severity: string }>;
  knowledge: Array<{
    id: string;
    category: string;
    inboundMessage: string;
    responseTemplate: string;
    status: string;
    /**
     * Provenance and question variants as the authoring rows hold them. Required rather than
     * optional: they are part of the draft hash (`brainKnowledgeDraftEntity`), and a loader that
     * silently omitted them would let a rebinding or a new variant publish as "nothing changed".
     */
    numberBindings: readonly KnowledgeNumberBinding[];
    rewriteHash: string | null;
    variants: readonly BrainKnowledgeVariant[];
    /** As on `BrainObjectionView`: read off the row, never synthesised, no actor recorded. */
    updatedAt?: string | null;
    publishedAt?: string | null;
  }>;
  snapshots: BrainSnapshotView[];
  draft: BrainDraftView | null;
  eval: BrainEvalView;
  citation: BrainCitationView;
  currentSnapshotPayload: Readonly<Record<string, unknown>> | null;
  objections: BrainObjectionView[];
  /**
   * Knowledge counts sourced from the live snapshot rather than `status`. Optional so fixtures
   * and older loaders that never computed it keep type-checking; a surface that needs the figure
   * should treat its absence as "not measured", never as zero.
   */
  knowledgePublish?: BrainKnowledgePublishCounts;
};

export type BrainKnowledgePublishCounts = {
  /** Rows in `brain_snapshot_entries` for the current (highest version) snapshot. */
  inLiveSnapshot: number;
  /**
   * Eligible rows (`disposition = 'shared'`, `status = 'draft'`, embedding present -- the exact
   * filter `publish_brain_draft` copies) that are absent from the live snapshot or differ from
   * their live copy. This is the number a publish would change.
   */
  draftAwaitingPublish: number;
  snapshotVersion: number | null;
};

export type KnowledgeEntryForCounts = {
  id: string;
  disposition: string;
  status: string;
  hasEmbedding: boolean;
  category: string;
  inboundMessage: string;
  responseTemplate: string;
  matchKeywords: readonly string[];
};

export type LiveSnapshotEntryForCounts = {
  entryId: string;
  category: string;
  inboundMessage: string;
  responseTemplate: string;
  matchKeywords: readonly string[];
};

function snapshotContentKey(entry: Omit<LiveSnapshotEntryForCounts, "entryId">) {
  return JSON.stringify([entry.category, entry.inboundMessage, entry.responseTemplate, [...entry.matchKeywords]]);
}

/**
 * The knowledge figures the Brain page may honestly show.
 *
 * `brain_knowledge_entries.status = 'published'` is a legacy column that `publish_brain_draft`
 * neither reads nor writes: the snapshot is built from `status = 'draft'` shared rows, so counting
 * `published` reports rows no publish ever copied and misses every row that is actually live.
 * These counts come from the snapshot table, which is what retrieval reads.
 */
export function knowledgePublishCounts(
  entries: readonly KnowledgeEntryForCounts[],
  snapshot: { version: number; entries: readonly LiveSnapshotEntryForCounts[] } | null,
): BrainKnowledgePublishCounts {
  const live = new Map((snapshot?.entries ?? []).map((entry) => [entry.entryId, snapshotContentKey(entry)]));
  const eligible = entries.filter((entry) =>
    entry.disposition === "shared" && entry.status === "draft" && entry.hasEmbedding,
  );
  const awaiting = eligible.filter((entry) => live.get(entry.id) !== snapshotContentKey(entry));
  return {
    inLiveSnapshot: live.size,
    draftAwaitingPublish: awaiting.length,
    snapshotVersion: snapshot?.version ?? null,
  };
}

// One filter value, never an array, so "exactly one category at a time" is a property of the
// type rather than a discipline the component has to keep. The counts are taken over the whole
// input and not the filtered result, because a chip row whose numbers shrink as you filter is
// describing the view instead of the list it is meant to be navigating.
export function objectionListView(
  rows: readonly BrainObjectionView[],
  filter: ObjectionCategoryFilter,
) {
  const visible = filter === "all" ? [...rows] : rows.filter((row) => row.category === filter);

  const options = [
    { value: "all" as ObjectionCategoryFilter, label: "All", count: rows.length },
    ...OBJECTION_CATEGORIES.map((category) => ({
      value: category as ObjectionCategoryFilter,
      label: category.charAt(0).toUpperCase() + category.slice(1),
      count: rows.filter((row) => row.category === category).length,
    })),
  ];

  const emptyLabel = visible.length > 0
    ? null
    : filter === "all"
      ? "No objections yet"
      : `No objections in ${filter}. Select All to clear the filter`;

  return {
    filter,
    rows: visible,
    options,
    // Counted over the visible rows so the tab can say how much of what you are looking at is
    // gated. The gate is never a filter: a gated row is listed under its own category chip.
    hardGateCount: visible.filter((row) => row.hardGate).length,
    emptyLabel,
  };
}

export function importBatchView(batch: BrainImportBatchView | null) {
  if (!batch) return { label: "No import run", complete: false as const, tone: "neutral" as const };
  const reconciled = batch.completedAt !== null
    && batch.status !== "failed"
    && batch.receivedCount === batch.normalizedCount
    && batch.normalizedCount === batch.persistedItemCount;
  if (!reconciled) {
    return {
      label: `Import incomplete: ${batch.persistedItemCount} of ${batch.receivedCount} rows saved`,
      complete: false as const,
      tone: "pending" as const,
    };
  }
  return {
    label: `Imported ${batch.receivedCount} rows, ${batch.flaggedCount} flagged`,
    complete: true as const,
    tone: "good" as const,
  };
}

export function importReviewView(
  row: BrainImportRowView,
  input: { disposition: ImportDisposition | null; resolvedFlagIds: readonly string[] },
) {
  const resolved = new Set(input.resolvedFlagIds);
  const blockingCodes = row.flags
    .filter((flag) => flag.severity === "blocking" && (
      !flag.resolved
      && (!resolved.has(flag.id) || flag.code === "source_shape" || flag.code === "unknown_placeholder")
    ))
    .map((flag) => flag.code);
  return {
    blockingCodes,
    canAccept: row.decision === "pending" && input.disposition !== null && blockingCodes.length === 0,
  };
}

export function evalGateView(evalState: BrainEvalView) {
  if (evalState.state === "not_run_for_this_version") {
    return {
      label: "Not run for this version",
      canPublish: false,
      details: ["The latest persisted run does not match this exact draft."],
    };
  }
  if (evalState.state === "blocked") {
    return {
      label: "Blocked",
      canPublish: false,
      details: evalState.blockers.map(
        (issue) => `${issue.suite} · ${issue.caseKey} · ${issue.ruleId} · ${issue.reason}`,
      ),
    };
  }
  return {
    label: "Ready",
    canPublish: true,
    details: evalState.warnings.map(
      (warning) => `${warning.suite} · ${warning.status}${warning.caseKeys.length ? ` · ${warning.caseKeys.join(", ")}` : ""}`,
    ),
  };
}

export function reasonControlView(reason: string) {
  return { enabled: reason.trim().length > 0, error: reason.trim() ? null : "A reason is required." };
}

export function qualificationMatrixView(input: {
  qualificationApproved: boolean;
  qualificationSource: "platform" | "demo_seed";
}) {
  const productionReady = input.qualificationApproved && input.qualificationSource === "platform";
  return {
    badge: productionReady ? "Approved" : "DRAFT / unapproved",
    productionReady,
    detail: productionReady ? "Production readiness true" : "Production readiness false",
  };
}

export function citationView(citation: BrainCitationView) {
  const grounded = Boolean(
    citation?.verifiedInPrompt
    && citation.declaredEntryId
    && citation.candidateEntryIds.includes(citation.declaredEntryId),
  );
  return {
    grounded,
    label: grounded && citation?.declaredEntryId
      ? `Grounded · ${citation.declaredEntryId}`
      : citation?.declaredEntryId
        ? "Citation unverified"
        : "No grounded row",
  };
}

export type BrainPublishResponse =
  | { status: "nothing_changed" }
  | {
      status: "published";
      receipt?: {
        snapshot?: { id?: string; version?: number };
        auditId?: string;
        actionKey?: string;
      };
    }
  | { state: "blocked" | "failed" | "not_run_for_this_version" | "refused"; code?: string };

export function publishReceiptView(response: BrainPublishResponse | null) {
  if (!response) return { label: "Draft", published: false, logged: false };
  if ("status" in response && response.status === "nothing_changed") {
    return { label: "Nothing changed", published: false, logged: false };
  }
  if ("status" in response && response.status === "published") {
    const receipt = response.receipt;
    const complete = Boolean(
      receipt?.snapshot?.id
      && Number.isSafeInteger(receipt.snapshot.version)
      && receipt?.auditId
      && receipt.actionKey === "brain.published",
    );
    return complete
      ? { label: `Published v${receipt!.snapshot!.version}`, published: true, logged: true }
      : { label: "Publish receipt incomplete", published: false, logged: false };
  }
  return { label: "Blocked", published: false, logged: false };
}

export function rollbackReceiptView(response: unknown) {
  if (!response || typeof response !== "object") {
    return { label: "No rollback run", rolledBack: false, logged: false };
  }
  const value = response as {
    status?: unknown;
    from?: unknown;
    receipt?: { snapshot?: { id?: unknown; version?: unknown; rollbackOfSnapshotId?: unknown }; auditId?: unknown; actionKey?: unknown };
  };
  const complete = value.status === "rolled_back"
    && Number.isSafeInteger(value.receipt?.snapshot?.version)
    && typeof value.receipt?.snapshot?.id === "string"
    && typeof value.receipt?.snapshot?.rollbackOfSnapshotId === "string"
    && typeof value.receipt?.auditId === "string"
    && value.receipt?.actionKey === "brain.rolled_back";
  return complete
    ? { label: `Rollback appended as v${value.receipt!.snapshot!.version}`, rolledBack: true, logged: true }
    : { label: "Rollback receipt incomplete", rolledBack: false, logged: false };
}

const IMPACT_LINES: Record<BrainImpactKey, string> = {
  compliance_rules_changed: "Compliance changed: every reply is re-checked.",
  placeholder_schema_changed: "Placeholder schema changed: tenant renders may change.",
  placeholder_resolution_changed: "Placeholder resolution changed: rendered answers may change.",
  knowledge_mode_changed: "Knowledge mode changed: prompt behavior changes.",
};

export function impactLines(keys: readonly BrainImpactKey[]) {
  return keys.map((key) => IMPACT_LINES[key]);
}

type DraftEntity = { id: string; type: string; value: Readonly<Record<string, unknown>> };

function draftEntities(payload: Readonly<Record<string, unknown>> | null) {
  if (!payload || !Array.isArray(payload.entities)) return [];
  return payload.entities.filter((entity): entity is DraftEntity => {
    if (!entity || typeof entity !== "object") return false;
    const value = entity as Partial<DraftEntity>;
    return typeof value.id === "string" && typeof value.type === "string"
      && Boolean(value.value) && typeof value.value === "object" && !Array.isArray(value.value);
  });
}

/**
 * One field that differs between the live entity and the draft's, in the words the payload holds.
 *
 * `before` and `after` are null when the field is absent on that side, which is a different fact
 * from an empty string and reads that way on the surface. `readable` says whether the value is
 * plain language: false for an object or an array, which the surface then shows as serialized JSON
 * behind a disclosure rather than inline, so a reader who came for a sentence is not handed one.
 *
 * It used to mean "withheld", and both sides were nulled out. That left the surface with nothing
 * to show and it deflected to the export -- but no export carries a payload
 * (`rendered-tables.ts` declares `brain-snapshot-diffs` as version, hashes, knowledge mode and
 * timestamps only), so an admin reviewing a changed `matchKeywords` array was sent to a document
 * that does not contain it. The data was here the whole time; withholding it was the defect.
 */
export type BrainFieldChange = {
  field: string;
  before: string | null;
  after: string | null;
  readable: boolean;
};

function scalarText(value: unknown): { text: string | null; readable: boolean } {
  if (value === null || value === undefined) return { text: null, readable: true };
  if (typeof value === "string") return { text: value, readable: true };
  if (typeof value === "number" || typeof value === "boolean") return { text: String(value), readable: true };
  // Two-space JSON rather than one line: a reader comparing two arrays is comparing them member
  // by member, and a single wrapped line makes that a character hunt.
  return { text: JSON.stringify(value, null, 2), readable: false };
}

/**
 * The field-level diff screen 1i is built on: the minus line and the plus line, per changed field.
 *
 * Both payloads are already in this function's hands -- the entity maps hold the whole `value`
 * object on each side -- so the plain-language before and after are derived, never authored and
 * never invented. This is the one part of 1i that is not a count: the artifact's claim is that a
 * publish is legible before it ships, and a list of entity names that changed does not carry that.
 *
 * Fields whose JSON matches are dropped, because a diff that lists unchanged rows is a dump.
 */
export function entityFieldChanges(
  previous: Readonly<Record<string, unknown>> | null,
  next: Readonly<Record<string, unknown>> | null,
): readonly BrainFieldChange[] {
  const keys = [...new Set([...Object.keys(previous ?? {}), ...Object.keys(next ?? {})])].sort();
  return keys.reduce<BrainFieldChange[]>((output, field) => {
    const from = previous?.[field];
    const to = next?.[field];
    if (JSON.stringify(from ?? null) === JSON.stringify(to ?? null)) return output;
    const left = scalarText(from);
    const right = scalarText(to);
    return [...output, {
      field,
      before: left.text,
      after: right.text,
      readable: left.readable && right.readable,
    }];
  }, []);
}

/** The UI computes entity and blast-radius tiers from persisted payloads; no impact prose is authored per edit. */
export function draftDiffView(
  current: Readonly<Record<string, unknown>> | null,
  draft: Readonly<Record<string, unknown>> | null,
) {
  const before = new Map(draftEntities(current).map((entity) => [`${entity.type}:${entity.id}`, entity]));
  const after = new Map(draftEntities(draft).map((entity) => [`${entity.type}:${entity.id}`, entity]));
  type EntityChange = {
    kind: "added" | "removed" | "changed";
    entityType: string;
    entityId: string;
    /** The fields that actually moved, so the surface can show what was said before and after. */
    fields: readonly BrainFieldChange[];
  };
  const changes = [...new Set([...before.keys(), ...after.keys()])].sort().reduce<EntityChange[]>((output, key) => {
    const previous = before.get(key);
    const next = after.get(key);
    if (!previous && next) {
      return [...output, {
        kind: "added", entityType: next.type, entityId: next.id,
        fields: entityFieldChanges(null, next.value),
      }];
    }
    if (previous && !next) {
      return [...output, {
        kind: "removed", entityType: previous.type, entityId: previous.id,
        fields: entityFieldChanges(previous.value, null),
      }];
    }
    if (previous && next && JSON.stringify(previous.value) !== JSON.stringify(next.value)) {
      return [...output, {
        kind: "changed", entityType: next.type, entityId: next.id,
        fields: entityFieldChanges(previous.value, next.value),
      }];
    }
    return output;
  }, []);
  const impacts = new Set<BrainImpactKey>();
  if (changes.some((change) => change.entityType === "compliance_rule")) impacts.add("compliance_rules_changed");
  if (changes.some((change) => change.entityType === "placeholder_definition")) impacts.add("placeholder_schema_changed");
  if (changes.some((change) => change.entityType === "placeholder_resolution")) impacts.add("placeholder_resolution_changed");
  if (current?.knowledgeMode !== draft?.knowledgeMode) impacts.add("knowledge_mode_changed");
  const keys = ([...impacts] as BrainImpactKey[]);
  return {
    status: changes.length === 0 && keys.length === 0 ? "nothing_changed" as const : "changed" as const,
    changes,
    impactKeys: keys,
    impactLines: impactLines(keys),
  };
}
