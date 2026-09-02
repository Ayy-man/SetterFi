"use client";

import { ChevronDown, ChevronRight, X } from "@/components/kit/icons";
import type { KitIcon } from "@/components/kit/icons";
import type { WorkspaceNavGlyph } from "@/lib/workspace-navigation";

import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { indicatorTransition } from "@/components/kit/motion";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

export type NavItem = {
  label: string;
  href: string;
  /**
   * Reserved for a future custom icon set. The sidebar deliberately renders no
   * icons at all -- group labels and text do the work -- so nothing reads this
   * yet. Keeping the slot means adding icons later is a render change, not a
   * data migration.
   */
  icon?: KitIcon;
  /**
   * The collapsed rail's two letters for this item. Set it where the derived monogram would
   * collide with a sibling's -- Compliance and Corrections both derive "CO".
   */
  short?: string;
  /**
   * The 14px outline the rail draws beside this destination. Purely decorative -- it is a CSS
   * pseudo-element on the row, so it carries no text and the row's accessible name is the label
   * alone -- but the four shapes are a vocabulary, and a rail of identical squares reads as a
   * template rather than as a product. The shape is declared per destination in
   * `workspace-navigation.ts`; omitted, the row draws the square.
   */
  glyph?: WorkspaceNavGlyph;
  /**
   * Marks a count that is somebody waiting on a person rather than inventory the platform holds,
   * which is the one count in the rail that takes the amber. It is a separate flag from `queue`
   * on purpose: `queue` only says a number is allowed on this row at all.
   */
  attention?: true;
  count?: number;
  matchPaths?: readonly string[];
  children?: readonly NavItem[];
};

export type NavGroup = {
  /** An empty label renders the group with no heading (Overview sits alone at the top). */
  label: string;
  items: readonly NavItem[];
};

/**
 * The one optional card under the nav. It exists for the thing the reader has to come back to --
 * an A2P registration still in carrier vetting, a provisioning run that stalled -- so `detail` is
 * a single plain line, and the honest-states rule keeps a percentage or a predicted date out of
 * it: a day counter or a plain status, nothing that pretends to know when it ends.
 */
export type SidebarAttention = {
  title: string;
  detail: string;
  href?: string;
};

/**
 * The fleet rollup that closes the owner rail, drawn on 24 of the 25 admin artboards
 * (`AdminClients.dc.html:190-203` is the canonical one; all 24 are byte-identical).
 *
 * **There is no total.** The artboard's "24 agents" is 21 + 2 + 1, and taking it as the sum
 * rather than as a fourth number is the whole reason the header and the bar can never disagree:
 * a separately-sourced total would eventually be read at a different instant from the three parts
 * and print a header that its own segments contradict.
 *
 * `registering` is the A2P carrier state and its word is fixed. The honest-states rule forbids
 * "setting up", a percentage and a predicted date here, because carrier vetting genuinely takes
 * two to three weeks and nobody on this side can shorten it or name the day it ends.
 */
export type SidebarFleetHealth = {
  /** Published, unpaused, answering leads. */
  live: number;
  /** With the carrier for A2P vetting. Never "setting up", never a percentage, never a date. */
  registering: number;
  /** Switched off by the client, whatever the agent's publish state. */
  paused: number;
};

type AppSidebarProps = {
  activePath: string;
  nav: readonly NavGroup[];
  attention?: SidebarAttention;
  /**
   * Admin only, and `AppShell` is where that is enforced -- these are fleet-wide counts across
   * every tenant, which is exactly the cross-client aggregate a coach and an affiliate may never
   * see. The rail is chrome, so a leak here would be a leak on every screen at once.
   */
  fleet?: SidebarFleetHealth;
  onNavigate?: () => void;
};

type MobileAppSidebarProps = AppSidebarProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * A count is a number the reader scans down a column, so it is mono, right-aligned and faint: it
 * qualifies the row it sits on rather than competing with the label for it.
 */
const NAV_ITEM_COUNT_CLASS =
  "shrink-0 text-right font-mono text-[length:var(--t-mono-crumb)] leading-[var(--t-mono-crumb-lh)] font-normal tabular-nums text-[var(--faint)]";

/**
 * The collapsed rail is 56px of text, not icons. A two-letter monogram keeps
 * every destination distinguishable at a glance where an icon would otherwise
 * sit, and the tooltip still spells the full label.
 */
