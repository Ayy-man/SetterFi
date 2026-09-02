import { describe, expect, it } from "vitest";

import { recoveryLinks } from "@/lib/auth/recovery-links";

describe("recoveryLinks", () => {
  it("keeps the demo pair when no per-user session exists", () => {
    for (const mode of ["open", "password"] as const) {
      expect(recoveryLinks({ mode, role: null })[0]).toEqual({
        href: "/admin/overview",
        label: "Open admin overview",
      });
    }
  });

  it("sends a coach session to the coach dashboard, never the admin console", () => {
    for (const role of ["coach", "coach_member"] as const) {
      const [primary, ...rest] = recoveryLinks({ mode: "supabase", role });
      expect(primary).toEqual({ href: "/coach/home", label: "Back to Home" });
      expect(rest.every((link) => !link.href.startsWith("/admin"))).toBe(true);
    }
  });

  /*
   * The secondary link a coach is offered used to be /meet-agent, inherited from the demo pair
   * every role shared. A dead end is where somebody is already lost, and the sandbox is the one
   * screen in the product that cannot tell them where the page they wanted went; the inbox is
   * where their actual work is. NotFound.dc.html draws this pair.
   */
  it("offers a coach the inbox as the way on, not the agent sandbox", () => {
    for (const role of ["coach", "coach_member"] as const) {
      const links = recoveryLinks({ mode: "supabase", role });
      expect(links.map((link) => link.href)).toEqual(["/coach/home", "/coach/conversations"]);
      expect(links.some((link) => link.href === "/meet-agent")).toBe(false);
    }
  });

  it("sends every platform role to the admin overview", () => {
    for (const role of ["owner", "admin", "success", "build"] as const) {
      expect(recoveryLinks({ mode: "supabase", role })[0].href).toBe("/admin/overview");
    }
  });

  it("gives an affiliate one way back and no links it cannot open", () => {
    const links = recoveryLinks({ mode: "supabase", role: "affiliate" });
    expect(links).toEqual([{ href: "/affiliate", label: "Open affiliate overview" }]);
  });

  it("sends a signed-out visitor to login", () => {
    expect(recoveryLinks({ mode: "supabase", role: null })).toEqual([
      { href: "/login", label: "Go to sign in" },
    ]);
  });
});
