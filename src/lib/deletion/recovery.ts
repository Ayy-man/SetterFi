import { randomUUID } from "node:crypto";

import type { EnvironmentSource } from "@/lib/env-contract";
import type { DeletionProviderInput, DeletionProviderPort } from "@/lib/sends/contracts";
import { hashSuppressionIdentifier } from "@/lib/suppression/identifier-hash";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

import type { DeletionProviderEvidence, DeletionSnapshot } from "./contracts";
import { createLiveGhlDeletionProviderPort } from "./ghl-provider";
import { loadDeletionSnapshot } from "./preview";

export type DeletionRecoveryClaim = {
  intentId: string;
  tenantId: string;
  contactId: string;
  actorId: string | null;
  status: "claimed" | "provider_confirmed";
  providerEvidence: DeletionProviderEvidence | null;
  idempotencyDigest: string;
  actorAuthorized: boolean;
  leaseToken: string;
};

export type DeletionRecoveryDependencies = {
  claim(limit: number): Promise<DeletionRecoveryClaim[]>;
  loadSnapshot(tenantId: string, contactId: string): Promise<DeletionSnapshot>;
  renew(input: { tenantId: string; intentId: string; leaseToken: string }): Promise<void>;
  checkpoint(input: {
    tenantId: string;
    actorId: string;
    intentId: string;
    leaseToken: string;
    evidence: DeletionProviderEvidence;
  }): Promise<void>;
  finalize(input: {
    tenantId: string;
    intentId: string;
    leaseToken: string;
    channels: string[];
    hashes: string[];
    last4s: Array<string | null>;
    providerReceipt: Record<string, unknown>;
  }): Promise<void>;
  mark(input: {
    intentId: string;
    leaseToken: string;
    outcome: "retry" | "operator_required";
    error: string;
  }): Promise<void>;
  provider: DeletionProviderPort;
  hashIdentifier(value: string): string;
  now(): Date;
  newLeaseToken(): string;
};

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> =>
    Boolean(row) && typeof row === "object" && !Array.isArray(row)) : [];
}

function parseClaim(row: Record<string, unknown>): DeletionRecoveryClaim {
  const intentId = row.intent_id ?? row.intentId;
  const tenantId = row.tenant_id ?? row.tenantId;
  const contactId = row.contact_id ?? row.contactId;
  const actorId = row.actor_id ?? row.actorId ?? null;
  const idempotencyDigest = row.idempotency_digest ?? row.idempotencyDigest;
  const actorAuthorized = row.actor_authorized ?? row.actorAuthorized;
  const leaseToken = row.lease_token ?? row.leaseToken;
  if (typeof intentId !== "string" || typeof tenantId !== "string" ||
    typeof contactId !== "string" || (actorId !== null && typeof actorId !== "string") ||
    (row.status !== "claimed" && row.status !== "provider_confirmed") ||
    typeof idempotencyDigest !== "string" || typeof actorAuthorized !== "boolean" ||
    typeof leaseToken !== "string") {
    throw new Error("CONTACT_DELETE_RECOVERY_CLAIM_INVALID");
  }
  return {
    intentId, tenantId, contactId, actorId, status: row.status,
    providerEvidence: row.provider_evidence as DeletionProviderEvidence | null,
    idempotencyDigest, actorAuthorized, leaseToken,
  };
}

function targets(snapshot: DeletionSnapshot): DeletionProviderInput[] {
  const unique = new Map<string, DeletionProviderInput>();
  for (const identity of snapshot.identities) {
    if (identity.provider !== "ghl" || !identity.providerContactId) continue;
    if (!identity.providerAccountId || !identity.ghlInstallId) {
      throw new Error("GHL_IDENTITY_ACCOUNT_REMEDIATION_REQUIRED");
    }
    const key = [identity.providerAccountId, identity.ghlInstallId, identity.providerContactId]
      .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("");
    unique.set(key, {
      tenantId: snapshot.tenantId,
      contactId: snapshot.contactId,
      providerContactId: identity.providerContactId,
      providerAccountId: identity.providerAccountId,
      ghlInstallId: identity.ghlInstallId,
      idempotencyKey: "",
    });
  }
  return [...unique.entries()].sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  )
    .map(([, target], index) => ({
      ...target,
      idempotencyKey: `contact-deletion-recovery:${snapshot.contactId}:${index}`,
    }));
}