export function navMonogram(label: string, short?: string) {
  if (short?.trim()) return short.trim().slice(0, 2).toUpperCase();
  const words = label.split(/[\s/]+/u).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

function normalizePath(path: string) {
  if (path === "/") return path;
  return path.replace(/\/+$/, "");
}

function pathMatches(candidate: string, activePath: string) {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedActive = normalizePath(activePath);
  return (
    normalizedActive === normalizedCandidate ||
    normalizedActive.startsWith(`${normalizedCandidate}/`)
  );
}

function isNavItemDirectlyActive(item: NavItem, activePath: string) {
  return [item.href, ...(item.matchPaths ?? [])].some((path) =>
    pathMatches(path, activePath),
  );
}

export function isNavItemActive(item: NavItem, activePath: string): boolean {
  return (
    isNavItemDirectlyActive(item, activePath) ||
    (item.children?.some((child) => isNavItemActive(child, activePath)) ?? false)
  );
}

/**
 * The one destination the rail calls current, plus the items it hangs under.
 *
 * Each row used to answer "am I current?" on its own by prefix-matching its own paths, so two
 * overlapping siblings -- a section landing at `/admin/run` beside a page at `/admin/run/support`
 * -- both matched `/admin/run/support` and both carried `aria-current="page"`. Only a nested child
 * displaced its parent, and siblings are not nested. Resolving once over the rendered tree makes
 * current singular by construction: the deepest matching path wins, and a tie goes to whichever
 * item the navigation declares first.
 */
export type NavCurrent = {
  /** The href of the single current item. */
  href: string;
  /** Hrefs of the items it is nested under, outermost first. */
  trail: readonly string[];
};

function matchDepth(item: NavItem, activePath: string) {
  const matched = [item.href, ...(item.matchPaths ?? [])]
    .filter((path) => pathMatches(path, activePath))
    .map((path) => normalizePath(path).length);
  return matched.length === 0 ? -1 : Math.max(...matched);
}

export function resolveCurrentNav(
  groups: readonly NavGroup[],
  activePath: string,
): NavCurrent | null {
  const matches: { depth: number; href: string; trail: readonly string[] }[] = [];

  const walk = (items: readonly NavItem[], trail: readonly string[]) => {
    for (const item of items) {
      const depth = matchDepth(item, activePath);
      if (depth >= 0) matches.push({ depth, href: item.href, trail });
      if (item.children?.length) walk(item.children, [...trail, item.href]);
    }
  };

  for (const group of groups) walk(group.items, []);

  // Strictly deeper wins, so an equal-depth tie keeps the first declaration.
  const best = matches.reduce<(typeof matches)[number] | null>(
    (winner, candidate) =>
      winner === null || candidate.depth > winner.depth ? candidate : winner,
    null,
  );
  return best === null ? null : { href: best.href, trail: best.trail };
}

export function keepFocusInside(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;

  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getAttribute("aria-hidden") !== "true");

  const first = focusable.at(0);
  const last = focusable.at(-1);
  if (!first || !last) return;

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

const NAV_LINK_BASE =
  // Current is a quiet fill plus weight 500, and nothing else. No coloured edge, no border-left
  // stripe, no accent label: an edge bar is the first thing that reads as generated UI, and the
  // fill already says which row you are on. The fill itself is not painted here -- it is a
  // separate element that travels between items (see ActiveNavPill) -- so `data-active` carries
  // only the weight and the ink. Hover is that same quiet fill, so moving the pointer down the
  // rail previews the shape of the thing you are about to commit to.
  "relative h-[var(--row-h-dense)] gap-[var(--s-2)] rounded-[var(--r-input)] px-[var(--s-2)] font-normal text-[var(--body)] no-underline transition-colors duration-[var(--duration-quick)] ease-[var(--ease-out)] motion-reduce:transition-none hover:no-underline hover:bg-[var(--quiet)] hover:text-[var(--ink)] focus-visible:ring-[var(--focus-ring)] data-active:bg-transparent data-active:font-medium data-active:text-[var(--ink)]";

/**
 * The one wash in the nav, as a single element that glides to whatever is current rather than one
 * background switching off and another switching on. The App Router keeps this layout mounted
 * across a navigation, so the travel is what the reader actually sees when they change page.
 *
 * It sits behind the label (`-z-10`) inside a button that already clips to its own radius, so it
 * needs no radius bookkeeping of its own beyond matching `--r-input`.
 */
function ActiveNavPill({ reduced }: { reduced: boolean | null }) {
  return (
    <motion.span
      aria-hidden
      className="absolute inset-0 -z-10 rounded-[var(--r-input)] bg-[var(--quiet)]"
      data-slot="sidebar-active-pill"
      layoutId="workspace-nav-active"
      transition={indicatorTransition(reduced)}
    />
  );
}

function NavLink({
  current,
  item,
  nested = false,
  onNavigate,
}: {
  current: NavCurrent | null;
  item: NavItem;
  nested?: boolean;
  onNavigate?: () => void;
}) {
  const active = current?.href === item.href;
  const activeRef = useRef<HTMLAnchorElement | null>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const label = (
    <>
      <span className="min-w-0 flex-1 truncate group-data-[collapsible=icon]:sr-only">
        {item.label}
      </span>
      <span
        aria-hidden
        // The monogram fades in as the rail finishes narrowing, rather than appearing the instant
        // the collapse starts. Snapping it in left a two-letter stub centred in a still-142px rail
        // for most of the slide, which read as a label that had broken rather than one that was
        // being replaced.
        //
        // It stays rendered at zero opacity instead of toggling `hidden`, which is what makes the
        // fade possible at all: an element revealed from `display: none` paints straight at its
        // final opacity, so the delay and the transition were both dead. Absolute so it takes no
        // space in the expanded rail, and `pointer-events-none` so an invisible layer never sits
        // between the reader and the link.
        className="pointer-events-none absolute inset-0 grid place-content-center text-center text-[length:var(--t-badge)] leading-none tracking-normal whitespace-nowrap opacity-0 transition-opacity duration-[var(--duration-quick)] ease-[var(--ease-out)] motion-reduce:transition-none group-data-[collapsible=icon]:opacity-100 group-data-[collapsible=icon]:delay-[var(--duration-quick)] motion-reduce:group-data-[collapsible=icon]:delay-0"
      >
        {navMonogram(item.label, item.short)}
      </span>
    </>
  );

  if (nested) {
    return (
      <SidebarMenuSubItem>
        <SidebarMenuSubButton
          aria-current={active ? "page" : undefined}
          className={NAV_LINK_BASE}
          isActive={active}
          onClick={onNavigate}
          ref={active ? activeRef : undefined}
          render={<Link href={item.href} />}
          style={{
            fontSize: "var(--t-nav)",
            lineHeight: "var(--t-nav-lh)",
          }}
        >
          {active ? <ActiveNavPill reduced={reduced} /> : null}
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {typeof item.count === "number" ? (
            <span
              aria-hidden
              className={NAV_ITEM_COUNT_CLASS}
              data-attention={item.attention ? "" : undefined}
              data-slot="nav-count"
            >
              {item.count}
            </span>
          ) : null}
        </SidebarMenuSubButton>
        {item.children?.length ? (
          <SidebarMenuSub className="border-[var(--line)]">
            {item.children.map((child) => (
              <NavLink
                current={current}
                item={child}
                key={child.href}
                nested
                onNavigate={onNavigate}
              />
            ))}
          </SidebarMenuSub>
        ) : null}
      </SidebarMenuSubItem>
    );
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-current={active ? "page" : undefined}
        className={`${NAV_LINK_BASE} group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-0`}
        // The rail's outline for this destination. It is drawn as a ::before on this row, so it
        // adds no element and no text to the link's accessible name.
        data-glyph={item.glyph ?? "square"}
        isActive={active}
        onClick={onNavigate}
        render={<Link href={item.href} ref={active ? activeRef : undefined} />}
        style={{
          fontSize: "var(--t-nav)",
          lineHeight: "var(--t-nav-lh)",
        }}
        tooltip={item.label}
      >
        {active ? <ActiveNavPill reduced={reduced} /> : null}
        {label}
      </SidebarMenuButton>
      {typeof item.count === "number" ? (
        <SidebarMenuBadge
          className={`h-auto ${NAV_ITEM_COUNT_CLASS}`}
          data-attention={item.attention ? "" : undefined}
          data-slot="nav-count"
        >
          {item.count}
        </SidebarMenuBadge>
      ) : null}
      {item.children?.length ? (
        <SidebarMenuSub className="border-[var(--line)] group-data-[collapsible=icon]:hidden">
          {item.children.map((child) => (
            <NavLink
              current={current}
              item={child}
              key={child.href}
              nested
              onNavigate={onNavigate}
            />
          ))}
        </SidebarMenuSub>
      ) : null}
    </SidebarMenuItem>
  );
}

function NavigationGroups({ activePath, nav, onNavigate }: AppSidebarProps) {
  // Resolved once for the whole rail, so exactly one row can be current no matter how the
  // groups overlap.
  const current = resolveCurrentNav(nav, activePath);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollShadows, setScrollShadows] = useState({ top: false, bottom: false });

  const updateScrollShadows = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const nextShadows = {
      top: scroller.scrollTop > 0,
      bottom: scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1,
    };
    setScrollShadows((current) =>
      current.top === nextShadows.top && current.bottom === nextShadows.bottom
        ? current
        : nextShadows,
    );
  }, []);

  useEffect(() => {
    updateScrollShadows();
    window.addEventListener("resize", updateScrollShadows);

    const scroller = scrollRef.current;
    const resizeObserver =
      scroller && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(updateScrollShadows)
        : null;
    if (scroller && resizeObserver) {
      resizeObserver.observe(scroller);
      Array.from(scroller.children).forEach((child) => resizeObserver.observe(child));
    }

    return () => {
      window.removeEventListener("resize", updateScrollShadows);
      resizeObserver?.disconnect();
    };
  }, [updateScrollShadows]);

  return (
    <nav aria-label="Primary" className="relative flex min-h-0 flex-1">
      {/* A scroll boundary, not an elevated surface. These two hairlines were borrowing
          --shadow-raised purely for its 24px blur, using an overlay token as a gradient on a
          1px line that nothing sits above -- which is how "elevated" stopped meaning anything
          in particular. The rule appearing and disappearing is already the whole signal that
          the list continues past the edge. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-[var(--z-sticky)] h-px bg-[var(--line)]"
        hidden={!scrollShadows.top}
      />
      <SidebarContent
        className="gap-[var(--s-1)] overflow-y-auto px-[var(--s-2)] py-[var(--s-3)]"
        onScroll={updateScrollShadows}
        ref={scrollRef}
      >
        {nav.map((group, index) => (
          <NavigationGroup
            current={current}
            group={group}
            key={group.label || `group-${index}`}
            onContentResize={updateScrollShadows}
            onNavigate={onNavigate}
          />
        ))}
      </SidebarContent>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 z-[var(--z-sticky)] h-px bg-[var(--line)]"
        hidden={!scrollShadows.bottom}
      />
    </nav>
  );
}

function NavigationGroup({
  current,
  group,
  onContentResize,
  onNavigate,
}: {
  current: NavCurrent | null;
  group: NavGroup;
  onContentResize: () => void;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(true);
  const labelled = group.label.length > 0;

  useEffect(() => {
    onContentResize();
  }, [onContentResize, open]);

  const menu = (
    <SidebarGroupContent>
      <SidebarMenu>
        {group.items.map((item) => (
          <NavLink
            current={current}
            item={item}
            key={item.href}
            onNavigate={onNavigate}
          />
        ))}
      </SidebarMenu>
    </SidebarGroupContent>
  );

  if (!labelled) {
    return <SidebarGroup className="p-0">{menu}</SidebarGroup>;
  }

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <SidebarGroup className="p-0">
        <SidebarGroupLabel
          aria-expanded={open}
          // The eyebrow over a group, not a heading inside it: 10.5px of letterspaced uppercase at
          // the faint ink, so it separates the groups without ever being mistaken for a destination.
          className="h-[var(--d-group-row)] w-full justify-between rounded-[var(--r-control)] px-[var(--s-2)] text-[var(--faint)] transition-colors duration-[var(--duration-quick)] ease-[var(--ease-out)] motion-reduce:transition-none hover:bg-[var(--quiet)] hover:text-[var(--muted)] focus-visible:ring-[var(--focus-ring)]"
          data-nav-eyebrow
          onClick={() => setOpen((value) => !value)}
          render={<button type="button" />}
          style={{
            fontSize: "10.5px",
            fontWeight: 600,
            letterSpacing: "0.08em",
            lineHeight: "var(--t-over-lh)",
            textTransform: "uppercase",
          }}
        >
          <span>{group.label}</span>
          {open ? (
            <ChevronDown aria-hidden className="size-[var(--s-4)]" strokeWidth={1.75} />
          ) : (
            <ChevronRight aria-hidden className="size-[var(--s-4)]" strokeWidth={1.75} />
          )}
        </SidebarGroupLabel>
        <CollapsibleContent>{menu}</CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

/**
 * The palette listens for the shortcut on `window`, so the hint opens it by *being* the shortcut
 * rather than by holding a second copy of the palette's open state. That keeps the wordmark row
 * ignorant of which palette is mounted -- the topbar's search dialog and `CommandPalette` both
 * answer the same key.
 */
export function openCommandPalette() {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "k",
      metaKey: true,
    }),
  );
}

