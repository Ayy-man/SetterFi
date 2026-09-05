import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  demoViewTargetsFor,
  foldedNavTarget,
  getWorkspaceActiveItem,
  isWorkspaceNavItemActive,
  navigationEnvironment,
  publishNavigationEnvironment,
  navItemAllowsRole,
  workspaceNavItemsWithChildren,
  workspaceNavigation,
  workspaceNavigationFor,
  withWorkspaceNavCounts,
  type WorkspaceNavItem,
  type WorkspaceRole,
} from "./workspace-navigation";

const allLive = {
  SETTERFI_PHASE5_LIVE: "true",
  SETTERFI_PHASE6_LIVE: "true",
};

const pathCases: ReadonlyArray<{
  role: WorkspaceRole;
  path: string;
  label: string;
}> = [
  { role: "admin", path: "/admin/overview", label: "Overview" },
  { role: "admin", path: "/admin/alerts", label: "Inbox" },
  { role: "admin", path: "/admin/platform-clients", label: "Clients" },
  { role: "admin", path: "/admin/billing", label: "Money" },
  { role: "admin", path: "/admin/brain", label: "The Brain" },
  { role: "admin", path: "/admin/compliance", label: "Compliance" },
  { role: "admin", path: "/admin/system", label: "System" },
  { role: "admin", path: "/admin/audit", label: "Audit" },
  { role: "coach", path: "/coach/home", label: "Overview" },
  { role: "coach", path: "/coach/conversations", label: "Inbox" },
  { role: "coach", path: "/coach/contacts", label: "Leads" },
  { role: "coach", path: "/coach/agent", label: "Agent" },
  { role: "coach", path: "/coach/billing", label: "Billing" },
  { role: "affiliate", path: "/affiliate", label: "Partner earnings" },
  { role: "coach", path: "/coach/pipelines", label: "Leads" },
];

function groupItemsWithChildren(items: readonly WorkspaceNavItem[]) {
  return items.flatMap((item) => [item, ...(item.children ?? [])]);
}

