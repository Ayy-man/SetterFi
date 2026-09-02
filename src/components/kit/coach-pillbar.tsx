"use client";

import Link from "next/link";

import {
  isWorkspaceNavItemActive,
  type WorkspaceNavGroup,
} from "@/lib/workspace-navigation";

/**
 * The coach surface's navigation: five destinations across the top, instead of a rail.
 *
 * A rail earns its width when there are seventeen places to go and somebody is in the product all
 * day, which is the owner console. A coach has five, opens the product a few times a week, and
 * told us in round-1 demo feedback that the console was confusing -- so the destinations sit in
 * one line where all five are visible at once and none of them is a decision.
 *
 * The four that used to be in the rail did not lose their route. Setup and Connections are on
 * Home's own card, where a coach is already looking when something needs doing; Notifications and
 * Help are in the account menu, on every page. `src/lib/workspace-navigation.test.ts` asserts each
 * of those entry points actually exists, which matters more than it sounds: commit f8d0381 added
 * two destinations to the rail precisely because their pages had become unreachable, so a
 * demotion that forgets to re-home is a regression with a name.
 *
 * The active pill is a solid fill rather than the console's wash. At this size a wash is genuinely
 * ambiguous about which destination you are on, which is the one question the bar exists to
 * answer.
 *
 * ---
 *
 * **On a phone the same bar is a bottom tab bar, and it is deliberately the same bar.**
 *
 * `CoachHomeMobile.dc.html` draws the five destinations pinned to the bottom edge at 390px, which
 * is where a thumb is, carrying the same counts and -- with one exception -- the same labels. The
 * exception is the first tab: the phone bar reads "Home" (`CoachHomeMobile.dc.html:160`) where all
 * eighteen desktop bars read "Overview". One nav item carries one label, so the desktop drawing
 * wins on the count of the evidence; `workspace-navigation.ts` argues that choice where the label
 * lives and `coach-nav-labels.test.ts` pins the phone's divergence so it stays visible. This
 * comment said "the same labels" flat, which was the drawing being asserted rather than read --
 * the same mistake the count's tone made two screens down, and the reason that one is now written
 * out in full at the badge. The obvious way to build the phone bar
 * is a second component with a second list of five links behind a media query, and it is the wrong
 * way: the list is derived from `nav`, so a second copy is a second thing that has to be kept in
 * step with `workspace-navigation.ts` -- and the failure mode is silent, because a stale copy still
 * renders five perfectly plausible links. It also puts two navigations in the accessibility tree,
 * so a screen-reader user is offered "Sections" twice and has to work out which one is real.
 *
 * So there is one `<nav>`, one `.map`, and a breakpoint. Everything below `sm` restyles the very
 * elements the desktop bar already rendered.
 *
 * **Why so many `!` utilities.** `coach.css` is imported unlayered by the coach route layout while
 * Tailwind's utilities live in `@layer utilities`, and an unlayered declaration beats a layered one
 * whatever their specificity says. `[data-shell-role="coach"] .coach-pillbar a` therefore wins over
 * a plain `max-sm:` utility for every property it sets -- display, gap, min-height, padding,
 * radius, colour, font-size, line-height. The `!` appears on exactly those properties and nowhere
 * else: a `max-sm:` utility for a property `coach.css` says nothing about (position, background,
 * border, grid) needs no help and does not get any. Keeping the marks that narrow is what makes
 * the diff readable if the desktop rules move -- anything with a `!` is answering a specific line
 * in `coach.css`.
 *
 * The phone bar is `fixed`, which is the only way the last child of `<main>` can sit on the bottom
 * edge from a component mounted at the top of `<main>`. That leaves the tail of a long page sitting
 * under the bar: `<main>` needs a bottom pad below `sm` and `app-shell.tsx` is not this component's
 * to edit, so it is reported rather than reached into.
 */
