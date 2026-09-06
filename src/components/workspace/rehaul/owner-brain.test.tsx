import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/brain",
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import {
  OwnerBrain,
  brainSectionRows,
  type OwnerBrainProps,
} from "@/components/workspace/rehaul/owner-brain";
import {
  emptyPlatformContent,
  type OwnerBrainApi,
  type PlatformContentView,
  type TestTurnResult,
} from "@/components/workspace/rehaul/owner-brain-api";
import type { AdminBrainInitialState } from "@/components/workspace/live/brain-view-models";
import { OWNER_BRAIN_TABS, ownerBrainTab } from "@/lib/console-tabs";

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

const COACHES = [
  { id: "tenant-demo", name: "Demo Coach", isDemo: true },
  { id: "tenant-real", name: "Real Coach", isDemo: false },
];

function turn(overrides: Partial<TestTurnResult> = {}): TestTurnResult {
  return {
    reply: "Happy to help. What are you earning per month right now?",
    held: false,
    heldClass: null,
    evidence: {
      citations: [{ entryId: "entry-1", question: "What does entry-1 cost?" }],
      qualification: { ruleId: "REV-001", outcome: "BOOK", step: 1, of: 4 },
      safety: {
        checks: [{ class: "NUM", passed: true, ruleId: null }, { class: "CLAIM", passed: true, ruleId: null }],
        moderator: { verdict: "allowed", ms: 900 },
      },
      promptHash: "abcdef1234567890",
      tokens: 2100,
      channelLength: { chars: 54, soft: 160, hard: 320 },
    },
    ...overrides,
  };
}

function fakeApi(overrides: Partial<OwnerBrainApi> = {}): OwnerBrainApi {
  const never = () => new Promise<never>(() => {});
  return {
    runTestTurn: vi.fn(async () => turn()),
    readPlatformContent: vi.fn(never),
    savePlatformContentDraft: vi.fn(never),
    approvePlatformContent: vi.fn(never),
    readAssembledPrompt: vi.fn(never),
    acceptImportItem: vi.fn(async () => ({})),
    rejectImportItem: vi.fn(async () => ({})),
    ...overrides,
  };
}

function renderBrain(props: Partial<OwnerBrainProps> = {}) {
  return render(
    <OwnerBrain
      api={fakeApi()}
      coaches={COACHES}
      initialState={state()}
      tab="behavior"
      {...props}
    />,
  );
}

