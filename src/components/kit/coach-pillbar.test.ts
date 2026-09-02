import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { CoachPillbar } from "@/components/kit/coach-pillbar";
import { workspaceNavigationFor } from "@/lib/workspace-navigation";

const LIVE = { SETTERFI_PHASE5_LIVE: "true", SETTERFI_PHASE6_LIVE: "true" };

function anchorTags(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*>/g)].map((match) => match[0]);
}

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

/*
 * CoachPillbar takes no hrefs of its own -- it flattens whatever `nav` group it is handed and
 * renders a link per item, so grepping its source for a route proves nothing about what actually
 * reaches the page. This renders it with the real coach nav config instead, the same way the
 * coach route layout does, and reads the anchors back out of the markup: that is the only place
 * the nine-to-five cut and the four demoted hrefs' absence from the pill bar can be checked for
 * real, rather than asserted by source text. workspace-navigation.test.ts owns the complementary
 * half of the same guarantee -- that each demoted href still has a real entry point somewhere
 * outside the pill bar.
 */
describe("coach pillbar", () => {
  it("renders exactly the five surviving coach destinations and none of the four demoted ones", () => {
    const nav = workspaceNavigationFor("coach", LIVE);
    const html = renderToStaticMarkup(
      createElement(CoachPillbar, { activePath: "/coach/home", nav }),
    );
    const tags = anchorTags(html);

    expect(tags.map((tag) => attr(tag, "href"))).toEqual([
      "/coach/home",
      "/coach/conversations",
      "/coach/contacts",
      "/coach/agent",
      "/coach/billing",
    ]);

    const demoted = ["/coach/get-started", "/coach/integrations", "/coach/settings", "/coach/help"];
    for (const href of demoted) {
      expect(tags.map((tag) => attr(tag, "href")), href).not.toContain(href);
    }
  });

  it("marks the active destination current and leaves the rest untouched", () => {
    const nav = workspaceNavigationFor("coach", LIVE);
    const html = renderToStaticMarkup(
      createElement(CoachPillbar, { activePath: "/coach/conversations/thread-1", nav }),
    );
    const tags = anchorTags(html);
    const inbox = tags.find((tag) => attr(tag, "href") === "/coach/conversations");
    const home = tags.find((tag) => attr(tag, "href") === "/coach/home");

    expect(attr(inbox!, "aria-current")).toBe("page");
    expect(attr(home!, "aria-current")).toBeUndefined();
  });
});

/**
 * The phone tab bar, and specifically that it is the *same* bar.
 *
 * `CoachHomeMobile.dc.html` pins the five destinations to the bottom edge at 390px. The cheap way
 * to build that is a second component holding a second list of five links behind a media query,
 * and these tests exist to make that cheap way fail loudly. A stale duplicate renders five
 * perfectly plausible links, so nothing looks wrong until a destination moves in
 * `workspace-navigation.ts` and only one of the two lists follows it; and two `<nav>` elements put
 * "Sections" into the accessibility tree twice, leaving a screen-reader user to work out which of
 * the two is the real one.
 *
 * So the assertions are about identity rather than appearance: one `<nav>`, five anchors, and the
 * phone treatment carried on those same five anchors rather than on a set of their own.
 */
