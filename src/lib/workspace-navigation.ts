import type { UserRole } from "@/lib/auth/claims";
import { phase5Live, phase6Live, type EnvironmentSource } from "@/lib/env-contract";

export type WorkspaceRole = "admin" | "coach" | "affiliate";

/**
 * The rail draws a 14px outline beside every destination, and the four shapes are a vocabulary
 * rather than decoration: a square is a list of things, a circle is people or threads, a bar is a
 * report or a record, a diamond is a system the platform runs. A rail of identical squares reads
 * as a template, which is the whole reason the shape is declared per destination.
 */
export type WorkspaceNavGlyph = "square" | "circle" | "bar" | "diamond";

export type WorkspaceNavItem = {
  label: string;
  href: string;
  /** The collapsed rail's two letters, where the derived monogram would collide with a sibling. */
  short?: string;
  /**
   * Marks a destination whose rows are a queue somebody works down -- threads waiting on a
   * reply, channels missing a receipt. Only a queue item accepts a count, so a number can never
   * appear beside a settings or a reference page where it would read as unread mail.
   */
  queue?: true;
  /**
   * Marks a queue whose depth is somebody waiting on a person, rather than inventory the platform
   * is holding. Threads escalated out of the agent are waiting; contacts, brain entries and
   * conversations are not. It is deliberately not `queue`: `queue` says a count is allowed here at
   * all, and ten destinations carry it, so spending the amber on every one of them would say
   * everything is urgent and therefore nothing is.
   */
  attention?: true;
  /** The rail's 14px outline for this destination. */
  glyph?: WorkspaceNavGlyph;
  /**
   * The queue depth, filled in per request by `withWorkspaceNavCounts`. The static config never
   * carries one: a count in a module constant is a count that is wrong by the time it renders.
   */
  count?: number;
  /**
   * Platform roles that may see this item. Omitted means every role sees it. A success reviewer
   * 403s on the money surfaces, so the nav stops offering them rather than sending them into a
   * guard.
   */
  roles?: readonly UserRole[];
  badge?: string;
  matchPaths?: readonly string[];
  liveWhen?: (environment?: EnvironmentSource) => boolean;
  children?: readonly WorkspaceNavItem[];
};

export type WorkspaceNavGroup = {
  /** An empty label renders the group without a heading (Overview, at the top). */
  label: string;
  items: readonly WorkspaceNavItem[];
};

export type WorkspaceRoleMeta = {
  label: string;
  workspace: string;
  home: string;
  initials: string;
};

export const workspaceRoleMeta: Record<WorkspaceRole, WorkspaceRoleMeta> = {
  admin: {
    label: "Admin",
    workspace: "SetterFi platform",
    home: "/admin/overview",
    initials: "SF",
  },
  coach: {
    label: "Coach",
    workspace: "Your agent",
    home: "/coach/home",
    initials: "YA",
  },
  affiliate: {
    label: "Affiliate",
    workspace: "Partner portal",
    home: "/affiliate",
    initials: "PP",
  },
};

export const demoViewTargets = [
  { id: "admin", ...workspaceRoleMeta.admin },
  { id: "coach", ...workspaceRoleMeta.coach },
  {
    id: "onboarding",
    label: "Onboarding",
    workspace: "Setup companion",
    home: "/onboarding",
    initials: "SC",
  },
  {
    id: "consumer",
    label: "Consumer",
    workspace: "Lead experience",
    home: "/consumer",
    initials: "LE",
  },
  { id: "affiliate", ...workspaceRoleMeta.affiliate },
] as const;

/**
 * The authenticated personas created by scripts/seed-staging-users.mjs.
 *
 * These are deliberately separate from demoViewTargets. A view target is a route
 * that an already-authenticated fixture session can visit; a review persona is an
 * account that must go through /login before its role claims change. Keeping only
 * harmless labels and destinations here means the client bundle never carries the
 * demo credentials that the server-only login page conditionally renders.
 */
export const demoReviewPersonas = [
  { id: "owner", label: "Staging owner", workspace: "SetterFi platform", home: "/admin/overview", initials: "SO" },
  { id: "admin", label: "Staging admin", workspace: "SetterFi platform", home: "/admin/overview", initials: "SA" },
  { id: "coach", label: "Staging coach", workspace: "Your agent", home: "/coach/home", initials: "SC" },
  { id: "affiliate", label: "Staging affiliate", workspace: "Partner portal", home: "/affiliate", initials: "SF" },
] as const;

// Phase 5
export function demoViewTargetsFor(environment: EnvironmentSource = process.env) {
  return phase5Live(environment)
    ? demoViewTargets.filter((target) => target.id !== "onboarding")
    : demoViewTargets;
}

/**
 * The three money surfaces a success reviewer is refused on (see moneyPageAccessStatus): they may
 * open Corrections, and nothing else under Money.
 */
