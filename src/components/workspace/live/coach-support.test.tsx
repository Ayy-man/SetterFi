import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoachSupport } from "@/components/workspace/live/coach-support";
import type { CoachSupportThreadRead } from "@/lib/repositories/support";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const thread: CoachSupportThreadRead = {
  id: "thread-one",
  tenantId: "tenant-one",
  subject: "Calendar setup question",
  status: "open",
  assignedTo: null,
  isTest: false,
  createdAt: "2026-08-24T09:00:00.000Z",
  updatedAt: "2026-08-24T10:00:00.000Z",
  messages: [{
    id: "message-one",
    authorId: "author-one",
    authorName: "Aisha Bello",
    body: "Can you help me check my booking hours?",
    isTest: false,
    createdAt: "2026-08-24T10:00:00.000Z",
  }],
};

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CoachSupport", () => {
  it("opens on Support and renders a saved message without a table above it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ threads: [thread] })));

    render(<CoachSupport enabled />);

    expect(screen.getByRole("tab", { name: "Support" })).toHaveAttribute("aria-selected", "true");
    const messageList = await screen.findByRole("feed", { name: "Support messages" });
    expect(screen.getByText("Can you help me check my booking hours?")).toBeVisible();
    expect(messageList).toContainElement(screen.getByText("Can you help me check my booking hours?"));
    expect(document.querySelector("table")).not.toBeInTheDocument();
  });

  it("renders a non-error empty state on the default tab when there are no requests", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ threads: [] })));

    render(<CoachSupport enabled />);

    expect(await screen.findByRole("heading", { name: "No support requests" })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "Support" })).toHaveAttribute("aria-selected", "true");
  });
});

/**
 * Help is a reading surface with one verb on it. These pin the two things the redesign claims:
 * the page spends exactly one accent fill and it follows the live action, and prose stays inside
 * the Line Length rule instead of running the width of the pane.
 */
describe("CoachSupport, redesign invariants", () => {
  it("spends exactly one accent fill, on the reply when a request is open", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ threads: [thread] })));

    render(<CoachSupport enabled />);

    await screen.findByRole("feed", { name: "Support messages" });
    const fills = document.querySelectorAll('[class*="--accent-fill"]');
    expect(fills, "one accent fill on the page, never two and never zero").toHaveLength(1);
    expect(fills[0].textContent).toBe("Send reply");
    expect(screen.getByRole("button", { name: "Create request" }).className)
      .not.toContain("--accent-fill");
  });

  it("moves the fill to Create request when there is nothing to reply to", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ threads: [] })));

    render(<CoachSupport enabled />);

    await screen.findByRole("heading", { name: "No support requests" });
    const fills = document.querySelectorAll('[class*="--accent-fill"]');
    expect(fills).toHaveLength(1);
    expect(fills[0].textContent).toBe("Create request");
  });

  it("caps every run of prose at a readable measure and never nests a card", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ threads: [thread] })));

    render(<CoachSupport enabled />);

    const body = await screen.findByText("Can you help me check my booking hours?");
    expect(body.className, "message bodies stay inside the Line Length rule").toContain("max-w-[var(--measure-prose)]");

    /*
     * The card shape moved from `Surface` to `DeckPanel` in the coach port, and the nesting check
     * moved with it. Without the length assertion first this loop would have gone vacuous the
     * moment the selector stopped matching anything -- which is exactly what happened to the
     * `.surface-card` version of it, and why the count is asserted before the nesting is.
     */
    const panels = document.querySelectorAll(".coach-panel");
    expect(panels.length, "the page is built out of deck panels").toBeGreaterThan(0);
    for (const panel of panels) {
      expect(panel.querySelector(".coach-panel")).toBeNull();
    }
  });

  /**
   * The layout failure this port exists to avoid, asserted as placement rather than as pixels.
   *
   * The pre-port row put a truncating 13px subject and a `shrink-0` mono timestamp on one flex
   * line inside a narrow column -- the same shape that rendered the inbox's lead names as "Jo…"
   * and "M…". At coach scale the timestamp is wider still. `truncate` is invisible to jsdom, so
   * nothing would go red; what a test can see is whether the clock is on the subject's line.
   */
  it("keeps a request's timestamp off the line its subject is on", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ threads: [thread] })));

    render(<CoachSupport enabled />);

    const row = await screen.findByRole("button", { name: /Calendar setup question/u });
    const subject = row.querySelector("[data-request-subject]");
    const meta = row.querySelector("[data-request-meta]");
    expect(subject, "the row still names the request").toHaveTextContent("Calendar setup question");
    expect(meta?.querySelector("time"), "the row still dates the request").not.toBeNull();
    expect(subject!.contains(meta!.querySelector("time")!)).toBe(false);
    expect(subject!.className, "a subject that truncates is a subject a coach cannot read")
      .not.toContain("truncate");
  });
});