describe("workspace navigation information architecture", () => {
  it("defines the admin groups and their ordered destinations", () => {
    expect(workspaceNavigation.admin.map((group) => [
      group.label,
      group.items.map((item) => [item.label, item.href]),
    ])).toEqual([
      ["Run", [
        ["Overview", "/admin/overview"],
        // Screen 5a merged Attention and Escalations into one destination. Inbox is that queue and
        // it sits at /admin/alerts, where the attention surface has always rendered. Client
        // requests folds onto it rather than keeping a rail row of its own.
        ["Inbox", "/admin/alerts"],
        ["Clients", "/admin/platform-clients"],
        ["Money", "/admin/billing"],
      ]],
      ["Platform", [
        ["The Brain", "/admin/brain"],
        ["Compliance", "/admin/compliance"],
        ["System", "/admin/system"],
        ["Audit", "/admin/audit"],
      ]],
    ]);
  });

  it("names both groups and opens Run with Overview", () => {
    expect(workspaceNavigation.admin.map((group) => group.label)).toEqual(["Run", "Platform"]);
    expect(workspaceNavigation.admin[0].items[0].label).toBe("Overview");
    expect(workspaceNavigation.admin.every((group) => group.label.length > 0)).toBe(true);
  });

  it("carries no child items, because the rail draws one level", () => {
    for (const group of workspaceNavigation.admin) {
      expect(group.items.some((item) => item.children)).toBe(false);
    }
  });

  it("keeps every top-level admin href unique across all groups", () => {
    const hrefs = workspaceNavigation.admin.flatMap((group) => group.items.map((item) => item.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs.filter((href) => href === "/admin/platform-clients")).toHaveLength(1);
    expect(hrefs).not.toContain("/admin/clients");
  });

  it("carries no icons, because the sidebar renders none", () => {
    for (const groups of Object.values(workspaceNavigation)) {
      for (const item of groups.flatMap((group) => workspaceNavItemsWithChildren(group.items))) {
        expect(Object.keys(item), item.label).not.toContain("icon");
      }
    }
  });

  it("ships no counts in the static config, because a constant count is a stale count", () => {
    for (const groups of Object.values(workspaceNavigation)) {
      for (const item of groups.flatMap((group) => workspaceNavItemsWithChildren(group.items))) {
        expect(item.count, item.label).toBeUndefined();
      }
    }
  });

  it("keeps each admin group at six destinations or fewer", () => {
    for (const group of workspaceNavigation.admin) {
      const items = groupItemsWithChildren(group.items);
      expect(items.length, group.label || "(unlabelled)").toBeLessThanOrEqual(6);
    }
  });

  it("keeps Money behind Phase 6", () => {
    const labels = (environment: Record<string, string>) =>
      workspaceNavigationFor("admin", environment).flatMap((group) =>
        group.items.map((item) => item.label));

    expect(labels({ SETTERFI_PHASE6_LIVE: "true" })).toContain("Money");
    expect(labels({ SETTERFI_PHASE6_LIVE: "false" })).not.toContain("Money");
  });

  it("leaves the coach rail untouched by the admin phase flags", () => {
    const paths = (environment: Record<string, string>) =>
      workspaceNavigationFor("coach", environment).flatMap((group) =>
        group.items.map((item) => item.href));

    expect(paths({ SETTERFI_PHASE5_LIVE: "true", SETTERFI_PHASE6_LIVE: "true" }))
      .toEqual(paths({ SETTERFI_PHASE5_LIVE: "false", SETTERFI_PHASE6_LIVE: "false" }));
  });

  it("flattens coach navigation to one ordered five-item list", () => {
    // The rail was cut from nine destinations to five (commit f8d0381 had grown it to nine by
    // adding Connections and Notifications, the last two pages with no other route in). Get
    // started, Connections, Notifications, and Help all left the rail here; see the "keeps the
    // four demoted coach destinations reachable outside the rail" test below for the guarantee
    // that replaces the rail as their reachability proof.
    expect(workspaceNavigation.coach).toHaveLength(1);
    expect(workspaceNavigation.coach[0].items.map((item) => [item.label, item.href])).toEqual([
      ["Overview", "/coach/home"],
      ["Inbox", "/coach/conversations"],
      ["Leads", "/coach/contacts"],
      ["Agent", "/coach/agent"],
      ["Billing", "/coach/billing"],
    ]);
    expect(workspaceNavigation.coach[0].items.find((item) => item.label === "Leads")?.matchPaths)
      .toEqual(["/coach/pipelines"]);
  });

  /*
   * commit f8d0381 added Connections and Notifications to the coach rail for exactly one reason:
   * those two pages had no other route in, so losing the rail row would have made them
   * unreachable. Now that the rail is cut back down to five items, that reasoning applies to all
   * four demoted destinations (Get started and Help included), and the rail can no longer be the
   * thing that proves they're reachable -- something else has to. This test is that something
   * else: for each demoted href, it asserts the href is gone from the coach rail AND that the
   * specific non-rail entry point named in the redesign brief actually contains it, by reading
   * the real source of the two files responsible (coach Home's attention surfaces, and the
   * account-menu dropdown) rather than trusting that a comment describes the code correctly.
   */
  it("keeps the four demoted coach destinations reachable outside the rail", () => {
    const coachHrefs = workspaceNavigation.coach[0].items.map((item) => item.href);
    const demoted = ["/coach/get-started", "/coach/integrations", "/coach/settings", "/coach/help"];
    for (const href of demoted) {
      expect(coachHrefs, href).not.toContain(href);
    }

    // Coach Home's own surface, which is `coach-dashboard.tsx` since the rehaul took the route.
    // The rows it draws are the same two entry points; both are plain JSX now rather than the
    // attention card's row objects, so the strings read for changed with the spelling. What this
    // asserts has not: each demoted route is reachable from a labelled control on Home.
    const measurement = readFileSync(
      resolve(process.cwd(), "src/components/workspace/rehaul/coach-dashboard.tsx"),
      "utf8",
    );
    // Get started: the blocked-steps row on the setup rail, "See setup".
    expect(measurement).toContain('href="/coach/get-started"');
    expect(measurement).toContain("See setup");
    // Connections: the setup rail's channels row. Since the rehaul the rows are derived in
    // coach-setup.tsx and the row's control opens the connect sheet for Instagram and Messenger
    // rather than linking the page, so the sheet button is the labelled control on Home.
    const setupRows = readFileSync(
      resolve(process.cwd(), "src/components/workspace/rehaul/coach-setup.tsx"),
      "utf8",
    );
    expect(setupRows).toContain("ConnectChannelButton");
    expect(setupRows).toMatch(/label: "Connect" \| "Reconnect"/);
    // ...and, because that row only exists while something is broken, the unconditional one on
    // Setup's channel strip. Setup is itself reachable from every coach page via the support
    // bubble, so this is the route that survives every channel being healthy.
    const checklist = readFileSync(
      resolve(process.cwd(), "src/components/onboarding/get-started-checklist.tsx"),
      "utf8",
    );
    expect(checklist).toContain('data-slot="channel-strip-connections"');
    expect(checklist).toContain('href="/coach/integrations"');

    const topbar = readFileSync(resolve(process.cwd(), "src/components/kit/app-topbar.tsx"), "utf8");
    // Notifications: the topbar bell and the account menu, both keyed off the coach role. Check
    // both the role-to-href map AND that the href variable it feeds is actually rendered into a
    // menu item -- a constant nobody reads is not a reachability guarantee.
    expect(topbar).toContain('coach: "/coach/settings"');
    expect(topbar).toMatch(/notificationSettingsHref\s*=\s*ROLE_NOTIFICATION_SETTINGS_HREF\[role\]/);
    expect(topbar).toMatch(/<DropdownMenuItem render={<Link href={notificationSettingsHref} \/>}>/);
    // Help: the account menu, added alongside notification settings in this same cut. Same two
    // checks -- the map has the route, and the account menu actually renders it.
    expect(topbar).toContain('coach: "/coach/help"');
    expect(topbar).toMatch(/helpHref\s*=\s*ROLE_HELP_HREF\[role\]/);
    expect(topbar).toMatch(/<DropdownMenuItem render={<Link href={helpHref} \/>}>/);
  });

  /*
   * /coach/tips was never on the rail, so the demotion test above cannot cover it -- and that is
   * exactly how it went missing: the route existed and answered 200, and the only reference to it
   * anywhere in the tree was a default prop on a component nothing mounted. It has two routes in
   * now, the account menu and the support bubble, and the bubble is only a route in if the shell
   * actually renders it, so this reads all three files rather than trusting any one of them.
   */
  it("keeps /coach/tips reachable from the account menu and the mounted support bubble", () => {
    const topbar = readFileSync(resolve(process.cwd(), "src/components/kit/app-topbar.tsx"), "utf8");
    expect(topbar).toContain('coach: "/coach/tips"');
    expect(topbar).toMatch(/tipsHref\s*=\s*ROLE_TIPS_HREF\[role\]/);
    expect(topbar).toMatch(/<DropdownMenuItem render={<Link href={tipsHref} \/>}>/);

    const bubble = readFileSync(
      resolve(process.cwd(), "src/components/workspace/live/coach-support-bubble.tsx"),
      "utf8",
    );
    expect(bubble).toMatch(/tipsHref\s*=\s*"\/coach\/tips"/);
    expect(bubble).toContain("href={tipsHref}");

    // The bubble is only an entry point while the shell mounts it. This is the assertion whose
    // absence let a finished, tested component ship to nobody.
    const shell = readFileSync(resolve(process.cwd(), "src/components/kit/app-shell.tsx"), "utf8");
    expect(shell).toContain("CoachSupportBubble");
    expect(shell).toMatch(/role === "coach" \? <CoachSupportBubble[ \n]/);
  });

  it("removes the onboarding demo switcher target only while Phase 5 is live", () => {
    expect(demoViewTargetsFor({ SETTERFI_PHASE5_LIVE: "true" }).map((target) => target.home))
      .not.toContain("/onboarding");
    expect(demoViewTargetsFor({ SETTERFI_PHASE5_LIVE: "false" }).map((target) => target.home))
      .toContain("/onboarding");
  });
});

describe("queue counts", () => {
  const item = (groups: readonly { items: readonly WorkspaceNavItem[] }[], href: string) =>
    groups.flatMap((group) => group.items).find((candidate) => candidate.href === href);

  it("stamps a depth on a queue destination", () => {
    const counted = withWorkspaceNavCounts(workspaceNavigationFor("admin", allLive), {
      "/admin/alerts": 4,
      "/admin/system": 2,
    });
    expect(item(counted, "/admin/alerts")?.count).toBe(4);
    expect(item(counted, "/admin/system")?.count).toBe(2);
  });

  it("drops a zero rather than parking a grey 0 in the rail", () => {
    const counted = withWorkspaceNavCounts(workspaceNavigationFor("admin", allLive), {
      "/admin/alerts": 0,
    });
    expect(item(counted, "/admin/alerts")?.count).toBeUndefined();
  });

  /*
   * The coach Inbox is a queue and carries the attention flag, which is the load-bearing half of
   * the canvas's decision to take the amber attention card off coach Home: with the card gone and
   * no count in the pill bar, a coach would have no needs-you signal anywhere in the shell.
   * `Main.dc.html`, `Inbox.dc.html` and `Agent.dc.html` all draw the amber count on this pill.
   */
  it("lets the coach Inbox pill carry a needs-you depth", () => {
    const inbox = workspaceNavigation.coach
      .flatMap((group) => group.items)
      .find((candidate) => candidate.href === "/coach/conversations");
    expect(inbox?.queue).toBe(true);
    expect(inbox?.attention).toBe(true);

    const counted = withWorkspaceNavCounts(workspaceNavigationFor("coach", allLive), {
      "/coach/conversations": 4,
    });
    expect(item(counted, "/coach/conversations")?.count).toBe(4);
    // And nowhere else on the coach rail, which has no other queue.
    expect(item(counted, "/coach/billing")?.count).toBeUndefined();
  });

  it("flags exactly the destinations whose rows are somebody's queue", () => {
    const queues = workspaceNavigation.admin
      .flatMap((group) => group.items)
      .filter((item) => item.queue)
      .map((item) => item.href);
    expect(queues).toEqual([
      "/admin/alerts",
      "/admin/platform-clients",
      "/admin/billing",
      "/admin/brain",
      "/admin/compliance",
      "/admin/system",
    ]);
    // Reference pages are not queues: a number beside them reads as unread mail.
    expect(queues).not.toContain("/admin/overview");
    expect(queues).not.toContain("/admin/audit");
  });

  it("refuses a count on a destination that is not a queue", () => {
    const counted = withWorkspaceNavCounts(workspaceNavigationFor("admin", allLive), {
      "/admin/overview": 9,
      "/admin/audit": 12,
    });
    expect(item(counted, "/admin/overview")?.count).toBeUndefined();
    expect(item(counted, "/admin/audit")?.count).toBeUndefined();
  });

  it("leaves the groups and their order untouched", () => {
    const counted = withWorkspaceNavCounts(workspaceNavigationFor("admin", allLive), {
      "/admin/support": 3,
    });
    expect(counted.map((group) => group.label))
      .toEqual(workspaceNavigationFor("admin", allLive).map((group) => group.label));
  });
});

describe("workspace navigation path resolution", () => {
  it("covers the required 15 canonical and merged-view paths", () => {
    expect(pathCases).toHaveLength(15);
  });

  it.each(pathCases)("resolves $path to $label", ({ role, path, label }) => {
    expect(getWorkspaceActiveItem(role, path, allLive)?.label).toBe(label);
  });

  it.each(pathCases)("rejects the synthetic look-alike for $path", ({ role, path }) => {
    const item = getWorkspaceActiveItem(role, path, allLive);
    expect(item).toBeDefined();
    expect(isWorkspaceNavItemActive(item!, `${path}-extra`)).toBe(false);
  });

  /**
   * Every route the navigation itself declares has to resolve to one current item. The rail draws
   * `aria-current` from this predicate per row, so two rows answering true for one path is two
   * current pages in the same list.
   */
  it("names one current item for every route the navigation declares", () => {
    const overlaps: string[] = [];

    for (const [role, groups] of Object.entries(workspaceNavigation)) {
      const items = groups.flatMap((group) =>
        workspaceNavItemsWithChildren(group.items),
      );
      const routes = new Set(
        items.flatMap((item) => [item.href, ...(item.matchPaths ?? [])]),
      );

      for (const route of routes) {
        const current = items.filter((item) =>
          isWorkspaceNavItemActive(item, route),
        );
        if (current.length !== 1) {
          overlaps.push(`${role} ${route}: ${current.map((item) => item.label).join(", ")}`);
        }
      }
    }

    expect(overlaps).toEqual([]);
  });

  it("still marks a coach destination current without an admin route match", () => {
    const inbox = workspaceNavigation.coach[0].items.find((item) => item.href === "/coach/conversations");
    expect(inbox && isWorkspaceNavItemActive(inbox, "/coach/conversations/thread-1")).toBe(true);
  });
});

describe("navigation environment publishing", () => {
  it("picks out exactly the existing navigation flags", () => {
    const environment = navigationEnvironment({
      SETTERFI_PHASE5_LIVE: "true",
      SETTERFI_PHASE6_LIVE: "false",
      SETTERFI_PHASE6_AFFILIATES_LIVE: "true",
      SUPABASE_SERVICE_ROLE_KEY: "must-not-travel",
    });
    expect(environment).toEqual({
      SETTERFI_PHASE5_LIVE: "true",
      SETTERFI_PHASE6_LIVE: "false",
      SETTERFI_PHASE6_AFFILIATES_LIVE: "true",
    });
  });

  it("builds the same navigation on the server and client passes", () => {
    const environment = { SETTERFI_PHASE5_LIVE: "true", SETTERFI_PHASE6_LIVE: "true" };
    const hrefs = (groups: ReturnType<typeof workspaceNavigationFor>) => groups
      .flatMap((group) => group.items.map((item) => item.href));

    const serverPass = workspaceNavigationFor("admin", environment);
    publishNavigationEnvironment(navigationEnvironment(environment));
    const clientPass = workspaceNavigationFor("admin", navigationEnvironment(environment));

    expect(hrefs(clientPass)).toEqual(hrefs(serverPass));
    expect(hrefs(clientPass)).toContain("/admin/overview");
    expect(hrefs(clientPass)).toContain("/admin/billing");
  });
});

describe("role-scoped admin navigation", () => {
  const hrefs = (platformRole?: Parameters<typeof workspaceNavigationFor>[2]) =>
    workspaceNavigationFor("admin", allLive, platformRole).flatMap((group) =>
      group.items.map((item) => item.href),
    );

  const moneyHrefs = ["/admin/billing"];

  it("hides the Money rail item from a success reviewer", () => {
    const success = hrefs("success");
    for (const href of moneyHrefs) expect(success).not.toContain(href);
  });

  it("leaves every other admin destination in place for success", () => {
    const success = hrefs("success");
    const owner = hrefs("owner");
    expect(success).toEqual(owner.filter((href) => !moneyHrefs.includes(href)));
  });

  it("shows the full nav to owner, admin, and to a caller that names no role", () => {
    for (const role of ["owner", "admin", undefined] as const) {
      for (const href of moneyHrefs) expect(hrefs(role)).toContain(href);
    }
  });

  it("treats an item with no roles as open to everyone", () => {
    expect(navItemAllowsRole({ label: "Audit", href: "/admin/audit" }, "success")).toBe(true);
  });

  it("gives Compliance a collapsed-rail monogram of its own", () => {
    const items = workspaceNavigation.admin.flatMap((group) => group.items);
    expect(items.find((item) => item.href === "/admin/compliance")?.short).toBe("CP");
  });
});

describe("the folded admin rail", () => {
  it("is exactly 8 items in 2 groups, in order, with the queue and attention flags carried", () => {
    const groups = workspaceNavigationFor("admin", allLive);
    expect(groups.map((group) => group.label)).toEqual(["Run", "Platform"]);

    const items = groups.flatMap((group) => group.items);
    expect(items).toHaveLength(8);
    expect(items.map((item) => [item.label, item.href, Boolean(item.queue), Boolean(item.attention)])).toEqual([
      ["Overview", "/admin/overview", false, false],
      ["Inbox", "/admin/alerts", true, true],
      ["Clients", "/admin/platform-clients", true, false],
      ["Money", "/admin/billing", true, false],
      ["The Brain", "/admin/brain", true, false],
      ["Compliance", "/admin/compliance", true, true],
      ["System", "/admin/system", true, false],
      ["Audit", "/admin/audit", false, false],
    ]);
  });

  it("still gates Money behind Phase 6 and the money roles", () => {
    const live = workspaceNavigationFor("admin", allLive).flatMap((group) => group.items);
    expect(live.map((item) => item.href)).toContain("/admin/billing");

    const phase6Off = workspaceNavigationFor("admin", { ...allLive, SETTERFI_PHASE6_LIVE: "false" })
      .flatMap((group) => group.items);
    expect(phase6Off.map((item) => item.href)).not.toContain("/admin/billing");

    const success = workspaceNavigationFor("admin", allLive, "success").flatMap((group) => group.items);
    expect(success.map((item) => item.href)).not.toContain("/admin/billing");
  });

  it("sums a folded href's count into the item that absorbed it", () => {
    const groups = workspaceNavigationFor("admin", allLive);
    const counted = withWorkspaceNavCounts(groups, { "/admin/support": 4, "/admin/alerts": 2 });
    const inbox = counted.flatMap((group) => group.items).find((item) => item.href === "/admin/alerts");
    expect(inbox?.count).toBe(6);
  });

  it("sums every route folded onto Clients and onto Money", () => {
    const groups = workspaceNavigationFor("admin", allLive);
    const clientsCounted = withWorkspaceNavCounts(groups, {
      "/admin/channel-health": 1,
      "/admin/provisioning": 2,
      "/admin/agents": 3,
      "/admin/agent-performance": 4,
      "/admin/platform-clients": 5,
    });
    const clients = clientsCounted.flatMap((group) => group.items).find((item) => item.href === "/admin/platform-clients");
    expect(clients?.count).toBe(15);

    const moneyCounted = withWorkspaceNavCounts(groups, {
      "/admin/tiers": 1,
      "/admin/affiliates": 2,
      "/admin/corrections": 3,
      "/admin/billing": 4,
    });
    const money = moneyCounted.flatMap((group) => group.items).find((item) => item.href === "/admin/billing");
    expect(money?.count).toBe(10);
  });

  it("maps every folded href to its target and leaves unmapped hrefs as identity", () => {
    const mappings: ReadonlyArray<[string, string]> = [
      ["/admin/support", "/admin/alerts"],
      ["/admin/channel-health", "/admin/platform-clients"],
      ["/admin/provisioning", "/admin/platform-clients"],
      ["/admin/agents", "/admin/platform-clients"],
      ["/admin/agent-performance", "/admin/platform-clients"],
      ["/admin/tiers", "/admin/billing"],
      ["/admin/affiliates", "/admin/billing"],
      ["/admin/corrections", "/admin/billing"],
      ["/admin/brain/testing", "/admin/brain"],
      ["/admin/account-terms", "/account"],
      ["/admin/help", "/account"],
    ];
    for (const [from, to] of mappings) {
      expect(foldedNavTarget(from)).toBe(to);
    }

    const unmapped = [
      "/admin/overview",
      "/admin/alerts",
      "/admin/platform-clients",
      "/admin/billing",
      "/admin/brain",
      "/admin/compliance",
      "/admin/system",
      "/admin/audit",
      "/coach/home",
      "/affiliate",
    ];
    for (const href of unmapped) {
      expect(foldedNavTarget(href)).toBe(href);
    }
  });
});
