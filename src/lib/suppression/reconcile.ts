import type { SuppressionProviderPort } from "@/lib/sends/contracts";
import { hashSuppressionIdentifier } from "@/lib/suppression/identifier-hash";
import { normalizeSuppressionIdentifier } from "@/lib/suppression/normalize";
import type { SuppressionIdentity } from "@/lib/suppression/service";

export type PendingProviderSuppression = {
  id: string;
  tenantId: string;
  contactId: string;
  channel: SuppressionIdentity["channel"];
  identifierHash: string;
  attempts: number;
};

export type ProviderSuppressionReconcileDependencies = {
  listPending(limit: number, now: string): Promise<readonly PendingProviderSuppression[]>;
  loadIdentities(tenantId: string, contactId: string): Promise<readonly SuppressionIdentity[]>;
  recordResult(input: {
    tenantId: string;
    suppressionId: string;
    confirmed: boolean;
    error: string | null;
  }): Promise<void>;
  provider: SuppressionProviderPort;
  hashIdentifier?: typeof hashSuppressionIdentifier;
};

function matchingIdentity(
  pending: PendingProviderSuppression,
  identities: readonly SuppressionIdentity[],
  hash: typeof hashSuppressionIdentifier,
) {
  return identities.find((identity) => {
    if (identity.tenantId !== pending.tenantId || identity.contactId !== pending.contactId
      || identity.channel !== pending.channel) return false;
    const normalized = normalizeSuppressionIdentifier(identity.channel, identity.normalizedIdentifier);
    return normalized !== null && hash(normalized) === pending.identifierHash;
  }) ?? null;
}

export async function reconcileProviderSuppressions(
  limit: number,
  now: string,
  dependencies: ProviderSuppressionReconcileDependencies,
) {
  const pending = await dependencies.listPending(limit, now);
  let confirmed = 0;
  let failed = 0;
  for (const item of pending) {
    let error = "SUPPRESSION_PROVIDER_RECONCILE_FAILED";
    try {
      const identity = matchingIdentity(
        item,
        await dependencies.loadIdentities(item.tenantId, item.contactId),
        dependencies.hashIdentifier ?? hashSuppressionIdentifier,
      );
      if (!identity) {
        error = "SUPPRESSION_IDENTITY_UNAVAILABLE";
        throw new Error(error);
      }
      const input = {
        tenantId: identity.tenantId,
        identityId: identity.identityId,
        provider: identity.provider,
        channel: identity.channel,
        providerIdentityId: identity.providerIdentityId,
        idempotencyKey: `suppression-reconcile:${item.id}:${item.attempts + 1}`,
      };
      const mutation = await dependencies.provider.suppress(input);
      const readback = await dependencies.provider.readBack(input);
      if (mutation.providerOperationId !== readback.providerOperationId || !readback.suppressed) {
        error = "PROVIDER_SUPPRESSION_READBACK_MISMATCH";
        throw new Error(error);
      }
      await dependencies.recordResult({
        tenantId: item.tenantId,
        suppressionId: item.id,
        confirmed: true,
        error: null,
      });
      confirmed += 1;
    } catch (caught) {
      if (caught instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(caught.message)) {
        error = caught.message;
      }
      await dependencies.recordResult({
        tenantId: item.tenantId,
        suppressionId: item.id,
        confirmed: false,
        error,
      });
      failed += 1;
    }
  }
  return { checked: pending.length, confirmed, failed };
}
