import {
  createComplianceEventEmitter,
  createNotificationRepository,
  outboundSendUnconfirmedEvent,
} from "@/lib/notifications/events";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type OutboundReconciliationClaim = {
  attemptId: string;
  tenantId: string;
  conversationId: string;
  idempotencyKey: string;
  disposition: "accepted" | "indeterminate";
  claimToken: string;
  providerMessageId: string | null;
  acceptedAt: string | null;
  errorCode: string;
  isTest: boolean;
  reconciliationAttempt: number;
};

export type OutboundReconciliationDependencies = {
  claim(now: Date, limit: number): Promise<readonly OutboundReconciliationClaim[]>;
  persistAccepted(claim: OutboundReconciliationClaim): Promise<void>;
  alertIndeterminate(claim: OutboundReconciliationClaim, now: Date): Promise<void>;
  finish(input: {
    claim: OutboundReconciliationClaim;
    outcome: "alerted" | "retry";
    error: string | null;
    retryAt: string | null;
    now: Date;
  }): Promise<void>;
};

function retryAt(now: Date, attempt: number) {
  const delayMinutes = Math.min(60, 2 ** Math.min(Math.max(attempt - 1, 0), 5));
  return new Date(now.getTime() + delayMinutes * 60_000).toISOString();
}

function safeError(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message.slice(0, 200)
    : "OUTBOUND_RECONCILIATION_RUNTIME_FAILED";
}

export async function runOutboundReconciliationBatch(
  dependencies: OutboundReconciliationDependencies,
  now = new Date(),
  limit = 25,
) {
  const claims = await dependencies.claim(now, limit);
  const receipt = { claimed: claims.length, persisted: 0, alerted: 0, retryable: 0 };
  for (const claim of claims) {
    try {
      if (claim.disposition === "accepted") {
        if (!claim.providerMessageId || !claim.acceptedAt) {
          throw new Error("OUTBOUND_ACCEPTED_RECEIPT_INVALID");
        }
        await dependencies.persistAccepted(claim);
        receipt.persisted += 1;
        continue;
      }
      await dependencies.alertIndeterminate(claim, now);
      await dependencies.finish({ claim, outcome: "alerted", error: null, retryAt: null, now });
      receipt.alerted += 1;
    } catch (error) {
      await dependencies.finish({
        claim,
        outcome: "retry",
        error: safeError(error),
        retryAt: retryAt(now, claim.reconciliationAttempt),
        now,
      });
      receipt.retryable += 1;
    }
  }
  return receipt;
}

function parseClaims(value: unknown): OutboundReconciliationClaim[] {
  if (!Array.isArray(value)) throw new Error("OUTBOUND_RECONCILIATION_CLAIMS_INVALID");
  return value.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("OUTBOUND_RECONCILIATION_CLAIMS_INVALID");
    const row = raw as Record<string, unknown>;
    if (
      typeof row.attempt_id !== "string" || typeof row.tenant_id !== "string"
      || typeof row.conversation_id !== "string" || typeof row.idempotency_key !== "string"
      || !["accepted", "indeterminate"].includes(String(row.disposition))
      || typeof row.claim_token !== "string" || typeof row.is_test !== "boolean"
      || !Number.isSafeInteger(Number(row.reconciliation_attempt))
    ) throw new Error("OUTBOUND_RECONCILIATION_CLAIMS_INVALID");
    return {
      attemptId: row.attempt_id,
      tenantId: row.tenant_id,
      conversationId: row.conversation_id,
      idempotencyKey: row.idempotency_key,
      disposition: row.disposition as "accepted" | "indeterminate",
      claimToken: row.claim_token,
      providerMessageId: typeof row.provider_message_id === "string" ? row.provider_message_id : null,
      acceptedAt: typeof row.accepted_at === "string" ? row.accepted_at : null,
      errorCode: typeof row.error_code === "string" ? row.error_code : "PROVIDER_ACCEPTANCE_UNKNOWN",
      isTest: row.is_test,
      reconciliationAttempt: Number(row.reconciliation_attempt),
    };
  });
}

export function createLiveOutboundReconciliationDependencies(): OutboundReconciliationDependencies {
  const client = createSupabaseServiceClient();
  const emit = createComplianceEventEmitter(createNotificationRepository());
  return {
    claim: async (now, limit) => {
      const { data, error } = await client.rpc("claim_outbound_reconciliation_batch", {
        p_limit: limit,
        p_lease_seconds: 300,
        p_now: now.toISOString(),
      });
      if (error) throw new Error("OUTBOUND_RECONCILIATION_CLAIM_FAILED");
      return parseClaims(data);
    },
    persistAccepted: async (claim) => {
      const { data, error } = await client.rpc("persist_claimed_outbound_send", {
        p_expected_tenant: claim.tenantId,
        p_idempotency_key: claim.idempotencyKey,
        p_claim_token: claim.claimToken,
        p_actor_id: null,
        p_provider_message_id: claim.providerMessageId,
        p_is_test: claim.isTest,
      });
      const row = data?.[0];
      if (error || !row?.message_id || !row.audit_id || !row.persisted_at) {
        throw new Error("OUTBOUND_ACCEPTED_PERSISTENCE_FAILED");
      }
    },
    alertIndeterminate: async (claim, now) => {
      const result = await emit(outboundSendUnconfirmedEvent({
        tenantId: claim.tenantId,
        outboundAttemptId: claim.attemptId,
        conversationId: claim.conversationId,
        idempotencyKey: claim.idempotencyKey,
        errorCode: claim.errorCode,
        occurredAt: now.toISOString(),
        isTest: claim.isTest,
      }));
      if (result.notificationIds.length === 0) {
        throw new Error("OUTBOUND_RECONCILIATION_ALERT_RECIPIENT_MISSING");
      }
    },
    finish: async (input) => {
      const { data, error } = await client.rpc("finish_outbound_reconciliation_attempt", {
        p_attempt_id: input.claim.attemptId,
        p_claim_token: input.claim.claimToken,
        p_outcome: input.outcome,
        p_error: input.error,
        p_retry_at: input.retryAt,
        p_now: input.now.toISOString(),
      });
      if (error || (input.outcome === "alerted" && data == null)) {
        throw new Error("OUTBOUND_RECONCILIATION_FINISH_FAILED");
      }
    },
  };
}
