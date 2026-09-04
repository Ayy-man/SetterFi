"use client";

import { ArrowRight, Bell, ChevronDown, CreditCard, Menu, Moon, Play, QuestionMark, Search, Settings, Sun, UserCircle } from "@/components/kit/icons";

import { AppBreadcrumbs, type Crumb } from "@/components/kit/breadcrumbs";
import { Button, buttonVariants } from "@/components/ui/button";
import { CoachPillbar } from "@/components/kit/coach-pillbar";
import { CommandPalette } from "@/components/kit/command-palette";
import type { WorkspaceNavGroup } from "@/lib/workspace-navigation";
import { usePaletteClientSearch } from "@/components/kit/palette-clients";
import type { UserRole } from "@/lib/auth/claims";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useIsomorphicLayoutEffect } from "@/components/ui/use-isomorphic-layout-effect";
import { runThemeTransition, watchThemeTransitionOrigin } from "@/components/kit/theme-transition";
import {
  applyTheme,
  readStoredPreference,
  resolveTheme,
  storeThemePreference,
  systemTheme,
  type ThemePreference,
  type WorkspaceTheme,
} from "@/lib/theme";
import Link from "next/link";
import dynamic from "next/dynamic";

import { displayName, displayText } from "@/lib/format/display-name";
import { cn } from "@/lib/utils";
import { useWorkspaceEnv } from "@/components/workspace/workspace-env";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

type AppTopbarProps = {
  role: "admin" | "coach" | "affiliate";
  crumbs: readonly Crumb[];
  actions?: ReactNode;
  onOpenMobileNavigation: () => void;
  activePath?: string;
  /**
   * The workspace's destinations, for the coach bar's pill group.
   *
   * Only the coach presentation reads it: every coach artboard draws the five pills *inside* the
   * 76px bar, centred between the lockup and the account chip, where the console draws a rail. The
   * shell already builds this list (counts applied), so the bar takes it rather than deriving a
   * second one -- a second derivation is a second thing to keep in step with
   * `workspace-navigation.ts`, and its failure mode is five plausible-looking wrong links.
   */
  nav?: readonly WorkspaceNavGroup[];
  /**
   * The signed-in platform role, for the palette's role gate. Absent -- an open or password
   * fixture, or a claims read that came back empty -- the palette falls back to the *least*
   * privileged role for this workspace, so an unresolved session never widens what the palette
   * offers. In the admin workspace that is `success`, which sees no money destinations.
   */
  platformRole?: UserRole;
};

/** Least privilege per workspace, for when the session's real role could not be read. */
const FALLBACK_PLATFORM_ROLE = {
  admin: "success",
  coach: "coach",
  affiliate: "affiliate",
} as const satisfies Record<AppTopbarProps["role"], UserRole>;

const ROLE_ACCOUNT_LABELS = {
  admin: "Admin account",
  coach: "Coach account",
  affiliate: "Affiliate account",
} as const;

/**
 * The fallback initials, for a session whose person we could not name.
 *
 * These are the role's initials, not anybody's: "CO" is not a coach called Colin. They shipped as
 * the *only* thing this button ever rendered, which is why every coach saw the same two letters --
 * see `initialsFor` below for where a real pair comes from now.
 */
const ROLE_INITIALS = {
  admin: "AD",
  coach: "CO",
  affiliate: "AF",
} as const;

/**
 * A person's initials from their display name: first letters of the first two whitespace tokens,
 * so "Marcus Reid" is MR and a single-token name is one letter rather than a padded pair.
 */
function initialsFor(fullName: string | null | undefined) {
  const tokens = (fullName ?? "").trim().split(/\s+/u).filter(Boolean).slice(0, 2);
  return tokens.map((token) => token[0]!.toUpperCase()).join("") || null;
}

/**
 * Where each role's notifications actually live -- the header bell and the account-menu item
 * both point here. Admin's /admin/settings is only a redirect to /admin/alerts, so both point at
 * the real page; the affiliate portal has no such surface, so both are hidden rather than inert.
 */
const ROLE_NOTIFICATION_SETTINGS_HREF = {
  admin: "/admin/alerts",
  coach: "/coach/settings",
  affiliate: null,
} as const;

