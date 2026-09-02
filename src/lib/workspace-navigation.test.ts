import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  demoViewTargetsFor,
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
  { role: "admin", path: "/admin/support", label: "Client requests" },
  { role: "admin", path: "/admin/channel-health", label: "Channel health" },
  { role: "admin", path: "/admin/provisioning", label: "Provisioning" },
  { role: "admin", path: "/admin/system", label: "System" },
  { role: "admin", path: "/admin/platform-clients", label: "Client book" },
  { role: "admin", path: "/admin/agents", label: "Agents" },
  { role: "admin", path: "/admin/agent-performance", label: "Agent performance" },
  { role: "admin", path: "/admin/billing", label: "Revenue and subscriptions" },
  { role: "admin", path: "/admin/corrections", label: "Corrections" },
  { role: "admin", path: "/admin/tiers", label: "Plans and pricing" },
  { role: "admin", path: "/admin/affiliates", label: "Affiliates and payouts" },
  { role: "admin", path: "/admin/brain", label: "The Brain" },
  { role: "admin", path: "/admin/brain/testing", label: "Evals" },
  { role: "admin", path: "/admin/compliance", label: "Compliance" },
  { role: "admin", path: "/admin/overview", label: "Overview" },
  { role: "admin", path: "/admin/audit", label: "Audit" },
  { role: "admin", path: "/admin/alerts", label: "Inbox" },
  { role: "admin", path: "/admin/help", label: "Help" },
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
        // it sits at /admin/alerts, where the attention surface has always rendered; only the label
        // was wrong. Client requests is the coach-to-platform support queue that used to wear the
        // "Attention" label while pointing somewhere else.
        ["Inbox", "/admin/alerts"],
        ["Client requests", "/admin/support"],
        ["Channel health", "/admin/channel-health"],
        ["Provisioning", "/admin/provisioning"],
        ["System", "/admin/system"],
      ]],
      ["Clients", [
        ["Client book", "/admin/platform-clients"],
        ["Agents", "/admin/agents"],
        ["Agent performance", "/admin/agent-performance"],
      ]],
      ["Money", [
        ["Revenue and subscriptions", "/admin/billing"],
        ["Plans and pricing", "/admin/tiers"],
        ["Affiliates and payouts", "/admin/affiliates"],
        ["Corrections", "/admin/corrections"],
      ]],
      ["Brain", [
        ["The Brain", "/admin/brain"],
        ["Evals", "/admin/brain/testing"],
        ["Compliance", "/admin/compliance"],
      ]],
      // Notifications is gone rather than renamed: it pointed at /admin/alerts, which renders the
      // Inbox whenever phase-8 alerts are live, so it was a second door onto the same queue.
      ["Platform", [
        ["Audit", "/admin/audit"],
        // The account-terms publisher: owner/admin only, and carrying no flag on purpose, because
        // a version has to be published before SETTERFI_ACCOUNT_TERMS_LIVE can be switched on.
        ["Account terms", "/admin/account-terms"],
        ["Help", "/admin/help"],
      ]],
    ]);
  });

  it("names all five groups and opens Run with Overview", () => {
    expect(workspaceNavigation.admin.map((group) => group.label))
      .toEqual(["Run", "Clients", "Money", "Brain", "Platform"]);
    expect(workspaceNavigation.admin[0].items[0].label).toBe("Overview");
    expect(workspaceNavigation.admin.every((group) => group.label.length > 0)).toBe(true);
  });

  it("collapses the Brain group to three destinations with no child items", () => {
    const brain = workspaceNavigation.admin.find((group) => group.label === "Brain");
    expect(brain?.items.some((item) => item.children)).toBe(false);
    expect(workspaceNavItemsWithChildren(brain?.items ?? []).map((item) => item.label)).toEqual([
      "The Brain",
      "Evals",
      "Compliance",
    ]);
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

  it("keeps Plans and pricing stable while Phase 6 gates its other live pages", () => {
    const live = workspaceNavigationFor("admin", { SETTERFI_PHASE6_LIVE: "true" });
    const off = workspaceNavigationFor("admin", { SETTERFI_PHASE6_LIVE: "false" });
    const labels = (groups: typeof live) => groups.flatMap((group) => group.items.map((item) => item.label));

    expect(labels(live)).toContain("Revenue and subscriptions");
    expect(labels(live)).toContain("Corrections");
    expect(labels(off)).not.toContain("Revenue and subscriptions");
    expect(labels(off)).not.toContain("Corrections");
    expect(labels(live).filter((label) => label === "Plans and pricing")).toHaveLength(1);
    expect(labels(off).filter((label) => label === "Plans and pricing")).toHaveLength(1);
    expect(getWorkspaceActiveItem("admin", "/admin/tiers-billing", { SETTERFI_PHASE6_LIVE: "true" })?.label)
      .toBe("Plans and pricing");
    expect(getWorkspaceActiveItem("admin", "/admin/tiers-billing", { SETTERFI_PHASE6_LIVE: "false" })?.label)
      .toBe("Plans and pricing");
  });

  it("keeps Provisioning behind Phase 5 without gating coach nav on it", () => {
    const live = { SETTERFI_PHASE5_LIVE: "true" };
    const off = { SETTERFI_PHASE5_LIVE: "false" };
    const paths = (role: WorkspaceRole, environment: typeof live) => workspaceNavigationFor(role, environment)
      .flatMap((group) => group.items.map((item) => item.href));

    expect(paths("admin", live)).toContain("/admin/provisioning");
    expect(paths("admin", off)).not.toContain("/admin/provisioning");
    // Get started left the coach rail in the nine-to-five cut below; it is no longer a nav item
    // to gate on Phase 5 at all, so the coach half of this test now only proves the rail is
    // unaffected by the admin-only flag.
    expect(paths("coach", live)).toEqual(paths("coach", off));
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

    const measurement = readFileSync(
      resolve(process.cwd(), "src/components/workspace/live/coach-measurement.tsx"),
      "utf8",
    );
    // Get started: the "Blocked setup steps" attention-card entry, "Open setup".
    expect(measurement).toContain('href: "/coach/get-started"');
    expect(measurement).toContain('note: "Open setup"');
    // Connections: AttentionQueue's blocked-channel row, which takes the card's one accent fill.
    // The label moved from a template literal in the `Link`'s children to plain JSX children when
    // the card was rebuilt on 2026-09-02 -- same link, same href, same words, different spelling --
    // so the string this reads for changed with it. What it asserts has not: that the route is
    // reachable from a control whose label names the channel it reconnects.
    expect(measurement).toContain('href="/coach/integrations"');
    expect(measurement).toContain("Reconnect {blockedChannel.channelLabel}");
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
      "/admin/support": 4,
      "/admin/channel-health": 2,
    });
    expect(item(counted, "/admin/support")?.count).toBe(4);
    expect(item(counted, "/admin/channel-health")?.count).toBe(2);
  });

  it("drops a zero rather than parking a grey 0 in the rail", () => {
    const counted = withWorkspaceNavCounts(workspaceNavigationFor("admin", allLive), {
      "/admin/support": 0,
    });
    expect(item(counted, "/admin/support")?.count).toBeUndefined();
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
      "/admin/support",
      "/admin/channel-health",
      "/admin/provisioning",
      "/admin/system",
      "/admin/platform-clients",
      "/admin/agents",
      "/admin/billing",
      "/admin/affiliates",
      "/admin/corrections",
      "/admin/brain",
      "/admin/compliance",
    ]);
    // Reference and settings pages are not queues: a number beside them reads as unread mail.
    expect(queues).not.toContain("/admin/help");
    expect(queues).not.toContain("/admin/audit");
    expect(queues).not.toContain("/admin/tiers");
    expect(queues).not.toContain("/admin/brain/testing");
  });

  it("refuses a count on a destination that is not a queue", () => {
    const counted = withWorkspaceNavCounts(workspaceNavigationFor("admin", allLive), {
      "/admin/help": 9,
      "/admin/audit": 12,
    });
    expect(item(counted, "/admin/help")?.count).toBeUndefined();
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
  it("covers the required 25 canonical and merged-view paths", () => {
    expect(pathCases).toHaveLength(25);
  });

  it.each(pathCases)("resolves $path to $label", ({ role, path, label }) => {
    expect(getWorkspaceActiveItem(role, path, allLive)?.label).toBe(label);
  });

  it.each(pathCases)("rejects the synthetic look-alike for $path", ({ role, path }) => {
    const item = getWorkspaceActiveItem(role, path, allLive);
    expect(item).toBeDefined();
    expect(isWorkspaceNavItemActive(item!, `${path}-extra`)).toBe(false);
  });

  it("marks exactly Evals current on its nested Brain route", () => {
    const active = workspaceNavigationFor("admin", allLive)
      .flatMap((group) => workspaceNavItemsWithChildren(group.items))
      .filter((item) => isWorkspaceNavItemActive(item, "/admin/brain/testing"));
    expect(active.map((item) => item.label)).toEqual(["Evals"]);
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
    expect(hrefs(clientPass)).toContain("/admin/provisioning");
    expect(hrefs(clientPass)).toContain("/admin/billing");
  });
});

