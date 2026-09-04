import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoachSupportBubble } from "@/components/workspace/live/coach-support-bubble";
import type { CoachSupportThreadRead } from "@/lib/repositories/support";

/**
 * The bubble is a floating, non-modal helper, which is the hardest thing on the coach surface to
 * get right by eye: it is off-screen in every screenshot, it is the only thing on the page a
 * keyboard user can be locked out of, and it is the one place the product is tempted to promise
 * how fast a person will answer.
 */

const THREAD: CoachSupportThreadRead = {
  id: "thread-1",
  tenantId: "tenant-1",
  subject: "Message from the dashboard",
  status: "open",
  assignedTo: null,
  isTest: false,
  createdAt: "2026-08-21T09:12:00.000Z",
  updatedAt: "2026-08-21T09:14:00.000Z",
  messages: [
    {
      id: "message-1",
      authorId: "coach-1",
      authorName: "Marcus Reid",
      body: "Can a lead still text me before then?",
      isTest: false,
      createdAt: "2026-08-21T09:12:00.000Z",
    },
    {
      id: "message-2",
      authorId: "support-1",
      authorName: "Dana Kessler (demo)",
      body: "Your registration went in on 21 August. (demo)",
      isTest: false,
      createdAt: "2026-08-21T09:14:00.000Z",
    },
  ],
};

