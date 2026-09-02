import type { Metadata } from "next";

import { GET as loadHostedArtifact } from "@/app/api/opt-in/[tenantSlug]/artifact/route";
import { OptinArtifact } from "@/components/onboarding/optin-artifact";
import type { HostedArtifactView } from "@/components/onboarding/view-models";
import { phase5Live } from "@/lib/env-contract";

export const metadata: Metadata = { title: "Privacy", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function TenantPrivacyPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const enabled = phase5Live();
  let artifact: HostedArtifactView | null = null;
  if (enabled) {
    const response = await loadHostedArtifact(
      new Request(`https://setterfi.local/api/opt-in/${encodeURIComponent(tenantSlug)}/artifact?page=privacy`),
      { params: Promise.resolve({ tenantSlug }) },
    );
    const payload = await response.json() as { artifact?: HostedArtifactView | null };
    artifact = response.ok ? payload.artifact ?? null : null;
  }
  return <OptinArtifact artifact={artifact} enabled={enabled} page="privacy" tenantSlug={tenantSlug} />;
}