export function SidebarWordmark() {
  return (
    <div className="flex h-[var(--row-h-compact)] w-full items-center gap-[var(--s-2)]">
      <Link
        className="flex min-w-0 items-center px-[var(--s-2)] no-underline"
        href="/"
      >
        <span className="truncate text-[length:var(--t-section)] leading-[var(--t-section-lh)] font-semibold tracking-[-0.014em] text-[var(--ink)] group-data-[collapsible=icon]:sr-only">
          Setter<span className="text-[var(--accent-text)]">Fi</span>
        </span>
        <span
          aria-hidden
          className="hidden w-full text-center text-[length:var(--t-section)] leading-[var(--t-section-lh)] font-semibold tracking-[-0.014em] text-[var(--ink)] group-data-[collapsible=icon]:block"
        >
          S<span className="text-[var(--accent-text)]">F</span>
        </span>
      </Link>
      <button
        aria-label="Open command palette"
        className="ml-auto shrink-0 rounded-[var(--r-control)] border border-[var(--line)] bg-[var(--quiet)] px-[var(--s-1)] py-px font-mono text-[length:var(--t-mono-crumb)] leading-[var(--t-mono-crumb-lh)] text-[var(--faint)] transition-colors duration-[var(--duration-quick)] ease-[var(--ease-out)] motion-reduce:transition-none hover:border-[var(--line-strong)] hover:text-[var(--muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] group-data-[collapsible=icon]:hidden"
        data-slot="sidebar-command-hint"
        onClick={openCommandPalette}
        type="button"
      >
        <kbd className="font-mono">⌘K</kbd>
      </button>
    </div>
  );
}

