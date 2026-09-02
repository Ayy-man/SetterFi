import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AppShell } from "@/components/kit/app-shell";
import { AffiliateMoney } from "@/components/workspace/live/affiliate-money";
import { loadPlatformActor } from "@/lib/auth/actors";
import { canAccessWorkspace, parseAppClaims } from "@/lib/auth/claims";
import { phase6AffiliatesLive } from "@/lib/env-contract";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Your referrals" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Partner" }, { label: "Your referrals" }] as const;
const TERMS_ENV_NAME = ["SETTERFI", "DEMO", "PLACEHOLDER", "AFFILIATE", "TERMS"].join("_");

function AffiliateShell({ enabled, termsCopy }: { enabled: boolean; termsCopy: string | null }) {
  return (
    <AppShell
      activePath="/affiliate"
      crumbs={CRUMBS}
      role="affiliate"
    >
      <AffiliateMoney enabled={enabled} termsCopy={termsCopy} />
    </AppShell>
  );
}

export default async function AffiliatePage() {
  if (!phase6AffiliatesLive()) return <AffiliateShell enabled={false} termsCopy={null} />;

  const actor = await loadPlatformActor();
  if (!actor) redirect("/login?next=%2Faffiliate");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) redirect("/login?next=%2Faffiliate");
  const claims = parseAppClaims(data.claims);
  /*
   * Gated on the `affiliates` row via `affiliate_access`, never on `role = 'affiliate'`. That is
   * T15-13, a decided rule, written up in `docs/ARCHITECTURE.md` (Security model, "The affiliate is
   * a capability, not a role value"):
   * `users.role` is single-valued and `users.email` is unique, so gating on the role forces a
   * coach who refers other coaches into a second account under a second email, while
   * `affiliates.user_id` attaches to the row they already have.
   *
   * Every layer behind this door now honours the same predicate, as of 2026-08-31:
   * `GET /api/affiliate/referrals` and the `affiliate-referrals` export both call
   * `canAccessWorkspace` with `affiliateAccess`, and `affiliate_payout_history_projection` selects
   * the caller by the `affiliates` row rather than the role
   * (`20261002000002_affiliate_payout_projection_capability_gate.sql`). Do not "fix" a future
   * disagreement by tightening here: this half is the decided behaviour, and matching it to a
   * stricter layer would make the product consistently violate T15-13.
   */
  if (claims.userId !== actor.userId || !canAccessWorkspace(actor.role, "affiliate", {
    affiliateAccess: claims.affiliateAccess,
  })) forbidden();

  const termsCopy = process.env[TERMS_ENV_NAME]?.trim() || null;
  return <AffiliateShell enabled termsCopy={termsCopy} />;
}
