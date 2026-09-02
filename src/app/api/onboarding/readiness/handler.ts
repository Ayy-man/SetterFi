import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { phase5Live, phase6StripeLive } from "@/lib/env-contract";
import { createPhase6SubscriptionReadinessPort } from "@/lib/billing/onboarding-port";
import type { OfferReadinessPort, ReadinessResult } from "@/lib/onboarding/contracts";
import {
  createDemoSubscriptionReadinessPort,
  createLiveReadinessRepository,
  evaluateReadiness,
} from "@/lib/onboarding/readiness";
import {
  loadOfferReviewReadiness,
  type OfferReviewReadiness,
} from "@/lib/repositories/offer-review";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };

type ReadinessDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  evaluate(tenantId: string): Promise<ReadinessResult>;
};

export function createReadinessHandler(dependencies: ReadinessDependencies) {
  return async function GET() {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    const actor = await dependencies.session();
    if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
    if (hasImpersonationMarker(actor)) return Response.json({ error: "Impersonated sessions are read-only." }, { status: 403, headers: NO_STORE });
    try {
      return Response.json({ readiness: await dependencies.evaluate(actor.tenantId) }, { headers: NO_STORE });
    } catch (cause) {
      console.error(
        "/api/onboarding/readiness failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json({ error: "Readiness could not be evaluated." }, { status: 503, headers: NO_STORE });
    }
  };
}

type OfferReadinessDependencies = {
  loadTenantDemo(tenantId: string): Promise<boolean>;
  loadReview(tenantId: string): Promise<OfferReviewReadiness>;
};

export function createOfferReadinessPort(dependencies: OfferReadinessDependencies): OfferReadinessPort {
  return async (tenantId) => {
    const [isDemo, review] = await Promise.all([
      dependencies.loadTenantDemo(tenantId),
      dependencies.loadReview(tenantId),
    ]);
    return {
      published: Boolean(review.offer),
      programName: review.offer?.programName ?? null,
      bookingMode: review.offer?.bookingMode ?? null,
      // The seeded demo path remains intentionally synthetic. Real offers only clear from the
      // version-and-hash-bound authority; both an unreviewed and rejected offer stay held.
      reviewState: isDemo ? "clear" : review.status === "clear" ? "clear"
        : review.status === "unavailable" ? "unavailable" : "held",
      // A real clear is evidence at the review timestamp, not at offer publication. It is a
      // durable, version-bound decision, so publication changes—not an arbitrary short timer—
      // invalidate it; the go-live RPC rechecks the exact revision transactionally.
      evidenceAt: isDemo ? review.offer?.updatedAt ?? null : review.evidenceAt,
    };
  };
}

async function loadTenantDemo(tenantId: string) {
  const client = createSupabaseServiceClient();
  const { data: tenant, error: tenantError } = await client
    .from("tenants").select("is_demo").eq("id", tenantId).maybeSingle();
  if (tenantError || !tenant) throw new Error("OFFER_READINESS_TENANT_READ_FAILED");
  return tenant.is_demo;
}

export const loadOfferReadiness = createOfferReadinessPort({
  loadTenantDemo,
  loadReview: loadOfferReviewReadiness,
});

/**
 * The single source of readiness evidence.
 *
 * Reporting readiness and committing go-live must judge a tenant on identical evidence. They did
 * not: this route installed the real Phase 6 port while the go-live POST installed only the demo
 * one, so a paid coach whose subscription had genuinely cleared read "ready" here and was refused
 * at the commit. Both callers now build their ports from this one function, so the two cannot
 * drift apart again without changing the evidence for both at once.
 *
 * Demo subscriptions stay synthetic. Real Stripe-mirror evidence is opt-in under the existing
 * paid-billing rollout flag, so both routes stay inert until Phase 6 billing is enabled.
 */
export function createReadinessEvidence() {
  return {
    repository: createLiveReadinessRepository(),
    offerReadiness: loadOfferReadiness,
    subscriptionReadiness: phase6StripeLive() ? createPhase6SubscriptionReadinessPort() : undefined,
    demoSubscriptionReadiness: createDemoSubscriptionReadinessPort(),
  };
}

export const GET = createReadinessHandler({
  enabled: phase5Live,
  session: loadRouteActor,
  evaluate: (tenantId) => evaluateReadiness(tenantId, createReadinessEvidence()),
});