/**
 * The one card allowed under the nav. Bordered rather than filled, because it has to read as a
 * note pinned to the rail and not as one more destination in it.
 */
function SidebarAttentionCard({ attention }: { attention: SidebarAttention }) {
  const body = (
    <>
      <span className="block text-[length:var(--t-mono-meta)] leading-[var(--t-section-title-lh)] font-semibold text-[var(--ink)]">
        {attention.title}
      </span>
      <span className="mt-[var(--s-1)] block text-[length:var(--t-mono-meta)] leading-[var(--t-mono-meta-lh)] text-[var(--muted)]">
        {attention.detail}
      </span>
    </>
  );

  return (
    <div
      className="rounded-[var(--r-card)] border border-[var(--line)] p-[var(--s-3)] group-data-[collapsible=icon]:hidden"
      data-slot="sidebar-attention"
    >
      {attention.href ? (
        <Link className="block no-underline" href={attention.href}>
          {body}
        </Link>
      ) : (
        body
      )}
    </div>
  );
}

/**
 * The rail's fleet card. Filled, where `SidebarAttentionCard` above is bordered.
 *
 * That card's docstring argues bordered-not-filled so it reads as a note pinned to the rail
 * rather than as one more destination, and the argument is sound for what it draws: a titled,
 * optionally-linked note, shaped like a nav row and sometimes clickable like one. **This card
 * resolves the same question the other way, and the canvas is why.** No nav row in this rail is
 * ever filled -- the active row takes a wash and a hairline (`app-shell.tsx` rail styles) -- so a
 * saturated ground is the one treatment in the rail that cannot be mistaken for a destination.
 * The fill is what marks it as not-a-nav, and it is also never a link, which the note may be.
 *
 * **The fill carries a fallback and that is load-bearing, not defensive noise.**
 * `--console-drench-live` is declared under `[data-shell-role="admin"]`, which the desktop rail
 * sits inside. The mobile rail does not: `MobileAppSidebar` renders into `SheetContent`, which
 * Radix portals to `document.body`, outside that subtree. An unresolved custom property drops its
 * whole declaration, so without the fallback this card would render with no background at all on
 * mobile -- near-white text on the sheet's pale ground, invisible, and silent. The literal is the
 * same gradient `console.css:72` declares; a fallback makes the reference safe, which is the
 * pattern `src/app/token-references.test.ts` exists to enforce.
 */