/*
 * Help lost its rail slot when the coach nav was cut from nine destinations to five (only Home,
 * Inbox, Leads, Agent, and Billing kept a row). Get started, Connections, and Notifications
 * all survived that cut because they already had a persistent entry point elsewhere -- the coach
 * Home attention queue, or this same account menu. Help had none, so the account menu is where it
 * moves rather than going unreachable. Affiliate has no help surface of its own, so it stays null
 * and hidden, the same as the affiliate row above.
 */
const ROLE_HELP_HREF = {
  admin: "/admin/help",
  coach: "/coach/help",
  affiliate: null,
} as const;

/*
 * Tips and trainings, which the canvas puts in this menu and in the support bubble.
 *
 * `/coach/tips` is a real route that answered 200 with no rendered surface linking to it -- the
 * only referrer in the tree was the support bubble's default prop, and the bubble was not mounted
 * anywhere, so the page could only be reached by typing the URL. The bubble is mounted now, and
 * this is its second route in, the way Notifications has both the bell and a menu row. Admin and
 * affiliate have no trainings surface, so they stay null and the row is not rendered rather than
 * rendered inert.
 */
const ROLE_TIPS_HREF = {
  admin: null,
  coach: "/coach/tips",
  affiliate: null,
} as const;

/*
 * Billing, which the canvas puts in this menu *and* keeps as a pill.
 *
 * `CoachAccountMenu.dc.html:217-220` lists it between Tips and Settings while
 * `CoachAccountMenu.dc.html:78` still draws the Billing pill in the bar behind the open menu. It is
 * drawn twice on purpose, so the pill is not a substitute for the row -- a coach who opens this
 * menu is usually opening it *because* of the bill, and until now the menu was the one place they
 * could not reach it from.
 *
 * Coach only, and the two nulls are the reason this is a role map rather than a bare constant.
 * `/admin/billing` exists but the console reaches it from its own rail, and no admin artboard puts
 * it in this menu; the affiliate portal has no billing surface at all. A row rendered for a role
 * whose artboard does not draw it is the same defect as a row missing from the role whose artboard
 * does, so both stay null and the item is not rendered rather than rendered inert.
 */
const ROLE_BILLING_HREF = {
  admin: null,
  coach: "/coach/billing",
  affiliate: null,
} as const;

const THEME_CHOICES: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/*
 * The coach's appearance control: `AccountMenu.dc.html` draws a 12px well of 4px padding holding
 * three 44px segments, the live one washed and the other two bare.
 *
 * Every declaration carries `!`. `coach.css` styles a coach menu's radio items at
 * `[data-shell-role="coach"].coach-account-menu :where([data-slot="dropdown-menu-radio-item"])`,
 * which is two classes and outranks a bare Tailwind utility, so without the flag the segments
 * would silently render as the 48px stacked rows that rule is for. The stylesheet is frozen for
 * this rebuild and is right about a menu row; this is not a menu row.
 */
const APPEARANCE_TROUGH_CLASS =
  "mt-[4px] flex gap-[4px] rounded-[12px] border border-[var(--line)] bg-[var(--well)] p-[4px]";
const APPEARANCE_SEGMENT_CLASS =
  "min-h-[44px]! flex-1 justify-center rounded-[9px]! border border-transparent px-[10px]! "
  + "text-[16px]! font-medium! whitespace-nowrap "
  /* The kit hangs a check glyph off the right edge of a radio item. In a stacked list that is the
     state; in a segmented control the washed cell already is, and the glyph would sit on top of
     the next segment's label. */
  + "[&_[data-slot=dropdown-menu-radio-item-indicator]]:hidden";
const APPEARANCE_SEGMENT_ON_CLASS =
  "border-[var(--accent-edge)]! bg-[var(--accent-wash-strong)] text-[var(--ink)]! font-semibold!";
const APPEARANCE_SEGMENT_OFF_CLASS = "text-[var(--muted)]!";

/**
 * The three appearance choices, drawn as a segmented control for the coach and as the console's
 * stacked radio rows everywhere else.
 *
 * Split out of the menu body because the coach shape needs a wrapper element around the three
 * items and the console shape must not have one. The items stay `DropdownMenuRadioItem`s in both,
 * so the group keeps its roving focus, its arrow keys and its `aria-checked` either way -- the
 * wrapper is a box, not a new control.
 */
