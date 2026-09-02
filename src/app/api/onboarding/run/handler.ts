import { accessToken, safeEqual } from "@/lib/access";
import { environmentValue, phase5Live } from "@/lib/env-contract";
import { createMockCalendarDriver, createRealCalendarDriver } from "@/lib/integrations/calendar";
import { resolveGhlLocationAccessToken } from "@/lib/integrations/ghl-oauth-store";
import { createMockGhlProvisioningDriver, createRealGhlProvisioningDriver } from "@/lib/integrations/ghl";
import { selectCalendarDriver, selectGhlProvisioningDriver } from "@/lib/integrations/selector";
import { optInArtifactIsPublished } from "@/lib/onboarding/artifacts";
import { createCoachLaneExecutors, createLiveCoachLaneDependencies } from "@/lib/onboarding/coach-lanes";
import type {
  ApprovedA2pInput,
  ApprovedCampaignInput,
  GhlLocationRequest,
  GhlNumberRequest,
  GhlSnapshotRequest,
} from "@/lib/onboarding/provider-contracts";
import { createGhlLaneExecutors, type GhlLaneEvidencePort } from "@/lib/onboarding/ghl-lane";
import { loadOfferReadiness } from "@/app/api/onboarding/readiness/handler";
import {
  runProvisioningCycle,
  type ProvisioningCycleResult,
  type StepExecutorArms,
  type StepExecutorRegistry,
} from "@/lib/onboarding/runner";
import { createLiveTestPassRepository, createTestPassExecutor } from "@/lib/onboarding/test-pass";
import { createOnboardingStepRepository } from "@/lib/repositories/onboarding-steps";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { runLivePreviewTurn } from "@/lib/webhooks/process-inbound";
import { runJobWithReceipt, type JobReceiptExecution } from "@/lib/jobs/job-receipts";

const NO_STORE = { "Cache-Control": "no-store" };
const TENANT_LIMIT = 25;

export type ProvisioningRunSummary = {
  tenants: number;
  succeeded: number;
  failed: number;
  steps: number;
  committed: number;
  stale: number;
  missingExecutors: number;
};

type RunnerDependencies = {
  enabled(): boolean;
  secret: string | null;
  execute?: JobReceiptExecution;
  run(limit: number): Promise<ProvisioningRunSummary>;
};

type CampaignArtifactEvidence = {
  id: string;
  version: number;
  artifact_hash: string;
  marketing_language_hash: string;
  non_marketing_language_hash: string;
  terms_url: string;
  privacy_url: string;
  campaign_description_hash: string;
  placeholder: boolean;
  confirmed_at: string | null;
};

type CampaignScreenEvidence = {
  id: string;
  input_hash: string;
  result: "clean" | "flagged";
  acknowledged_at: string | null;
  admin_confirmed_at: string | null;
};

type ApprovedCampaignContentEvidence = {
  artifact_id: string;
  artifact_version: number;
  artifact_hash: string;
  marketing_language_hash: string;
  non_marketing_language_hash: string;
  terms_url: string;
  privacy_url: string;
  campaign_description_hash: string;
  content_screen_id: string;
  content_screen_input_hash: string;
  sample_messages_hash: string;
  approved_at: string;
  approved_by: string;
};

/** Converts only an explicit, current client approval into the filing contract. */
export function approvedCampaignInput(
  evidence: {
    artifact: CampaignArtifactEvidence | null;
    screen: CampaignScreenEvidence | null;
    content: ApprovedCampaignContentEvidence | null;
    isDemo: boolean;
  },
): ApprovedCampaignInput | null {
  const { artifact, screen, content, isDemo } = evidence;
  const screenReady = screen?.result === "clean"
    || (screen?.result === "flagged" && screen.acknowledged_at && screen.admin_confirmed_at);
  if (!artifact || !screen || !content || !screenReady || !artifact.confirmed_at
    || !optInArtifactIsPublished(artifact, { isDemo }) || !content.approved_at || !content.approved_by
    || content.artifact_id !== artifact.id || content.artifact_version !== artifact.version
    || content.artifact_hash !== artifact.artifact_hash
    || content.marketing_language_hash !== artifact.marketing_language_hash
    || content.non_marketing_language_hash !== artifact.non_marketing_language_hash
    || content.terms_url !== artifact.terms_url || content.privacy_url !== artifact.privacy_url
    || content.campaign_description_hash !== artifact.campaign_description_hash
    || content.content_screen_id !== screen.id || content.content_screen_input_hash !== screen.input_hash
    || !/^[0-9a-f]{64}$/.test(content.sample_messages_hash)) return null;
  return {
    artifactId: artifact.id,
    contentScreenId: screen.id,
    campaignDescriptionHash: artifact.campaign_description_hash,
    sampleMessagesHash: content.sample_messages_hash,
  };
}

