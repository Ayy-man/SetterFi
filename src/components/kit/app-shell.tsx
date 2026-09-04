"use client";

import {
  AppSidebar,
  MobileAppSidebar,
  type NavGroup,
  type NavItem,
  type SidebarAttention,
  type SidebarFleetHealth,
} from "@/components/kit/app-sidebar";
import { AppTopbar } from "@/components/kit/app-topbar";
import { CoachSupportBubble } from "@/components/workspace/live/coach-support-bubble";
import { CoachContextEyeSurface } from "@/components/workspace/rehaul/context-eye";
import { PaletteClientProvider } from "@/components/kit/palette-clients";
import type { Crumb } from "@/components/kit/breadcrumbs";
import { SidebarProvider } from "@/components/ui/sidebar";
import type { CSSProperties, ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";

import type { UserRole } from "@/lib/auth/claims";
import {
  withWorkspaceNavCounts,
  workspaceNavigationFor,
  type WorkspaceNavCounts,
} from "@/lib/workspace-navigation";
import { useWorkspaceEnv } from "@/components/workspace/workspace-env";

export type { Crumb, NavGroup, NavItem, SidebarAttention, SidebarFleetHealth };

export type ShellDensity = "comfortable" | "compact" | "dense";

export type AppShellProps = {
  role: "admin" | "coach" | "affiliate";
  activePath: string;
  // Optional: server pages must omit it. Nav items carry liveWhen functions,
  // which cannot cross the server/client boundary as props; the shell builds
  // them here from the role and the published navigation environment.
  nav?: readonly NavGroup[];
  /**
   * Queue depths for the rail, as plain numbers keyed by href.
   *
   * The alternative -- building the nav with `withWorkspaceNavCounts` and passing it in through
   * `nav` -- only works from a client component, because nav items carry `liveWhen` predicates and
   * a function cannot cross the server boundary as a prop. A server page that did it got a React
   * "Functions cannot be passed directly to Client Components" error in the console and a rail
   * with no counts on it. Numbers cross fine, so a server page hands the numbers and the shell,
   * which is already a client component, applies them to the nav it builds.
   */
  navCounts?: WorkspaceNavCounts;
  /**
   * The signed-in platform role, where the page already has it. It only removes nav items the
   * page's own guard would refuse -- a success reviewer 403s on Revenue, Plans, and Affiliates,
   * so the sidebar stops offering them. Omitted (or supplied by the workspace layout through
   * context) leaves the nav exactly as it is.
   */
  platformRole?: UserRole;
  /**
   * The optional card under the nav: the one thing in this workspace still waiting on somebody.
   * Omitted, the rail ends at the last nav group.
   */
  attention?: SidebarAttention;
  /**
   * Fleet-wide counts under the nav, on the owner console only.
   *
   * The guard is here rather than at the call site because the rail is chrome: it renders on
   * every screen, so a leak would be a leak everywhere at once, and a prop a caller merely
   * *should not* pass on a coach page is one that eventually gets passed. `role` already decides
   * the rail's width, density and nav, and it decides this too -- a coach or affiliate shell
   * drops the card whatever it is handed.
   */
  fleet?: SidebarFleetHealth;
  crumbs: readonly Crumb[];
  actions?: ReactNode;
  children: ReactNode;
};

const SIDEBAR_COOKIE_NAME = "sidebar_state";
const DENSITY_STORAGE_KEY = "setterfi:device:density";

const ROLE_DEFAULT_DENSITY = {
  admin: "compact",
  coach: "comfortable",
  affiliate: "comfortable",
} as const satisfies Record<AppShellProps["role"], ShellDensity>;

function isShellDensity(value: string | null): value is ShellDensity {
  return value === "comfortable" || value === "compact" || value === "dense";
}

type ShellDensityContextValue = {
  density: ShellDensity;
  setDensity: (density: ShellDensity) => void;
};

const ShellDensityContext = createContext<ShellDensityContextValue | null>(null);

/**
 * The density control lives in the table's Display menu, not the header, so the
 * table needs a handle on the shell-wide value. Everything that reads density
 * reads the `data-density` attribute this sets on the shell root; the hook only
 * exists so a control can write it.
 */
export function useShellDensity(): ShellDensityContextValue {
  return (
    useContext(ShellDensityContext) ?? {
      density: "compact",
      setDensity: () => {},
    }
  );
}

/**
 * The rail's width: 186px on the coach's, 246px on the admin's, which carries group labels and
 * mono counts at greater density and needs the room for them.
 *
 * 246 rather than the 200 this shipped with, because 246 is the number the rest of the console
 * already assumes. `docs/REDESIGN-CANVAS.md:53` specifies it, and `admin/console.css:290` computes
 * the deck's `auto-fit` columns against "the window minus a 246px rail" in its own comment -- so
 * every console screen was laying panels out for a rail 46px narrower than the one beside them.
 * Requested by the admin-run lane, which owns the console and not this file.
 */
const ROLE_RAIL_WIDTH = {
  admin: "246px",
  coach: "186px",
  affiliate: "186px",
} as const satisfies Record<AppShellProps["role"], string>;

/**
 * The artifact's rail, expressed as a stylesheet rather than as markup.
 *
 * The rail's elements live in `app-sidebar.tsx` and `ui/sidebar.tsx`, and this pass is appearance
 * only: no nav item, route, count source, prop or accessible name changes, so restating the rail
 * as CSS keyed to the slots those files already emit is the change that touches nothing else.
 * Every selector below matches a `data-slot` the sidebar renders today, and every declaration is
 * a colour, a size or a radius.
 *
 * The rules are unlayered, so they win over the Tailwind utilities in `@layer utilities` without
 * needing specificity games. The two `!important`s are for declarations the sidebar writes as an
 * inline `style` prop, which no stylesheet can outrank.
 *
 * The glyph shapes and the amber count are keyed to `data-glyph` and `data-attention`, which the
 * nav data declares per destination -- a route spelled out in a selector here would break the day
 * that route moved, with no test to catch it.
 *
 * Values come from the design artifact spec's rail, nav and attention-card sections. Two of them
 * were written as the dark palette's periwinkle at a hand-picked alpha -- the rail's right edge at
 * .12 and the attention card's border at .15 -- on the argument that the token contract declared
 * no token at either number. That argument was about arithmetic and the tokens are about roles, and the arithmetic is
 * what fails: the light palette solves its hairlines as `rgba(60, 90, 150, ...)`, so re-solving
 * `tokens.css` left both of these behind as a dark-era slate drawn on a near-white rail. The rail's
 * right edge separates two surfaces, which is `--line`; the attention card's border is an outline
 * inside one surface on a card that already has a `--well` face, which is `--line-soft`.
 * `src/components/palette-literals.test.ts` is the guard, and this file has come off its DEBT list.
 *
 * Four values that were literals here are now tokens, because they were the reason the rail did
 * not follow the theme: the mark's gradient, the active glyph's fill and the active pill's border
 * were all written in the old teal and stayed teal after the accent moved to blue, and the group
 * label was a fixed `#63728e` that reads as a mid-slate on navy and as an illegible one on white.
 */
const RAIL_STYLES = `
[data-slot="sidebar-inner"] {
  background: var(--rail);
}
[data-slot="sidebar-container"][data-side="left"] {
  border-right-color: var(--line);
}

/* The lockup, at the console artboards' own anatomy (AdminOverview.dc.html:68-74): a 52px band
   closed by a hairline, a 26px accent-washed tile with an accent hairline round it and a 15px
   glyph inside, then the wordmark at 15px/600 and the role pill.

   The tile and the glyph are two pseudo-elements rather than one because a single element cannot
   both carry a wash and be masked to a glyph shape -- the mask would eat the wash. The glyph is
   masked rather than drawn as a data-URI background because a colour inside a data URI is a
   literal, and a literal is exactly how the old mark stayed teal after the accent moved to blue.
   Both are pure decoration: assistive tech reads the link's text, which is unchanged. Both step
   aside in the collapsed rail, where 56px only has room for the monogram. */
[data-slot="sidebar-header"] {
  position: relative;
}
[data-slot="sidebar-header"] a[href="/"]::before {
  content: "";
  flex: none;
  width: 26px;
  height: 26px;
  margin-right: 10px;
  border: 1px solid var(--accent-edge);
  border-radius: 7px;
  background: var(--accent-wash);
}
[data-slot="sidebar-header"]::before {
  content: "";
  position: absolute;
  /* The header's own padding, then the link's, then the tile's remaining 5.5px either side of a
     15px glyph. Both paddings are the same token the two elements are written with. */
  left: calc(var(--s-2) * 2 + 5.5px);
  top: 50%;
  width: 15px;
  height: 15px;
  transform: translateY(-50%);
  background-color: var(--accent-text);
  mask: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z'/%3E%3C/svg%3E") center / contain no-repeat;
}
[data-slot="sidebar"][data-collapsible="icon"] [data-slot="sidebar-header"] a[href="/"]::before,
[data-slot="sidebar"][data-collapsible="icon"] [data-slot="sidebar-header"]::before {
  display: none;
}
[data-slot="sidebar-header"] a[href="/"] > span:first-child {
  font-size: 15px;
  letter-spacing: -0.014em;
}

/* The role pill. The artboards draw "OWNER", and it is drawn on an owner's screen -- but the admin
   workspace serves four platform roles and the topbar's own fallback is the success role, so a hard-coded
   OWNER would be a false statement on three of them. It reads the role the shell was actually
   given, and a session whose role could not be resolved gets no pill rather than a guess. */
[data-slot="sidebar-header"] a[href="/"]::after {
  flex: none;
  margin-left: 8px;
  padding: 2px 7px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--well);
  color: var(--faint);
  font-family: var(--font-mono), "IBM Plex Mono", monospace;
  font-size: 10.5px;
  letter-spacing: 0.04em;
}
[data-shell-root][data-platform-role="owner"] [data-slot="sidebar-header"] a[href="/"]::after {
  content: "OWNER";
}
[data-shell-root][data-platform-role="admin"] [data-slot="sidebar-header"] a[href="/"]::after {
  content: "ADMIN";
}
[data-shell-root][data-platform-role="success"] [data-slot="sidebar-header"] a[href="/"]::after {
  content: "SUCCESS";
}
[data-shell-root][data-platform-role="build"] [data-slot="sidebar-header"] a[href="/"]::after {
  content: "BUILD";
}
[data-slot="sidebar"][data-collapsible="icon"] [data-slot="sidebar-header"] a[href="/"]::after {
  content: none;
}

/* Rail items: 7px 9px in a radius-8 well, 13px text, a 14px glyph on a 1.5px stroke. The size is
   read off --t-nav because the row writes its own font-size inline from that token. */
nav[aria-label="Primary"] {
  --t-nav: 13px;
}
[data-slot="sidebar-menu-button"],
[data-slot="sidebar-menu-sub-button"] {
  gap: 10px;
  padding: 7px 9px;
  border-radius: 8px;
}
[data-slot="sidebar-menu-button"][data-glyph]::before {
  content: "";
  flex: none;
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--glyph);
}
[data-slot="sidebar-menu-button"][data-glyph="square"]::before {
  border-radius: 4px;
}
[data-slot="sidebar-menu-button"][data-glyph="circle"]::before {
  border-radius: 99px;
}
[data-slot="sidebar-menu-button"][data-glyph="bar"]::before {
  height: 6px;
  border-radius: 2px;
}
[data-slot="sidebar-menu-button"][data-glyph="diamond"]::before {
  border-radius: 3px;
  transform: rotate(45deg);
}
[data-slot="sidebar-menu-button"][data-glyph][data-active]::before {
  border-color: var(--accent-bright);
  background: var(--accent-edge);
}
[data-slot="sidebar"][data-collapsible="icon"] [data-slot="sidebar-menu-button"][data-glyph]::before {
  display: none;
}

/* The travelling fill is what marks the current row, so the active treatment lands on it: the
   accent wash, an accent hairline all the way round (not down one edge), and the row's own weight
   500 which the button already carries. */
[data-slot="sidebar-active-pill"] {
  background: var(--accent-wash-strong);
  border: 1px solid var(--accent-edge);
  border-radius: 8px;
}

/* Group labels: 11.5px sans at 600 and .07em, uppercase, per AdminOverview.dc.html:79. They were
   9.5px mono at .11em, which is the overline role and the wrong one for this: an overline labels a
   figure inside a panel a reader is already looking at, and these five words are the console's
   top-level map, read at a glance from the far side of a 246px rail. The sidebar writes size,
   weight and tracking as an inline style, so those three need the marks. */
[data-slot="sidebar-group-label"] {
  height: auto;
  /* 12px in, to sit on the rail items' own text edge. The 10px on top is the gap between groups:
     the artboard gets that from an 18px margin under each group, which the rail does not have. */
  padding: 10px 12px 7px;
  color: var(--meta);
  font-size: 11.5px !important;
  font-weight: 600 !important;
  letter-spacing: 0.07em !important;
  text-transform: uppercase;
}

/* Counts sit right, in 10px mono, qualifying the row rather than competing with it. The badge is
   absolutely positioned by the primitive, so it is centred here rather than pinned to a top offset
   that assumed the old row height. */
[data-slot="nav-count"] {
  font-size: 10px;
  font-weight: 500;
  color: var(--overline);
}
[data-sidebar="menu-badge"][data-slot="nav-count"] {
  top: 50%;
  right: 9px;
  height: auto;
  transform: translateY(-50%);
}
/* A count that is asking for something rather than reporting it. The row declares itself
   attention-bearing in the nav data, so this survives a route moving and picks up any future
   queue that says the same thing about itself. */
[data-slot="nav-count"][data-attention] {
  color: var(--warning-text);
}

/* The card under the nav. */
[data-slot="sidebar-footer"] {
  padding: 12px;
}
[data-slot="sidebar-attention"] {
  padding: 12px 13px;
  border-radius: 11px;
  border-color: var(--line-soft);
  background: var(--well);
}

/* The fleet card, drawn on 24 admin artboards at AdminClients.dc.html:190-203.

   The fill repeats console.css:72's gradient as a fallback rather than reading the token alone.
   --console-drench-live is declared under [data-shell-role="admin"]; the mobile rail is a Radix
   SheetContent portalled to document.body, which is outside that subtree, and an unresolved
   custom property drops the whole declaration -- so the token alone would leave this card with no
   ground at all on mobile, near-white text on a pale sheet, and nothing in the console to say so.
   These rules live here rather than in console.css for the same reason: a stylesheet is global
   wherever its <style> sits, so unscoped selectors reach the portal even though variables do not.

   13px radius, 13px/14px padding: the drawn values. No radius token holds 13 -- --r-card is 14,
   --r-panel 12, --r-well 11 -- and binding to the nearest number rather than to a role is the
   mistake this codebase refuses by name.

   The hairline and the two quieter texts are mixes of --on-accent rather than white alphas. Over
   a drenched ground a white alpha is a correct value, and palette-literals.test.ts would put the
   file on its drench allowlist for it -- but that exemption is file-wide, and this file is the
   shell every role mounts, so it would also wave through the next literal somebody writes in a
   rule that is not drenched. The mix costs nothing and follows the token: re-solve --on-accent
   and the card's foreground, its muted counts and its border all move together.

   Nothing in this comment is a constant name on purpose. Every word in this template literal is
   served to the browser inside the rail's style element, so it reaches container.textContent --
   naming the allowlist constant here put a screaming-snake identifier into rendered page text and
   tripped admin-system-health.test.tsx:296, the guard that keeps deployment configuration names
   off operator screens. Comments in this string are page content, not source. */
[data-slot="sidebar-fleet-health"] {
  padding: 13px 14px;
  border: 1px solid color-mix(in srgb, var(--on-accent) 10%, transparent);
  border-radius: 13px;
  background: var(--console-drench-live, linear-gradient(158deg, oklch(0.28 0.08 262), oklch(0.17 0.04 265)));
  color: var(--on-accent);
}
[data-slot="sidebar"][data-collapsible="icon"] [data-slot="sidebar-fleet-health"] {
  display: none;
}
[data-slot="sidebar-fleet-health-head"] {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 9px;
}
[data-slot="sidebar-fleet-health-title"] {
  font-size: 13px;
  font-weight: 500;
}
[data-slot="sidebar-fleet-health-total"] {
  font-size: 11.5px;
  color: color-mix(in srgb, var(--on-accent) 75%, transparent);
}
[data-slot="sidebar-fleet-health-bar"] {
  display: flex;
  gap: 3px;
  margin-bottom: 8px;
}
/* The three state marks, at the graphics floor rather than the text one: these are 5px bars, so
   1.4.11's 3:1 applies, and it applies against the drench under them and not against the page. */
[data-slot="sidebar-fleet-health-bar"] > span {
  height: 5px;
  border-radius: var(--r-full);
}
[data-slot="sidebar-fleet-health-bar"] > span[data-fleet-tone="good"] { background: var(--good); }
[data-slot="sidebar-fleet-health-bar"] > span[data-fleet-tone="waiting"] { background: var(--waiting); }
[data-slot="sidebar-fleet-health-bar"] > span[data-fleet-tone="warning"] { background: var(--warning); }
[data-slot="sidebar-fleet-health-counts"] {
  font-size: 12px;
  color: color-mix(in srgb, var(--on-accent) 80%, transparent);
}
`;

function readSidebarCookie(): boolean | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${SIDEBAR_COOKIE_NAME}=(true|false)`),
  );
  if (!match) return null;
  return match[1] === "true";
}

export function AppShell({
  actions,
  activePath,
  attention,
  children,
  crumbs,
  fleet,
  nav: navProp,
  navCounts,
  platformRole,
  role,
}: AppShellProps) {
  const { account, platformRole: sessionPlatformRole } = useWorkspaceEnv();
  /*
   * The fleet card is owner-console chrome and nothing else. Reading `role` here rather than
   * trusting the caller is what makes that structural: these are cross-tenant counts, the rail
   * renders on every screen, and a coach shell handed them by mistake would leak the whole
   * platform's shape on every page at once rather than on one.
   */
  const railFleet = role === "admin" ? fleet : undefined;
  /*
   * The signed-in platform role, resolved once. It reaches the rail's role pill as an attribute
   * rather than as markup because the pill is a pseudo-element in RAIL_STYLES, which is a constant
   * string with no interpolation in it -- so the stylesheet names the four roles and the attribute
   * says which one this session is. Undefined stamps nothing and the pill does not render, which
   * is the honest state: a session whose role we could not read must not be labelled OWNER.
   */
  const resolvedPlatformRole = platformRole ?? sessionPlatformRole;
  const resolvedNav =
    navProp ?? workspaceNavigationFor(role, undefined, resolvedPlatformRole);
  const nav = navCounts ? withWorkspaceNavCounts(resolvedNav, navCounts) : resolvedNav;
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [density, setDensityState] = useState<ShellDensity>(
    ROLE_DEFAULT_DENSITY[role],
  );

  // The cookie is read after the first paint so the server and client agree on
  // the first render; the sidebar's own width transition is disabled, so the
  // correction is not visible as a slide.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const stored = readSidebarCookie();
      if (stored !== null) setSidebarOpen(stored);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // Read after the first paint, for the same reason as the sidebar cookie: the
  // server render cannot know a device preference.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const stored = window.localStorage.getItem(DENSITY_STORAGE_KEY);
        if (isShellDensity(stored)) setDensityState(stored);
      } catch {
        // An unavailable storage jar leaves the role default in place.
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const shellCount = document.querySelectorAll(
      "[data-shell-root], [data-workspace-layout]",
    ).length;
    if (shellCount > 1) {
      throw new Error("AppShell cannot render inside another application shell.");
    }
  }, []);

  function setDesktopSidebarOpen(open: boolean) {
    setSidebarOpen(open);
    // SidebarProvider writes the cookie itself; this keeps the shell's own
    // controlled state in step with it.
  }

  function setDensity(next: ShellDensity) {
    setDensityState(next);
    try {
      window.localStorage.setItem(DENSITY_STORAGE_KEY, next);
    } catch {
      // The current page still re-renders at the chosen density.
    }
  }

  return (
    <ShellDensityContext.Provider value={{ density, setDensity }}>
      {/*
        The registry sits above the topbar and above the page, because the palette lives in the
        topbar and the client list that feeds it is loaded by the page. Empty on every page that
        registers nothing, which is what makes the palette drop its Clients group rather than
        render an empty one.
      */}
      <PaletteClientProvider>
      <SidebarProvider
        // The rail's collapse animates now (see `ui/sidebar.tsx`): 250ms of width on
        // --ease-smooth-out, which is the scale's pairing for a resize. This wrapper used to
        // override that back to `transition-none`, which is why collapsing snapped.
        className="min-h-svh min-w-0 overflow-x-clip bg-[var(--canvas)]"
        data-shell-root
        data-density={density}
        data-sidebar={sidebarOpen ? "expanded" : "collapsed"}
        data-shell-role={role}
        data-platform-role={resolvedPlatformRole}
        onOpenChange={setDesktopSidebarOpen}
        open={sidebarOpen}
        style={
          {
            "--sidebar-width": ROLE_RAIL_WIDTH[role],
            "--sidebar-width-icon": "var(--sidebar-w-collapsed)",
            "--row-h": `var(--row-h-${density})`,
          } as CSSProperties
        }
      >
        {/* A constant stylesheet with no interpolation in it. */}
        <style dangerouslySetInnerHTML={{ __html: RAIL_STYLES }} />

        <a
          className="sr-only z-[var(--z-toast)] rounded-[var(--r-control)] bg-[var(--raised)] px-[var(--s-3)] py-[var(--s-2)] text-[var(--ink)] shadow-[var(--shadow-raised)] focus:not-sr-only focus:fixed focus:top-[var(--s-2)] focus:left-[var(--s-2)]"
          href="#main"
        >
          Skip to main content
        </a>

        {/*
          The coach surface navigates from a pill bar across the top of the page rather than from
          the rail, so it renders no sidebar at all -- not a hidden one. Leaving the rail mounted
          and hiding it would keep its five links in the accessibility tree and give a screen
          reader two navigations for one workspace.
        */}
        {role === "coach" ? null : (
          <div className="hidden lg:block">
            <AppSidebar activePath={activePath} attention={attention} fleet={railFleet} nav={nav} />
          </div>
        )}

        <div
          className="flex h-full w-full min-w-0 flex-1 flex-col has-[div[data-layout=fixed]]:h-svh"
          id="content"
          // The pane behind every page, and the single cool bloom off its top-right that is the
          // only light source in the design. Painted here rather than per page so no route has to
          // remember to bring its own ground.
          style={{
            backgroundColor: "var(--pane)",
            backgroundImage: "var(--pane-bloom)",
            backgroundRepeat: "no-repeat",
          }}
        >
          <AppTopbar
            actions={actions}
            activePath={activePath}
            crumbs={crumbs}
            // The coach bar renders the destinations itself. The console ignores this and keeps
            // its rail; passing it unconditionally is what stops the bar deriving a second list.
            nav={nav}
            onOpenMobileNavigation={() => setMobileNavigationOpen(true)}
            platformRole={resolvedPlatformRole}
            role={role}
          />
          <main
            className={[
              "mx-auto flex w-full max-w-[var(--content-max)] min-w-0 flex-1 flex-col px-[var(--s-4)] py-[var(--s-6)] sm:px-[var(--s-6)] xl:px-[var(--page-x)] has-[div[data-layout=fixed]]:min-h-0 has-[div[data-layout=fixed]]:overflow-hidden",
              /*
               * Room for the coach's phone tab bar. Below `sm` the pill bar goes `fixed` to the
               * bottom edge at 56px plus the home-indicator inset (`coach-pillbar.tsx`), and it is
               * mounted at the top of this element, so nothing in the normal flow accounted for
               * it: the last row of every coach page sat under the bar. 16px of air on top of the
               * bar's own height and inset, which is the same expression the support bubble uses
               * to clear it.
               */
              role === "coach"
                ? "max-sm:pb-[calc(56px+16px+env(safe-area-inset-bottom))]"
                : "",
            ].join(" ")}
            id="main"
            tabIndex={-1}
          >
            {/*
              The coach pill bar used to mount here, as the first child of `<main>`. Every coach
              artboard draws it inside the 76px bar instead, centred between the lockup and the
              account chip, so `AppTopbar` renders it now and the page starts at its own greeting.
              Nothing about the bar itself changed -- it is the same component, the same one `<nav>`
              and the same five links, and below `sm` it is still the `fixed` phone tab bar that
              `<main>`'s bottom pad below reserves room for.
            */}
            {/*
              The coach shell's own eye default: header placement at the coach's 46px, so an eye
              mounted by any coach screen lands beside Export rather than in the bottom-right
              corner the support bubble owns. `CoachScale` declares the same thing for the
              onboarding and auth surfaces, which never render an `AppShell`.

              The console keeps the module default -- floating, 32px -- because it is the density
              its eleven callsites were drawn at, and every one of them that wants the header row
              already says so.
            */}
            {role === "coach" ? (
              <CoachContextEyeSurface>{children}</CoachContextEyeSurface>
            ) : (
              children
            )}
          </main>
        </div>

        {/*
          The support bubble, mounted once per coach workspace and outside <main> on purpose: it is
          `fixed`, so inheriting `--content-max` would only constrain a box that is already taken
          out of flow, and sitting inside the scrolling column would put a dialog inside the
          landmark it floats over.

          The name comes from the workspace layout's one display-name read, not from a prop: this
          is a client component mounted by thirty pages, so a prop would have meant thirty reads.
          Absent -- outside `supabase` mode, or a read that failed -- the bubble falls back to
          "Need a hand?", which is the behaviour it was built for and better than a placeholder.
        */}
        {role === "coach" ? <CoachSupportBubble coachName={account?.firstName ?? undefined} /> : null}

        {/* Same reasoning as the rail: the pill bar wraps and stays usable on a phone, so a coach
            has no second navigation to open. */}
        {role === "coach" ? null : (
          <MobileAppSidebar
            activePath={activePath}
            attention={attention}
            fleet={railFleet}
            nav={nav}
            onOpenChange={setMobileNavigationOpen}
            open={mobileNavigationOpen}
          />
        )}
      </SidebarProvider>
      </PaletteClientProvider>
    </ShellDensityContext.Provider>
  );
}