async function providerEvidence(
  claim: DeletionRecoveryClaim,
  snapshot: DeletionSnapshot,
  dependencies: DeletionRecoveryDependencies,
): Promise<DeletionProviderEvidence> {
  const providerTargets = targets(snapshot);
  if (providerTargets.length === 0) return { kind: "not_applicable" };
  const receipts: Extract<DeletionProviderEvidence, { kind: "confirmed_absent" }>["receipts"] = [];
  for (const target of providerTargets) {
    await dependencies.renew({
      tenantId: claim.tenantId, intentId: claim.intentId, leaseToken: claim.leaseToken,
    });
    const before = await dependencies.provider.readAbsent(target);
    if (before.absent) {
      receipts.push({
        providerOperationId: before.providerOperationId,
        acceptedAt: before.observedAt,
        observedAt: before.observedAt,
      });
      continue;
    }
    await dependencies.renew({
      tenantId: claim.tenantId, intentId: claim.intentId, leaseToken: claim.leaseToken,
    });
    const mutation = await dependencies.provider.deleteContact(target);
    await dependencies.renew({
      tenantId: claim.tenantId, intentId: claim.intentId, leaseToken: claim.leaseToken,
    });
    const after = await dependencies.provider.readAbsent(target);
    if (!after.absent || after.providerOperationId !== mutation.providerOperationId) {
      throw new Error("CONTACT_DELETE_RECOVERY_PROVIDER_UNCONFIRMED");
    }
    receipts.push({ ...mutation, observedAt: after.observedAt });
  }
  return { kind: "confirmed_absent", receipts };
}

function tombstones(snapshot: DeletionSnapshot, hash: (value: string) => string) {
  const unique = new Map<string, { channel: string; hash: string; last4: string | null }>();
  for (const identity of snapshot.identities) {
    const digest = hash(identity.normalizedIdentifier);
    const key = `${identity.channel}:${digest}`;
    if (!unique.has(key)) unique.set(key, {
      channel: identity.channel,
      hash: digest,
      last4: identity.identifierLast4,
    });
  }
  return [...unique.values()];
}

export async function recoverContactDeletionClaim(
  claim: DeletionRecoveryClaim,
  dependencies: DeletionRecoveryDependencies,
) {
  if (!claim.actorId || !claim.actorAuthorized) {
    await dependencies.mark({
      intentId: claim.intentId, leaseToken: claim.leaseToken, outcome: "operator_required",
      error: "CONTACT_DELETE_RECOVERY_ACTOR_REQUIRED",
    });
    return "operator_required" as const;
  }
  try {
    const snapshot = await dependencies.loadSnapshot(claim.tenantId, claim.contactId);
    let evidence = claim.providerEvidence;
    if (claim.status === "claimed") {
      evidence = await providerEvidence(claim, snapshot, dependencies);
      try {
        await dependencies.renew({
          tenantId: claim.tenantId, intentId: claim.intentId, leaseToken: claim.leaseToken,
        });
        await dependencies.checkpoint({
          tenantId: claim.tenantId,
          actorId: claim.actorId as string,
          intentId: claim.intentId,
          leaseToken: claim.leaseToken,
          evidence,
        });
      } catch {
        await dependencies.mark({
          intentId: claim.intentId, leaseToken: claim.leaseToken, outcome: "operator_required",
          error: "CONTACT_DELETE_RECOVERY_ACTOR_REVALIDATION_FAILED",
        });
        return "operator_required" as const;
      }
    }
    if (!evidence) throw new Error("CONTACT_DELETE_RECOVERY_EVIDENCE_REQUIRED");
    const items = tombstones(snapshot, dependencies.hashIdentifier);
    await dependencies.renew({
      tenantId: claim.tenantId, intentId: claim.intentId, leaseToken: claim.leaseToken,
    });
    await dependencies.finalize({
      tenantId: claim.tenantId,
      intentId: claim.intentId,
      leaseToken: claim.leaseToken,
      channels: items.map((item) => item.channel),
      hashes: items.map((item) => item.hash),
      last4s: items.map((item) => item.last4),
      providerReceipt: {
        intentId: claim.intentId,
        providerEvidence: evidence,
        idempotencyDigest: claim.idempotencyDigest,
        verifiedAt: dependencies.now().toISOString(),
        recoveryMode: "durable_job",
      },
    });
    return "completed" as const;
  } catch (error) {
    await dependencies.mark({
      intentId: claim.intentId,
      leaseToken: claim.leaseToken,
      outcome: "retry",
      error: error instanceof Error ? error.message : "CONTACT_DELETE_RECOVERY_FAILED",
    });
    return "retry" as const;
  }
}

