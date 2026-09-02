/**
 * The tenant behind the public hosted conversation preview.
 *
 * This route is public, so choosing "some" demo tenant is not safe: a newly seeded
 * demo workspace can contain a different offer, lead history, or draft content. The
 * Phase 1 fixture tenant is the only supported public preview and is named by a
 * stable identifier shared with the guarded seeders. The lookup also verifies the
 * row remains labelled demo, so deleting or repurposing it fails closed.
 */

import { DEMO_TENANT_ID } from "@/lib/demo-tenant";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type ConsumerPreviewTenantRow = {
  id: string;
  is_demo: boolean;
};

export function selectConsumerPreviewTenant(
  row: ConsumerPreviewTenantRow | null | undefined,
): string | null {
  if (!row || row.id !== DEMO_TENANT_ID || row.is_demo !== true) return null;
  return row.id;
}

type ConsumerPreviewTenantDependencies = {
  load(): Promise<ConsumerPreviewTenantRow | null>;
};

async function liveDependencies(): Promise<ConsumerPreviewTenantDependencies> {
  const client = createSupabaseServiceClient();
  return {
    async load() {
      const { data, error } = await client
        .from("tenants")
        .select("id,is_demo")
        .eq("id", DEMO_TENANT_ID)
        .maybeSingle();
      if (error) return null;
      return data;
    },
  };
}

/**
 * Resolves only the named, labelled public preview tenant. In particular, this must
 * not fall back to the oldest demo row as the platform test-agent may do: the browser
 * has no authenticated actor that could make that broader choice safe.
 */
export async function resolveConsumerPreviewTenant(
  dependencies?: ConsumerPreviewTenantDependencies,
): Promise<string | null> {
  const deps = dependencies ?? await liveDependencies();
  return selectConsumerPreviewTenant(await deps.load());
}
