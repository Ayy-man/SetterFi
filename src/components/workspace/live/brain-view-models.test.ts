import { describe, expect, it } from "vitest";

import {
  citationView,
  draftDiffView,
  entityFieldChanges,
  evalGateView,
  importBatchView,
  importReviewView,
  knowledgePublishCounts,
  publishReceiptView,
  qualificationMatrixView,
  reasonControlView,
  rollbackReceiptView,
  objectionListView,
  OBJECTION_CATEGORIES,
  type BrainImportRowView,
  type BrainObjectionView,
  type ObjectionCategory,
} from "./brain-view-models";

const row: BrainImportRowView = {
  id: "item-1",
  batchId: "batch-1",
  sourceRef: "source-1",
  operation: "new",
  category: "qualification",
  inboundMessage: "Synthetic question",
  responseTemplate: "Synthetic answer",
  disposition: null,
  decision: "pending",
  flags: [
    { id: "flag-a", code: "unbound_figure", severity: "blocking", field: "responseTemplate", offset: 4, resolved: false },
    { id: "flag-b", code: "bare_x", severity: "blocking", field: "responseTemplate", offset: 18, resolved: false },
  ],
};

describe("Brain honest-state view models", () => {
  it("claims Imported only after completed counts reconcile", () => {
    expect(importBatchView({
      id: "batch-1", source: "mock", status: "open", receivedCount: 46,
      normalizedCount: 46, flaggedCount: 9, persistedItemCount: 46, completedAt: "2026-08-17T00:00:00Z",
    }).label).toBe("Imported 46 rows, 9 flagged");
    expect(importBatchView({
      id: "batch-1", source: "mock", status: "open", receivedCount: 46,
      normalizedCount: 46, flaggedCount: 9, persistedItemCount: 45, completedAt: null,
    }).label).toBe("Import incomplete: 45 of 46 rows saved");
  });

  it("names every blocking code and refuses acceptance until disposition and resolutions exist", () => {
    expect(importReviewView(row, { disposition: null, resolvedFlagIds: [] })).toEqual({
      blockingCodes: ["unbound_figure", "bare_x"],
      canAccept: false,
    });
    expect(importReviewView(row, { disposition: "shared", resolvedFlagIds: ["flag-a", "flag-b"] })).toEqual({
      blockingCodes: [],
      canAccept: true,
    });
  });

  it("counts what is in the live snapshot and what a publish would change, never the status column", () => {
    const entry = (id: string, overrides: Partial<{
      disposition: string; status: string; hasEmbedding: boolean; responseTemplate: string;
      inboundMessage: string; category: string; matchKeywords: string[];
    }> = {}) => ({
      id,
      disposition: "shared",
      status: "draft",
      hasEmbedding: true,
      category: "Credit",
      inboundMessage: `Question ${id}`,
      responseTemplate: `Answer ${id}`,
      matchKeywords: [] as string[],
      ...overrides,
    });
    const live = (id: string, overrides: Partial<{
      responseTemplate: string; inboundMessage: string; category: string; matchKeywords: string[];
    }> = {}) => ({
      entryId: id,
      category: "Credit",
      inboundMessage: `Question ${id}`,
      responseTemplate: `Answer ${id}`,
      matchKeywords: [] as string[],
      ...overrides,
    });

    // Nothing published yet: every eligible draft awaits, nothing is live.
    expect(knowledgePublishCounts([entry("a"), entry("b")], null)).toEqual({
      inLiveSnapshot: 0,
      draftAwaitingPublish: 2,
      snapshotVersion: null,
    });

    const counts = knowledgePublishCounts([
      entry("a"),                                                   // live and unchanged
      entry("b", { responseTemplate: "Rewritten answer" }),        // live but edited since
      entry("c"),                                                   // eligible, never published
      entry("d", { disposition: "tenant_specific" }),               // routed to a tenant, never shared
      entry("e", { disposition: "needs_rewrite" }),                 // quarantined
      entry("f", { hasEmbedding: false }),                          // publish_brain_draft skips it
      entry("g", { status: "published" }),                          // legacy status, publish ignores it
    ], {
      version: 4,
      entries: [live("a"), live("b"), live("z")],                    // z was deleted from the draft table
    });
    expect(counts).toEqual({ inLiveSnapshot: 3, draftAwaitingPublish: 2, snapshotVersion: 4 });
  });

  it("distinguishes stale, blocked, and warning-only eval evidence", () => {
    expect(evalGateView({ state: "not_run_for_this_version", runId: null, blockers: [], warnings: [] })).toMatchObject({
      label: "Not run for this version", canPublish: false,
    });
    expect(evalGateView({
      state: "blocked", runId: "run-1",
      blockers: [{ suite: "pricing_discipline", caseKey: "price-1", ruleId: "NUM-001", reason: "failed" }],
      warnings: [],
    })).toEqual({ label: "Blocked", canPublish: false, details: ["pricing_discipline · price-1 · NUM-001 · failed"] });
    expect(evalGateView({
      state: "ready", runId: "run-2", blockers: [],
      warnings: [{ suite: "voice_tone", status: "not_configured", caseKeys: [] }],
    })).toMatchObject({ label: "Ready", canPublish: true });
  });

  it("requires distinct nonblank publish and rollback reasons", () => {
    expect(reasonControlView("  ")).toEqual({ enabled: false, error: "A reason is required." });
    expect(reasonControlView("Publish reviewed draft")).toEqual({ enabled: true, error: null });
  });

  it("renders a demo qualification matrix as DRAFT and not production ready", () => {
    expect(qualificationMatrixView({ qualificationApproved: false, qualificationSource: "demo_seed" })).toEqual({
      badge: "DRAFT / unapproved", productionReady: false, detail: "Production readiness false",
    });
  });

  it("never claims Grounded unless the declaration is verified and present in candidates", () => {
    expect(citationView({ traceId: "t", declaredEntryId: "entry-1", verifiedInPrompt: false, candidateEntryIds: ["entry-1"], createdAt: "now" }).label).toBe("Citation unverified");
    expect(citationView({ traceId: "t", declaredEntryId: "entry-1", verifiedInPrompt: true, candidateEntryIds: ["entry-2"], createdAt: "now" }).label).toBe("Citation unverified");
    expect(citationView({ traceId: "t", declaredEntryId: "entry-1", verifiedInPrompt: true, candidateEntryIds: ["entry-1"], createdAt: "now" }).label).toBe("Grounded · entry-1");
  });

  it("never claims Published or Logged without the persisted snapshot and audit receipt", () => {
    expect(publishReceiptView({ status: "nothing_changed" })).toEqual({ label: "Nothing changed", published: false, logged: false });
    expect(publishReceiptView({ status: "published", receipt: { snapshot: { id: "s", version: 4 } } })).toEqual({
      label: "Publish receipt incomplete", published: false, logged: false,
    });
    expect(publishReceiptView({ status: "published", receipt: { snapshot: { id: "s", version: 4 }, auditId: "a", actionKey: "brain.published" } })).toEqual({
      label: "Published v4", published: true, logged: true,
    });
  });

  it("never claims an appended rollback without the matching registry receipt", () => {
    expect(rollbackReceiptView({ status: "rolled_back", receipt: { snapshot: { id: "s", version: 5, rollbackOfSnapshotId: "old" } } })).toMatchObject({ rolledBack: false, logged: false });
    expect(rollbackReceiptView({ status: "rolled_back", receipt: { snapshot: { id: "s", version: 5, rollbackOfSnapshotId: "old" }, auditId: "a", actionKey: "brain.rolled_back" } })).toEqual({
      label: "Rollback appended as v5", rolledBack: true, logged: true,
    });
  });
});

