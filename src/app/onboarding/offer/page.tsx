import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { OfferStep } from "@/components/onboarding/offer-step";
import { offerReview } from "@/components/onboarding/offer-view-models";
import { OnboardingStepShell, STEP_PANEL_CLASS } from "@/components/onboarding/step-shell";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { phase2Live, phase5Live } from "@/lib/env-contract";
import { createOfferLayerRepository } from "@/lib/repositories/offer-layer";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Your offer",
  description: "The four things your SetterFi agent needs to know about your business.",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

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

/** The one shape this route draws when it cannot read the offer: a sentence, in its place. */
function OfferAbsence({ body, title }: { body: string; title: string }) {
  return (
    <OnboardingStepShell
      eyeCopy="This step reads back the four things your agent knows about your business. You change all four from your agent screen."
      eyeScreen="onboarding-offer"
      lead="Your agent knows the industry already. These four answers are what make it yours."
      primary={null}
      stepKey="offer"
      width={980}
    >
      <section className={STEP_PANEL_CLASS}>
        <div className="px-[16px] py-[24px] sm:px-[20px]">
          <h2 className="m-0 text-[20px] leading-[1.2] font-[500] tracking-[-0.015em] text-[color:var(--ink)]">
            {title}
          </h2>
          <p className="m-0 mt-[10px] max-w-[56ch] text-[16px] leading-[1.55] text-[color:var(--muted)]">
            {body}
          </p>
        </div>
      </section>
    </OnboardingStepShell>
  );
}

export default async function OnboardingOfferPage() {
  if (!phase5Live() || !phase2Live()) {
    return (
      <OfferAbsence
        body="The offer layer is not enabled on this deployment, so there is nothing here to read back or change yet."
        title="Your offer is not enabled"
      />
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
      <OfferAbsence
        body="Your saved offer could not be read just now, so this page cannot say what your agent knows about your business. Nothing has changed."
        title="Your offer is unavailable"
      />
    );
  }

  return <OfferStep review={review} />;
}
