import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { phase5Live } from "@/lib/env-contract";
import { normalizeApprovedCampaignContent } from "@/lib/onboarding/artifacts";
import { createOnboardingEvidenceRepository } from "@/lib/repositories/onboarding-evidence";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };

export type ArtifactView = {
  artifactId: string;
  version: number;
  templateVersion: string;
  controls: readonly [
    { key: "marketing"; checked: false; required: false; renderedLanguage: string; renderedLanguageHash: string },
    { key: "non_marketing"; checked: false; required: false; renderedLanguage: string; renderedLanguageHash: string },
  ];
  termsUrl: string;
  privacyUrl: string;
  campaignDescriptionHash: string;
  placeholder: boolean;
  confirmedAt: string | null;
  campaignContent?: {
    contentId: string;
    version: number;
    sampleMessages: readonly string[];
    sampleMessagesHash: string;
    approvedAt: string;
    approvedBy: string;
  } | null;
};

type ArtifactDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  load(tenantId: string): Promise<ArtifactView | null>;
  confirm(input: { tenantId: string; artifactId: string; actorId: string }): Promise<{
    auditId: string;
    actionKey: "onboarding.artifact_confirmed";
  }>;
  approveCampaignContent(input: { tenantId: string; actorId: string; sampleMessages: readonly string[] }): Promise<{
    contentId: string;
    version: number;
    approvedAt: string;
    auditId: string;
    actionKey: "onboarding.campaign_content_approved";
  }>;
};

function actorRefusal(actor: RouteActor | null, write = false) {
  if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
    if (hasImpersonationMarker(actor)) {
    return Response.json({ error: "Impersonated sessions are read-only." }, { status: 403, headers: NO_STORE });
  }
  if (write && actor.role !== "coach") {
    return Response.json({ error: "Forbidden." }, { status: 403, headers: NO_STORE });
  }
  return null;
}

function exactArtifactBody(value: unknown): value is { artifactId: string } {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && typeof (value as { artifactId?: unknown }).artifactId === "string"
    && Boolean((value as { artifactId: string }).artifactId.trim());
}

function exactCampaignContentBody(value: unknown): value is { sampleMessages: string[] } {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && Array.isArray((value as { sampleMessages?: unknown }).sampleMessages)
    && (value as { sampleMessages: unknown[] }).sampleMessages.every((message) => typeof message === "string");
}

export function createArtifactHandlers(dependencies: ArtifactDependencies) {
  return {
    GET: async () => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
      const actor = await dependencies.session();
      const refused = actorRefusal(actor);
      if (refused || !actor) return refused!;
      try {
        return Response.json({ artifact: await dependencies.load(actor.tenantId) }, { headers: NO_STORE });
      } catch (cause) {
        console.error(
          "/api/onboarding/artifacts failed.",
          cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
        );
        return Response.json({ error: "Opt-in artifact is unavailable." }, { status: 503, headers: NO_STORE });
      }
    },
    POST: async (request: Request) => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
      const actor = await dependencies.session();
      const refused = actorRefusal(actor, true);
      if (refused || !actor) return refused!;
      try {
        const body: unknown = await request.json();
        if (exactArtifactBody(body)) {
          const receipt = await dependencies.confirm({
            tenantId: actor.tenantId,
            artifactId: body.artifactId,
            actorId: actor.userId,
          });
          if (!receipt.auditId.trim()) throw new Error("CONFIRM_ONBOARDING_ARTIFACT_EMPTY");
          return Response.json({ artifactId: body.artifactId, receipt }, { headers: NO_STORE });
        }
        if (exactCampaignContentBody(body)) {
          const draft = normalizeApprovedCampaignContent(body);
          const receipt = await dependencies.approveCampaignContent({
            tenantId: actor.tenantId,
            actorId: actor.userId,
            sampleMessages: draft.sampleMessages,
          });
          if (!receipt.auditId.trim() || !receipt.contentId.trim() || receipt.version < 1 || !receipt.approvedAt.trim()) {
            throw new Error("APPROVE_ONBOARDING_CAMPAIGN_CONTENT_EMPTY");
          }
          return Response.json({ campaignContentId: receipt.contentId, receipt }, { headers: NO_STORE });
        }
        throw new Error("INVALID_BODY");
      } catch {
        return Response.json({ error: "Artifact confirmation or campaign content approval was refused." }, { status: 409, headers: NO_STORE });
      }
    },
  };
}

