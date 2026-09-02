import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/kit/app-shell";
import {
  AdminAccountTerms,
  type AccountTermsVersionView,
} from "@/components/workspace/live/admin-account-terms";
import { loadAccountTermsRegistry } from "@/lib/account/terms-publisher";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { accountTermsLive } from "@/lib/env-contract";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Account terms" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Platform", href: "/admin/audit" }, { label: "Account terms" }] as const;

/**
 * Publishing the contract every coach signs is an owner or admin act, and the API refuses anyone
 * else, so the page refuses them here rather than rendering controls that 403.
 */
const PUBLISHING_ROLES = new Set(["owner", "admin"]);

function AccountTermsShell({ children }: { children: ReactNode }) {
  return (
    <AppShell activePath="/admin/account-terms" crumbs={CRUMBS} role="admin">
      {children}
    </AppShell>
  );
}

/**
 * Deliberately not gated on `accountTermsLive`. The flag arms acceptance at signup; a version has
 * to exist before that flag can be switched on, so the publisher stays reachable while it is off
 * and the screen states which of the two is true.
 */
export default async function AdminAccountTermsPage() {
  const supabase = await createSupabaseServerClient();
  const { data: claimData, error: claimError } = await supabase.auth.getClaims();
  if (claimError || !claimData?.claims) redirect("/login?next=%2Fadmin%2Faccount-terms");
  const claims = parseAppClaims(claimData.claims);
  if (!canAccessWorkspace(claims.role, "admin", { affiliateAccess: claims.affiliateAccess })) {
    const home = workspaceForRole(claims.role);
    redirect(home ? `/${home}` : "/login");
  }
  if (!claims.role || !PUBLISHING_ROLES.has(claims.role)) redirect("/admin/overview");

  let published: AccountTermsVersionView | null = null;
  let drafts: readonly AccountTermsVersionView[] = [];
  let readError: string | null = null;
  try {
    const registry = await loadAccountTermsRegistry();
    published = registry.published;
    drafts = registry.drafts;
  } catch {
    readError = "The account terms registry could not be read, so this page cannot say what is published.";
  }

  return (
    <AccountTermsShell>
      <AdminAccountTerms
        acceptanceLive={accountTermsLive()}
        drafts={drafts}
        published={published}
        readError={readError}
      />
    </AccountTermsShell>
  );
}