async function liveDependencies(environment: EnvironmentSource): Promise<DeletionRecoveryDependencies> {
  const client = createSupabaseServiceClient();
  return {
    claim: async (limit) => {
      const { data, error } = await client.rpc("claim_contact_deletion_recovery", {
        p_limit: limit,
      });
      if (error) throw new Error("CONTACT_DELETE_RECOVERY_CLAIM_FAILED");
      return rows(data).map(parseClaim);
    },
    loadSnapshot: loadDeletionSnapshot,
    renew: async (input) => {
      const { error } = await client.rpc("renew_contact_deletion_lease", {
        p_expected_tenant: input.tenantId,
        p_intent_id: input.intentId,
        p_lease_token: input.leaseToken,
      });
      if (error) throw new Error("CONTACT_DELETE_RECOVERY_LEASE_LOST");
    },
    checkpoint: async (input) => {
      const { error } = await client.rpc("checkpoint_contact_deletion_provider", {
        p_expected_tenant: input.tenantId,
        p_actor_id: input.actorId,
        p_intent_id: input.intentId,
        p_lease_token: input.leaseToken,
        p_provider_evidence: input.evidence,
      });
      if (error) throw new Error("CONTACT_DELETE_RECOVERY_CHECKPOINT_FAILED");
    },
    finalize: async (input) => {
      const { error } = await client.rpc("finalize_contact_deletion_recovery", {
        p_expected_tenant: input.tenantId,
        p_intent_id: input.intentId,
        p_lease_token: input.leaseToken,
        p_tombstone_channels: input.channels,
        p_tombstone_hashes: input.hashes,
        p_tombstone_last4s: input.last4s,
        p_provider_receipt: input.providerReceipt,
      });
      if (error) throw new Error("CONTACT_DELETE_RECOVERY_FINALIZE_FAILED");
    },
    mark: async (input) => {
      const { error } = await client.rpc("mark_contact_deletion_recovery", {
        p_intent_id: input.intentId,
        p_lease_token: input.leaseToken,
        p_outcome: input.outcome,
        p_error: input.error,
      });
      if (error) throw new Error("CONTACT_DELETE_RECOVERY_MARK_FAILED");
    },
    provider: createLiveGhlDeletionProviderPort(),
    hashIdentifier: (value) => hashSuppressionIdentifier(value, environment),
    now: () => new Date(),
    newLeaseToken: randomUUID,
  };
}

export async function recoverContactDeletions(
  limit = 10,
  dependencies?: DeletionRecoveryDependencies,
  environment: EnvironmentSource = process.env,
) {
  const deps = dependencies ?? await liveDependencies(environment);
  const result = { claimed: 0, completed: 0, retried: 0, operatorRequired: 0 };
  for (let index = 0; index < limit; index += 1) {
    const claims = await deps.claim(1);
    if (claims.length === 0) break;
    if (claims.length !== 1) throw new Error("CONTACT_DELETE_RECOVERY_CLAIM_INVALID");
    result.claimed += 1;
    const outcome = await recoverContactDeletionClaim(claims[0], deps);
    if (outcome === "completed") result.completed += 1;
    else if (outcome === "retry") result.retried += 1;
    else result.operatorRequired += 1;
  }
  return result;
}

export async function recoverAdoptedContactDeletion(
  input: { tenantId: string; intentId: string; actorId: string },
  dependencies?: DeletionRecoveryDependencies,
  environment: EnvironmentSource = process.env,
) {
  const deps = dependencies ?? await liveDependencies(environment);
  const leaseToken = deps.newLeaseToken();
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("claim_contact_deletion_recovery_intent", {
    p_expected_tenant: input.tenantId,
    p_actor_id: input.actorId,
    p_intent_id: input.intentId,
    p_lease_token: leaseToken,
  });
  if (error) throw new Error("CONTACT_DELETE_RECOVERY_INTENT_CLAIM_FAILED");
  const claimRows = rows(data);
  if (claimRows.length !== 1) throw new Error("CONTACT_DELETE_RECOVERY_INTENT_CLAIM_INVALID");
  return recoverContactDeletionClaim(parseClaim(claimRows[0]), deps);
}