describe("ownerBrainTab", () => {
  it("accepts the eight tab ids, folds the old ones, and falls back to Behavior", () => {
    for (const tab of OWNER_BRAIN_TABS) expect(ownerBrainTab(tab)).toBe(tab);
    expect(ownerBrainTab("overview")).toBe("behavior");
    expect(ownerBrainTab("versions")).toBe("behavior");
    expect(ownerBrainTab("evals")).toBe("suite");
    expect(ownerBrainTab("diagnostics")).toBe("suite");
    expect(ownerBrainTab("not-a-tab")).toBe("behavior");
    expect(ownerBrainTab(undefined)).toBe("behavior");
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

describe("OwnerBrain, frame", () => {
  it("renders the title, the live version pill, the rail and the header actions", () => {
    renderBrain();

    expect(screen.getByRole("heading", { level: 1, name: "The Brain" })).toBeInTheDocument();
    expect(screen.getAllByText(/Live v12/).length).toBeGreaterThan(0);
    const rail = screen.getByRole("navigation", { name: "Configure" });
    for (const label of ["Behavior", "Qualification", "Knowledge", "Safety", "Models"]) {
      expect(within(rail).getByRole("link", { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(within(rail).getByText("HOW SETTINGS APPLY")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "History" })).toBeInTheDocument();
    expect(screen.getByText("Inspect prompt").closest("a")).toHaveAttribute("href", expect.stringContaining("tab=prompt"));
    expect(screen.getByRole("button", { name: "Review & publish" })).toBeInTheDocument();
  });

  it("tags every editable field with who it reaches", () => {
    renderBrain();

    const tags = document.querySelectorAll('[data-slot="scope-tag"][data-scope="ALL"]');
    expect(tags.length).toBeGreaterThan(0);
  });

  it("prints no explainer sentence the live surface carried under a heading", () => {
    renderBrain();

    expect(screen.queryByText(OLD_EXPLAINER)).not.toBeInTheDocument();
    expect(screen.queryByText(OLD_SUBTITLE)).not.toBeInTheDocument();
  });

  it("shows the logged microcopy beside the draft save", () => {
    renderBrain();

    const save = screen.getByRole("button", { name: /Save draft/ });
    expect(within(save.parentElement!).getByText("Logged")).toBeInTheDocument();
  });

  it("shows the logged microcopy beside the import", () => {
    renderBrain({ tab: "knowledge" });

    const importNow = screen.getByRole("button", { name: /^Import/ });
    expect(within(importNow.parentElement!).getByText("Logged")).toBeInTheDocument();
  });

  it("says why publishing is blocked instead of leaving a dead control", async () => {
    renderBrain();

    fireEvent.click(screen.getByRole("button", { name: "Review & publish" }));

    await waitFor(() => expect(screen.getByText("Create a saved draft first.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Publish v13/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Export publish preview/ })).toBeInTheDocument();
  });
});

describe("OwnerBrain, test conversation", () => {
  it("starts the lead reply empty rather than prefilling an invented question", () => {
    renderBrain();

    const input = screen.getByLabelText("Reply as the lead") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Reply as the lead");
  });

  it("runs a turn against the chosen coach on the draft and shows the evidence under the reply", async () => {
    const api = fakeApi();
    render(<OwnerBrain api={api} coaches={COACHES} initialState={state()} tab="behavior" />);

    fireEvent.change(screen.getByLabelText("Reply as the lead"), { target: { value: "How much is it?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText(/What are you earning per month/)).toBeInTheDocument());
    expect(api.runTestTurn).toHaveBeenCalledWith(expect.objectContaining({
      coachTenantId: "tenant-demo",
      revision: "draft",
      channel: "sms",
      message: "How much is it?",
      history: [],
    }));
    expect(screen.getByText(/Rule: REV-001/)).toBeInTheDocument();
    expect(screen.getByText(/Safety: 2 checks passed/)).toBeInTheDocument();
    expect(screen.getByText(/Knowledge: /)).toBeInTheDocument();
  });

  it("prints a held reply as held, with its class", async () => {
    const api = fakeApi({
      runTestTurn: vi.fn(async () => turn({
        reply: "",
        held: true,
        heldClass: "NUM",
        evidence: { ...turn().evidence, safety: { checks: [{ class: "NUM", passed: false, ruleId: "NUM-001" }], moderator: { verdict: "blocked", ms: 400 } } },
      })),
    });
    render(<OwnerBrain api={api} coaches={COACHES} initialState={state()} tab="behavior" />);

    fireEvent.change(screen.getByLabelText("Reply as the lead"), { target: { value: "Guarantee me 10k" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText(/Held · NUM/)).toBeInTheDocument());
    expect(screen.getByText(/Safety: NUM-001/)).toBeInTheDocument();
  });

  it("prints the route failure honestly when the turn cannot run", async () => {
    const api = fakeApi({ runTestTurn: vi.fn(async () => { throw new Error("TEST_TURN_FAILED"); }) });
    render(<OwnerBrain api={api} coaches={COACHES} initialState={state()} tab="behavior" />);

    fireEvent.change(screen.getByLabelText("Reply as the lead"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("TEST_TURN_FAILED"));
  });
});

describe("OwnerBrain, full-width views", () => {
  it("renders the folded evals surface on the suite view and nothing of it elsewhere", () => {
    const evals = <p>Folded evals surface</p>;
    const { rerender } = render(
      <OwnerBrain api={fakeApi()} coaches={COACHES} evals={evals} initialState={state()} tab="suite" />,
    );
    expect(screen.getByText("Folded evals surface")).toBeInTheDocument();
    // The rail stays on a full-width view; the test conversation is what gives way.
    expect(screen.getByRole("navigation", { name: "Configure" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Test conversation" })).not.toBeInTheDocument();

    rerender(<OwnerBrain api={fakeApi()} coaches={COACHES} evals={evals} initialState={state()} tab="behavior" />);
    expect(screen.queryByText("Folded evals surface")).not.toBeInTheDocument();
  });

  it("keeps green off an unsaved flag decision and blocks approval until the answer is edited", () => {
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
    renderBrain({ initialState: withFlag, tab: "review" });

    expect(screen.getByText("Blocking")).toBeInTheDocument();
    expect(screen.queryByText("Resolved")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve to draft/ })).toBeDisabled();
    expect(screen.getByText(/Edit the answer before approving/)).toBeInTheDocument();
  });

  it("gives every slot that can block approval an editor and names the blockers in words", async () => {
    const live = { ...emptyPlatformContent(), scopeClosing: "SETTERFI_DEMO_PLACEHOLDER_SCOPE_CLOSING" };
    const draft = { ...live, platformFrame: "Frame", controlCopy: { STOP: "Unsubscribed.", HELP: "Reply STOP to opt out.", START: "" } };
    const view: PlatformContentView = {
      approved: null,
      live,
      draft,
      draftHash: "1".repeat(64),
      blockers: ["scopeClosing", "heldReplies.NUM", "controlCopy.START"],
      canApprove: false,
      mission: "",
      qualification: "",
    };
    renderBrain({ api: fakeApi({ readPlatformContent: vi.fn(async () => view) }), tab: "safety" });

    expect(await screen.findByLabelText("Reply to STOP")).toHaveValue("Unsubscribed.");
    expect(screen.getByLabelText("Reply to START")).toHaveValue("");
    expect(screen.getByLabelText("Third off-topic message")).toHaveValue("SETTERFI_DEMO_PLACEHOLDER_SCOPE_CLOSING");
    expect(screen.getByLabelText("First off-topic message")).toBeInTheDocument();
    expect(screen.getByText(/Approval is blocked until these are written: third off-topic message, holding message for NUM, START reply\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve for every agent" })).toBeDisabled();
  });

  it("lists every import row in the master list and shows the selected one", () => {
    renderBrain({ tab: "review" });

    expect(screen.getByText("Review imports")).toBeInTheDocument();
    expect(screen.getByText("Clean, ready to approve")).toBeInTheDocument();
    expect((screen.getByLabelText("Agent answers") as HTMLTextAreaElement).value).toBe("Response row-1");
    expect(screen.getByRole("button", { name: /Export import rows/ })).toBeInTheDocument();
  });

  it("assembles the prompt for the chosen coach and revision", async () => {
    const api = fakeApi({
      readAssembledPrompt: vi.fn(async () => ({
        blocks: [
          { label: "[A0]", title: "System frame", source: "system" as const, text: "You are the coach's assistant." },
          { label: "[C]", title: "Coach offer", source: "coach" as const, text: "Programme: 12 weeks." },
        ],
        promptHash: "0123456789abcdef",
        tokens: 1800,
        knowledgeMode: "inline",
      })),
    });
    render(<OwnerBrain api={api} coaches={COACHES} initialState={state()} tab="prompt" />);

    await waitFor(() => expect(screen.getByText("System frame")).toBeInTheDocument());
    expect(api.readAssembledPrompt).toHaveBeenCalledWith({ coachTenantId: "tenant-demo", revision: "draft" });
    expect(screen.getByText("You are the coach's assistant.")).toBeInTheDocument();
    expect(screen.getByText(/1,800 tokens/)).toBeInTheDocument();
  });
});

describe("OwnerBrain, knowledge and objections", () => {
  it("lists answers with their publish state and a hard-gated objection with its gate", () => {
    renderBrain({
      initialState: state({
        objections: [{
          id: "obj-1",
          label: "Too expensive",
          category: "pricing",
          hardGate: true,
          matchKeywords: ["expensive"],
          response: "Totally fair. What would make it worth it?",
          status: "published",
          updatedAt: null,
          publishedAt: null,
        }],
      }),
      tab: "knowledge",
    });

    expect(screen.getByText("What does entry-3 cost?")).toBeInTheDocument();
    expect(screen.getAllByText("Draft").length).toBeGreaterThan(0);
    expect(screen.getByText("Too expensive")).toBeInTheDocument();
    expect(screen.getByText("Hard-gated")).toBeInTheDocument();
  });
});
