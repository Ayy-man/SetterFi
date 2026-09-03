import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/brain",
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import {
  OwnerBrain,
  brainSectionRows,
  ownerBrainTab,
} from "@/components/workspace/rehaul/owner-brain";
import type { AdminBrainInitialState } from "@/components/workspace/live/brain-view-models";

/** One sentence the live surface printed under a heading. It must not survive the rehaul. */
const OLD_EXPLAINER =
  "Every coach's agent reads this one shared configuration, so a publish reaches all of them at once, from their next reply onward.";
const OLD_SUBTITLE =
  "Review, evaluate, publish, and roll back the shared platform configuration from saved evidence.";

function knowledgeRow(id: string, status: "published" | "draft") {
  return {
    id,
    category: "pricing",
    inboundMessage: `What does ${id} cost?`,
    responseTemplate: `Response ${id}`,
    status,
    updatedAt: "2026-08-27T09:00:00.000Z",
    publishedAt: status === "published" ? "2026-08-27T10:00:00.000Z" : null,
  };
}

function state(overrides: Partial<AdminBrainInitialState> = {}): AdminBrainInitialState {
  return {
    batch: {
      id: "batch-1",
      source: "notion",
      status: "open",
      receivedCount: 2,
      normalizedCount: 2,
      flaggedCount: 1,
      persistedItemCount: 2,
      completedAt: "2026-08-28T10:00:00.000Z",
    },
    importRows: [{
      id: "row-1",
      batchId: "batch-1",
      sourceRef: "notion-row-1",
      operation: "new" as const,
      category: "pricing",
      inboundMessage: "Inbound row-1",
      responseTemplate: "Response row-1",
      disposition: null,
      decision: "pending" as const,
      flags: [],
    }],
    mission: [{ id: "mission:goal", label: "goal", text: "Book qualified calls." }],
    qualification: [],
    qualificationApproved: true,
    qualificationSource: "platform",
    compliance: [],
    knowledge: [
      knowledgeRow("entry-1", "published"),
      knowledgeRow("entry-2", "published"),
      knowledgeRow("entry-3", "draft"),
    ],
    objections: [],
    snapshots: [{
      id: "snap-1",
      version: 12,
      contentHash: "hash-12",
      sourceHash: "source-12",
      knowledgeMode: "inline",
      platformTokens: 100,
      rollbackOfSnapshotId: null,
      publishedAt: "2026-09-02T10:00:00.000Z",
    }],
    draft: null,
    eval: { state: "not_run_for_this_version", runId: null, blockers: [], warnings: [] },
    citation: null,
    currentSnapshotPayload: null,
    ...overrides,
  };
}

describe("ownerBrainTab", () => {
  it("accepts the seven tab ids and falls back to the overview", () => {
    expect(ownerBrainTab("versions")).toBe("versions");
    expect(ownerBrainTab("evals")).toBe("evals");
    expect(ownerBrainTab("not-a-tab")).toBe("overview");
    expect(ownerBrainTab(undefined)).toBe("overview");
  });
});

describe("brainSectionRows", () => {
  it("counts live against total per part, and says what differs from live", () => {
    const rows = brainSectionRows(state(), { knowledge_entry: 2 });
    const answers = rows.find((row) => row.title === "Answers to questions leads ask");
    const mission = rows.find((row) => row.title === "Mission and voice");

    expect(answers).toMatchObject({ live: 2, total: 3, changed: 2, changeTone: "amber" });
    expect(answers?.changeLabel).toBe("2 entities differ");
    expect(mission).toMatchObject({ live: 1, total: 1, changeLabel: "No change", changeTone: "neutral" });
  });

  it("reports the rows a part has not published rather than a change it cannot see", () => {
    const rows = brainSectionRows(state(), {});
    const answers = rows.find((row) => row.title === "Answers to questions leads ask");

    expect(answers?.changeLabel).toBe("1 not live yet");
  });
});