const MONEY_ROLES: readonly UserRole[] = ["owner", "admin", "build"];
const BRAIN_MUTATION_ROLES: readonly UserRole[] = ["owner", "admin"];
/** Publishing account terms is the same authority the API and the RPC both check. */
const ACCOUNT_TERMS_ROLES: readonly UserRole[] = ["owner", "admin"];

/**
 * The one spelling of the Inbox route, shared by the nav item and by `coachNavCounts`. The count
 * is keyed by href, so a literal typed twice is a pill that silently stops carrying its number.
 */
export const COACH_INBOX_HREF = "/coach/conversations";

export const workspaceNavigation: Record<WorkspaceRole, readonly WorkspaceNavGroup[]> = {
  admin: [
    /*
     * Five groups, every one of them labelled, and the label says what the reader came to do:
     * Run the platform today, look after Clients, deal with Money, tend the Brain, administer the
     * Platform itself. Overview leads Run rather than floating alone above the rail -- it is the
     * first stop of the day-to-day loop, not a category of its own.
     */
    {
      label: "Run",
      items: [
        { label: "Overview", href: "/admin/overview", glyph: "square" },
        /*
         * Inbox is the merged destination from screen 5a: system problems and lead handoffs in one
         * queue. It lives at /admin/alerts because that is where the attention queue has always
         * been rendered; only the label was wrong. Client requests is the coach-to-platform support
         * thread queue at /admin/support, which used to be labelled "Attention" while pointing at
         * something else entirely. Renaming one without the other would have left the crossed pair
         * that made the merge necessary.
         */
        { label: "Inbox", href: "/admin/alerts", queue: true, attention: true, glyph: "diamond" },
        { label: "Client requests", href: "/admin/support", short: "CQ", queue: true, glyph: "circle" },
        { label: "Channel health", href: "/admin/channel-health", queue: true, glyph: "bar" },
        { label: "Provisioning", href: "/admin/provisioning", liveWhen: phase5Live, queue: true, glyph: "circle" },
        { label: "System", href: "/admin/system", queue: true, glyph: "diamond" },
      ],
    },
    {
      label: "Clients",
      items: [
        { label: "Client book", href: "/admin/platform-clients", queue: true, glyph: "circle" },
        /*
         * One setter per client, so the roster is a client dimension rather than a category of its
         * own. It takes a count because unpublished agents are a queue somebody works down.
         */
        { label: "Agents", href: "/admin/agents", queue: true, glyph: "diamond" },
        { label: "Agent performance", href: "/admin/agent-performance", glyph: "bar" },
      ],
    },
    {
      label: "Money",
      items: [
        {
          label: "Revenue and subscriptions",
          href: "/admin/billing",
          liveWhen: phase6Live,
          roles: MONEY_ROLES,
          queue: true,
          glyph: "bar",
        },
        {
          label: "Plans and pricing",
          href: "/admin/tiers",
          matchPaths: ["/admin/tiers-billing"],
          roles: MONEY_ROLES,
          glyph: "square",
        },
        { label: "Affiliates and payouts", href: "/admin/affiliates", roles: MONEY_ROLES, queue: true, glyph: "circle" },
        {
          label: "Corrections",
          href: "/admin/corrections",
          liveWhen: phase6Live,
          short: "CR",
          queue: true,
          glyph: "diamond",
        },
      ],
    },
    {
      label: "Brain",
      items: [
        { label: "The Brain", href: "/admin/brain", queue: true, glyph: "diamond" },
        { label: "Evals", href: "/admin/brain/testing", roles: BRAIN_MUTATION_ROLES, glyph: "square" },
        { label: "Compliance", href: "/admin/compliance", short: "CP", queue: true, glyph: "bar" },
      ],
    },
    {
      label: "Platform",
      items: [
        { label: "Audit", href: "/admin/audit", glyph: "bar" },
        /*
         * The publisher for the contract a coach accepts at signup. It carries no flag: a version
         * has to be published before `SETTERFI_ACCOUNT_TERMS_LIVE` can be switched on, so gating
         * the door on that flag would lock the room from the inside.
         */
        {
          label: "Account terms",
          href: "/admin/account-terms",
          roles: ACCOUNT_TERMS_ROLES,
          short: "AT",
          glyph: "bar",
        },
        { label: "Help", href: "/admin/help", glyph: "square" },
      ],
    },
  ],
  coach: [
    {
      label: "Workspace",
      items: [
        /*
         * "Overview" and "Agent", which is what the canvas draws, and both were renamed here
         * without an argument -- the two labels below are the only nav strings in this file that
         * do not match their drawing.
         *
         * Eighteen artboards draw this bar and all eighteen carry
         * `Overview | Inbox | Leads | Agent | Billing`, with no exception:
         * `coach-nav-labels.test.ts` re-derives that from the files rather than restating it here,
         * so a future rename has to argue with the drawing instead of with a comment.
         *
         * Three things make the old labels an oversight rather than a decision. The product's own
         * voice already called it Overview -- `CoachSetup.dc.html:100` and `CoachTips.dc.html:100`
         * both draw a body-copy back-link reading "Back to overview" on screens that render no nav
         * at all. Every one of the twenty admin labels above is canvas-exact, including "Overview"
         * for the admin landing page, so this file follows canvas nav labels everywhere else. And
         * the demotion from nine destinations to five is argued at length below, naming each cut
         * route and its replacement entry point, while the renames are argued nowhere.
         *
         * "Your agent" was also the wrong string for a second reason the drawing makes plain: it is
         * the product lockup. Every coach artboard puts "Your agent" beside the mark at the left of
         * the same 76px bar (`Billing.dc.html:61`), so the old label repeated the wordmark a few
         * inches to its right and the bar named the product twice.
         *
         * **The one counterexample, which is real and is deliberately not followed.**
         * `CoachHomeMobile.dc.html:160` draws the phone tab bar as
         * `Home | Inbox | Leads | Agent | Billing` -- "Home", not "Overview". So the canvas is
         * unanimous on "Agent" (19 of 19) and 18-to-1 on "Overview". One nav item carries one
         * label, a coach never sees both viewports at once, and the eighteen desktop drawings plus
         * the product's own back-link copy outweigh a single phone drawing. The guard is scoped to
         * the desktop bar and pins the phone's divergence separately, so this stays a decision
         * somebody made rather than a difference nobody noticed. Logged in `docs/GAPS.md`.
         */
        { label: "Overview", href: "/coach/home", glyph: "square" },
        /*
         * `queue: true` so the pill can carry the needs-you depth. `Main.dc.html`, `Inbox.dc.html`
         * and `Agent.dc.html` all draw an amber mono count on this pill, and it is the load-bearing
         * half of the canvas's decision to take the amber attention card off Home: with the card
         * gone and no count here, a coach would have no needs-you signal anywhere in the shell.
         * The count itself comes per request from whichever coach page already holds the number.
         */
        { label: "Inbox", href: COACH_INBOX_HREF, queue: true, attention: true, glyph: "circle" },
        {
          label: "Leads",
          href: "/coach/contacts",
          matchPaths: ["/coach/pipelines"],
          glyph: "circle",
        },
        { label: "Agent", href: "/coach/agent", glyph: "square" },
        { label: "Billing", href: "/coach/billing", glyph: "diamond" },
        /*
         * The rail was cut from nine rows to five: Get started, Connections, Notifications, and
         * Help all left. None of them went unreachable -- each already had (or, for Help, was
         * given) a persistent entry point outside the rail, so cutting the row didn't cut the
         * route:
         *   - Get started (/coach/get-started) -- coach Home's attention card ("Open setup"),
         *     see the "Blocked setup steps" source in coach-measurement.tsx.
         *   - Connections (/coach/integrations) -- Setup's channel strip, whose "Manage your
         *     connections" link renders unconditionally (get-started-checklist.tsx), plus coach
         *     Home's AttentionQueue, which puts a blocked channel ahead of everything else and
         *     gives it the primary fill ("Reconnect {channel}") in coach-measurement.tsx. The
         *     AttentionQueue route fires only while a channel is blocked, which is why the strip
         *     link exists: it is the route that survives everything being healthy.
         *   - Notifications (/coach/settings) -- the topbar bell and the account menu, on every
         *     page, via ROLE_NOTIFICATION_SETTINGS_HREF in app-topbar.tsx.
         *   - Help (/coach/help) -- the account menu, via ROLE_HELP_HREF in app-topbar.tsx. This
         *     one was new: before this cut, Help had no persistent entry point at all, only links
         *     from Meet Your Agent and the offer editor, so it needed the account-menu addition
         *     to survive losing its rail row.
         * workspace-navigation.test.ts pins both halves of this: the five-item rail, and that each
         * of the four demoted hrefs still has a real, reachable home. coach-pillbar.test.ts renders
         * the bar and reads the anchors back, which is the only check that survives this config
         * being handed in as a prop.
         */
      ],
    },
  ],
  affiliate: [
    {
      label: "Partner earnings",
      items: [{ label: "Partner earnings", href: "/affiliate", glyph: "bar" }],
    },
  ],
};

