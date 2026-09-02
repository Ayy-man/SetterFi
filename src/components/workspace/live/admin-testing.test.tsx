import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminBrainTesting } from "@/components/workspace/live/admin-testing";
import type {
  ComparisonArmMetrics,
  EvalComparisonResult,
} from "@/lib/evals/comparison";
import type { TestingView } from "@/components/workspace/live/view-models";

const testing: TestingView = {
  moderatorUnavailableCount: 0,
  arms: [
    {
      id: "A",
      label: "Baseline generator",
      role: "Generator",
      state: "Mock",
      reason: null,
      trace: null,
      grounded: false,
    },
    {
      id: "B",
      label: "Challenger generator",
      role: "Generator",
      state: "Skipped",
      reason: "Real driver selected without a usable key",
      trace: null,
      grounded: false,
    },
  ],
};

describe("AdminBrainTesting", () => {
  it("keeps adjacent sentences separated in the known empty-arm fixture", () => {
    const { container } = render(
      <AdminBrainTesting
        tenant={{
          id: "81000000-0000-4000-8000-000000000001",
          name: "Synthetic Demo Funding",
          isDemo: true,
        }}
        testing={testing}
      />,
    );

    const renderedText = container.textContent ?? "";
    // When neither arm has a trace the page says so once, above both cards, rather than printing
    // the identical sentence in two panels side by side.
    expect(
      screen.getByText(
        "No arm has a saved trace, so neither carries a grounding or outcome claim yet.",
      ),
    ).toBeInTheDocument();
    expect(
      renderedText.match(
        /No saved trace\. This arm has no grounding or outcome claim\./g,
      ),
    ).toBeNull();
    expect(renderedText).not.toContain("traceThis");
    // The role is a tag beside the name, never joined onto it -- that produced "Generator, Generator".
    expect(renderedText).not.toContain("Baseline generator, Generator");
    expect(screen.getAllByText("Generator")).toHaveLength(2);
    expect(screen.getByText("Test workspace data")).toBeInTheDocument();
    expect(screen.getByText("Excluded from analytics")).toBeInTheDocument();
    // Still said exactly once. The count is what this line is for: the drift it catches is the
    // page-level disclosure being repeated per panel until it stops being read.
    expect(renderedText.match(/test workspace data/giu)).toHaveLength(1);
  });
});