export function CoachPillbar({
  activePath,
  nav,
}: {
  activePath: string;
  nav: readonly WorkspaceNavGroup[];
}) {
  const items = nav.flatMap((group) => group.items);
  if (items.length === 0) return null;

  return (
    <nav
      aria-label="Sections"
      className={[
        "coach-pillbar",
        // The bottom bar's own frame. None of these properties is declared by `coach.css`, so
        // none of them needs `!`.
        "max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-30",
        "max-sm:border-t max-sm:border-[var(--line)] max-sm:bg-[var(--pane)]",
        // The safe-area pad is why the bottom padding is larger than the top: on a phone with a
        // home indicator the last 34px of the viewport are not reliably tappable, and a tab strip
        // flush to the edge puts Billing under the gesture bar.
        "max-sm:px-[6px] max-sm:pt-[6px] max-sm:pb-[calc(10px+env(safe-area-inset-bottom))]",
        // Five equal columns rather than the desktop bar's wrapping flex row: at 390px a wrapping
        // row puts Billing on a second line, and a tab bar that changes height as counts appear
        // and disappear is a tab bar that moves under the thumb.
        "max-sm:grid! max-sm:grid-cols-5 max-sm:gap-[2px]!",
      ].join(" ")}
    >
      {items.map((item) => {
        const current = isWorkspaceNavItemActive(item, activePath);
        return (
          <Link
            aria-current={current ? "page" : undefined}
            className={[
              // The border is on every tab, transparent until the tab is the current one, so the
              // active tab does not gain a pixel and shove its neighbours sideways.
              "max-sm:border max-sm:border-transparent",
              "max-sm:flex-col max-sm:justify-center max-sm:text-center",
              // 56px, above the surface's own 44px floor, because a tab bar is hit with a thumb
              // rather than a fingertip and it is the one control on the screen that is never
              // scrolled to.
              "max-sm:h-[56px] max-sm:min-h-[56px]!",
              "max-sm:gap-[3px]! max-sm:px-[4px]! max-sm:rounded-[12px]!",
              // 13px rather than the artboard's 12.5, and the reason is the reader: this surface
              // exists because coaches over 55 could not read the console, and half a pixel of
              // label width is a poor trade against that. The kit's icon doctrine says the nav is
              // text-only, so the label is the whole affordance and it gets the room the icon
              // would have taken.
              "max-sm:text-[13px]! max-sm:leading-[1.2]!",
              // The wash, not the desktop bar's solid fill. A filled 56px block at the bottom of a
              // phone screen reads as a button somebody pressed rather than as where you are, and
              // the accent is already spent once on this screen's hero panel.
              "max-sm:aria-[current=page]:border-[var(--accent-edge)]",
              "max-sm:aria-[current=page]:bg-[var(--accent-wash)]!",
              "max-sm:aria-[current=page]:text-[var(--accent-text)]!",
            ].join(" ")}
            href={item.href}
            key={item.href}
          >
            {item.label}
            {/*
              A count rides the pill only where the nav says the destination is a queue, which is
              the same rule the rail follows: a number beside Billing would read as unread mail
              rather than as work waiting. `withWorkspaceNavCounts` has already dropped zeroes, so
              a count that reaches here is always worth drawing.

              It stays after the label in the DOM at both sizes, so it is read as "Inbox 4" either
              way; the phone bar only changes which axis the pair stacks on.
            */}
            {typeof item.count === "number" ? (
              <span
                /*
                 * Amber at both sizes, because that is what the artboards draw.
                 *
                 * This carried a comment saying the desktop bar was neutral "which is what the
                 * artboards draw", with a test pinning the neutral pair and repeating the same
                 * claim. Both were wrong about the drawing: `Main.dc.html:74` gives the desktop
                 * Inbox count `rgba(184, 137, 78, 0.14)` on a `rgba(184, 137, 78, 0.26)` border in
                 * `--warning-text`, and `CoachHomeMobile.dc.html:165` gives the phone bar the same
                 * tone a shade stronger. The argument for neutral -- that the desktop count sits
                 * in a row the coach is already looking at -- is a reasonable one somebody could
                 * make, and it is not the one the canvas made.
                 *
                 * An amber zero would say a coach is behind when they are not, and cannot happen
                 * here: `withWorkspaceNavCounts` drops zeroes before a count reaches this bar, so
                 * every number drawn is work actually waiting. The phone keeps its own metrics --
                 * a 19px chip at 11.5px rather than 24px at 13px -- because the tab bar is
                 * shorter, not because the tone changes.
                 */
                className="rounded-[var(--r-full)] bg-[var(--warning-wash)] px-[var(--s-2)] font-[family-name:var(--font-mono)] text-[13px] leading-[20px] text-[color:var(--warning-text)] max-sm:px-[6px] max-sm:text-[12px] max-sm:leading-[18px]"
                data-coach-target="exempt"
              >
                {item.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