/**
 * Queue depths, keyed by the destination's own href: `{ "/admin/support": 4 }`.
 *
 * A page that already counted its own rows hands them straight to the shell, so the rail and the
 * page can never disagree about how many things are waiting.
 */
export type WorkspaceNavCounts = Readonly<Record<string, number>>;

/**
 * Stamps queue depths onto the nav for one render.
 *
 * Two rules are enforced here rather than left to each caller. A count only ever lands on an item
 * marked `queue`, so a number cannot appear beside Help or Plans and pricing, where it would read
 * as unread mail rather than as work. And a zero is dropped rather than rendered: an empty queue
 * is said by the page being empty when you open it, not by a grey 0 sitting in the rail all day.
 */
export function withWorkspaceNavCounts(
  groups: readonly WorkspaceNavGroup[],
  counts: WorkspaceNavCounts,
): readonly WorkspaceNavGroup[] {
  return groups.map((group) => ({
    ...group,
    items: group.items.map((item) => {
      const count = item.queue ? counts[item.href] : undefined;
      return typeof count === "number" && count > 0 ? { ...item, count } : item;
    }),
  }));
}

export function workspaceNavItemsWithChildren(items: readonly WorkspaceNavItem[]): WorkspaceNavItem[] {
  return items.flatMap((item) => [
    item,
    ...workspaceNavItemsWithChildren(item.children ?? []),
  ]);
}

