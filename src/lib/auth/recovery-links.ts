/**
 * Where a dead-end page sends someone back to. The 404 offered "Open admin
 * overview" to everyone, so a coach who mistyped a URL was handed a link the
 * proxy would immediately bounce -- a second dead end, and a leak of which
 * surfaces exist above their role. Recovery is a function of the session, so it
 * lives here as a pure map and is unit-tested rather than inlined in the page.
 */

import { workspaceForRole, type UserRole } from "@/lib/auth/claims";

export type RecoveryLink = { href: string; label: string };

export type RecoverySession = {
  /** The gate guarding this deployment, from `authMode()`. */
  mode: "open" | "password" | "supabase";
  /** The session's role under real auth; null when signed out or unknown. */
  role: UserRole | null;
};

/**
 * The links a route-unavailable page should offer. The first is the primary
 * action; the rest are secondary. Never empty.
 *
 * Outside `supabase` mode there is no per-user session to read, so every view
 * is genuinely open and the historical demo pair stays -- inventing a
 * role-specific link there would be a guess dressed as knowledge.
 */
export function recoveryLinks(session: RecoverySession): [RecoveryLink, ...RecoveryLink[]] {
  const agent: RecoveryLink = { href: "/meet-agent", label: "Test the agent" };

  if (session.mode !== "supabase") {
    return [{ href: "/admin/overview", label: "Open admin overview" }, agent];
  }

  switch (workspaceForRole(session.role)) {
    case "admin":
      return [{ href: "/admin/overview", label: "Open admin overview" }, agent];
    case "coach":
      /*
       * A coach's second way out is their inbox, not the agent sandbox. `/meet-agent` was here
       * because it was the historical demo pair for every role, and handing a coach who mistyped
       * a URL a link into a test harness offers them the one screen on the product that cannot
       * help them find the page they were looking for. `NotFound.dc.html` draws these two.
       *
       * "Back to Home" rather than the artboard's "Back to Overview": the artboard's coach nav
       * calls the first destination Overview and the shipped nav calls it Home
       * (`workspace-navigation.test.ts` pins the label), and a link should name its destination
       * the way the destination names itself. The word moves the day the nav item does.
       */
      return [
        { href: "/coach/home", label: "Back to Home" },
        { href: "/coach/conversations", label: "Go to your inbox" },
      ];
    case "affiliate":
      // Affiliates never reach /meet-agent, so a second link would only be
      // another bounce. One honest way back.
      return [{ href: "/affiliate", label: "Open affiliate overview" }];
    default:
      return [{ href: "/login", label: "Go to sign in" }];
  }
}