describe("OwnerBrain", () => {
  it("renders the title, the published version and the live knowledge figure", () => {
    render(<OwnerBrain initialState={state()} tab="overview" />);

    expect(screen.getByRole("heading", { level: 1, name: "The Brain" })).toBeInTheDocument();
    expect(screen.getByText(/Published v12/)).toBeInTheDocument();
    const tile = screen.getByText("Live knowledge").parentElement!;
    expect(within(tile).getByText("2")).toBeInTheDocument();
    expect(within(tile).getByText(/entries/)).toBeInTheDocument();
  });

  it("prints no explainer sentence the live surface carried under a heading", () => {
    render(<OwnerBrain initialState={state()} tab="overview" />);

    expect(screen.queryByText(OLD_EXPLAINER)).not.toBeInTheDocument();
    expect(screen.queryByText(OLD_SUBTITLE)).not.toBeInTheDocument();
  });

  it("says why publishing is blocked instead of leaving a dead control", () => {
    render(<OwnerBrain initialState={state()} tab="overview" />);

    expect(screen.getByText("Create a saved draft first.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Publish to all agents/ })).toBeDisabled();
  });

  it("renders the folded Evals surface on the evals tab and nothing of it elsewhere", () => {
    const evals = <p>Folded evals surface</p>;
    const { rerender } = render(
      <OwnerBrain evals={evals} initialState={state()} tab="evals" />,
    );
    expect(screen.getByText("Folded evals surface")).toBeInTheDocument();

    rerender(<OwnerBrain evals={evals} initialState={state()} tab="overview" />);
    expect(screen.queryByText("Folded evals surface")).not.toBeInTheDocument();
  });
});

describe("OwnerBrain, review fixes", () => {
  it("gives the publish preview table an export", () => {
    render(<OwnerBrain initialState={state()} tab="overview" />);

    expect(screen.getByRole("button", { name: /Export publish preview/ })).toBeInTheDocument();
  });

  it("shows the logged microcopy beside the draft save", () => {
    render(<OwnerBrain initialState={state()} tab="overview" />);

    const save = screen.getByRole("button", { name: /Save draft from current rows/ });
    expect(within(save.parentElement!).getByText("Logged")).toBeInTheDocument();
  });

  it("shows the logged microcopy beside the import", () => {
    render(<OwnerBrain initialState={state()} tab="review" />);

    const importNow = screen.getByRole("button", { name: /Import now/ });
    expect(within(importNow.parentElement!).getByText("Logged")).toBeInTheDocument();
  });

  it("starts the synthetic turn empty rather than prefilling an invented question", () => {
    render(<OwnerBrain initialState={state()} tab="overview" />);

    const input = screen.getByLabelText("Synthetic test turn") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Type a message a lead might send");
  });

  it("keeps green off an unsaved flag decision and off the synthetic-turn explainer", () => {
    const withFlag = state({
      importRows: [{
        id: "row-1",
        batchId: "batch-1",
        sourceRef: "notion-row-1",
        operation: "new" as const,
        category: "pricing",
        inboundMessage: "Inbound row-1",
        responseTemplate: "Response row-1",
        disposition: null,
        decision: "pending" as const,
        flags: [{
          id: "flag-1",
          code: "first_person_pii",
          severity: "blocking" as const,
          field: "responseTemplate",
          offset: 0,
          resolved: false,
        }],
      }],
    });
    render(<OwnerBrain initialState={withFlag} tab="review" />);

    expect(screen.getByText("Blocking")).toBeInTheDocument();
    expect(screen.queryByText("Resolved")).not.toBeInTheDocument();
  });

  it("titles the objection callout without the explainer sentence", () => {
    render(<OwnerBrain initialState={state()} tab="knowledge" />);

    expect(screen.getByText("Hard-gated objections")).toBeInTheDocument();
    expect(screen.queryByText("The agent cannot invent a number")).not.toBeInTheDocument();
  });
});
