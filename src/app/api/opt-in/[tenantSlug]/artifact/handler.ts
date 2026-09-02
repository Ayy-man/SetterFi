import { phase5Live } from "@/lib/env-contract";
import type { HostedArtifactView } from "@/components/onboarding/view-models";
import {
  loadHostedOnboardingArtifact,
  type HostedArtifactPage,
  type HostedArtifactProjection,
} from "@/lib/repositories/onboarding-evidence";

const NO_STORE = { "Cache-Control": "no-store" };
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PAGES: readonly HostedArtifactPage[] = ["consent", "terms", "privacy"];

type HostedArtifactDependencies = {
  enabled(): boolean;
  load(tenantSlug: string, page: HostedArtifactPage): Promise<HostedArtifactProjection | null>;
};

function pageFrom(request: Request) {
  const page = new URL(request.url).searchParams.get("page");
  return PAGES.includes(page as HostedArtifactPage) ? page as HostedArtifactPage : null;
}

function artifactView(artifact: HostedArtifactProjection): HostedArtifactView {
  return {
    artifactId: artifact.artifactId,
    version: artifact.version,
    templateVersion: artifact.templateVersion,
    tenantSlug: artifact.tenantSlug,
    businessName: artifact.businessName,
    isDemo: artifact.isDemo,
    controls: [
      {
        key: "marketing",
        checked: false,
        required: false,
        renderedLanguage: artifact.marketingLanguage,
        renderedLanguageHash: artifact.marketingLanguageHash,
      },
      {
        key: "non_marketing",
        checked: false,
        required: false,
        renderedLanguage: artifact.nonMarketingLanguage,
        renderedLanguageHash: artifact.nonMarketingLanguageHash,
      },
    ],
    termsBody: artifact.termsBody,
    termsBodyHash: artifact.termsBodyHash,
    privacyBody: artifact.privacyBody,
    privacyBodyHash: artifact.privacyBodyHash,
    termsUrl: artifact.termsUrl,
    privacyUrl: artifact.privacyUrl,
    campaignDescriptionHash: artifact.campaignDescriptionHash,
    artifactHash: artifact.artifactHash,
    placeholder: artifact.placeholder,
    confirmedAt: artifact.confirmedAt,
  };
}

export function createHostedArtifactHandler(dependencies: HostedArtifactDependencies) {
  return async function GET(
    request: Request,
    context: { params: Promise<{ tenantSlug: string }> },
  ) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    }
    const { tenantSlug } = await context.params;
    const page = pageFrom(request);
    if (!SLUG.test(tenantSlug) || tenantSlug.length > 63 || !page) {
      return Response.json({ artifact: null }, { headers: NO_STORE });
    }
    try {
      const artifact = await dependencies.load(tenantSlug, page);
      return Response.json({ artifact: artifact ? artifactView(artifact) : null }, {
        headers: NO_STORE,
      });
    } catch (cause) {
      console.error(
        "/api/opt-in/[tenantSlug]/artifact failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json({ error: "Hosted page is unavailable." }, {
        status: 503,
        headers: NO_STORE,
      });
    }
  };
}

export const GET = createHostedArtifactHandler({
  enabled: phase5Live,
  load: loadHostedOnboardingArtifact,
});
