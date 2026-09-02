import { createHash } from "node:crypto";

import {
  validateWebFormConsentEvidence,
  type ConsentEvidenceValidation,
  type WebFormConsentEvidence,
} from "@/lib/compliance/consent-evidence";
import { verifyConsentBinding } from "@/lib/compliance/consent-binding";
import { environmentValue, phase5Live } from "@/lib/env-contract";
import { acceptArtifactSubmission } from "@/lib/onboarding/artifacts";
import {
  consumeTenantRateLimit,
  tenantRateLimitCallerKey,
  type TenantRateLimitResult,
} from "@/lib/rate-limit/tenant-rate-limit";
import {
  createOnboardingEvidenceRepository,
  type RecordWebFormConsentInput,
} from "@/lib/repositories/onboarding-evidence";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type PublicArtifact = {
  tenantId: string;
  isDemo: boolean;
  artifactId: string;
  templateVersion: string;
  marketingLanguage: string;
  nonMarketingLanguage: string;
};

type ConsentDependencies = {
  enabled(): boolean;
  limit(request: Request, artifact: PublicArtifact): Promise<TenantRateLimitResult>;
  resolve(tenantSlug: string): Promise<PublicArtifact | null>;
  validate: typeof validateWebFormConsentEvidence | null;
  verifyBinding(input: {
    token: string;
    tenantId: string;
    artifactId: string;
    now: Date;
  }): { contactIdentityId: string; formSubmissionId: string } | null;
  record(input: RecordWebFormConsentInput): Promise<{
    auditId: string;
    actionKey: "consent.web_form_recorded";
    evidence: WebFormConsentEvidence;
  }>;
  now(): Date;
};

type ConsentBody = {
  artifactId: string;
  consentToken: string | null;
  marketing: boolean;
  nonMarketing: boolean;
};

function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

function parseBody(value: unknown): ConsentBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => ![
    "artifactId",
    "consentToken",
    "marketing",
    "nonMarketing",
  ].includes(key))) return null;
  if (
    typeof body.artifactId !== "string"
    || !body.artifactId.trim()
    || typeof body.marketing !== "boolean"
    || typeof body.nonMarketing !== "boolean"
  ) return null;
  const selected = body.marketing || body.nonMarketing;
  const consentToken = typeof body.consentToken === "string" ? body.consentToken.trim() : null;
  if (selected && (!consentToken || consentToken.length > 2_048)) return null;
  return {
    artifactId: body.artifactId.trim(),
    consentToken,
    marketing: body.marketing,
    nonMarketing: body.nonMarketing,
  };
}

function evidenceFor(input: RecordWebFormConsentInput): WebFormConsentEvidence {
  return {
    schemaVersion: 1,
    formSubmissionId: input.formSubmissionId,
    formUrl: input.pageUrl,
    disclosureVersion: input.disclosureVersion,
    disclosureTextHash: createHash("sha256").update(input.renderedLanguage).digest("hex"),
    submittedAt: input.submittedAt,
    purposes: [...input.purposes],
    channels: [...input.channels],
  };
}

