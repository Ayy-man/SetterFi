import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { DataState } from "@/components/kit/data-state";
import { offerReview } from "@/components/onboarding/offer-view-models";
import { OnboardingStage } from "@/components/onboarding/onboarding-stage";
import { SetupSteps } from "@/components/onboarding/setup-steps";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { OnboardingOfferRehaul } from "@/components/workspace/rehaul/onboarding-offer";
import { phase2Live, phase5Live } from "@/lib/env-contract";
import { createOfferLayerRepository } from "@/lib/repositories/offer-layer";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Tell us about your offer",
  description: "The four things your SetterFi agent needs to know about your business.",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

const TITLE = "Tell us about your offer";
const LEAD =
  "Four answers, and your agent knows your business. Everything else about how it talks to funding leads is already built and kept current for you.";

async function coachContext() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) redirect("/login?next=%2Fonboarding%2Foffer");
  const claims = parseAppClaims(data.claims);
  if (!canAccessWorkspace(claims.role, "coach", { affiliateAccess: claims.affiliateAccess })) {
    const home = workspaceForRole(claims.role);
    redirect(home ? `/${home}` : "/login");
  }
  if (!claims.tenantId) redirect("/login");
  return { tenantId: claims.tenantId };
}

export default async function OnboardingOfferPage() {
  if (!phase5Live() || !phase2Live()) {
    return (
      <OnboardingStage lead={LEAD} title={TITLE} width="wide">
        <DataState
          body="The offer layer is not enabled on this deployment, so there is nothing here to read back or change yet."
          kind="empty"
          title="Your offer is not enabled"
        />
      </OnboardingStage>
    );
  }

  const { tenantId } = await coachContext();
  const repository = createOfferLayerRepository();

  let review = null;
  try {
    /*
     * The published offer first, and the draft only when nothing is published. That order is the
     * honest one: the published row is what the agent is actually saying to leads, and a screen
     * that showed an unpublished draft as the current state would tell a coach their agent is
     * using words it has never seen. The read-back says which of the two it is looking at.
     */
    const [published, draft] = await Promise.all([
      repository.loadOffer({ status: "published", tenantId }),
      repository.loadOffer({ status: "draft", tenantId }),
    ]);
    review = published
      ? offerReview(published, "published")
      : offerReview(draft, draft ? "draft" : "none");
  } catch {
    review = null;
  }

  if (!review) {
    return (
      <OnboardingStage
        lead={LEAD}
        steps={<SetupSteps current="offer" />}
        title={TITLE}
        width="wide"
      >
        <DataState
          body="Your saved offer could not be read just now, so this page cannot say what your agent knows about your business. Nothing has changed."
          kind="empty"
          title="Your offer is unavailable"
        />
      </OnboardingStage>
    );
  }

  return <OnboardingOfferRehaul review={review} />;
}
