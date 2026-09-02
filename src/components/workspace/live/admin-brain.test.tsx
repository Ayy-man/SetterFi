import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AdminBrain } from "@/components/workspace/live/admin-brain";
import type { AdminBrainInitialState } from "@/components/workspace/live/brain-view-models";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

function importRow(id: string, decision: "pending" | "accepted") {
  return {
    id,
    batchId: "batch-1",
    sourceRef: `notion-${id}`,
    operation: "new" as const,
    category: "pricing",
    inboundMessage: `Inbound ${id}`,
    responseTemplate: `Response ${id}`,
    disposition: null,
    decision,
    flags: [],
  };
}

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

function objectionRow(id: string, hardGate: boolean) {
  return {
    id,
    label: `Objection ${id}`,
    category: "pricing" as const,
    hardGate,
    matchKeywords: ["cost"],
    response: `Response ${id}`,
    status: "published",
    updatedAt: "2026-08-27T09:00:00.000Z",
    publishedAt: "2026-08-27T10:00:00.000Z",
  };
}

function state(
  overrides: Partial<AdminBrainInitialState> = {},
): AdminBrainInitialState {
  return {
    batch: {
      id: "batch-1",
      source: "mock",
      status: "open",
      receivedCount: 2,
      normalizedCount: 2,
      flaggedCount: 2,
      persistedItemCount: 2,
      completedAt: "2026-08-28T10:00:00.000Z",
    },
    importRows: [importRow("row-1", "pending"), importRow("row-2", "pending")],
    mission: [],
    qualification: [],
    qualificationApproved: true,
    qualificationSource: "platform",
    compliance: [],
    knowledge: [],
    snapshots: [
      {
        id: "snap-1",
        version: 4,
        contentHash: "hash-4",
        sourceHash: "source-4",
        knowledgeMode: "inline",
        platformTokens: 100,
        rollbackOfSnapshotId: null,
        publishedAt: "2026-08-20T10:00:00.000Z",
      },
    ],
    draft: {
      id: "draft-1",
      contentHash: "hash-4",
      payload: {},
      createdAt: "2026-08-28T11:00:00.000Z",
    },
    eval: {
      state: "not_run_for_this_version",
      runId: null,
      blockers: [],
      warnings: [],
    },
    citation: null,
    currentSnapshotPayload: {},
    objections: [],
    ...overrides,
  };
}