async function authorized(request: Request, secret: string | null) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [candidateHash, secretHash] = await Promise.all([accessToken(candidate), accessToken(secret)]);
  return safeEqual(candidateHash, secretHash);
}

export function createProvisioningRunHandler(dependencies: RunnerDependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    if (!(await authorized(request, dependencies.secret))) {
      return Response.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
    }
    try {
      const work = () => dependencies.run(TENANT_LIMIT);
      const result = await (request.method === "GET" && dependencies.execute
        ? dependencies.execute("provisioning-run", work)
        : work());
      return Response.json(result, { headers: NO_STORE });
    } catch (error) {
      const code = error instanceof Error && /^(?:PHASE3|PHASE4)_[A-Z0-9_]+_MISSING$/.test(error.message)
        ? error.message
        : null;
      return Response.json(
        code
          ? { error: "A required provisioning seam is unavailable.", code }
          : { error: "Provisioning run could not be completed." },
        { status: 503, headers: NO_STORE },
      );
    }
  };
}

function configuration(name: "GHL_AGENCY_COMPANY_ID" | "GHL_SNAPSHOT_ID" | "GHL_NUMBER_POOL_ID") {
  return environmentValue(name) ?? `mock-${name.toLowerCase().replaceAll("_", "-")}`;
}

