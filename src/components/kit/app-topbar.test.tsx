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
 * A coach and an owner get the 520px account sheet: the same sections, over the page the reader is
 * already on, rather than six separate routes out of it. The affiliate portal has no account
 * artboard of its own -- and the owner panel carries the terms registry and the operator runbooks,
 * which an affiliate must not be handed -- so it keeps the dropdown it has always had.
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

  it("opens the account sheet for a coach", async () => {
    const user = userEvent.setup();
    const chip = renderChip("coach", "Coach account");
    // The chip is the same control the dropdown had: same face, same name, same initials.
    expect(chip.textContent).toContain("Dana");
    expect(chip.textContent).toContain("DH");

    await user.click(chip);

    await waitFor(() => {
      expect(document.querySelector('[data-slot="account-sheet"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-slot="dropdown-menu-content"]')).toBeNull();
  });

  it("opens the account sheet for the owner console too", async () => {
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
    });
    expect(document.querySelector('[data-slot="account-sheet"]')).toBeNull();
  });
});