function mockThreads(threads: readonly CoachSupportThreadRead[]) {
  return vi.fn(async () => new Response(JSON.stringify({ threads }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

beforeEach(() => {
  vi.stubGlobal("fetch", mockThreads([THREAD]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CoachSupportBubble", () => {
  it("starts closed and opens the panel from the launcher", async () => {
    const user = userEvent.setup();
    render(<CoachSupportBubble coachName="Marcus" />);

    // The positive control. Without it, every "is not in the document" below would pass against a
    // component stubbed to return null.
    const launcher = screen.getByRole("button", { name: "Message support" });
    expect(launcher).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(launcher);

    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(launcher).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Close support" })).toBeVisible();
  });

  /**
   * The read happens on open, not on mount. The bubble is on every coach page, so a read on mount
   * is one Supabase round trip per navigation -- 300 to 360ms of it -- for a panel most coaches
   * never open.
   */
  it("reads the thread only once the panel is opened", async () => {
    const user = userEvent.setup();
    render(<CoachSupportBubble />);

    expect(fetch).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Message support" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/support/threads",
      expect.objectContaining({ cache: "no-store" }),
    ));
  });

  /**
   * The header names the person who actually answered, derived from who did not open the thread.
   * A coach thread is always opened by the coach, so anyone else in it is support. The name also
   * goes through `displayName`, because a seeded row carries the "(demo)" marker in the database
   * on purpose and a human reading a name must not see it.
   */
  it("names the person answering, from the thread rather than from a constant", async () => {
    render(<CoachSupportBubble defaultOpen />);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Dana Kessler")).toBeVisible();
    // The seeders' marker is stripped from the name and from the message body alike: the audit
    // counted it six times on the Help page this panel replaces.
    expect(within(dialog).getByText("Your registration went in on 21 August.")).toBeVisible();
    expect(within(dialog).queryByText(/\(demo\)/u)).not.toBeInTheDocument();
  });

  it("says SetterFi support when nobody has answered yet", async () => {
    vi.stubGlobal("fetch", mockThreads([{ ...THREAD, messages: [THREAD.messages[0]!] }]));
    render(<CoachSupportBubble defaultOpen />);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("SetterFi support")).toBeVisible();
    expect(within(dialog).queryByText("Dana Kessler")).not.toBeInTheDocument();
  });

  /**
   * Catches a support-response promise being reintroduced. The artboard prints "Usually replies
   * within the hour" and "Open until 6pm", and nothing in the codebase or the copy files records an
   * SLA, a first-response target, or staffed hours -- so either sentence would be the product
   * committing a support team that has never agreed to it. If real numbers are ever written down,
   * this test is what has to change with them.
   */
  it("makes no promise about how fast support replies or when it is open", async () => {
    render(<CoachSupportBubble defaultOpen />);

    await screen.findByRole("dialog");
    expect(screen.queryByText(/within the hour/iu)).not.toBeInTheDocument();
    expect(screen.queryByText(/replies? within/iu)).not.toBeInTheDocument();
    expect(screen.queryByText(/open until/iu)).not.toBeInTheDocument();
  });

  it("links out to the guides and to the trainings surface", async () => {
    render(<CoachSupportBubble defaultOpen />);

    await screen.findByRole("dialog");
    expect(screen.getByRole("link", { name: "Read the guides" }))
      .toHaveAttribute("href", "/coach/help");
    expect(screen.getByRole("link", { name: "Tips and trainings" }))
      .toHaveAttribute("href", "/coach/tips");
  });

  /**
   * The composer posts to the same endpoints the Help page uses, and the panel only shows what the
   * server handed back. A message that exists only in this browser is the one thing a coach must
   * never be shown as sent.
   */
  it("appends to the open thread and renders what the server read back", async () => {
    const user = userEvent.setup();
    const saved: CoachSupportThreadRead = {
      ...THREAD,
      messages: [...THREAD.messages, {
        id: "message-3",
        authorId: "coach-1",
        authorName: "Marcus Reid",
        body: "Thank you.",
        isTest: false,
        createdAt: "2026-08-21T09:20:00.000Z",
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.endsWith("/messages") ? { thread: saved } : { threads: [THREAD] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CoachSupportBubble defaultOpen />);
    await screen.findByRole("dialog");

    await user.type(screen.getByLabelText("Write your message"), "Thank you.");
    await user.click(screen.getByRole("button", { name: /Send/u }));

    await waitFor(() => expect(screen.getByText("Thank you.")).toBeVisible());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/support/threads/thread-1/messages",
      expect.objectContaining({ method: "POST" }),
    );
  });

  /**
   * With no thread yet, one field still has to produce a thread, and the subject it carries must be
   * a statement of provenance rather than a slice of the coach's own sentence promoted to a title.
   */
  it("opens a thread with a stated subject when the coach has none", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.method === "POST" ? { thread: THREAD } : { threads: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CoachSupportBubble defaultOpen />);
    await screen.findByText(/You have not written to us yet/u);

    await user.type(screen.getByLabelText("Write your message"), "My agent stopped replying.");
    await user.click(screen.getByRole("button", { name: /Send/u }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/support/threads",
      expect.objectContaining({ method: "POST" }),
    ));
    const post = fetchMock.mock.calls.find((call) => call[1]?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body)).subject).toBe("Message from the dashboard");
  });

  /**
   * A failed read is said as a failed read. An empty panel with a composer in it tells a coach they
   * have never written to us, which may be false and is the one thing they would act on.
   */
  it("says the read failed rather than showing an empty conversation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    render(<CoachSupportBubble defaultOpen />);

    expect(await screen.findByText(/could not read your conversation/u)).toBeVisible();
    expect(screen.queryByText(/You have not written to us yet/u)).not.toBeInTheDocument();
  });

  /**
   * Catches the panel becoming keyboard-unreachable or keyboard-inescapable, which is the failure a
   * floating overlay reaches first. Escape is bound to the document rather than to the panel
   * precisely because the panel is not a focus trap, so this also catches someone "tidying" that
   * listener onto the panel element.
   */
  it("closes on Escape and hands focus back to the launcher", async () => {
    const user = userEvent.setup();
    render(<CoachSupportBubble coachName="Marcus" />);

    await user.click(screen.getByRole("button", { name: "Message support" }));
    expect(await screen.findByRole("dialog")).toBeVisible();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Message support" })).toHaveFocus();
  });

  /**
   * The One Fill Rule, and the reason the launcher is `--ink`. The bubble sits on every coach
   * screen, every coach screen already spends its one filled accent control, so a filled launcher
   * would put two in view on all of them. Open, Send is the page's one extra fill and the launcher
   * still carries none.
   */
  it("keeps the launcher unfilled and spends one accent fill inside the open panel", async () => {
    const user = userEvent.setup();
    const { container } = render(<CoachSupportBubble />);

    expect(container.querySelectorAll('[class*="--accent-fill"]')).toHaveLength(0);
    const launcher = screen.getByRole("button", { name: "Message support" });
    expect(launcher.className).toContain("bg-[var(--ink)]");

    await user.click(launcher);
    await screen.findByRole("dialog");

    const fills = container.querySelectorAll('[class*="--accent-fill"]');
    expect(fills, "Send is the one fill the open panel spends").toHaveLength(1);
    expect(fills[0]!.textContent).toContain("Send");
  });

  /**
   * Catches the entry animation being made unconditional. `motion-safe:` is the only reason a
   * reader who asked their system for less motion gets a panel that is simply there; an
   * `animate-in` written without the prefix would animate for everyone.
   */
  it("only animates the panel in under motion-safe", async () => {
    render(<CoachSupportBubble defaultOpen />);

    const panel = await screen.findByRole("dialog");
    const animating = Array.from(panel.classList).filter((name) =>
      name.includes("animate-in") || name.includes("fade-in") || name.includes("slide-in"));
    expect(animating.length, "the panel does animate in").toBeGreaterThan(0);
    for (const name of animating) {
      expect(name, `${name} is not gated on motion-safe`).toMatch(/^motion-safe:/u);
    }
  });
});