function liveGhlEvidence(): GhlLaneEvidencePort {
  const client = createSupabaseServiceClient();
  const externalReference = async (tenantId: string, stepKey: string) => {
    const { data, error } = await client
      .from("provisioning_steps")
      .select("external_ref")
      .eq("tenant_id", tenantId)
      .eq("step_key", stepKey)
      .maybeSingle();
    if (error) throw new Error("PROVISIONING_EXTERNAL_REFERENCE_READ_FAILED");
    return data?.external_ref && typeof data.external_ref === "object"
      ? data.external_ref as Record<string, unknown>
      : null;
  };
  const referenceText = async (tenantId: string, stepKey: string, field: string, code: string) => {
    const reference = await externalReference(tenantId, stepKey);
    const value = reference?.[field];
    if (typeof value !== "string" || !value.trim()) throw new Error(code);
    return value;
  };
  return {
    loadExternalReference: (attempt) => externalReference(attempt.tenantId, attempt.stepKey),
    loadLocationRequest: async (attempt): Promise<GhlLocationRequest> => {
      const [{ data: tenant, error: tenantError }, { data: settings, error: settingsError }, { data: profile, error: profileError }] = await Promise.all([
        client.from("tenants").select("name").eq("id", attempt.tenantId).maybeSingle(),
        client.from("tenant_settings").select("timezone").eq("tenant_id", attempt.tenantId).maybeSingle(),
        client.from("business_profiles").select("address_line1, address_line2, city, region, postal_code, country_code").eq("tenant_id", attempt.tenantId).maybeSingle(),
      ]);
      if (tenantError || settingsError || profileError) throw new Error("GHL_LOCATION_INPUT_READ_FAILED");
      if (!tenant || !settings || (!profile && !attempt.isDemo)) throw new Error("GHL_LOCATION_BUSINESS_PROFILE_REQUIRED");
      return {
        companyId: configuration("GHL_AGENCY_COMPANY_ID"),
        snapshotId: configuration("GHL_SNAPSHOT_ID"),
        name: tenant.name,
        timezone: settings.timezone,
        country: profile?.country_code ?? "US",
        address: {
          line1: profile?.address_line1 ?? "Synthetic demo address",
          ...(profile?.address_line2 ? { line2: profile.address_line2 } : {}),
          city: profile?.city ?? "Demo City",
          region: profile?.region ?? "NY",
          postalCode: profile?.postal_code ?? "10001",
        },
      };
    },
    loadSnapshotRequest: async (attempt): Promise<GhlSnapshotRequest> => ({
      locationId: await referenceText(attempt.tenantId, "ghl_location", "locationId", "GHL_LOCATION_REFERENCE_REQUIRED"),
      snapshotId: configuration("GHL_SNAPSHOT_ID"),
      companyId: configuration("GHL_AGENCY_COMPANY_ID"),
    }),
    loadNumberRequest: async (attempt): Promise<GhlNumberRequest> => ({
      locationId: await referenceText(attempt.tenantId, "ghl_location", "locationId", "GHL_LOCATION_REFERENCE_REQUIRED"),
      poolId: configuration("GHL_NUMBER_POOL_ID"),
    }),
    loadApprovedBrandInput: async (attempt): Promise<ApprovedA2pInput | null> => {
      const [{ data: artifact, error: artifactError }, { data: profile, error: profileError }] = await Promise.all([
        client
          .from("onboarding_optin_artifacts")
          .select("id, artifact_hash, placeholder, confirmed_at")
          .eq("tenant_id", attempt.tenantId)
          .eq("is_current", true)
          .maybeSingle(),
        client.from("business_profiles").select("id").eq("tenant_id", attempt.tenantId).maybeSingle(),
      ]);
      if (artifactError || profileError) throw new Error("A2P_BRAND_INPUT_READ_FAILED");
      if (!artifact || !profile || !artifact.confirmed_at
        || !optInArtifactIsPublished({ placeholder: Boolean(artifact.placeholder) }, { isDemo: attempt.isDemo })) return null;
      return { artifactId: artifact.id, businessProfileId: profile.id, artifactHash: artifact.artifact_hash };
    },
    loadApprovedCampaignInput: async (attempt): Promise<ApprovedCampaignInput | null> => {
      const [
        { data: artifact, error: artifactError },
        { data: screen, error: screenError },
        { data: content, error: contentError },
      ] = await Promise.all([
        client
          .from("onboarding_optin_artifacts")
          .select("id, version, artifact_hash, marketing_language_hash, non_marketing_language_hash, terms_url, privacy_url, campaign_description_hash, placeholder, confirmed_at")
          .eq("tenant_id", attempt.tenantId)
          .eq("is_current", true)
          .maybeSingle(),
        client
          .from("onboarding_content_screens")
          .select("id, input_hash, result, acknowledged_at, admin_confirmed_at")
          .eq("tenant_id", attempt.tenantId)
          .eq("is_current", true)
          .maybeSingle(),
        client
          .from("onboarding_approved_campaign_contents")
          .select("artifact_id, artifact_version, artifact_hash, marketing_language_hash, non_marketing_language_hash, terms_url, privacy_url, campaign_description_hash, content_screen_id, content_screen_input_hash, sample_messages_hash, approved_at, approved_by")
          .eq("tenant_id", attempt.tenantId)
          .order("version", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (artifactError || screenError || contentError) throw new Error("A2P_CAMPAIGN_INPUT_READ_FAILED");
      return approvedCampaignInput({ artifact, screen, content, isDemo: attempt.isDemo });
    },
  };
}

function arms(mockArm: StepExecutorArms["mockArm"], selectedArm: StepExecutorArms["mockArm"]): StepExecutorArms {
  return { mockArm, driverSelection: () => selectedArm };
}

function liveExecutorRegistry(): StepExecutorRegistry {
  const mockGhl = createMockGhlProvisioningDriver();
  const selectedGhl = selectGhlProvisioningDriver({
    factories: { mock: createMockGhlProvisioningDriver, real: createRealGhlProvisioningDriver },
  });
  const evidence = liveGhlEvidence();
  const mockLane = createGhlLaneExecutors({ driverForAttempt: () => mockGhl, evidence });
  const selectedLane = createGhlLaneExecutors({ driverForAttempt: () => selectedGhl, evidence });
  const coach = createCoachLaneExecutors(createLiveCoachLaneDependencies({
    offerReadiness: loadOfferReadiness,
  }));
  const selectedCalendar = selectCalendarDriver({
    factories: {
      mock: createMockCalendarDriver,
      real: () => createRealCalendarDriver({
        getLocationAccessToken: resolveGhlLocationAccessToken,
      }),
    },
  });
  const testRepository = createLiveTestPassRepository();
  const runGroundedTurn = async (tenantId: string) => {
    const result = await runLivePreviewTurn({
      tenantId,
      message: "What can your program help me understand?",
      mode: "test",
    });
    return {
      grounded: result.trace.declaredEntryVerified && result.trace.sources.length > 0,
      outputChecksPassed: result.trace.screen.verdict === "continue"
        && result.trace.checks.every((check) => check.passed),
      citationIds: result.trace.sources.map((source) => source.entryId),
      outputCheckRuleIds: [...new Set(result.trace.checks.flatMap((check) => check.ruleIds))],
      unresolvedPlaceholders: /{{[^{}]+}}|SETTERFI_DEMO_PLACEHOLDER_/.test(result.response.reply)
        ? ["unresolved"]
        : [],
    };
  };
  const mockTest = createTestPassExecutor({
    runGroundedTurn,
    calendar: createMockCalendarDriver(),
    repository: testRepository,
  });
  const selectedTest = createTestPassExecutor({
    runGroundedTurn,
    calendar: selectedCalendar,
    repository: testRepository,
  });
  return {
    ghl_location: arms(mockLane.executeGhlLocation, selectedLane.executeGhlLocation),
    ghl_snapshot: arms(mockLane.executeGhlSnapshot, selectedLane.executeGhlSnapshot),
    phone_number: arms(mockLane.executePhoneNumber, selectedLane.executePhoneNumber),
    a2p_brand: arms(mockLane.executeA2pBrand, selectedLane.executeA2pBrand),
    a2p_campaign: arms(mockLane.executeA2pCampaign, selectedLane.executeA2pCampaign),
    meta_connect: arms(coach.meta_connect, coach.meta_connect),
    whatsapp_connect: arms(coach.whatsapp_connect, coach.whatsapp_connect),
    calendar_connect: arms(coach.calendar_connect, coach.calendar_connect),
    offer_layer: arms(coach.offer_layer, coach.offer_layer),
    test_pass: arms(mockTest, selectedTest),
  };
}

async function runProvisioningTenants(limit: number): Promise<ProvisioningRunSummary> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("tenants")
    .select("id, is_demo")
    .eq("status", "onboarding")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error("PROVISIONING_TENANT_READ_FAILED");
  const repository = createOnboardingStepRepository();
  const executors = liveExecutorRegistry();
  const results: ProvisioningCycleResult[] = [];
  let failed = 0;
  for (const tenant of data ?? []) {
    try {
      results.push(...await runProvisioningCycle({
        tenantId: tenant.id,
        isDemo: tenant.is_demo,
        executors,
        repository,
      }));
    } catch (error) {
      if (error instanceof Error && /^(?:PHASE3|PHASE4)_[A-Z0-9_]+_MISSING$/.test(error.message)) {
        throw error;
      }
      failed += 1;
    }
  }
  return {
    tenants: data?.length ?? 0,
    succeeded: (data?.length ?? 0) - failed,
    failed,
    steps: results.length,
    committed: results.filter((result) => result.kind === "committed").length,
    stale: results.filter((result) => result.kind === "stale").length,
    missingExecutors: results.filter((result) => result.kind === "executor_missing").length,
  };
}

export const POST = createProvisioningRunHandler({
  enabled: phase5Live,
  secret: process.env.CRON_SECRET?.trim() || null,
  execute: runJobWithReceipt,
  run: runProvisioningTenants,
});

// Vercel cron invokes GET with the CRON_SECRET bearer. POST remains the manually-triggered
// operator path; both methods deliberately share the same flag, authentication, and summary.
export const GET = POST;
