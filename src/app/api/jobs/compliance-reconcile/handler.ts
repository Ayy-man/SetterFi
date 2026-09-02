import { accessToken, safeEqual } from "@/lib/access";
import { phase1Live, phase3Live, suppressionSyncLive } from "@/lib/env-contract";
import { runDailyLifecycleSweep } from "@/lib/followups/scheduler";
import { claimFairTenantIds } from "@/lib/jobs/fair-scan";
import { runJobWithReceipt, type JobReceiptExecution } from "@/lib/jobs/job-receipts";
import { createLiveFollowupSchedulerRepository } from "@/lib/repositories/followups";
import { createLiveSuppressionProviderPort } from "@/lib/suppression/provider";
import { hashSuppressionIdentifier } from "@/lib/suppression/identifier-hash";
import { reconcileProviderSuppressions } from "@/lib/suppression/reconcile";
import type { SuppressionIdentity } from "@/lib/suppression/service";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const TENANT_LIMIT = 100;
const PROVIDER_RETRY_LIMIT = 100;
const noStoreHeaders = { "Cache-Control": "no-store" };

type Dependencies = {
  secret: string | null;
  execute?: JobReceiptExecution;
  syncEnabled(): boolean;
  listTenants(limit: number): Promise<readonly string[]>;
  sweep(tenantId: string, now: string): Promise<{ closedCount: number }>;
  reconcileProvider(limit: number): Promise<{ checked: number; confirmed: number; failed: number }>;
};

async function authorized(request: Request, secret: string | null) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [candidateHash, secretHash] = await Promise.all([accessToken(candidate), accessToken(secret)]);
  return safeEqual(candidateHash, secretHash);
}

export function createComplianceReconcileHandler(dependencies: Dependencies) {
  return async function GET(request: Request) {
    if (!phase1Live() || !phase3Live()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    if (!(await authorized(request, dependencies.secret))) {
      return Response.json({ error: "Unauthorized." }, { status: 401, headers: noStoreHeaders });
    }
    const work = async () => {
      const now = new Date().toISOString();
      const tenants = await dependencies.listTenants(TENANT_LIMIT);
      let staleClosed = 0;
      for (const tenantId of tenants) {
        staleClosed += (await dependencies.sweep(tenantId, now)).closedCount;
      }
      const provider = dependencies.syncEnabled()
        ? await dependencies.reconcileProvider(PROVIDER_RETRY_LIMIT)
        : { checked: 0, confirmed: 0, failed: 0, skipped: "SETTERFI_SUPPRESSION_SYNC_LIVE is off" as const };
      return { tenants: tenants.length, staleClosed, provider };
    };
    return Response.json(
      await (dependencies.execute ? dependencies.execute("compliance-reconcile", work, {
        counters: (result) => ({
          tenants: result.tenants,
          staleClosed: result.staleClosed,
          checked: result.provider.checked,
          confirmed: result.provider.confirmed,
          failed: result.provider.failed,
        }),
      }) : work()),
      { headers: noStoreHeaders },
    );
  };
}

async function listTenants(limit: number) {
  const client = createSupabaseServiceClient();
  return claimFairTenantIds(client, "compliance_lifecycle", limit);
}

async function reconcileProvider(limit: number) {
  const client = createSupabaseServiceClient();
  const provider = createLiveSuppressionProviderPort();
  return reconcileProviderSuppressions(limit, new Date().toISOString(), {
    listPending: async (batchLimit, now) => {
      const { data, error } = await client.from("suppression_entries")
        .select("id,tenant_id,contact_id,channel,identifier_hash,provider_sync_attempts")
        .in("provider_sync_state", ["pending", "failed"])
        .not("contact_id", "is", null)
        .or(`provider_next_retry_at.is.null,provider_next_retry_at.lte.${now}`)
        // Oldest never-attempted rows go first; failed rows rotate behind them by last check time,
        // so one permanently failing tenant cannot occupy the fixed worker head forever.
        .order("provider_last_checked_at", { ascending: true, nullsFirst: true })
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(batchLimit);
      if (error) throw new Error("SUPPRESSION_RECONCILE_READ_FAILED");
      return (data ?? []).map((row) => ({
        id: String(row.id),
        tenantId: String(row.tenant_id),
        contactId: String(row.contact_id),
        channel: row.channel,
        identifierHash: String(row.identifier_hash),
        attempts: Number(row.provider_sync_attempts),
      }));
    },
    loadIdentities: async (tenantId, contactId): Promise<readonly SuppressionIdentity[]> => {
      const { data, error } = await client.from("contact_identities")
        .select("id,tenant_id,contact_id,provider,channel,provider_identity_id,normalized_phone,normalized_email")
        .eq("tenant_id", tenantId)
        .eq("contact_id", contactId);
      if (error) throw new Error("SUPPRESSION_IDENTITY_READ_FAILED");
      return (data ?? []).map((row) => ({
        tenantId: String(row.tenant_id),
        contactId: String(row.contact_id),
        identityId: String(row.id),
        provider: row.provider,
        channel: row.channel,
        recipientExternalId: String(row.provider_identity_id),
        providerIdentityId: String(row.provider_identity_id),
        normalizedIdentifier: row.normalized_phone ?? row.normalized_email ?? String(row.provider_identity_id),
        suppressionId: null,
      }));
    },
    recordResult: async (input) => {
      const { error } = await client.rpc("record_provider_suppression_result", {
        p_expected_tenant: input.tenantId,
        p_suppression_id: input.suppressionId,
        p_confirmed: input.confirmed,
        p_error: input.error,
      });
      if (error) throw new Error("SUPPRESSION_PROVIDER_RESULT_FAILED");
    },
    provider,
    hashIdentifier: (value) => hashSuppressionIdentifier(value),
  });
}

export const GET = createComplianceReconcileHandler({
  secret: process.env.CRON_SECRET?.trim() || null,
  execute: runJobWithReceipt,
  syncEnabled: suppressionSyncLive,
  listTenants,
  sweep: async (tenantId, now) => runDailyLifecycleSweep(
    { tenantId, now },
    createLiveFollowupSchedulerRepository(),
  ),
  reconcileProvider,
});