describe("AdminBrain", () => {
  it("makes Publish the page's one filled action and keeps its audit caption out of the label", () => {
    render(<AdminBrain initialState={state()} />);

    // The accessible name is the verb alone. Shipped inside the label it read as
    // "Publish to all agents PUBLISH LOGGED", which is a worse button name for a screen reader
    // and a shout on the product's most privileged control.
    const publish = screen.getByRole("button", {
      name: "Publish to all agents",
    });
    expect(publish).toBeVisible();
    expect(publish.textContent).not.toMatch(/logged/i);

    // The caption is a sibling of the button inside the LoggedButton wrapper, not a child.
    const wrapper = publish.closest('[data-slot="logged-button"]');
    expect(wrapper).not.toBeNull();
    expect(
      within(wrapper as HTMLElement).getByText("Publish logged"),
    ).toBeVisible();
  });

  it("gives the disabled Publish a reason the reader can see beside it", () => {
    render(<AdminBrain initialState={state()} />);

    const publish = screen.getByRole("button", {
      name: "Publish to all agents",
    });
    expect(publish).toBeDisabled();
    // A disabled control whose reason lives in a card 500px away is a dead end.
    expect(
      screen.getAllByText("Run the evaluation for this draft first.").length,
    ).toBeGreaterThan(0);
  });

  it("names the first unmet precondition rather than a later one", () => {
    render(<AdminBrain initialState={state({ draft: null })} />);

    // Without a draft there is nothing for an evaluation to match, so the draft is the ask.
    expect(
      screen.getAllByText("Create a saved draft first.").length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByText("Run the evaluation for this draft first."),
    ).toBeNull();
  });

  it("does not claim nothing changed while imported rows are still awaiting review", () => {
    render(<AdminBrain initialState={state()} />);

    // The page used to print "Imported 2 rows, 2 flagged" and "Nothing changed." about the same
    // draft. Both are true and they are about different things: an imported row reaches the
    // draft only once it is accepted.
    expect(screen.getByText("Imported 2 rows, 2 flagged")).toBeVisible();
    expect(screen.queryByText("Nothing changed.")).toBeNull();
    expect(
      screen.getByText(
        "Nothing yet. The 2 imported rows are still in review and join the draft once accepted.",
      ),
    ).toBeVisible();
  });

  it("says the draft matches the published version when no import is waiting", () => {
    render(
      <AdminBrain
        initialState={state({
          batch: null,
          importRows: [importRow("row-1", "accepted")],
        })}
      />,
    );

    expect(
      screen.getByText("Nothing. This draft matches the published version."),
    ).toBeVisible();
  });

  it("keeps Import now out of the page header so Publish is the only header action", () => {
    render(<AdminBrain initialState={state()} />);

    const header = document.querySelector('[data-slot="detail-page-header"]');
    expect(header).not.toBeNull();
    expect(
      within(header as HTMLElement).queryByRole("button", {
        name: "Import now",
      }),
    ).toBeNull();
    expect(
      within(header as HTMLElement).getByRole("button", {
        name: "Publish to all agents",
      }),
    ).toBeVisible();
  });

  it("labels demo rows on screen and says nothing about provenance for real ones", () => {
    // A mock import batch means everything the page reads came from one, which is a whole-page
    // claim and so renders as the chip above the title rather than a sentence under the subtitle.
    const { unmount } = render(<AdminBrain initialState={state()} />);
    expect(document.querySelector('[data-slot="provenance-chip"]')).toHaveAttribute(
      "data-provenance",
      "test",
    );
    unmount();

    render(
      <AdminBrain
        initialState={state({
          batch: {
            id: "batch-1",
            source: "notion",
            status: "open",
            receivedCount: 2,
            normalizedCount: 2,
            flaggedCount: 2,
            persistedItemCount: 2,
            completedAt: "2026-08-28T10:00:00.000Z",
          },
        })}
      />,
    );
    expect(document.querySelector('[data-slot="provenance-chip"]')).toBeNull();
  });

  it("puts a tab's count in the count slot instead of gluing it into the label", () => {
    render(
      <AdminBrain
        initialState={state({ knowledge: [knowledgeRow("k-1", "published")] })}
      />,
    );

    // "(2)" inside the label makes the tab's accessible name read "Import review 2" to a screen
    // reader every time focus lands on it. The kit has a decorative count slot for exactly this.
    const review = screen.getByRole("tab", { name: "Import review" });
    expect(within(review).getByText("2")).toHaveAttribute(
      "data-slot",
      "detail-page-tab-count",
    );
  });

  it("leaves the count off a tab that has nothing to count", () => {
    render(
      <AdminBrain initialState={state({ importRows: [], knowledge: [] })} />,
    );

    // A faint grey zero in the tab strip reads as a broken number; the empty tab says so in its
    // own body instead.
    const review = screen.getByRole("tab", { name: "Import review" });
    expect(within(review).queryByText("0")).toBeNull();
    const knowledge = screen.getByRole("tab", { name: "Knowledge" });
    expect(within(knowledge).queryByText("0")).toBeNull();
  });

  it("bands knowledge by publish state, live rows first, with no repeated status pill", async () => {
    render(
      <AdminBrain
        initialState={state({
          knowledge: [
            knowledgeRow("k-1", "draft"),
            knowledgeRow("k-2", "published"),
          ],
        })}
      />,
    );

    await userEvent.click(screen.getByRole("tab", { name: "Knowledge" }));

    const bands = screen.getAllByText(
      /^(Published, live on every agent|Draft, not yet published)$/,
    );
    expect(bands.map((node) => node.textContent)).toEqual([
      "Published, live on every agent",
      "Draft, not yet published",
    ]);
    // The band header already says what every row under it is, so the row does not say it again.
    expect(screen.queryByRole("columnheader", { name: "Status" })).toBeNull();
  });

  it("bands objections by the hard gate and leads with the gated ones", async () => {
    render(
      <AdminBrain
        initialState={state({
          objections: [objectionRow("o-1", false), objectionRow("o-2", true)],
        })}
      />,
    );

    await userEvent.click(screen.getByRole("tab", { name: "Knowledge" }));

    const bands = screen.getAllByText(
      /^(Hard-gated, figures bound to platform rules|Not gated)$/,
    );
    expect(bands.map((node) => node.textContent)).toEqual([
      "Hard-gated, figures bound to platform rules",
      "Not gated",
    ]);
    expect(screen.queryByRole("columnheader", { name: "Gate" })).toBeNull();
  });

  it("says in words that the agent cannot invent a figure", async () => {
    render(
      <AdminBrain
        initialState={state({
          objections: [objectionRow("o-1", true), objectionRow("o-2", false)],
        })}
      />,
    );

    await userEvent.click(screen.getByRole("tab", { name: "Knowledge" }));

    expect(screen.getByText("The agent cannot invent a number")).toBeVisible();
    expect(
      screen.getByText(/1 of 2 objections are hard-gated\./),
    ).toBeVisible();
  });

  it("names the gate as absent rather than claiming one when nothing is gated", async () => {
    render(
      <AdminBrain
        initialState={state({ objections: [objectionRow("o-1", false)] })}
      />,
    );

    await userEvent.click(screen.getByRole("tab", { name: "Knowledge" }));

    expect(screen.getByText(/No objection is hard-gated yet\./)).toBeVisible();
  });

  it("says a never-published brain has never published instead of printing zero", () => {
    render(
      <AdminBrain
        initialState={state({ snapshots: [], knowledge: [], objections: [] })}
      />,
    );

    // A tile reading "0" claims a measurement. These three were never taken.
    expect(screen.getByText("Never published")).toBeVisible();
    expect(screen.getByText("No entry is published yet")).toBeVisible();
    expect(screen.getByText("No answer is gated yet")).toBeVisible();
  });

  it("restates the blocker where publishing is read about, and never claims ready while blocked", () => {
    render(<AdminBrain initialState={state()} />);

    // The button is in the header and the Publish panel is three sections down, so the reason has
    // to be in both places: whichever one the reader is standing at is the one that has to answer
    // "why can I not press this". The failure this pins is the panel quietly saying "Ready" --
    // the header guards below are satisfied by the header copy alone and would not catch it.
    const panel = document.getElementById("publish-title")?.closest("[data-slot='surface']");
    expect(panel).not.toBeNull();
    expect(
      within(panel as HTMLElement).getByText(
        "Run the evaluation for this draft first.",
      ),
    ).toBeVisible();
    expect(within(panel as HTMLElement).queryByText(/^Ready\./)).toBeNull();
  });

  it("shows what the entity said before and what it will say after", () => {
    render(
      <AdminBrain
        initialState={state({
          currentSnapshotPayload: {
            entities: [
              { id: "k-1", type: "knowledge_entry", value: { answer: "Not offered." } },
            ],
            knowledgeMode: "inline",
          },
          draft: {
            id: "draft-1",
            contentHash: "hash-4",
            payload: {
              entities: [
                {
                  id: "k-1",
                  type: "knowledge_entry",
                  value: { answer: "Off by default. Two payments four weeks apart, never more." },
                },
              ],
              knowledgeMode: "inline",
            },
            createdAt: "2026-08-28T11:00:00.000Z",
          },
        })}
      />,
    );

    // Screen 1i's minus and plus lines. Both payloads are already in `draftDiffView`'s hands, so
    // this is derived text, not an authored summary -- and without it the panel names which
    // entity moved while withholding the only thing that makes a publish reviewable.
    expect(screen.getByText("Not offered.")).toBeVisible();
    expect(
      screen.getByText("Off by default. Two payments four weeks apart, never more."),
    ).toBeVisible();
  });

  it("shows a structured field's before and after, and never points at an export for them", () => {
    render(
      <AdminBrain
        initialState={state({
          currentSnapshotPayload: {
            entities: [{ id: "q-1", type: "qualification_rule", value: { tiers: [1, 2] } }],
            knowledgeMode: "inline",
          },
          draft: {
            id: "draft-1",
            contentHash: "hash-4",
            payload: {
              entities: [{ id: "q-1", type: "qualification_rule", value: { tiers: [1, 2, 3] } }],
              knowledgeMode: "inline",
            },
            createdAt: "2026-08-28T11:00:00.000Z",
          },
        })}
      />,
    );

    // A serialized array is not the plain language this panel promises, so it stays behind a
    // disclosure rather than being pasted into the flow. But it is shown: this branch used to say
    // the before and after "are in the export", and no export this page offers carries a payload
    // -- `rendered-tables.ts` declares brain-snapshot-diffs as version, hashes, knowledge mode and
    // timestamps. Pointing an admin at a document that does not hold the value is the failure.
    expect(document.body.textContent).not.toMatch(/in the export/i);
    expect(screen.getByText(/Show what it said before and after/)).toBeVisible();

    const before = document.querySelector('[data-slot="structured-diff-before"]');
    const after = document.querySelector('[data-slot="structured-diff-after"]');
    expect(before?.textContent).toEqual(JSON.stringify([1, 2], null, 2));
    expect(after?.textContent).toEqual(JSON.stringify([1, 2, 3], null, 2));
  });

  it("says a structured side that is absent is absent, in the same words a sentence field uses", () => {
    render(
      <AdminBrain
        initialState={state({
          currentSnapshotPayload: {
            entities: [{ id: "q-1", type: "qualification_rule", value: {} }],
            knowledgeMode: "inline",
          },
          draft: {
            id: "draft-1",
            contentHash: "hash-4",
            payload: {
              entities: [{ id: "q-1", type: "qualification_rule", value: { tiers: [1] } }],
              knowledgeMode: "inline",
            },
            createdAt: "2026-08-28T11:00:00.000Z",
          },
        })}
      />,
    );

    // "[]" would be a claim that the field held an empty array before, which it did not.
    expect(
      document.querySelector('[data-slot="structured-diff-before"]')?.textContent,
    ).toEqual("Not set before this draft.");
  });

  it("never sends a reader to an export for a value the export does not carry", () => {
    // The render guard above only covers the fixture it draws. This one covers the file: the
    // three export resources this page offers -- brain-snapshots, brain-snapshot-diffs and the
    // import batches -- declare no payload column in `src/lib/exports/rendered-tables.ts`, so no
    // copy anywhere on this surface may promise a value is findable there. Comments are stripped
    // first: the ban is on what the page says, not on what the source explains about it.
    // `import.meta.url` is an http URL under jsdom, so the path comes off the working directory.
    const source = readFileSync(
      join(process.cwd(), "src/components/workspace/live/admin-brain.tsx"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^\s*\/\/.*$/gmu, "");

    expect(source).not.toMatch(/in the export/iu);
  });

  it("says what a pending change reaches, not just which table it lives in", () => {
    render(
      <AdminBrain
        initialState={state({
          currentSnapshotPayload: { entities: [], knowledgeMode: "inline" },
          draft: {
            id: "draft-1",
            contentHash: "hash-4",
            payload: {
              entities: [
                { id: "c-1", type: "compliance_rule", value: { slug: "no-guarantees" } },
              ],
              knowledgeMode: "inline",
            },
            createdAt: "2026-08-28T11:00:00.000Z",
          },
        })}
      />,
    );

    // A publish reaches every coach's agent at once, so the diff has to read as a consequence.
    // "Changed compliance_rule" is the column name the row is stored under; these two sentences
    // are what the reader actually needs before pressing the button, and the second one is the
    // authored impact line the page used to compute and then throw away in favour of a
    // title-cased key.
    expect(screen.getByText("Compliance rule")).toBeVisible();
    expect(
      screen.getByText("Every reply is re-checked against it before it is sent."),
    ).toBeVisible();
    expect(
      screen.getByText("Compliance changed: every reply is re-checked."),
    ).toBeVisible();
  });

  it("counts the knowledge that is actually live, not everything saved", () => {
    render(
      <AdminBrain
        initialState={state({
          knowledge: [
            knowledgeRow("k-1", "published"),
            knowledgeRow("k-2", "draft"),
            knowledgeRow("k-3", "draft"),
          ],
        })}
      />,
    );

    // The tile is a deck panel since the console port, so the element holding both its label and
    // its figure is the panel's `<section>` rather than the flat `<div>` StatStrip drew.
    const tile = screen.getByText("Knowledge live on agents").closest("section");
    expect(tile).not.toBeNull();
    expect(within(tile as HTMLElement).getByText("1")).toBeVisible();
    expect(screen.getByText("2 still draft")).toBeVisible();
  });
  /**
   * The corpus panel, and the two columns the canvas draws that cannot be filled.
   *
   * The canvas counts `brain_documents` and prints an "Edited by" beside each section. Both are
   * refused here. `brain_documents` and `brain_chunks` are labelled in the schema itself as
   * reserved and unused by the structured-row runtime, so counting them would print a Brain of
   * zero documents while the agents answer from a full one -- a fabricated emptiness, and as wrong
   * as a fabricated figure. And no Brain table carries an actor at all, so the panel says where
   * attribution actually lives instead of leaving a column to be filled with something.
   */
  it("counts the tables the runtime reads, and names no editor because no table records one", () => {
    render(
      <AdminBrain
        initialState={state({
          knowledge: [knowledgeRow("k-1", "published"), knowledgeRow("k-2", "draft")],
          objections: [objectionRow("o-1", true)],
          compliance: [],
        })}
      />,
    );

    expect(screen.getByText("What the Brain knows")).toBeVisible();
    const group = screen.getByText("Answers to questions leads ask")
      .closest('[data-slot="setting-group"]');
    expect(group).not.toBeNull();
    const corpus = within(group as HTMLElement);

    // Live-of-total, so a draft entry is never counted as something an agent can cite.
    expect(corpus.getByText("1 live of 2")).toBeVisible();
    // A part with nothing in it says so rather than printing a zero that reads as a broken count.
    expect(corpus.getAllByText("Nothing recorded").length).toBeGreaterThan(0);
    expect(corpus.queryByText(/Edited by/i)).toBeNull();
    expect(
      screen.getByText(/No Brain table records who changed a row/),
    ).toBeVisible();
  });

  /**
   * CLAUDE.md: "Every table exports CSV/JSON." Six export controls on this page were wrapped in
   * `exportReason.trim() ? … : undefined`, so a reader saw tables with no export affordance at all
   * until they filled a page-level reason field above them -- and nothing on screen said a reason
   * was what was missing. The rule was broken from the reader's side even though the control
   * existed in the source.
   *
   * The server constraint is real and stays: `/api/exports/[resource]` refuses a platform export
   * with no reason. `ExportMenu` collects it inside itself, labels it "Required for this export",
   * and holds both downloads disabled until it is filled, which is `admin-audit-log.tsx`'s and
   * `admin-testing.tsx`'s pattern -- the requirement enforced where it is explained.
   */
  it("shows every export without a page-level reason field, and keeps each one disabled until the menu's own reason is filled", async () => {
    render(<AdminBrain initialState={state({
      importRows: [importRow("row-1", "pending")],
    })} />);

    await userEvent.click(screen.getByRole("tab", { name: "Import review" }));

    // Named rather than counted: these sit in pairs, and a bare count passes for two controls that
    // both read "Export".
    const batches = screen.getByRole("button", { name: "Export import batches" });
    expect(batches).toBeEnabled();
    expect(screen.getByRole("button", { name: "Export import rows" })).toBeEnabled();
    // The field that used to gate them is gone from the page body.
    expect(screen.queryByLabelText("Export reason")).toBeNull();

    await userEvent.click(batches);
    const menu = await screen.findByRole("menu");
    const csv = within(menu).getByRole("menuitem", { name: /Download CSV/ });
    expect(csv).toHaveAttribute("data-disabled");
    expect(within(menu).getByText("Required for this export.")).toBeVisible();

    await userEvent.type(within(menu).getByLabelText("Export reason"), "Quarterly brain audit");
    expect(
      within(menu).getByRole("menuitem", { name: /Download CSV/ }),
    ).not.toHaveAttribute("data-disabled");
  });

  it("does not build the corpus from the tables the schema calls reserved and unused", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/workspace/live/admin-brain.tsx"),
      "utf8",
    );
    const comment = source.indexOf("reserved and unused by the Phase 2");

    // Naming them in the comment that explains the refusal is fine; reading them is not.
    expect(source).not.toMatch(/from\(\s*["']brain_documents["']/);
    expect(source).not.toMatch(/from\(\s*["']brain_chunks["']/);
    expect(comment).toBeGreaterThan(-1);
  });
});