describe("coach pillbar at phone width", () => {
  it("keeps one navigation and one set of links, restyled rather than duplicated", () => {
    const nav = workspaceNavigationFor("coach", LIVE);
    const html = renderToStaticMarkup(
      createElement(CoachPillbar, { activePath: "/coach/home", nav }),
    );

    expect(html.match(/<nav\b/g)).toHaveLength(1);

    const tags = anchorTags(html);
    // Positive control: the bar really rendered its five destinations, so the single-nav claim
    // above is about a bar that exists rather than about a component that returned nothing.
    expect(tags).toHaveLength(5);

    const navTag = html.match(/<nav\b[^>]*>/)![0];
    expect(attr(navTag, "class")).toContain("max-sm:fixed");
    expect(attr(navTag, "class")).toContain("max-sm:grid-cols-5");

    for (const tag of tags) {
      // 56px, above this surface's own 44px floor, on every tab and not just the current one.
      expect(attr(tag, "class"), attr(tag, "href")).toContain("max-sm:h-[56px]");
    }
  });

  it("carries the same queue counts into the phone bar as into the desktop pills", () => {
    const nav = [{
      label: "",
      items: [
        { label: "Home", href: "/coach/home" },
        { label: "Inbox", href: "/coach/conversations", queue: true as const, count: 4 },
        { label: "Billing", href: "/coach/billing" },
      ],
    }];
    const html = renderToStaticMarkup(
      createElement(CoachPillbar, { activePath: "/coach/home", nav }),
    );

    // The count is a child of the Inbox anchor, so there is exactly one number and both widths
    // read it from the same element. A phone bar with its own badge markup would show up here as
    // a second "4".
    expect(html.match(/>4</g)).toHaveLength(1);
    const inbox = html.slice(html.indexOf('href="/coach/conversations"'));
    expect(inbox.slice(0, inbox.indexOf("</a>"))).toContain(">4<");
    // Billing is not a queue, so it carries no number at either width.
    const billing = html.slice(html.indexOf('href="/coach/billing"'));
    expect(billing.slice(0, billing.indexOf("</a>"))).not.toMatch(/\d/);
  });

  /*
   * The queue count is amber at both sizes, and this test used to pin the opposite.
   *
   * It asserted the unprefixed pair was `--band`/`--body` and explained that the desktop count
   * sits in a row the coach is already looking at, so amber on both would spend a tone where
   * nothing needed pointing at. That reasoning is defensible; it is just not what the canvas
   * drew. `Main.dc.html:74` renders the desktop Inbox count on `rgba(184, 137, 78, 0.14)` with a
   * `rgba(184, 137, 78, 0.26)` border in `--warning-text`, and `CoachHomeMobile.dc.html:165` uses
   * the same tone slightly stronger. The component's comment made the same false citation, so the
   * claim was stated twice and checked never -- the guard was holding the defect in place while
   * reading as coverage, which is the same shape as the landing page's drench test.
   *
   * Asserting the tone rather than the absence of a tone is what makes this catch a revert: going
   * back to `--band` fails on the positive assertion instead of quietly satisfying a negative one.
   */
  it("gives the queue count the artboard's warning tone at both sizes", () => {
    const nav = [{
      label: "",
      items: [{ label: "Inbox", href: "/coach/conversations", queue: true as const, count: 4 }],
    }];
    const html = renderToStaticMarkup(
      createElement(CoachPillbar, { activePath: "/coach/home", nav }),
    );
    const count = html.slice(html.indexOf("<span"), html.indexOf("</span>"));

    expect(count).toContain("bg-[var(--warning-wash)]");
    expect(count).toContain("text-[color:var(--warning-text)]");
    // And the neutral pair it used to carry is gone, at both sizes rather than only unprefixed.
    expect(count).not.toContain("var(--band)");
    expect(count).not.toContain("text-[color:var(--body)]");
    // The phone keeps its own metrics, which is the only thing that changes below `sm`.
    expect(count).toContain("max-sm:text-[12px]");
  });
});

/*
 * The bar the pills now sit in, read off `coach.css`.
 *
 * The pill group moved out of `<main>` and into the top bar, which is where all seven coach
 * artboards draw it. Two of the three things that makes true are stylesheet rules rather than
 * markup, so this is where they can be checked: the bar's own 76px height, and the bordered well
 * the group sits in.
 *
 * The media query is the load-bearing part and is the one a later reader would most plausibly
 * simplify away. Below `sm` the very same `<nav>` is the phone tab bar -- `fixed` to the bottom
 * edge, with its own top hairline and its own `--pane` ground written as plain Tailwind utilities.
 * `coach.css` is imported unlayered, so an unconditional `border` on `.coach-pillbar` beats
 * `max-sm:border-t` and draws a pill-shaped outline around the phone's tab strip.
 */
describe("the coach top bar, in coach.css", () => {
  const COACH_CSS = readFileSync(
    resolve(process.cwd(), "src/app/(workspace)/coach/coach.css"),
    "utf8",
  );

  it("raises the shared topbar token to 76px inside the coach scope only", () => {
    const scope = COACH_CSS.slice(
      COACH_CSS.indexOf('[data-shell-role="coach"] {'),
      COACH_CSS.indexOf("}", COACH_CSS.indexOf('[data-shell-role="coach"] {')),
    );
    // The positive control: the block really is the coach root block, so the assertion below is
    // about a scope that exists rather than about an empty slice.
    expect(scope).toContain("--coach-body: 16px");
    expect(scope).toMatch(/--topbar-h:\s*76px/u);
  });

  it("gives the group its bordered well above the phone breakpoint and not below it", () => {
    const start = COACH_CSS.indexOf("@media (min-width: 640px) {");
    expect(start, "the desktop-only block was not found, so nothing below was checked")
      .toBeGreaterThan(-1);
    const block = COACH_CSS.slice(start, COACH_CSS.indexOf("\n}\n", start));

    expect(block).toContain(".coach-pillbar {");
    expect(block).toContain("border: 1px solid var(--line)");
    expect(block).toContain("background: var(--well)");

    // And nowhere outside it: an unconditional border here is the phone-bar regression.
    const unconditional = COACH_CSS.slice(
      COACH_CSS.indexOf('[data-shell-role="coach"] .coach-pillbar {'),
      COACH_CSS.indexOf("}", COACH_CSS.indexOf('[data-shell-role="coach"] .coach-pillbar {')),
    );
    expect(unconditional).toContain("display: flex");
    expect(unconditional).not.toContain("border");
    expect(unconditional).not.toContain("background");
  });
});