/**
 * The flags the nav's own liveWhen predicates read. None is NEXT_PUBLIC, so none
 * of them exists in the browser bundle.
 */
const NAV_ENVIRONMENT_NAMES = [
  "SETTERFI_PHASE5_LIVE",
  "SETTERFI_PHASE6_LIVE",
  "SETTERFI_PHASE6_AFFILIATES_LIVE",
] as const;

/** Server-only: the nav flags, picked out for handing to the browser. */
export function navigationEnvironment(
  environment: EnvironmentSource = process.env,
): EnvironmentSource {
  return Object.fromEntries(
    NAV_ENVIRONMENT_NAMES.map((name) => [name, environment[name]]),
  );
}

let publishedEnvironment: EnvironmentSource | null = null;

/**
 * Hands the server-resolved nav flags to the browser.
 *
 * WorkspaceShell is a client component that calls workspaceNavigationFor with no
 * environment, so it read process.env: populated during SSR, empty after
 * hydration. "Get started" therefore rendered on a server-rendered load and
 * vanished on the next client navigation, which is why one role's top nav
 * differed between its own pages. The (workspace) layout already exists to
 * resolve exactly this kind of flag on the server -- it does the same for the
 * demo views -- so it publishes them here and both passes agree.
 */
export function publishNavigationEnvironment(environment: EnvironmentSource) {
  publishedEnvironment = environment;
}

function defaultNavigationEnvironment(): EnvironmentSource {
  if (typeof window === "undefined") return process.env;
  return publishedEnvironment ?? process.env;
}

// Phase 5
export function workspaceNavigationFor(
  role: WorkspaceRole,
  environment: EnvironmentSource = defaultNavigationEnvironment(),
  platformRole?: UserRole,
): readonly WorkspaceNavGroup[] {
  return workspaceNavigation[role]
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          (!item.liveWhen || item.liveWhen(environment)) &&
          navItemAllowsRole(item, platformRole),
      ),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * An item with no `roles` is open to everyone; an item with `roles` is hidden from a known
 * platform role that is not on the list. An unknown role -- no session, a coach shell, a test that
 * passes nothing -- sees the full nav, so this can only ever remove what a guard would refuse.
 */
export function navItemAllowsRole(item: WorkspaceNavItem, platformRole?: UserRole) {
  if (!item.roles || !platformRole) return true;
  return item.roles.includes(platformRole);
}

function pathMatches(activePath: string, candidate: string) {
  return activePath === candidate || activePath.startsWith(`${candidate}/`);
}

export function isWorkspaceNavItemActive(item: WorkspaceNavItem, activePath: string) {
  const matches = [item.href, ...(item.matchPaths ?? [])]
    .filter((path) => pathMatches(activePath, path));
  if (matches.length === 0) return false;

  // Parent destinations should not be current when a more-specific sibling owns the route.
  // This makes aria-current and visual selection singular for /admin/brain/testing.
  const longestMatch = Math.max(...Object.values(workspaceNavigation)
    .flatMap((groups) => groups.flatMap((group) => workspaceNavItemsWithChildren(group.items)))
    .flatMap((candidate) => [candidate.href, ...(candidate.matchPaths ?? [])])
    .filter((path) => pathMatches(activePath, path))
    .map((path) => path.length));
  return matches.some((path) => path.length === longestMatch);
}

export function getWorkspaceActiveItem(
  role: WorkspaceRole,
  activePath: string,
  environment: EnvironmentSource = process.env,
) {
  const items = workspaceNavigationFor(role, environment)
    .flatMap((group) => workspaceNavItemsWithChildren(group.items));
  return items.find((item) => [item.href, ...(item.matchPaths ?? [])].includes(activePath))
    ?? items.find((item) => isWorkspaceNavItemActive(item, activePath));
}
