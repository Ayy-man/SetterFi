import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { AppTopbar } from "@/components/kit/app-topbar";
import { SidebarProvider } from "@/components/ui/sidebar";

/**
 * The account menu is the one piece of coach chrome that renders outside the coach shell.
 *
 * `src/components/ui/dropdown-menu.tsx` wraps its content in `MenuPrimitive.Portal`, which mounts
 * to `document.body`, and every rule in `coach.css` is scoped to `[data-shell-role="coach"]` --
 * the attribute `AppShell` stamps on the shell root. So the coach's own menu was rendering at the
 * console's density: roughly a 192px column of 26px rows at 14px, on a surface whose floors are
 * 16px body text and a 44px target with no exceptions, next to an artboard
 * (`CoachAccountMenu.dc.html`) that draws a 340px panel of 48px rows at 17px.
 *
 * These tests assert the seam rather than the sizes: that the portalled popup carries the role
 * attribute the stylesheet needs and that the stylesheet has rules keyed to it. Neither half is
 * worth anything alone -- an attribute nothing styles is noise, and a rule nothing stamps is
 * dead -- and jsdom resolves no stylesheet, so a computed-size assertion here would measure the
 * empty string. The rendered sizes belong in `coach.smoke.spec.ts`, which has a real engine.
 */
const TOPBAR_PROPS = {
  activePath: "/coach/home",
  crumbs: [{ label: "Home" }],
  onOpenMobileNavigation: () => {},
} as const;

const COACH_NAV = [
  { label: "", items: [{ label: "Home", href: "/coach/home" }] },
] as const;

async function openAccountMenu(role: "admin" | "coach", name: string) {
  const user = userEvent.setup();
  // The topbar carries the console's mobile-nav trigger, which reads the sidebar context.
  render(
    <SidebarProvider>
      <AppTopbar {...TOPBAR_PROPS} nav={COACH_NAV} role={role} />
    </SidebarProvider>,
  );
  await user.click(screen.getByRole("button", { name }));

  let content: HTMLElement | null = null;
  await waitFor(() => {
    content = document.querySelector('[data-slot="dropdown-menu-content"]');
    expect(content, "the account menu did not open, so nothing below was checked").not.toBeNull();
  });
  return content as unknown as HTMLElement;
}

describe("the coach's account menu", () => {
  it("carries the shell role out through the portal, so coach.css can reach it", async () => {
    const content = await openAccountMenu("coach", "Coach account");

    expect(content.getAttribute("data-shell-role")).toBe("coach");
    expect(content.className).toContain("coach-account-menu");
    // The portal is the whole point: if this ever renders inside the shell root the attribute is
    // redundant, and if it stays outside it is the only thing that carries the scope.
    expect(content.closest("[data-shell-root]")).toBeNull();
  });

  /**
   * The console is deliberately the other density -- 13.5px on 30-34px targets, for the client's
   * own team who are in it all day -- so the fix above must not reach it. A single shared menu
   * styled to the coach's floors would be this fix's obvious failure mode.
   */
  it("leaves the owner console's menu at the console's density", async () => {
    const content = await openAccountMenu("admin", "Admin account");

    expect(content.getAttribute("data-shell-role")).toBeNull();
    expect(content.className).not.toContain("coach-account-menu");
  });

  /**
   * `CoachAccountMenu.dc.html:217-220` lists Billing in this menu while `:78` keeps the Billing
   * pill in the bar behind it. Drawing it twice is the point: the pill is not a substitute, and a
   * coach opening this menu is usually opening it because of the bill.
   *
   * Asserted as a link with an href rather than as text, because the failure mode this replaces
   * was not a missing word -- the label existed on the pill all along -- it was that no route out
   * of this menu reached the page.
   */
  it("reaches billing from the coach's menu, which the pill does not replace", async () => {
    const content = await openAccountMenu("coach", "Coach account");

    const billing = Array.from(content.querySelectorAll("a")).find(
      (link) => link.textContent?.trim() === "Billing",
    );
    expect(billing, "the coach's account menu has no Billing row").toBeDefined();
    expect(billing?.getAttribute("href")).toBe("/coach/billing");
  });

  /**
   * The other end of the same decision. `/admin/billing` exists, but the console reaches it from
   * its own rail and no admin artboard puts it in this menu, so the role map holds a null and the
   * row is not rendered. A row that appeared for every role would be the obvious failure mode of
   * the test above, in the same way the console-density test guards the one before it.
   */
  it("does not put billing in the console's menu, which has its own rail for it", async () => {
    const content = await openAccountMenu("admin", "Admin account");

    const labels = Array.from(content.querySelectorAll("a")).map(
      (link) => link.textContent?.trim(),
    );
    expect(labels).not.toContain("Billing");
  });

  it("has rules on the other end of the seam, keyed to the popup itself", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/app/(workspace)/coach/coach.css"),
      "utf8",
    );

    // Written against the element rather than as a descendant of it: the popup IS the scope root
    // once the attribute is stamped, so `[role] .class` would match nothing.
    expect(css).toContain('[data-shell-role="coach"].coach-account-menu');
    // The artboard's panel width and row height, which are what the console's defaults got wrong.
    expect(css).toMatch(/\.coach-account-menu\s*\{[^}]*width:\s*340px/u);
    expect(css).toMatch(/min-height:\s*48px/u);
  });
});
