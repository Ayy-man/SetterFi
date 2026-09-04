import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CoachInbox } from "@/components/workspace/rehaul/coach-inbox";
import type { ConversationRead } from "@/lib/repositories/conversations";

/*
 * The agent toggle has to be readable in both of its states.
 *
 * A separate file from `coach-inbox.test.tsx` on purpose: that file is the Inbox's behaviour
 * suite and belongs to the screen's own lane, and this is a shared-kit-boundary guard that
 * happens to be pinned on the one screen where the defect was measured. Keeping it apart means
 * the screen can be rebuilt without this assertion being lost in the diff.
 *
 * What it pins is exactly what was broken: the button's own class list has to name a background
 * and a text colour, they have to be different tokens, and neither property may be spelled twice.
 * jsdom resolves no `var()`, so asserting on the computed colour here would assert on nothing --
 * the token identity is the strongest true statement this environment can make. The emitted-CSS
 * half of the rule lives in `src/components/kit/utility-collision.test.ts`, and the measured
 * contrast was checked in Chrome against the dev server.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/coach/conversations",
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const NOW = "2026-09-03T12:00:00.000Z";

function conversation(overrides: Partial<ConversationRead> = {}): ConversationRead {
  return {
    id: "one",
    contactId: "contact-one",
    contactName: "Jasmine Torres",
    channel: "instagram",
    status: "needs_human",
    statusReason: "lead_requested_human",
    takenOverBy: null,
    unreadByCoach: true,
    disclosurePending: false,
    currentStepAsks: 2,
    isDemo: false,
    isTest: false,
    lastActivityAt: "2026-09-03T11:48:00.000Z",
    qualification: { credit: null, goal: null, outcome: null, timeline: null },
    appointment: null,
    messages: [{
      id: "message-one",
      direction: "in",
      author: "lead",
      body: "Is the credit rebuild included if I sign up?",
      createdAt: "2026-09-03T11:48:00.000Z",
      delivered: true,
    }],
    ...overrides,
  };
}

/** The arbitrary utility setting one property, or null. Mirrors the kit-wide collision guard. */
function tokenFor(element: Element, property: "background-color" | "color"): string | null {
  const patterns = {
    "background-color": /^bg-\[(?!image:|linear-gradient|radial-gradient|url)(.+)\]$/u,
    color: /^text-\[color:(.+)\]$/u,
  } as const;

  const matches = [...element.classList]
    .map((token) => patterns[property].exec(token)?.[1])
    .filter((value): value is string => value != null);

  // Two spellings of one property is the defect itself, so it fails here rather than picking one.
  expect(matches.length, `${property} is spelled ${matches.length} times: ${matches.join(", ")}`)
    .toBeLessThanOrEqual(1);
  return matches[0] ?? null;
}

function toggleColours(row: ConversationRead) {
  render(<CoachInbox initialConversations={[row]} nowIso={NOW} viewerId="coach-1" />);
  const button = screen.getByRole("button", { name: row.takenOverBy === "coach-1" ? "Hand back" : "Take over" });

  return {
    background: tokenFor(button, "background-color"),
    text: tokenFor(button, "color"),
  };
}

describe("the Inbox agent toggle is legible in both states", () => {
  it("paints Take over on distinct background and text tokens", () => {
    const { background, text } = toggleColours(conversation());

    expect(background).toBe("var(--ink)");
    expect(text).toBe("var(--card)");
    expect(background).not.toBe(text);
  });

  it("paints Hand back on distinct background and text tokens", () => {
    const { background, text } = toggleColours(
      conversation({ status: "human", statusReason: null, takenOverBy: "coach-1" }),
    );

    expect(background).toBe("var(--ink)");
    expect(text).toBe("var(--card)");
    expect(background).not.toBe(text);
  });
});
