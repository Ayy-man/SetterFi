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
 * the screen can be rebuilt without this assertion being lost in the diff, which is exactly what
 * the 2026-09-04 rebuild then did.
 *
 * What it pins is exactly what was broken: the control's own class list has to name a background
 * and a text colour, they have to be different tokens, and neither property may be spelled twice.
 * jsdom resolves no `var()`, so asserting on the computed colour here would assert on nothing;
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

function bandColours(row: ConversationRead, role: "switch" | "button", name?: RegExp) {
  render(
    <CoachInbox
      initialConversations={[row]}
      nowIso={NOW}
      view="everything"
      viewerId="coach-1"
    />,
  );
  const control = role === "switch"
    ? screen.getByRole("switch")
    : screen.getByRole("button", { name: name! });

  return {
    label: control.textContent ?? "",
    background: tokenFor(control, "background-color"),
    text: tokenFor(control, "color"),
  };
}

describe("the Inbox band control is legible in every state it takes", () => {
  it("paints the agent-on state on distinct tokens and says which state it is in", () => {
    const { background, label, text } = bandColours(
      conversation({ status: "agent", statusReason: null }),
      "switch",
    );

    expect(label).toContain("Your agent is answering");
    expect(background).toBe("var(--good-wash)");
    expect(text).toBe("var(--good-text)");
    expect(background).not.toBe(text);
  });

  it("paints the you-are-answering state on distinct tokens and says which state it is in", () => {
    const { background, label, text } = bandColours(
      conversation({ status: "human", statusReason: null, takenOverBy: "coach-1" }),
      "switch",
    );

    expect(label).toContain("You are answering");
    expect(background).toBe("var(--warning-wash)");
    expect(text).toBe("var(--warning-text)");
    expect(background).not.toBe(text);
  });

  /*
   * The third state the switch cannot hold. A thread a handover rule stopped has no holder, and
   * `release` refuses an empty `expectedHolderId`, so the only write here is `claim` and the band
   * draws a button. It is held to the same colour rule as the two switch arms.
   */
  it("paints the stopped state on distinct tokens and offers the one write that is legal", () => {
    const { background, label, text } = bandColours(
      conversation(),
      "button",
      /^Answer this yourself$/u,
    );

    expect(label).toContain("Answer this yourself");
    expect(background).toBe("var(--warning-wash)");
    expect(text).toBe("var(--warning-text)");
    expect(background).not.toBe(text);
  });
});