function ThemeChoices({
  isCoach,
  preference,
}: {
  isCoach: boolean;
  preference: ThemePreference;
}) {
  const items = THEME_CHOICES.map((choice) => (
    <DropdownMenuRadioItem
      className={
        isCoach
          ? cn(
            APPEARANCE_SEGMENT_CLASS,
            preference === choice.value
              ? APPEARANCE_SEGMENT_ON_CLASS
              : APPEARANCE_SEGMENT_OFF_CLASS,
          )
          : undefined
      }
      key={choice.value}
      value={choice.value}
    >
      {choice.label}
    </DropdownMenuRadioItem>
  ));
  if (!isCoach) return <>{items}</>;
  return <div className={APPEARANCE_TROUGH_CLASS}>{items}</div>;
}

/**
 * The account sheet, loaded only where it is rendered.
 *
 * A static import would put the sheet -- and with it the notification view models, the guide
 * catalogue and the Base UI dialog -- into the chunk every page of every role downloads, including
 * the affiliate portal, which never renders it. `next/dynamic` keeps it in its own chunk.
 */
const AccountSheet = dynamic(() =>
  import("@/components/workspace/rehaul/account-sheet").then((module) => module.AccountSheet));

function readRootTheme(): WorkspaceTheme {
  if (typeof document === "undefined") return "light";
  const explicitTheme =
    document.documentElement.dataset.workspaceTheme ??
    document.documentElement.dataset.theme;
  if (explicitTheme === "dark" || explicitTheme === "light") return explicitTheme;
  return "light";
}


/**
 * The mark in the coach lockup, drawn here rather than imported.
 *
 * `icons.tsx` carries the console's 16px glyph set; this is a 20px mark inside a 38px tile and it
 * is the only place it appears, so it is a local shape rather than a seventh export nothing else
 * uses. `aria-hidden` because the wordmark beside it is the readable half of the lockup.
 */
function AgentMark() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 24 24"
      width="20"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

