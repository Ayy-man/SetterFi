import { describe, expect, it } from "vitest";

import { workspaceNavigation } from "@/lib/workspace-navigation";

/**
 * The coach rail's five destinations, in order.
 *
 * In the working repository this test derived the expected labels from the design canvas so a
 * rename had to argue with the drawing. The canvas is not part of this repository, so the labels
 * are pinned here as the record of what the approved drawing shows: `Overview | Inbox | Leads |
 * Agent | Billing` on every desktop artboard, with the phone bar naming the first destination
 * "Home" on purpose (see `workspace-navigation.ts` for that decision). Change the rail and this
 * goes red; change it deliberately and update this list in the same commit.
 */
const CANVAS_LABELS = ["Overview", "Inbox", "Leads", "Agent", "Billing"] as const;

describe("the coach rail carries the approved five destinations", () => {
  it("carries the five labels, in order", () => {
    const shipped = workspaceNavigation.coach.flatMap((group) =>
      group.items.map((item) => item.label),
    );
    expect(shipped).toEqual([...CANVAS_LABELS]);
  });
});