function SidebarFleetHealthCard({ fleet }: { fleet: SidebarFleetHealth }) {
  const total = fleet.live + fleet.registering + fleet.paused;
  // No fleet, no card. A rail card reading "0 agents" over an empty bar states nothing and still
  // occupies the footer on all twenty-four screens.
  if (total === 0) return null;

  // Order is the drawn order and it is also the order of goodness, which is what lets the bar be
  // read without a legend: working, waiting on somebody else, off.
  const segments = [
    { key: "live", count: fleet.live, tone: "good" },
    { key: "registering", count: fleet.registering, tone: "waiting" },
    { key: "paused", count: fleet.paused, tone: "warning" },
  ].filter((segment) => segment.count > 0);

  return (
    <div data-slot="sidebar-fleet-health">
      <div data-slot="sidebar-fleet-health-head">
        <span data-slot="sidebar-fleet-health-title">Platform health</span>
        <span className="mono" data-slot="sidebar-fleet-health-total">
          {`${total} ${total === 1 ? "agent" : "agents"}`}
        </span>
      </div>
      {/*
        Decorative, and `aria-hidden` for that reason: every fact in it is spelled out in the
        sentence underneath, so announcing three unlabelled bars would repeat the line badly
        rather than add to it. `flex-grow` is the count itself, so the bar is the proportion
        rather than a picture of one.
      */}
      <div aria-hidden data-slot="sidebar-fleet-health-bar">
        {segments.map((segment) => (
          <span
            data-fleet-tone={segment.tone}
            key={segment.key}
            style={{ flexGrow: segment.count }}
          />
        ))}
      </div>
      <div data-slot="sidebar-fleet-health-counts">
        {segments.map((segment) => `${segment.count} ${segment.key}`).join(" · ")}
      </div>
    </div>
  );
}

