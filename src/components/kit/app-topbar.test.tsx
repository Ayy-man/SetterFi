import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { AppTopbar } from "@/components/kit/app-topbar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { WorkspaceEnvProvider } from "@/components/workspace/workspace-env";
import { demoViewTargets } from "@/lib/workspace-navigation";

const TOPBAR_PROPS = {
  activePath: "/coach/home",
  crumbs: [{ label: "Home" }],
  onOpenMobileNavigation: () => {},
} as const;

const COACH_NAV = [
  { label: "", items: [{ label: "Home", href: "/coach/home" }] },
] as const;

describe("the named account chip", () => {
  /*
   * Reported 2026-09-03 from a screenshot: the chip showed the initials and the chevron with
   * nothing between them. The trigger was a `size="icon"` Button, which is `size-8` -- a fixed
   * 32px square. The named variants override the height but a width they never set, so the
   * first name truncated to zero and the chevron was pressed against the initials. jsdom cannot
   * measure that, so this pins the cause: a chip with a name must not carry the square variant.
   */
  for (const role of ["coach", "admin"] as const) {
    it(`sizes the ${role} chip to its content once a first name is known`, () => {
      render(
        <WorkspaceEnvProvider
          account={{ fullName: "Dana Hart", firstName: "Dana", business: null }}
          demoAccountSwitching={false}
          demoViews={demoViewTargets}
          mode="supabase"
        >
          <SidebarProvider>
            <AppTopbar {...TOPBAR_PROPS} nav={COACH_NAV} role={role} />
          </SidebarProvider>
        </WorkspaceEnvProvider>,
      );
      const chip = screen.getByRole("button", { name: role === "coach" ? "Coach account" : "Admin account" });
      expect(chip.textContent).toContain("Dana");
      expect(chip.textContent).toContain("DH");
      expect(chip.className.split(/\s+/u)).not.toContain("size-8");
    });
  }

  it("keeps the square when nobody is named", () => {
    render(
      <SidebarProvider>
        <AppTopbar {...TOPBAR_PROPS} nav={COACH_NAV} role="coach" />
      </SidebarProvider>,
    );
    const chip = screen.getByRole("button", { name: "Coach account" });
    expect(chip.textContent).not.toContain("Dana");
    expect(chip.className.split(/\s+/u)).toContain("size-[46px]");
  });
});

/**
 * Which control the account chip is, per role.
 *
 * The owner console keeps the 520px account sheet: the same sections, over the page the reader is
 * already on, and it carries the terms registry and the operator runbooks that only a platform
 * operator may see. The coach gets a menu again -- `design/coach/AccountMenu.dc.html` settled that
 * shape after the sheet had shipped for both -- because a coach has five screens and a sheet with
 * sections in it is the console's answer to nineteen. The affiliate portal has no account artboard
 * of its own, so it keeps the dropdown it has always had.
 */