describe("AdminBrainTesting comparison evidence", () => {
  const metrics: ComparisonArmMetrics = {
    passed: 3,
    total: 4,
    passRate: 75,
    falseBlocks: 1,
    negativeCases: 2,
    providerCostCredits: 0.4,
    costPerCaseCredits: 0.1,
    costPerThousandCredits: 100,
    latencyP50Ms: 20,
    latencyP95Ms: 40,
  };
  const emptyMetrics = Object.fromEntries(
    Object.keys(metrics).map((key) => [key, null]),
  ) as ComparisonArmMetrics;

  const comparison: EvalComparisonResult = {
    comparisonId: "comparison-1",
    status: "completed",
    state: "non_comparable",
    stateReason: "voice_tone:not_configured",
    driverArm: "mock",
    brainDraftVersionId: "draft-1",
    contentHash: "a".repeat(64),
    brainVersion: null,
    offerVersion: null,
    rulesVersion: "rules-1",
    knowledgeMode: null,
    corpusRevision: "corpus-1",
    caseSetHash: "b".repeat(64),
    modelConfigAId: "config-a",
    modelConfigBId: "config-b",
    runAId: "run-a",
    runBId: "run-b",
    createdAt: "2026-08-18T00:00:00.000Z",
    finishedAt: "2026-08-18T00:01:00.000Z",
    suites: [
      {
        suite: "voice_tone",
        state: "not_configured",
        armA: emptyMetrics,
        armB: emptyMetrics,
      },
      {
        suite: "compliance_guardrails",
        state: "comparable",
        armA: metrics,
        armB: metrics,
      },
    ],
  };

  const panel = {
    enabled: true,
    configs: [
      {
        id: "config-a",
        label: "Active generator",
        model: "model-a",
        active: true,
      },
      {
        id: "config-b",
        label: "Challenger generator",
        model: "model-b",
        active: false,
      },
    ],
    draft: { id: "draft-1", contentHash: "a".repeat(64) },
  };

  function renderBench() {
    return render(
      <AdminBrainTesting
        comparison={panel}
        tenant={{
          id: "81000000-0000-4000-8000-000000000001",
          name: "Synthetic Demo Funding",
          isDemo: true,
        }}
        testing={testing}
      />,
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("counts the configured arms in the tab's count slot, not in its name", () => {
    renderBench();

    // Read aloud, "Test bench 2" is a worse tab name than "Test bench"; the count is decorative
    // and belongs in the slot the kit provides for it.
    const bench = screen.getByRole("tab", { name: "Test bench" });
    expect(within(bench).getByText("2")).toHaveAttribute(
      "data-slot",
      "detail-page-tab-count",
    );
  });

  it("leaves the comparison tab uncounted until a run has produced suites", () => {
    renderBench();

    const tab = screen.getByRole("tab", { name: "Comparison" });
    expect(within(tab).queryByText("0")).toBeNull();
  });

  it("marks an unmeasured arm cell as an absence rather than a value", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ comparison }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    renderBench();
    await userEvent.click(screen.getByRole("tab", { name: "Comparison" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Run comparison" }),
    );

    // "Not configured" sitting plain in a numeric column reads as a value. The suite that did
    // not run has no measurement, and the cell says so in the kit's absence treatment.
    const absent = await screen.findAllByText("not configured");
    expect(absent.length).toBeGreaterThan(0);
    for (const node of absent)
      expect(node).toHaveAttribute("data-slot", "absent-value");
  });

  it("bands saved suites by outcome, comparable first, and drops the repeated state column", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ comparison }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    renderBench();
    await userEvent.click(screen.getByRole("tab", { name: "Comparison" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Run comparison" }),
    );

    const bands = await screen.findAllByText(
      /^(Comparable, both arms ran the same cases|Not configured)$/,
    );
    // The band order is the reading order: the suites that produced a verdict, then the ones
    // that did not. Row order in the payload does not decide it.
    expect(bands.map((node) => node.textContent)).toEqual([
      "Comparable, both arms ran the same cases",
      "Not configured",
    ]);
    // The band header says what every row under it is, so the row does not repeat it.
    expect(screen.queryByRole("columnheader", { name: "State" })).toBeNull();
  });

  it("counts the suites in the comparison tab once a run has produced them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ comparison }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    renderBench();
    await userEvent.click(screen.getByRole("tab", { name: "Comparison" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Run comparison" }),
    );

    await screen.findByText("Comparable, both arms ran the same cases");
    const tab = screen.getByRole("tab", { name: "Comparison" });
    expect(within(tab).getByText("2")).toHaveAttribute(
      "data-slot",
      "detail-page-tab-count",
    );
  });

  it("says a refused comparison recorded nothing rather than leaving a bare code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              state: "refused",
              code: "EVAL_COMPARISON_REFUSED",
            }),
            { status: 422, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    renderBench();
    await userEvent.click(screen.getByRole("tab", { name: "Comparison" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Run comparison" }),
    );

    expect(
      await screen.findByText("The comparison request did not complete"),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Nothing was saved, so no suite carries a verdict from this attempt.",
        { exact: false },
      ),
    ).toBeVisible();
  });
  /**
   * CLAUDE.md: "Every table exports CSV/JSON." This page used to render neither export control
   * until a reason was typed into a field beside them, so the default state of the only table on
   * the surface was no export at all -- and nothing on screen said a reason was what was missing.
   *
   * The rule is now guarded from the reader's side rather than from the prop's: both menus are
   * present, both offer CSV and JSON, and both refuse to download until the reason `ExportMenu`
   * asks for is filled in. Asserting only that `exportResource` is passed would pass again the
   * moment somebody re-wraps it in a condition.
   */
  it("puts both eval exports on screen before any reason is typed, and offers CSV and JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ comparison }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    renderBench();
    await userEvent.click(screen.getByRole("tab", { name: "Comparison" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Run comparison" }),
    );

    // Two exports of two different resources, so neither is called the bare word: one row per
    // comparison run, one row per suite result.
    const runs = await screen.findByRole("button", { name: "Export comparison runs" });
    const results = screen.getByRole("button", { name: "Export suite results" });
    expect(runs).toBeEnabled();
    expect(results).toBeEnabled();

    await userEvent.click(results);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Download CSV/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Download JSON/ })).toBeInTheDocument();
  });

  it("keeps the download disabled until the reason the menu asks for is filled in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ comparison }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    renderBench();
    await userEvent.click(screen.getByRole("tab", { name: "Comparison" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Run comparison" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Export suite results" }),
    );

    const menu = await screen.findByRole("menu");
    const csv = within(menu).getByRole("menuitem", { name: /Download CSV/ });
    // Always reachable, never armed by accident: the reason is a platform export audit record,
    // and the control says so where it is asked for rather than in a field somewhere else.
    expect(csv).toHaveAttribute("data-disabled");
    expect(within(menu).getByText("Required for this export.")).toBeVisible();

    await userEvent.type(
      within(menu).getByLabelText("Export reason"),
      "Quarterly model review",
    );
    expect(
      within(menu).getByRole("menuitem", { name: /Download CSV/ }),
    ).not.toHaveAttribute("data-disabled");
  });

  /**
   * CLAUDE.md: "Test data is segregated from real analytics, and labeled as such on-screen."
   *
   * The page carried an `isTest: true` prop that nothing rendered, which satisfies the first half
   * and not the second. The rows are `eval_cases` run through both arms -- never lead
   * conversations -- so the table says that under itself, unconditionally, rather than depending
   * on the tenant happening to be a demo one.
   */
  it("says on screen that the suite rows are eval cases and reach no analytics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ comparison }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    renderBench();
    await userEvent.click(screen.getByRole("tab", { name: "Comparison" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Run comparison" }),
    );

    expect(
      await screen.findByText(
        "Every row is a case from the eval case set run through both arms, never a real lead conversation, and nothing here reaches analytics.",
      ),
    ).toBeVisible();
  });
});
