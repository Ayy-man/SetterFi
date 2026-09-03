"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { UserRole } from "@/lib/auth/claims";
import type { EnvironmentSource } from "@/lib/env-contract";
import {
  demoReviewPersonas,
  demoViewTargets,
  publishNavigationEnvironment,
  type WorkspaceRole,
} from "@/lib/workspace-navigation";

export type DemoViewTarget = (typeof demoViewTargets)[number];
export type DemoReviewPersona = (typeof demoReviewPersonas)[number];
export type WorkspaceAuthMode = "open" | "password" | "supabase";

type WorkspaceEnv = {
  mode: WorkspaceAuthMode;
  demoViews: readonly DemoViewTarget[];
  demoAccountSwitching: boolean;
  /**
   * The signed-in platform role, when the server layout has resolved one. The shell reads it to
   * drop nav items this role's own page guard would refuse. Undefined means "not known", which
   * renders the full nav -- the same thing every shell rendered before this existed.
   */
  platformRole?: UserRole;
  /**
   * The signed-in person's display name and their business, when the server layout resolved them.
   * Display only -- the topbar's account chip and the coach support bubble read it and nothing
   * else does. Undefined means "not known", which is what every surface rendered before this
   * existed and what they still render outside `supabase` mode.
   */
  account?: WorkspaceAccount;
};

export type WorkspaceAccount = {
  /** "Marcus Reid", for the account menu's header. Null when the column is unset or blank. */
  fullName: string | null;
  /** "Marcus", for the trigger chip and the support bubble's greeting. */
  firstName: string | null;
  /** The tenant's own name, for the line under the person's. */
  business: string | null;
  /**
   * Whether this is a seeded account: `tenants.is_demo`, and false where there is no tenant.
   *
   * Display only, and specifically so that a surface which strips the seeders' "(demo)" marker out
   * of a name has something true to put in its place. `lib/format/display-name.ts` is explicit
   * that the marker may only be dropped where the demo state is shown some other way, and the
   * pill that shows it needs a flag rather than the text it just removed.
   */
  isDemo?: boolean;
};

// The default is today's behaviour exactly, so a shell mounted outside the provider
// (a test, a future mount that forgets the layout) renders what it renders now.
const WorkspaceEnvContext = createContext<WorkspaceEnv>({
  mode: "open",
  demoViews: demoViewTargets,
  demoAccountSwitching: false,
});

export function WorkspaceEnvProvider({
  account,
  mode,
  demoViews,
  demoAccountSwitching,
  platformRole,
  navEnvironment,
  children,
}: WorkspaceEnv & { navEnvironment?: EnvironmentSource; children: ReactNode }) {
  // Published during render, before any descendant shell renders and asks for
  // its nav. Idempotent, so a re-render or a Strict Mode double-invoke is a
  // no-op rather than a state change.
  if (navEnvironment) publishNavigationEnvironment(navEnvironment);

  return (
    <WorkspaceEnvContext.Provider
      value={{ account, mode, demoViews, demoAccountSwitching, platformRole }}
    >
      {children}
    </WorkspaceEnvContext.Provider>
  );
}

export function useWorkspaceEnv() {
  return useContext(WorkspaceEnvContext);
}

/**
 * Under real auth, render only the demo views this session can actually open.
 *
 * The two cross-role workspace entries are refused, though not where the original
 * report guessed: decideRoute allows an admin into /coach/home, because
 * canAccessWorkspace deliberately lets platform staff into the coach portal. The
 * refusal is the tenant check at src/app/(workspace)/coach/home/page.tsx:62, which
 * redirects a tenant-less admin straight back to /admin/platform-clients. /consumer
 * stays because it is a public prefix any session opens, and /onboarding stays
 * because decideRoute matches only /(admin|coach|affiliate), so no workspace segment
 * claims it. The real cross-role mechanism is impersonation, a deliberate audited
 * action behind /api/platform/impersonation/start. This list is not it, and it
 * should not pretend to be.
 *
 * Under "open" and "password" these are the fixture identities the demo views were
 * written for, and navigating between them genuinely is a role switch, so nothing
 * is filtered.
 */
export function demoViewsForSession(
  targets: readonly DemoViewTarget[],
  mode: WorkspaceAuthMode,
  role: WorkspaceRole,
): readonly DemoViewTarget[] {
  if (mode !== "supabase") return targets;

  return targets.filter(
    (target) => target.id === role || target.id === "consumer" || target.id === "onboarding",
  );
}