export function AppTopbar({
  actions,
  activePath = "",
  crumbs,
  nav,
  onOpenMobileNavigation,
  platformRole,
  role,
}: AppTopbarProps) {
  /*
   * One component, two presentations, and deliberately not two components.
   *
   * `docs/REDESIGN-CANVAS.md` documents two densities on purpose: the coach side is 16px body with
   * a 44px floor and five destinations in a top pill bar, the owner console is 13.5px with 30-34px
   * targets and nineteen destinations in a 246px rail. The bar is where the two are furthest
   * apart -- 76px against 52px, a lockup against breadcrumbs, pills against nothing -- which is
   * exactly the pressure that makes a fork look cheap. What a fork costs is the theme handling, the
   * account menu, the notification href table and the palette gate, all duplicated and all free to
   * drift; the account menu alone is ninety lines that neither surface has ever wanted differently.
   */
  const isCoach = role === "coach";
  const [commandOpen, setCommandOpen] = useState(false);
  const [theme, setTheme] = useState<WorkspaceTheme>("light");
  // Null until the stored preference has been read after paint: applying a
  // "system" theme before then would overwrite what the boot script painted.
  const [preference, setPreference] = useState<ThemePreference | null>(null);
  const notificationSettingsHref = ROLE_NOTIFICATION_SETTINGS_HREF[role];
  const helpHref = ROLE_HELP_HREF[role];
  const tipsHref = ROLE_TIPS_HREF[role];
  const billingHref = ROLE_BILLING_HREF[role];
  const { account, mode } = useWorkspaceEnv();
  const [accountSheetOpen, setAccountSheetOpen] = useState(false);
  /*
   * The chip only becomes the artboard's named one when there is a name to put in it. With no
   * name -- the open and password fixtures, a failed read, a workspace opened by somebody whose
   * row we cannot see -- it stays the round initials button it has always been, rather than a chip
   * with a placeholder in it. A greeting addressed to the wrong person is worse than one addressed
   * to nobody, which is the same rule the support bubble's fallback follows.
   */
  const initials = initialsFor(account?.fullName) ?? ROLE_INITIALS[role];
  const searchClients = usePaletteClientSearch();

  useIsomorphicLayoutEffect(() => {
    const rootTheme = readRootTheme();
    setTheme(rootTheme);
    applyTheme(rootTheme);
  }, []);

  // The stored preference is only read after paint: the boot script in the root
  // layout has already painted from it, so reading it during render would be a
  // second source of truth and a hydration mismatch.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() =>
      setPreference(readStoredPreference()),
    );
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // "System" has to keep following the OS while the page is open.
  useEffect(() => {
    if (preference !== "system") return;
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => {
      const next = systemTheme();
      setTheme(next);
      applyTheme(next);
    };
    follow();
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [preference]);

  /*
   * The shortcut is bound only where the palette is mounted. `SIMPLIFICATION-SPEC.md` §2.10 marks
   * the command palette KILL on the coach side, and a listener that outlived the dialog would be
   * worse than the dialog was: it swallows the browser's own Cmd+K on every coach page and then
   * opens nothing.
   */
  useEffect(() => {
    if (isCoach) return;

    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isCoach]);

  useEffect(() => {
    watchThemeTransitionOrigin();
  }, []);

  /*
   * The chip's face and its contents, hoisted so the rehaul's sheet trigger and the dropdown's
   * trigger are literally the same control rather than two that have to be kept matching. Nothing
   * moved: every class string below is the one the trigger already carried, including the coach's
   * `data-[popup-open]` edge, which is inert on a plain button and is what draws the tether from
   * the chip to the popup when there is one.
   */
  const accountChipClassName = cn(
    "shrink-0 transition-none active:translate-y-0",
    account?.firstName
      ? isCoach
        ? "h-[46px] gap-[11px] rounded-[12px] border-[var(--line)] bg-[var(--well)] pr-[14px] pl-[8px]"
        : "h-[var(--s-8)] gap-[var(--s-2)] rounded-[var(--r-control)] px-[var(--s-2)]"
      : isCoach
        ? "size-[46px] rounded-[12px] border-[var(--line)] bg-[var(--well)]"
        : "size-[var(--s-8)] rounded-[var(--r-full)]",
    /*
      The open state, which `CoachAccountMenu.dc.html:196` draws and the chip did not have: the
      artboard's chip is mid-open with `border: 1px solid var(--accent-edge)` and its chevron in
      `--accent-text`, rotated 180 degrees.

      It matters more here than it would on a console control because Base UI renders no backdrop
      and the menu is portalled to `document.body`, so with the chip inert there is nothing at all
      on the page marking where the 340px panel came from -- the one artboard on the coach side
      that draws a scrim (`CoachAccountMenu.dc.html:194`) is drawing what we deliberately do not
      ship. The edge is the only remaining tether between the trigger and its popup.

      Base UI puts `data-popup-open` on the trigger, which is the same hook
      `data-table-column-header.tsx:62` and `admin-audit-log.tsx:1055` already press the same way.
      Coach only: the console's chip is 32px chrome a team lives in and has no artboard asking
      for this.
    */
    isCoach && "data-[popup-open]:border-[var(--accent-edge)]",
  );
  /*
    A named chip is a content-sized control, not a 32px square: `size="icon"` is `size-8`, which
    fixes the width and truncated the first name to nothing while the chevron squeezed against the
    initials (reported 2026-09-03). The unnamed fallback keeps the square it always had.
  */
  const accountChipSize = account?.firstName ? "default" : "icon";
  const accountChipContent = (
    <>
      <span
        className={cn(
          "tracking-normal",
          isCoach ? "font-[family-name:var(--font-mono)] text-[14px]" : "text-over",
          account?.firstName
            && (isCoach
              ? "inline-flex size-[32px] items-center justify-center rounded-[8px] border border-[var(--accent-edge)] bg-[var(--accent-wash)] text-[var(--accent-text)]"
              : "inline-flex size-[var(--s-6)] items-center justify-center rounded-[var(--r-full)] bg-[var(--band)]"),
        )}
      >
        {initials}
      </span>
      {account?.firstName ? (
        <>
          <span
            className={cn(
              "max-w-[calc(var(--s-12)*2)] truncate",
              isCoach ? "text-[16px] text-[var(--ink)]" : "text-body",
            )}
          >
            {account.firstName}
          </span>
          {/*
            `in-data-[popup-open]:` rather than a `group` on the trigger, because the trigger is a
            `render=` Button and adding a group class to it would change what every other role's
            chip matches. `in-*` compiles to `:where([data-popup-open]) .x`, which is an ancestor
            match at zero added specificity, and Tailwind emits it after the unvariant
            `text-[var(--faint)]` so the open colour wins on source order -- both checked against
            this repo's own compiler rather than assumed.
          */}
          <ChevronDown
            aria-hidden
            className={
              isCoach
                ? "size-[17px] text-[var(--faint)] transition-[rotate,color] duration-[var(--duration-quick)] ease-[var(--ease-out)] in-data-[popup-open]:rotate-180 in-data-[popup-open]:text-[var(--accent-text)] motion-reduce:transition-none"
                : undefined
            }
            strokeWidth={1.75}
          />
        </>
      ) : null}
    </>
  );

  function chooseTheme(next: ThemePreference) {
    setPreference(next);
    storeThemePreference(next);
    const resolved = resolveTheme(next);
    // The whole swap goes inside the transition, state included: the browser snapshots the page
    // after the callback runs, so anything applied outside it would already be painted in the
    // "before" picture and the circle would reveal a page that had not changed.
    runThemeTransition(() => {
      setTheme(resolved);
      applyTheme(resolved);
    });
  }

  return (
    <>
      <header
        className={cn(
          "sticky top-0 z-[var(--z-sticky)] flex h-[var(--topbar-h)] min-w-0 items-center border-b border-[var(--line)] px-[var(--s-4)] sm:px-[var(--s-6)] xl:px-[var(--page-x)]",
          // The coach bar sits on the pane it introduces rather than on the canvas behind the
          // rail, which is what the artboards draw and what the console has no equivalent of.
          // Its height comes from `--topbar-h`, which `coach.css` raises to 76px inside
          // `[data-shell-role="coach"]` -- the token stays 52px everywhere else.
          isCoach
            ? "gap-[var(--s-4)] bg-[var(--pane)] xl:gap-[32px]"
            : "gap-[var(--s-3)] bg-[var(--canvas)]",
        )}
      >
        {/*
          Neither navigation control exists on the coach surface, because neither thing it operates
          exists there: `AppShell` mounts no `AppSidebar` and no `MobileAppSidebar` for a coach --
          the five destinations are a pill bar under the header instead.

          Rendering them anyway left a hamburger that opened nothing and a collapse toggle for a
          rail that was not there, on every coach route. Sighted coaches saw two dead controls; a
          screen reader announced "Open navigation" and "Toggle sidebar" and then found no
          navigation to open, which is worse than either. The shell already decides this, so the
          header asks the same question rather than guessing from a breakpoint.
        */}
        {isCoach ? null : (
          <>
            <Button
              aria-label="Open navigation"
              className="transition-none active:translate-y-0 lg:hidden"
              onClick={onOpenMobileNavigation}
              size="icon"
              variant="ghost"
            >
              <Menu aria-hidden strokeWidth={1.75} />
            </Button>
            <SidebarTrigger
              aria-label="Toggle sidebar"
              className="hidden shrink-0 transition-none active:translate-y-0 lg:inline-flex"
            />
          </>
        )}

        {isCoach ? (
          <>
            {/*
              The lockup. A plain box rather than a link, because the artboards draw it as one and
              because the pill group two inches to its right already owns Home -- a mark that also
              navigated there would be a second, unlabelled route to a destination the bar is
              already showing the state of.

              The wordmark drops below `md`, where the bar has the mark, the account chip and no
              room for both names; the phone artboard keeps the mark, so the mark is what stays.
            */}
            <div className="flex flex-none items-center gap-[12px] lg:w-[250px]">
              <span className="grid size-[38px] flex-none place-items-center rounded-[10px] border border-[var(--accent-edge)] bg-[var(--accent-wash)] text-[var(--accent-text)]">
                <AgentMark />
              </span>
              <span className="hidden truncate text-[20px] leading-[1.2] font-semibold tracking-[-0.014em] text-[var(--ink)] md:inline">
                Your agent
              </span>
            </div>
            {/*
              The destinations, in the bar. They used to render as the first child of `<main>`,
              which put the navigation inside the page rather than around it and left the bar
              carrying breadcrumbs to a place the coach could already see.

              Between `sm` and `lg` the five pills are wider than the room between the two 250px
              end slots, so the group scrolls sideways rather than wrapping: this bar is a fixed
              76px and a wrapped second row would be clipped. Below `sm` the same nav is `fixed` to
              the bottom edge as the phone tab bar, so this box is empty there -- which is why the
              well it sits in is drawn by `.coach-pillbar` itself in `coach.css` and not by this
              wrapper, where it would have been a stray bordered rectangle on every phone.
            */}
            <div className="flex min-w-0 flex-1 justify-center overflow-x-auto">
              {nav ? <CoachPillbar activePath={activePath} nav={nav} /> : null}
            </div>
          </>
        ) : (
          <>
            <AppBreadcrumbs crumbs={crumbs} />
            <div className="min-w-[var(--s-2)] flex-1" />
          </>
        )}

        {/*
          `display: contents` on the console side, so the bar's own flex row is unchanged there.
          The coach side needs a real box: the pill group is centred by a `flex-1` between two end
          slots, and it is only actually centred while both slots are the same width.
        */}
        <div
          className={
            isCoach
              ? "flex flex-none items-center justify-end gap-[12px] lg:w-[250px]"
              : "contents"
          }
        >
        {actions ? (
          <div className="hidden items-center gap-[var(--s-2)] sm:flex">{actions}</div>
        ) : null}

        {/*
          KILL on the coach side, per `SIMPLIFICATION-SPEC.md` §2.10 and every coach artboard: a
          coach has five destinations, all of them visible in the bar, so a search box that offers
          to find them is offering to solve a problem the pill group already solved.
        */}
        {isCoach ? null : (
          <Button
            aria-keyshortcuts="Meta+K Control+K"
            aria-label="Search"
            className="hidden h-[var(--s-8)] w-[calc(var(--s-12)*4)] justify-start gap-[var(--s-2)] border-[var(--line)] bg-[var(--card)] px-[var(--s-2)] text-body text-[var(--faint)] transition-none hover:border-[var(--line-strong)] hover:bg-[var(--card)] hover:text-[var(--ink)] active:translate-y-0 sm:inline-flex xl:w-[calc(var(--s-10)*7)]"
            onClick={() => setCommandOpen(true)}
            variant="outline"
          >
            <Search aria-hidden strokeWidth={1.75} />
            <span>Search</span>
            <kbd className="ml-auto rounded-[var(--r-control)] border border-[var(--line)] bg-[var(--quiet)] px-[var(--s-1)] font-mono text-over text-[var(--faint)]">
              ⌘K
            </kbd>
          </Button>
        )}

        {notificationSettingsHref ? (
          // A real anchor wearing the button's clothes. Routing it through <Button render={<Link/>}>
          // makes Base UI either stamp type="button" on an <a> and log about it, or -- with
          // nativeButton={false} -- announce a navigation as role="button". The sidebar already
          // carries a "Notifications" link to this page, so the bell takes a distinct name rather
          // than giving a screen reader two identical entries.
          <Link
            aria-label="Open notifications"
            className={cn(
              buttonVariants({ size: "icon", variant: "outline" }),
              "hidden shrink-0 transition-none active:translate-y-0 sm:inline-flex",
              // 46px in a squared well on the coach bar, 32px round on the console's. The two
              // numbers are the two densities, not a preference: 44px is the coach surface's floor
              // with no exceptions, and the console runs 30-34px targets for a team in it all day.
              isCoach
                ? "size-[46px] rounded-[12px] border-[var(--line)] bg-[var(--well)] text-[var(--muted)]"
                : "size-[var(--s-8)]",
            )}
            href={notificationSettingsHref}
          >
            <Bell aria-hidden strokeWidth={1.75} />
          </Link>
        ) : null}

        {/*
          The account chip.

          The owner console opens the 520px account sheet, unchanged: the same sections, over the
          page the reader is already on, and it carries the account terms registry and the operator
          runbooks that only a platform operator may see.

          The coach opens a menu again, and that is a revision rather than a regression. The sheet
          was the coach's chip too until `design/coach/AccountMenu.dc.html` settled the shape: a
          340px panel of three destinations, an appearance control, and Sign out. A coach has five
          screens; a sheet with sections in it is the console's answer to nineteen. The sheet's
          coach variant stays reachable in its own right at `/account`, so nothing it holds became
          unreachable when the chip stopped opening it.

          Affiliate keeps the menu it has, with no artboard of its own to move it.

          The chip itself is the same control in all three cases -- same face, same contents, same
          accessible name -- because they share `accountChipClassName` and `accountChipContent`.
        */}
        {role === "admin" ? (
          <>
            <Button
              aria-label={ROLE_ACCOUNT_LABELS[role]}
              className={accountChipClassName}
              onClick={() => setAccountSheetOpen(true)}
              size={accountChipSize}
              variant="outline"
            >
              {accountChipContent}
            </Button>
            <AccountSheet
              onOpenChange={setAccountSheetOpen}
              open={accountSheetOpen}
              variant="owner"
            />
          </>
        ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={ROLE_ACCOUNT_LABELS[role]}
                className={accountChipClassName}
                size={accountChipSize}
                variant="outline"
              />
            }
          >
            {accountChipContent}
          </DropdownMenuTrigger>
          {/*
            The coach's menu is portalled out of the coach shell, so it is told which shell it
            belongs to.

            `DropdownMenuContent` renders through `MenuPrimitive.Portal`, which mounts to
            `document.body`. Every rule in `coach.css` is scoped to `[data-shell-role="coach"]`,
            which `AppShell` stamps on the shell root -- so none of them reached this popup, and a
            surface whose floors are 16px body and a 44px target was handing its coaches a 192px
            menu of 26px rows at 14px. Stamping the role onto the portalled content is what makes
            the existing scoped rules apply, rather than transcribing the same numbers into class
            strings here where the stylesheet cannot see them drift. The console's menu is
            deliberately 13.5px on 30-34px targets and takes neither the attribute nor the class,
            so it does not move.
          */}
          <DropdownMenuContent
            align="end"
            className={cn(
              "w-[calc(var(--s-12)*4)] rounded-[var(--r-card)] bg-[var(--raised)] shadow-[var(--shadow-raised)]",
              isCoach && "coach-account-menu",
            )}
            data-shell-role={isCoach ? "coach" : undefined}
          >
            <DropdownMenuGroup>
              {/*
                The person, then their business, then the role's generic label when neither is
                known. The generic label is still the button's accessible name in every case, so a
                screen reader always hears which account this menu belongs to even when the header
                is showing a person's name.
              */}
              {account?.fullName || account?.business ? (
                <DropdownMenuLabel
                  className={cn(
                    "flex",
                    isCoach ? "coach-account-menu__identity items-center" : "flex-col gap-[2px]",
                  )}
                >
                  {/*
                    The artboard heads the coach's menu with the same avatar tile the chip that
                    opened it carries, so the menu reads as that account's rather than as a loose
                    list of links. `aria-hidden` because the two lines beside it say the same
                    thing in words, and the trigger already carries the account's name.
                  */}
                  {isCoach ? (
                    <span aria-hidden="true" className="coach-account-menu__avatar">
                      {initials}
                    </span>
                  ) : null}
                  <span className="flex min-w-0 flex-col gap-[2px]">
                    {account.fullName ? (
                      <span
                        className={cn(
                          "truncate text-body text-[var(--ink)]",
                          isCoach && "coach-account-menu__name",
                        )}
                      >
                        {/*
                          The seeders staple "(demo)" onto every name they write, and the coach
                          menu is a place a person reads their own name. The console keeps the raw
                          string because the pill beside it is what says "demo" there; the coach
                          side has no such pill, so the marker would be the only demo signal on the
                          screen and it would be sitting inside the account's own name.
                        */}
                        {isCoach ? displayName(account.fullName) : account.fullName}
                      </span>
                    ) : null}
                    {account.business ? (
                      <span
                        className={cn(
                          "truncate text-[var(--t-badge)] text-[var(--muted)]",
                          isCoach && "coach-account-menu__business",
                        )}
                      >
                        {isCoach ? displayText(account.business) : account.business}
                      </span>
                    ) : null}
                  </span>
                </DropdownMenuLabel>
              ) : (
                <DropdownMenuLabel className="text-[var(--t-badge)] text-[var(--muted)]">
                  {ROLE_ACCOUNT_LABELS[role]}
                </DropdownMenuLabel>
              )}
              {tipsHref ? (
                <DropdownMenuItem render={<Link href={tipsHref} />}>
                  <Play aria-hidden strokeWidth={1.75} />
                  Tips and trainings
                </DropdownMenuItem>
              ) : null}
              {billingHref ? (
                <DropdownMenuItem render={<Link href={billingHref} />}>
                  <CreditCard aria-hidden strokeWidth={1.75} />
                  Billing
                </DropdownMenuItem>
              ) : null}
              {/*
                One row, two words, because the coach page it opens is no longer only about
                notifications. `AccountMenu.dc.html` names it Settings and `Notifications.dc.html`
                titles the page Settings, so the row and its destination now say the same word.
                Every other role still reads "Notification settings", which is what /admin/alerts
                is and all it is.
              */}
              {notificationSettingsHref ? (
                <DropdownMenuItem render={<Link href={notificationSettingsHref} />}>
                  <Settings aria-hidden strokeWidth={1.75} />
                  {isCoach ? "Settings" : "Notification settings"}
                </DropdownMenuItem>
              ) : null}
              {/*
                Help is the coach's one demoted row, and the support bubble took it: the bubble's
                "Read the guides" is on every coach page, which is a better entry point than a row
                behind a chip. Every other role that has a help surface still gets the row here.
              */}
              {helpHref && !isCoach ? (
                <DropdownMenuItem render={<Link href={helpHref} />}>
                  <QuestionMark aria-hidden strokeWidth={1.75} />
                  Help
                </DropdownMenuItem>
              ) : null}
              {/*
                Account security is not on the coach artboard, and leaving it in was the difference
                between a menu of three destinations and a menu of five. Password and session
                management still live at /account/security, reached from the account page itself.
              */}
              {isCoach ? null : mode === "supabase" ? (
                <DropdownMenuItem render={<Link href="/account/security" />}>
                  <UserCircle aria-hidden strokeWidth={1.75} />
                  Account security
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem disabled>
                  <UserCircle aria-hidden strokeWidth={1.75} />
                  Account security
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              className={isCoach ? "flex flex-col" : undefined}
              onValueChange={(value) => chooseTheme(value as ThemePreference)}
              value={preference ?? "system"}
            >
              {/*
                "Appearance" for the coach, "Theme" everywhere else, and the glyph goes with the
                word. The artboard labels the group by what it changes rather than by the name of
                the setting, and it draws no sun or moon beside it -- the three segments below
                already say which of them is on, so a glyph mirroring the resolved theme would be
                the same fact printed twice.
              */}
              <DropdownMenuLabel className="flex items-center gap-[var(--s-2)] text-[var(--t-badge)] text-[var(--muted)]">
                {isCoach ? null : theme === "dark" ? (
                  <Moon aria-hidden className="size-[var(--s-4)]" strokeWidth={1.75} />
                ) : (
                  <Sun aria-hidden className="size-[var(--s-4)]" strokeWidth={1.75} />
                )}
                {isCoach ? "Appearance" : "Theme"}
              </DropdownMenuLabel>
              {/*
                The coach's three choices are a segmented control rather than three stacked rows:
                one line that says which of three the surface is on, which is what
                `AccountMenu.dc.html` draws and what keeps a five-screen menu from spending three
                48px rows on a preference nobody opens the menu for.

                The trough is a plain wrapper and the segments are still `DropdownMenuRadioItem`s,
                so the group keeps its roving focus, its arrow keys and its `aria-checked`. Every
                declaration on the segments carries `!` because `coach.css` styles a coach menu's
                radio items as 48px rows at two-class specificity, which outranks a bare utility.
              */}
              <ThemeChoices isCoach={isCoach} preference={preference ?? "system"} />
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            {mode === "supabase" ? (
              <form action="/auth/signout?next=%2Flogin" method="post">
                {/*
                  `nativeButton` because this item really does render a `<button>`. Base UI's menu
                  item renders a `<div>` by default and synthesises the button behaviour it needs;
                  handed a real button through `render` without being told, it warns in the dev
                  overlay and applies both sets. The submit stays a submit, which is the whole point
                  of the form: sign-out is a POST, not a link.
                */}
                <DropdownMenuItem nativeButton render={<button className="w-full" type="submit" />}>
                  <ArrowRight aria-hidden strokeWidth={1.75} />
                  Sign out
                </DropdownMenuItem>
              </form>
            ) : (
              /* No session exists to end in the open and password modes, so the exit is a plain
                 link back to the view picker rather than a sign-out that would have nothing
                 to revoke. */
              <DropdownMenuItem render={<Link href="/" />}>
                <ArrowRight aria-hidden strokeWidth={1.75} />
                Switch view
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        )}
        </div>
      </header>

      {/*
        The kit's palette, not a second one. The topbar used to render its own CommandDialog over
        a flattened nav, which meant two palettes in the repo with different groupings, no role
        gate of their own, and no way to offer anything but a page. This one groups destinations,
        gates every row against the signed-in role, and takes a Clients source.
      */}
      {isCoach ? null : (
        <CommandPalette
          activePath={activePath}
          onOpenChange={setCommandOpen}
          open={commandOpen}
          role={platformRole ?? FALLBACK_PLATFORM_ROLE[role]}
          searchClients={searchClients}
        />
      )}
    </>
  );
}
