import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { coachNavCounts, type NeedsYouCountSource } from "@/lib/coach-nav-counts";
import { COACH_INBOX_HREF, workspaceNavigation } from "@/lib/workspace-navigation";

function fakeClient(result: { count: number | null; error: unknown }) {
  const calls: Array<[string, string]> = [];
  const client = {
    from(table: string) {
      calls.push(["from", table]);
      return {
        select(columns: string, options: { count: "exact"; head: true }) {
          calls.push(["select", `${columns}:${options.count}:${String(options.head)}`]);
          const chain = {
            eq(column: string, value: string) {
              calls.push(["eq", `${column}=${value}`]);
              return chain;
            },
            then: (resolve: (value: typeof result) => unknown) => resolve(result),
          };
          return chain as never;
        },
      };
    },
  } as unknown as NeedsYouCountSource;
  return { client, calls };
}

describe("coachNavCounts", () => {
  it("keys the count by the Inbox href the nav item uses", async () => {
    const { client } = fakeClient({ count: 4, error: null });
    expect(await coachNavCounts("tenant-1", client)).toEqual({ [COACH_INBOX_HREF]: 4 });
  });

  it("counts every needs_human row in the tenant, matching what the Inbox lists", async () => {
    const { client, calls } = fakeClient({ count: 0, error: null });
    await coachNavCounts("tenant-1", client);
    expect(calls).toContainEqual(["from", "conversations"]);
    expect(calls).toContainEqual(["eq", "tenant_id=tenant-1"]);
    expect(calls).toContainEqual(["eq", "status=needs_human"]);
    // No is_test predicate: on the seeded demo tenant every row is a test row, and a pill reading
    // nothing over an Inbox listing four threads is the dishonest state.
    expect(calls.filter(([verb, arg]) => verb === "eq" && arg.startsWith("is_test"))).toEqual([]);
  });

  it("returns no count -- not a zero -- when the read fails", async () => {
    const { client } = fakeClient({ count: null, error: new Error("boom") });
    expect(await coachNavCounts("tenant-1", client)).toEqual({});
  });
});

/*
 * The pin the round-2 audit asked for. The amber count is the coach's only needs-you signal now
 * that the attention card is gone from Home, so a coach route that renders the pill bar without
 * one is a route where that signal silently disappears. The href list is read out of the nav
 * config rather than typed here, so adding a sixth coach pill fails this test until whatever
 * renders it is mapped below.
 */
const SURFACE_FOR_HREF: Record<string, readonly string[]> = {
  "/coach/home": ["src/app/(workspace)/coach/home/page.tsx"],
  "/coach/conversations": ["src/components/workspace/live/coach-conversations.tsx"],
  "/coach/contacts": [
    "src/app/(workspace)/coach/contacts/page.tsx",
    "src/app/(workspace)/coach/pipelines/page.tsx",
  ],
  "/coach/agent": ["src/app/(workspace)/coach/agent/page.tsx"],
  "/coach/billing": ["src/app/(workspace)/coach/billing/page.tsx"],
};

describe("every coach pill route passes a count", () => {
  const hrefs = workspaceNavigation.coach.flatMap((group) =>
    group.items.map((item) => item.href),
  );

  it("maps every coach nav item to the file that renders its shell", () => {
    expect(hrefs.slice().sort()).toEqual(Object.keys(SURFACE_FOR_HREF).sort());
  });

  for (const [href, files] of Object.entries(SURFACE_FOR_HREF)) {
    for (const file of files) {
      it(`${file} passes navCounts for ${href}`, () => {
        const source = readFileSync(file, "utf8");
        expect(source).toMatch(/navCounts=\{/u);
        // The Inbox is a client component and derives the same predicate off the rows it renders;
        // every server page reads the one shared helper.
        if (file.endsWith("coach-conversations.tsx")) {
          expect(source).toMatch(/navCounts=\{\{\s*"\/coach\/conversations":\s*needsYou\s*\}\}/u);
          expect(source).toMatch(/row\.status === "needs_human"/u);
        } else {
          expect(source).toMatch(/navCounts=\{await coachNavCounts\(/u);
        }
      });
    }
  }
});