describe("role-scoped admin navigation", () => {
  const hrefs = (platformRole?: Parameters<typeof workspaceNavigationFor>[2]) =>
    workspaceNavigationFor("admin", allLive, platformRole).flatMap((group) =>
      group.items.map((item) => item.href),
    );

  const moneyHrefs = ["/admin/billing", "/admin/tiers", "/admin/affiliates"];

  it("offers eval controls only to the owner/admin mutation set", () => {
    expect(hrefs("owner")).toContain("/admin/brain/testing");
    expect(hrefs("admin")).toContain("/admin/brain/testing");
    expect(hrefs("success")).not.toContain("/admin/brain/testing");
    expect(hrefs("build")).not.toContain("/admin/brain/testing");
  });

  it("hides the three money surfaces a success reviewer is refused on", () => {
    const success = hrefs("success");
    for (const href of moneyHrefs) expect(success).not.toContain(href);
    // Corrections is the one Money surface success may open, so it stays.
    expect(success).toContain("/admin/corrections");
  });

  it("leaves every other admin destination in place for success", () => {
    const success = hrefs("success");
    const owner = hrefs("owner");
    expect(success).toEqual(owner.filter((href) =>
      !moneyHrefs.includes(href)
      && href !== "/admin/brain/testing"
      && href !== "/admin/account-terms",
    ));
  });

  it("shows the full nav to owner, admin, and to a caller that names no role", () => {
    for (const role of ["owner", "admin", undefined] as const) {
      for (const href of moneyHrefs) expect(hrefs(role)).toContain(href);
    }
  });

  it("treats an item with no roles as open to everyone", () => {
    expect(navItemAllowsRole({ label: "Help", href: "/admin/help" }, "success")).toBe(true);
  });

  it("gives Compliance and Corrections distinct collapsed-rail monograms", () => {
    const items = workspaceNavigation.admin.flatMap((group) => group.items);
    const compliance = items.find((item) => item.href === "/admin/compliance");
    const corrections = items.find((item) => item.href === "/admin/corrections");
    expect(compliance?.short).toBe("CP");
    expect(corrections?.short).toBe("CR");
  });
});
