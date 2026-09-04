import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoachSupport } from "@/components/workspace/live/coach-support";
import type { CoachSupportThreadRead } from "@/lib/repositories/support";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const thread: CoachSupportThreadRead = {
  id: "thread-one",
  tenantId: "tenant-one",
  subject: "Calendar setup question (demo)",
  status: "open",
  assignedTo: null,
  isTest: false,
  createdAt: "2026-08-24T09:00:00.000Z",
  updatedAt: "2026-08-24T10:00:00.000Z",
  messages: [{
    id: "message-one",
    authorId: "author-one",
    authorName: "Aisha Bello (demo)",
    body: "Can you help me check my booking hours?",
    isTest: false,
    createdAt: "2026-08-24T10:00:00.000Z",
  }],
};

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * The Help page after spec section 2.9 demoted it. The audit measured what keeping a help centre
 * beside the bubble cost: two floating circles 250px apart in one corner, three support entry
 * points on a support page, two accent-filled primary actions in view. So the page keeps the
 * guides and the record, and gives up every way of starting or continuing a conversation.
 */
describe("CoachSupport", () => {
  it("offers no way to write, since the bubble is the one place to do that", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ threads: [thread] })));
    const { container } = render(<CoachSupport enabled />);

    await screen.findByText("Can you help me check my booking hours?");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send|Create|Reply/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    // And therefore no accent fill either: the page has no verb left to spend one on.
    expect(container.querySelectorAll('[class*="--accent-fill"]')).toHaveLength(0);
  });

  /**
   * There is no coach guide catalogue anywhere in the tree -- `lib/admin-help-guides.ts` is
   * operator runbooks whose own docblock says a coach must never see them. The absence is stated
   * in words where the list would be, rather than filled with headings nobody has written copy
   * behind.
   */
  it("states that the guides are not written rather than drawing an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ threads: [] })));
    render(<CoachSupport enabled />);

    const guides = screen
      .getAllByRole("heading", { name: "Guides" })
      .map((heading) => heading.closest("section"))
      .find(Boolean) as HTMLElement;
    expect(within(guides).getByText("No guides have been written yet.")).toBeVisible();
    expect(within(guides).queryByRole("link")).not.toBeInTheDocument();
  });

  it("lists what the coach has already asked, read only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ threads: [thread] })));
    render(<CoachSupport enabled />);

    const panel = screen
      .getByRole("heading", { name: "What you have asked us" })
      .closest("section") as HTMLElement;
    await waitFor(() => expect(within(panel).getByText("Calendar setup question")).toBeVisible());
    expect(within(panel).getByText("Can you help me check my booking hours?")).toBeVisible();
    expect(within(panel).getByText("Open")).toBeVisible();
  });

  /**
   * The audit counted `(demo)` six times on this page: the sidebar item, the thread title, both
   * author names and both message bodies. `displayName` covers names; a subject and a message body
   * are free text and take `displayText`.
   */
  it("strips the seeders' marker from subjects, authors and bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ threads: [thread] })));
    render(<CoachSupport enabled />);

    await screen.findByText("Calendar setup question");
    expect(screen.getByText(/Aisha Bello,/u)).toBeVisible();
    expect(screen.queryByText(/\(demo\)/u)).not.toBeInTheDocument();
  });

  it("says the read failed rather than showing an empty record", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 503)));
    render(<CoachSupport enabled />);

    expect(await screen.findByText("Your requests could not be read just now.")).toBeVisible();
    expect(screen.queryByText("You have not written to us yet.")).not.toBeInTheDocument();
  });

  it("says support messaging is off rather than reading when it is disabled", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<CoachSupport enabled={false} />);

    expect(screen.getByText(/Support messaging is not active/u)).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("titles the page at the coach scale and offers a way back", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ threads: [] })));
    render(<CoachSupport enabled />);

    const title = screen.getByRole("heading", { level: 1, name: "Guides" });
    expect(title.className).toContain("coach-page-title");
    expect(screen.getByRole("link", { name: /Back to Home/u }))
      .toHaveAttribute("href", "/coach/home");
  });
});