const objection = (
  id: string,
  category: ObjectionCategory,
  hardGate = false,
): BrainObjectionView => ({
  id,
  label: `Objection ${id}`,
  category,
  hardGate,
  matchKeywords: ["kw"],
  response: "Synthetic response",
  status: "published",
});

describe("objection category filter", () => {
  const rows: BrainObjectionView[] = [
    objection("a", "timing"),
    objection("b", "pricing"),
    objection("c", "pricing", true),
    objection("d", "clarity"),
  ];

  it("keeps the unfiltered list reachable through All, in input order", () => {
    const view = objectionListView(rows, "all");
    expect(view.filter).toBe("all");
    expect(view.rows.map((each) => each.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("shows one category at a time, because the signature holds one value not an array", () => {
    expect(objectionListView(rows, "pricing").rows.map((each) => each.id)).toEqual(["b", "c"]);
    expect(objectionListView(rows, "timing").rows.map((each) => each.id)).toEqual(["a"]);
  });

  it("always offers all six chips, including categories with no rows", () => {
    const view = objectionListView(rows, "all");
    expect(view.options.map((option) => option.value)).toEqual(["all", ...OBJECTION_CATEGORIES]);
    expect(view.options).toHaveLength(6);
    expect(view.options.find((option) => option.value === "compliance")?.count).toBe(0);
    expect(view.options.find((option) => option.value === "partner")?.count).toBe(0);
  });

  it("counts the whole list on every chip, not the filtered view", () => {
    const view = objectionListView(rows, "pricing");
    expect(view.options[0]).toEqual({ value: "all", label: "All", count: 4 });
    const categoryTotal = view.options.slice(1).reduce((sum, option) => sum + option.count, 0);
    expect(categoryTotal).toBe(rows.length);
  });

  it("names the active category and the way out when a filter matches nothing", () => {
    const empty = objectionListView(rows, "partner");
    expect(empty.rows).toEqual([]);
    expect(empty.emptyLabel).toBe("No objections in partner. Select All to clear the filter");

    const noRows = objectionListView([], "all");
    expect(noRows.rows).toEqual([]);
    expect(noRows.emptyLabel).toBe("No objections yet");

    expect(objectionListView(rows, "pricing").emptyLabel).toBeNull();
  });

  it("never filters by gate: a gated pricing row shows under pricing and under All", () => {
    expect(objectionListView(rows, "pricing").rows.map((each) => each.id)).toContain("c");
    expect(objectionListView(rows, "all").rows.map((each) => each.id)).toContain("c");
    expect(objectionListView(rows, "all").hardGateCount).toBe(1);
    expect(objectionListView(rows, "pricing").hardGateCount).toBe(1);
    expect((OBJECTION_CATEGORIES as readonly string[]).includes("hard_gate")).toBe(false);
    expect((OBJECTION_CATEGORIES as readonly string[]).includes("hard gate")).toBe(false);
  });
});

describe("entityFieldChanges", () => {
  it("carries the words the entity said before and the words it will say after", () => {
    const changes = entityFieldChanges(
      { answer: "Quote the exact number. Never say it depends.", position: 3 },
      { answer: "Quote the exact number in the first reply. Never say it depends.", position: 3 },
    );

    // Screen 1i's whole claim is that a publish is legible before it ships. A list of entity
    // names that changed does not carry that; the sentence on each side does.
    expect(changes).toEqual([
      {
        field: "answer",
        before: "Quote the exact number. Never say it depends.",
        after: "Quote the exact number in the first reply. Never say it depends.",
        readable: true,
      },
    ]);
  });

  it("separates a field that was absent from one that was emptied", () => {
    const added = entityFieldChanges({}, { note: "" });
    expect(added).toEqual([{ field: "note", before: null, after: "", readable: true }]);

    const cleared = entityFieldChanges({ note: "Not offered." }, { note: null });
    expect(cleared).toEqual([{ field: "note", before: "Not offered.", after: null, readable: true }]);
  });

  it("carries a structured value serialized rather than withholding it", () => {
    const changes = entityFieldChanges({ tiers: [1, 2] }, { tiers: [1, 2, 3] });

    // `readable: false` marks it as not-a-sentence, which is what tells the surface to put it
    // behind a disclosure instead of inline. It does not mean "do not show it": both sides were
    // nulled out here until 2026-08-31, and the surface then deflected to an export that carries
    // no payload at all, so a reader checking a changed array was sent somewhere it is not.
    expect(changes).toEqual([{
      field: "tiers",
      before: JSON.stringify([1, 2], null, 2),
      after: JSON.stringify([1, 2, 3], null, 2),
      readable: false,
    }]);
  });

  it("keeps an absent side absent even when the other side is structured", () => {
    // A field that only exists on one side is still an absence, not an empty object, and the
    // surface says so in the same words it uses for a sentence field.
    expect(entityFieldChanges({}, { tiers: [1] })).toEqual([{
      field: "tiers",
      before: null,
      after: JSON.stringify([1], null, 2),
      readable: false,
    }]);
  });

  it("drops fields that did not move, so the diff is a diff and not a dump", () => {
    expect(entityFieldChanges({ a: "same", b: "old" }, { a: "same", b: "new" }).map((f) => f.field))
      .toEqual(["b"]);
  });

  it("hands the surface the field changes for every added, removed and changed entity", () => {
    const view = draftDiffView(
      { entities: [{ id: "k-1", type: "knowledge_entry", value: { answer: "Not offered." } }] },
      { entities: [{ id: "k-1", type: "knowledge_entry", value: { answer: "Off by default." } }] },
    );

    expect(view.changes).toHaveLength(1);
    expect(view.changes[0].fields).toEqual([
      { field: "answer", before: "Not offered.", after: "Off by default.", readable: true },
    ]);

    const added = draftDiffView(
      { entities: [] },
      { entities: [{ id: "k-2", type: "knowledge_entry", value: { answer: "Two payments." } }] },
    );
    expect(added.changes[0].fields).toEqual([
      { field: "answer", before: null, after: "Two payments.", readable: true },
    ]);

    const removed = draftDiffView(
      { entities: [{ id: "k-2", type: "knowledge_entry", value: { answer: "Two payments." } }] },
      { entities: [] },
    );
    expect(removed.changes[0].fields).toEqual([
      { field: "answer", before: "Two payments.", after: null, readable: true },
    ]);
  });
});