export function createConsentHandler(dependencies: ConsentDependencies) {
  return async function POST(
    request: Request,
    context: { params: Promise<{ tenantSlug: string }> },
  ) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    if (!isSameOrigin(request)) return Response.json({ error: "Request origin was refused." }, { status: 403, headers: NO_STORE });
    const { tenantSlug: rawSlug } = await context.params;
    const tenantSlug = rawSlug.trim().toLowerCase();
    if (!SLUG.test(tenantSlug) || tenantSlug !== rawSlug) {
      return Response.json({ error: "Opt-in page was not found." }, { status: 404, headers: NO_STORE });
    }
    try {
      const artifact = await dependencies.resolve(tenantSlug);
      if (!artifact) return Response.json({ error: "Opt-in page was not found." }, { status: 404, headers: NO_STORE });
      const limited = await dependencies.limit(request, artifact);
      if (!limited.allowed) {
        if (limited.reason === "RATE_LIMIT_STORE_UNAVAILABLE") {
          return Response.json(
            {
              error: "Consent submissions are temporarily unavailable. Try again later.",
              code: limited.reason,
            },
            { status: 503, headers: { ...NO_STORE, "Retry-After": String(limited.retryAfter) } },
          );
        }
        return Response.json(
          { error: "Too many submissions. Try again later." },
          { status: 429, headers: { ...NO_STORE, "Retry-After": String(limited.retryAfter) } },
        );
      }
      const body = parseBody(await request.json());
      if (!body || body.artifactId !== artifact.artifactId) {
        return Response.json({ error: "Consent submission is invalid." }, { status: 400, headers: NO_STORE });
      }
      const submission = acceptArtifactSubmission({
        marketing: body.marketing,
        nonMarketing: body.nonMarketing,
      });
      if (submission.selectedControls.length === 0) {
        return Response.json({
          outcome: "no_consent_selected",
          consentRecorded: false,
          isDemo: artifact.isDemo,
          message: "No messaging consent was selected, so no consent evidence was recorded.",
        }, { headers: NO_STORE });
      }
      if (typeof dependencies.validate !== "function") {
        return Response.json(
          { error: "Consent validation is unavailable.", code: "PHASE3_CONSENT_CONTRACT_MISSING" },
          { status: 503, headers: NO_STORE },
        );
      }
      const renderedLanguage = submission.selectedControls.map((control) => (
        control === "marketing" ? artifact.marketingLanguage : artifact.nonMarketingLanguage
      )).join("\n\n");
      const now = dependencies.now();
      const binding = dependencies.verifyBinding({
        token: body.consentToken!,
        tenantId: artifact.tenantId,
        artifactId: artifact.artifactId,
        now,
      });
      if (!binding) {
        return Response.json({ error: "Consent identity binding was refused." }, {
          status: 403,
          headers: NO_STORE,
        });
      }
      const recordInput: RecordWebFormConsentInput = {
        tenantId: artifact.tenantId,
        artifactId: artifact.artifactId,
        contactIdentityId: binding.contactIdentityId,
        renderedLanguage,
        pageUrl: new URL(`/opt-in/${tenantSlug}`, request.url).toString(),
        submittedAt: now.toISOString(),
        formSubmissionId: binding.formSubmissionId,
        disclosureVersion: artifact.templateVersion,
        purposes: [
          ...(body.marketing ? ["follow_up" as const] : []),
          ...(body.nonMarketing ? ["agent_reply" as const] : []),
        ],
        channels: ["sms"],
      };
      const validation: ConsentEvidenceValidation = dependencies.validate(evidenceFor(recordInput));
      if (validation.kind !== "verified") {
        return Response.json({ error: "Consent evidence was refused." }, { status: 400, headers: NO_STORE });
      }
      const receipt = await dependencies.record(recordInput);
      if (!receipt.auditId.trim()) throw new Error("RECORD_WEB_FORM_CONSENT_EMPTY");
      return Response.json({
        outcome: "consent_recorded",
        consentRecorded: true,
        isDemo: artifact.isDemo,
        message: "Your selected messaging consent was recorded.",
        receipt: { auditId: receipt.auditId, actionKey: receipt.actionKey },
      }, { status: 201, headers: NO_STORE });
    } catch (error) {
      if (error instanceof Error && error.message === "PHASE3_CONSENT_CONTRACT_MISSING") {
        return Response.json(
          { error: "Consent validation is unavailable.", code: error.message },
          { status: 503, headers: NO_STORE },
        );
      }
      return Response.json({ error: "Consent submission was refused." }, { status: 409, headers: NO_STORE });
    }
  };
}

async function resolvePublicArtifact(tenantSlug: string): Promise<PublicArtifact | null> {
  const client = createSupabaseServiceClient();
  const { data: tenant, error: tenantError } = await client
    .from("tenants")
    .select("id, is_demo")
    .eq("slug", tenantSlug)
    .eq("status", "active")
    .maybeSingle();
  if (tenantError) throw new Error("PUBLIC_OPTIN_TENANT_READ_FAILED");
  if (!tenant) return null;
  const { data: artifact, error: artifactError } = await client
    .from("onboarding_optin_artifacts")
    .select("id, template_version, marketing_language, non_marketing_language")
    .eq("tenant_id", tenant.id)
    .eq("is_current", true)
    .not("confirmed_at", "is", null)
    .maybeSingle();
  if (artifactError) throw new Error("PUBLIC_OPTIN_ARTIFACT_READ_FAILED");
  if (!artifact) return null;
  return {
    tenantId: tenant.id,
    isDemo: tenant.is_demo,
    artifactId: artifact.id,
    templateVersion: artifact.template_version,
    marketingLanguage: artifact.marketing_language,
    nonMarketingLanguage: artifact.non_marketing_language,
  };
}

export const POST = createConsentHandler({
  enabled: phase5Live,
  limit: async (request, artifact) => {
    const client = createSupabaseServiceClient();
    return consumeTenantRateLimit({
      tenantId: artifact.tenantId,
      routeKey: "opt-in-consent",
      callerKey: tenantRateLimitCallerKey(request),
      limit: 12,
      windowMs: 15 * 60 * 1_000,
    }, {
      client: {
        rpc: async (name, args) => {
          const { data, error } = await client.rpc(name, args);
          return { data, error };
        },
      },
    });
  },
  resolve: resolvePublicArtifact,
  validate: validateWebFormConsentEvidence,
  verifyBinding: ({ token, tenantId, artifactId, now }) => {
    const secret = environmentValue("SETTERFI_TAG_SECRET");
    return secret ? verifyConsentBinding({ token, secret, tenantId, artifactId, now }) : null;
  },
  record: (input) => createOnboardingEvidenceRepository().recordWebFormConsent(input),
  now: () => new Date(),
});