export function AppSidebar({ attention, fleet, ...props }: AppSidebarProps) {
  return (
    <Sidebar
      className="border-[var(--line)]"
      collapsible="icon"
    >
      <SidebarHeader className="h-[var(--topbar-h)] justify-center gap-0 border-b border-[var(--line)] px-[var(--s-2)] py-0">
        <SidebarWordmark />
      </SidebarHeader>
      <NavigationGroups {...props} />
      {attention || fleet ? (
        <SidebarFooter className="p-[var(--s-2)]">
          {attention ? <SidebarAttentionCard attention={attention} /> : null}
          {fleet ? <SidebarFleetHealthCard fleet={fleet} /> : null}
        </SidebarFooter>
      ) : null}
      <SidebarRail />
    </Sidebar>
  );
}

export function MobileAppSidebar({
  activePath,
  attention,
  fleet,
  nav,
  onOpenChange,
  open,
}: MobileAppSidebarProps) {
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeAtDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) onOpenChange(false);
    };

    if (desktop.matches) onOpenChange(false);
    desktop.addEventListener("change", closeAtDesktop);
    return () => desktop.removeEventListener("change", closeAtDesktop);
  }, [onOpenChange]);

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent
        className="w-[var(--sidebar-w)] gap-0 border-[var(--line)] bg-[var(--quiet)] p-0 shadow-[var(--shadow-drawer)] data-[side=left]:w-[var(--sidebar-w)] sm:max-w-[var(--sidebar-w)]"
        onKeyDown={keepFocusInside}
        showCloseButton={false}
        side="left"
      >
        <SheetHeader className="flex h-[var(--topbar-h)] flex-row items-center justify-between border-b border-[var(--line)] px-[var(--s-4)] py-0">
          <SheetTitle className="text-[length:var(--t-section)] font-semibold tracking-[-0.01em] text-[var(--ink)]">
            SetterFi
          </SheetTitle>
          <SheetDescription className="sr-only">Workspace navigation</SheetDescription>
          <button
            aria-label="Close navigation"
            autoFocus
            className="grid size-[var(--s-8)] place-items-center rounded-[var(--r-input)] text-[var(--muted)] hover:bg-[var(--row-hover)] hover:text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            <X aria-hidden className="size-[var(--s-4)]" strokeWidth={1.75} />
          </button>
        </SheetHeader>
        <NavigationGroups
          activePath={activePath}
          nav={nav}
          onNavigate={() => onOpenChange(false)}
        />
        {attention || fleet ? (
          <div className="flex flex-col gap-[var(--s-2)] border-t border-[var(--line)] p-[var(--s-3)]">
            {attention ? <SidebarAttentionCard attention={attention} /> : null}
            {fleet ? <SidebarFleetHealthCard fleet={fleet} /> : null}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