describe("the account chip", () => {
  function renderChip(role: "coach" | "admin" | "affiliate", name: string) {
    render(
      <WorkspaceEnvProvider
        account={{ fullName: "Dana Hart", firstName: "Dana", business: "Hart Credit" }}
        demoAccountSwitching={false}
        demoViews={demoViewTargets}
        mode="supabase"
      >
        <SidebarProvider>
          <AppTopbar {...TOPBAR_PROPS} nav={COACH_NAV} role={role} />
        </SidebarProvider>
      </WorkspaceEnvProvider>,
    );
    return screen.getByRole("button", { name });
  }

  it("opens the account menu for a coach", async () => {
    const user = userEvent.setup();
    const chip = renderChip("coach", "Coach account");
    // The chip is the same control the sheet had: same face, same name, same initials.
    expect(chip.textContent).toContain("Dana");
    expect(chip.textContent).toContain("DH");

    await user.click(chip);

    await waitFor(() => {
      expect(document.querySelector('[data-slot="dropdown-menu-content"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-slot="account-sheet"]')).toBeNull();
  });

  it("opens the account sheet for the owner console", async () => {
    const user = userEvent.setup();
    await user.click(renderChip("admin", "Admin account"));

    await waitFor(() => {
      expect(document.querySelector('[data-slot="account-sheet"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-slot="dropdown-menu-content"]')).toBeNull();
  });

  it("keeps the dropdown for the affiliate portal, which has no account panel", async () => {
    const user = userEvent.setup();
    await user.click(renderChip("affiliate", "Affiliate account"));

    await waitFor(() => {
      expect(document.querySelector('[data-slot="dropdown-menu-content"]')).not.toBeNull();
      expect(document.querySelector('[data-slot="account-sheet"]')).toBeNull();
    });
  });
});

/**
 * The coach's account menu, against `design/coach/AccountMenu.dc.html`.
 *
 * Three destinations in one block, an appearance control under a rule, and Sign out alone under
 * another. Counting the rows is what catches the console's list creeping back into it: the menu
 * had Help and Account security in it as well, which is five destinations for a five-screen app.
 */
describe("the coach account menu", () => {
  async function openCoachMenu(
    account = { fullName: "Dana Hart", firstName: "Dana", business: "Hart Credit" },
  ) {
    const user = userEvent.setup();
    render(
      <WorkspaceEnvProvider
        account={account}
        demoAccountSwitching={false}
        demoViews={demoViewTargets}
        mode="supabase"
      >
        <SidebarProvider>
          <AppTopbar {...TOPBAR_PROPS} nav={COACH_NAV} role="coach" />
        </SidebarProvider>
      </WorkspaceEnvProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Coach account" }));
    await waitFor(() => {
      expect(document.querySelector('[data-slot="dropdown-menu-content"]')).not.toBeNull();
    });
    return user;
  }

  it("offers exactly the artboard's three destinations, in its order", async () => {
    await openCoachMenu();

    const links = Array.from(document.querySelectorAll('[data-slot="dropdown-menu-content"] a'));
    expect(links.map((link) => link.textContent)).toEqual([
      "Tips and trainings",
      "Billing",
      "Settings",
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/coach/tips",
      "/coach/billing",
      "/coach/settings",
    ]);
  });

  /*
   * Help moved to the support bubble, which is on every coach page and is therefore a better entry
   * point than a row behind a chip. Account security is not on the artboard at all and still lives
   * at its own route. Both are named here rather than left to the count above, because a row
   * reappearing is the failure and the count alone would not say which one.
   */
  it("carries neither Help nor Account security", async () => {
    await openCoachMenu();

    const menu = document.querySelector('[data-slot="dropdown-menu-content"]') as HTMLElement;
    expect(menu.textContent).not.toContain("Help");
    expect(menu.textContent).not.toContain("Account security");
    expect(menu.textContent).toContain("Sign out");
  });

  /**
   * The appearance control is a segmented row, not three stacked menu rows, and every segment has
   * to beat `coach.css`'s 48px row styling with `!` to get there. A segment that silently reverted
   * to a row is the exact regression this catches, so the flagged classes are asserted rather than
   * the rendered geometry, which jsdom cannot measure.
   */
  it("draws appearance as one segmented control rather than three rows", async () => {
    await openCoachMenu();

    const menu = document.querySelector('[data-slot="dropdown-menu-content"]') as HTMLElement;
    expect(menu.textContent).toContain("Appearance");
    expect(menu.textContent).not.toContain("Theme");

    const segments = Array.from(
      menu.querySelectorAll('[data-slot="dropdown-menu-radio-item"]'),
    ) as HTMLElement[];
    expect(segments.map((segment) => segment.textContent)).toEqual(["Light", "Dark", "System"]);
    for (const segment of segments) {
      expect(segment.className).toContain("min-h-[44px]!");
      expect(segment.className).toContain("flex-1");
    }
    // One trough around all three, which is what makes it a segmented control and not a list.
    expect(segments[0]!.parentElement).toBe(segments[2]!.parentElement);
    expect(segments[0]!.parentElement!.className).toContain("bg-[var(--well)]");
  });

  /**
   * The console's menu is deliberately 13.5px on 30 to 34px targets for a team in it all day, and
   * `coach.css` is scoped to `[data-shell-role="coach"]` on a popup that Base UI portals to
   * `document.body`. Without the attribute none of the coach's floors reach the menu at all.
   */
  it("stamps the coach shell role onto the portalled menu", async () => {
    await openCoachMenu();

    const menu = document.querySelector('[data-slot="dropdown-menu-content"]') as HTMLElement;
    expect(menu.getAttribute("data-shell-role")).toBe("coach");
    expect(menu.className).toContain("coach-account-menu");
  });

  /**
   * The coach menu is the one place on the coach side a person reads their own full name, and the
   * console's answer to the seeders' marker is a "Demo" pill the coach shell does not have. Left
   * alone, "(demo)" would be the only demo signal on the screen and it would be inside the
   * account's own name. The console keeps the raw string, which is why this is asserted per role.
   */
  it("strips the seeders' marker from the coach's own name and workspace", async () => {
    await openCoachMenu({
      fullName: "Reid Calloway (demo)",
      firstName: "Reid",
      business: "Measurement Review Workspace (demo)",
    });

    const menu = document.querySelector('[data-slot="dropdown-menu-content"]') as HTMLElement;
    expect(menu.textContent).toContain("Reid Calloway");
    expect(menu.textContent).toContain("Measurement Review Workspace");
    expect(menu.textContent).not.toContain("(demo)");
  });
});