async function loadCurrentArtifact(tenantId: string): Promise<ArtifactView | null> {
  const client = createSupabaseServiceClient();
  const [{ data, error }, { data: campaignContent, error: campaignContentError }] = await Promise.all([
    client.from("onboarding_optin_artifacts").select(`
      id, version, template_version, marketing_language, marketing_language_hash,
      non_marketing_language, non_marketing_language_hash, terms_url, privacy_url,
      campaign_description_hash, placeholder, confirmed_at
    `).eq("tenant_id", tenantId).eq("is_current", true).maybeSingle(),
    client.from("onboarding_approved_campaign_contents")
      .select("id, version, sample_messages, sample_messages_hash, approved_at, approved_by")
      .eq("tenant_id", tenantId).order("version", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (error || campaignContentError) throw new Error("ONBOARDING_ARTIFACT_READ_FAILED");
  if (!data) return null;
  const sampleMessages = campaignContent?.sample_messages;
  if (campaignContent && (!Array.isArray(sampleMessages) || !sampleMessages.every((message) => typeof message === "string"))) {
    throw new Error("ONBOARDING_CAMPAIGN_CONTENT_READ_INVALID");
  }
  return {
    artifactId: data.id,
    version: data.version,
    templateVersion: data.template_version,
    controls: [
      {
        key: "marketing",
        checked: false,
        required: false,
        renderedLanguage: data.marketing_language,
        renderedLanguageHash: data.marketing_language_hash,
      },
      {
        key: "non_marketing",
        checked: false,
        required: false,
        renderedLanguage: data.non_marketing_language,
        renderedLanguageHash: data.non_marketing_language_hash,
      },
    ],
    termsUrl: data.terms_url,
    privacyUrl: data.privacy_url,
    campaignDescriptionHash: data.campaign_description_hash,
    placeholder: data.placeholder,
    confirmedAt: data.confirmed_at,
    campaignContent: campaignContent
      ? {
        contentId: campaignContent.id,
        version: campaignContent.version,
        sampleMessages,
        sampleMessagesHash: campaignContent.sample_messages_hash,
        approvedAt: campaignContent.approved_at,
        approvedBy: campaignContent.approved_by,
      }
      : null,
  };
}

async function approveCampaignContent(input: { tenantId: string; actorId: string; sampleMessages: readonly string[] }) {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("approve_onboarding_campaign_content", {
    p_expected_tenant: input.tenantId,
    p_actor_id: input.actorId,
    p_sample_messages: [...input.sampleMessages],
  });
  if (error || !Array.isArray(data) || data.length !== 1) throw new Error("APPROVE_ONBOARDING_CAMPAIGN_CONTENT_FAILED");
  const receipt = data[0] as Record<string, unknown>;
  if (typeof receipt.content_id !== "string" || typeof receipt.version !== "number"
    || typeof receipt.approved_at !== "string" || (typeof receipt.audit_id !== "string" && typeof receipt.audit_id !== "number")) {
    throw new Error("APPROVE_ONBOARDING_CAMPAIGN_CONTENT_EMPTY");
  }
  return {
    contentId: receipt.content_id,
    version: receipt.version,
    approvedAt: receipt.approved_at,
    auditId: String(receipt.audit_id),
    actionKey: "onboarding.campaign_content_approved" as const,
  };
}

const handlers = createArtifactHandlers({
  enabled: phase5Live,
  session: loadRouteActor,
  load: loadCurrentArtifact,
  confirm: (input) => createOnboardingEvidenceRepository().confirmArtifact(input),
  approveCampaignContent,
});

export const GET = handlers.GET;
export const POST = handlers.POST;
