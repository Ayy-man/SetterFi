/**
 * A rehearsal turn: the lead's next message, played into a demo tenant's test thread.
 *
 * This is the inbound half of the simulated arm. It writes the same durable receipt a provider
 * webhook would, runs the same claimed-receipt processor, and reads the outcome back from the
 * rows that processor wrote. Nothing here is a shortcut into the engine: the receipt is real,
 * the conversation state machine is real, and the reply goes through the send gateway, where
 * the demo tenant routes it to the simulated driver.
 *
 * It is loud on purpose. A receipt that finishes `failed` is returned with its error code, and a
 * turn that produced no reply says why, so a person testing the platform sees the same fact the
 * recovery worker would have seen in the job receipts.
 */

import { randomUUID } from "node:crypto";

import type { NormalizedInboundMessage } from "@/lib/integrations/types";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  persistWebhookReceipt,
  processLiveWebhookReceipt,
  tenantReceiptEventId,
  type ProcessedInboundBatch,
  type WebhookReceiptRead,
  type WebhookReceiptWrite,
} from "@/lib/webhooks/process-inbound";

export const REHEARSAL_MAX_BODY = 1_000;

export type RehearsalOutcome = {
  receiptId: string;
  /** True when the caller's idempotency key matched a receipt already written. */
  replayed: boolean;
  receiptStatus: WebhookReceiptRead["status"];
  /** The processor's own error code when the receipt did not finish `processed`. */
  error: string | null;
  /**
   * What the processor did with the lead's message: `sent`, `held`, `no_send`, `control`,
   * `deferred` (quiet hours; the reply is scheduled as a follow-up), or `refused` with the send
   * gateway's reason. Null when the processor reported nothing, which
   * happens when the receipt was claimed elsewhere first.
   */
  turn: { kind: string; reason: string | null } | null;
  conversationStatus: string | null;
  reply: {
    messageId: string;
    body: string;
    providerMessageId: string | null;
    simulated: boolean;
  } | null;
};

export type RehearsalDependencies = {
  loadThread(input: { tenantId: string; conversationId: string }): Promise<{
    isDemo: boolean;
    isTest: boolean;
    channel: string;
    identity: {
      provider: "ghl" | "meta_direct";
      channel: NormalizedInboundMessage["identity"]["channel"];
      externalId: string;
      normalizedPhone: string | null;
      normalizedEmail: string | null;
      providerAccountId: string | null;
    } | null;
  } | null>;
  persistReceipt(input: WebhookReceiptWrite): Promise<WebhookReceiptRead>;
  /** The receipt an earlier submit with the same key wrote, if any. Absent means never replayed. */
  findReceipt?(input: { provider: "ghl" | "meta"; providerEventId: string; tenantId: string }): Promise<WebhookReceiptRead | null>;
  processReceipt(receipt: WebhookReceiptRead): Promise<ProcessedInboundBatch | null>;
  readOutcome(input: {
    tenantId: string;
    conversationId: string;
    receiptId: string;
    /** The inbound event this turn wrote, for callers that correlate by message rather than attempt. */
    eventId: string;
  }): Promise<Omit<RehearsalOutcome, "receiptId" | "turn" | "replayed">>;
  now?: () => Date;
};

export function rehearsalBody(value: unknown) {
  if (typeof value !== "string") return null;
  const body = value.trim();
  if (!body || body.length > REHEARSAL_MAX_BODY) return null;
  return body;
}

export const REHEARSAL_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function rehearseLeadTurn(
  input: {
    tenantId: string;
    conversationId: string;
    actorId: string;
    body: string;
    /**
     * Supplied by the caller per draft. A retry of the same request then lands on the receipt
     * already written, so a timed-out submit cannot play the lead's line twice.
     */
    idempotencyKey?: string;
  },
  dependencies: RehearsalDependencies = liveRehearsalDependencies(),
): Promise<RehearsalOutcome> {
  const body = rehearsalBody(input.body);
  if (!body) throw new Error("REHEARSAL_BODY_INVALID");
  const thread = await dependencies.loadThread(input);
  if (!thread) throw new Error("REHEARSAL_CONVERSATION_NOT_FOUND");
  // Both facts, not either: a demo tenant's real-looking thread and a real tenant's test thread
  // are each refused, so the rehearsal can only ever touch rows analytics already exclude.
  if (!thread.isDemo || !thread.isTest) throw new Error("REHEARSAL_THREAD_NOT_REHEARSABLE");
  if (!thread.identity) throw new Error("REHEARSAL_IDENTITY_REQUIRED");

  if (input.idempotencyKey !== undefined && !REHEARSAL_KEY_PATTERN.test(input.idempotencyKey)) {
    throw new Error("REHEARSAL_KEY_INVALID");
  }
  const now = (dependencies.now ?? (() => new Date()))();
  const observedAt = now.toISOString();
  const eventId = `rehearsal:${input.conversationId}:${input.idempotencyKey ?? randomUUID()}`;
  const event: NormalizedInboundMessage = {
    kind: "message",
    eventId,
    providerMessageId: eventId,
    body,
    externalAccountId: thread.identity.providerAccountId ?? `rehearsal:${input.tenantId}`,
    identity: {
      channel: thread.identity.channel,
      provider: thread.identity.provider,
      externalId: thread.identity.externalId,
      normalizedPhone: thread.identity.normalizedPhone,
      normalizedEmail: thread.identity.normalizedEmail,
    },
    providerWindow: {
      observedAt,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
      source: "derived_24h",
    },
  };
  const provider = thread.identity.provider === "ghl" ? "ghl" : "meta";
  const providerEventId = tenantReceiptEventId({ tenantId: input.tenantId, eventId, providerMessageId: eventId });
  // The payload carries the observation time, so a retry cannot be re-persisted as the same
  // receipt; it is looked up by the key instead and the rest of the turn reads from what the
  // first submit wrote.
  const existing = input.idempotencyKey !== undefined
    ? await dependencies.findReceipt?.({ provider, providerEventId, tenantId: input.tenantId }) ?? null
    : null;
  const receipt = existing ?? await dependencies.persistReceipt({
    provider,
    providerEventId,
    tenantId: input.tenantId,
    eventType: "InboundMessage",
    payload: {
      // Provenance lives here: the claim RPC only hands out receipts whose signature flag is
      // set, so that flag is the processing gate rather than a statement about a provider.
      raw: { rehearsal: true, actorId: input.actorId },
      normalized: { events: [event] },
    },
  });
  let processingError: string | null = null;
  let turn: RehearsalOutcome["turn"] = null;
  try {
    const processed = await dependencies.processReceipt(receipt);
    const first = processed?.events.find((entry) => entry.eventId === eventId) ?? processed?.events[0] ?? null;
    if (first) {
      // The processor folds a quiet-hours deferral into `refused`, since from its seat nothing
      // was sent. For the person rehearsing, "held until morning" and "refused" are different
      // facts, so the deferral is named as such here.
      const deferred = first.kind === "refused" && first.reason === "quiet_hours";
      turn = {
        kind: deferred ? "deferred" : first.kind,
        reason: first.kind === "refused" ? first.reason : null,
      };
    }
  } catch (error) {
    processingError = error instanceof Error ? error.message.slice(0, 200) : "REHEARSAL_PROCESSING_FAILED";
  }
  const outcome = await dependencies.readOutcome({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    receiptId: receipt.id,
    eventId,
  });
  return {
    receiptId: receipt.id,
    replayed: existing !== null,
    ...outcome,
    turn,
    error: outcome.error ?? processingError,
  };
}

export function liveRehearsalDependencies(): RehearsalDependencies {
  const client = createSupabaseServiceClient();
  return {
    loadThread: async ({ tenantId, conversationId }) => {
      const { data: conversation, error } = await client.from("conversations")
        .select("id,contact_id,channel,is_test")
        .eq("tenant_id", tenantId).eq("id", conversationId).maybeSingle();
      if (error) throw new Error(`REHEARSAL_CONVERSATION_READ_FAILED:${error.message}`);
      if (!conversation) return null;
      const [{ data: tenant, error: tenantError }, { data: identity, error: identityError }] = await Promise.all([
        client.from("tenants").select("is_demo").eq("id", tenantId).single(),
        client.from("contact_identities")
          .select("provider,channel,provider_identity_id,normalized_phone,normalized_email,provider_account_id")
          .eq("tenant_id", tenantId).eq("contact_id", conversation.contact_id)
          .eq("channel", conversation.channel).limit(1).maybeSingle(),
      ]);
      if (tenantError || !tenant) throw new Error("REHEARSAL_TENANT_READ_FAILED");
      if (identityError) throw new Error(`REHEARSAL_IDENTITY_READ_FAILED:${identityError.message}`);
      const provider = identity?.provider === "ghl" || identity?.provider === "meta_direct"
        ? identity.provider
        : null;
      return {
        isDemo: tenant.is_demo === true,
        isTest: conversation.is_test === true,
        channel: conversation.channel,
        identity: identity && provider && typeof identity.provider_identity_id === "string"
          ? {
              provider,
              channel: identity.channel,
              externalId: identity.provider_identity_id,
              normalizedPhone: identity.normalized_phone ?? null,
              normalizedEmail: identity.normalized_email ?? null,
              providerAccountId: identity.provider_account_id ?? null,
            }
          : null,
      };
    },
    persistReceipt: (input) => persistWebhookReceipt(input),
    findReceipt: async ({ provider, providerEventId, tenantId }) => {
      const { data, error } = await client.from("webhook_events")
        .select("id, provider, provider_event_id, tenant_id, event_type, payload, status")
        .eq("tenant_id", tenantId).eq("provider", provider).eq("provider_event_id", providerEventId).maybeSingle();
      if (error) throw new Error("REHEARSAL_RECEIPT_LOOKUP_FAILED");
      if (!data) return null;
      return {
        id: String(data.id),
        inserted: false,
        provider: data.provider as "ghl" | "meta",
        providerEventId: String(data.provider_event_id),
        tenantId: typeof data.tenant_id === "string" ? data.tenant_id : null,
        eventType: String(data.event_type),
        payload: (data.payload ?? {}) as Record<string, unknown>,
        status: data.status as WebhookReceiptRead["status"],
      };
    },
    processReceipt: (receipt) => processLiveWebhookReceipt(receipt),
    readOutcome: async ({ tenantId, conversationId, receiptId }) => {
      // The reply is the message the send gateway persisted for this receipt: every outbound
      // attempt records the webhook event it answers, so a concurrent rehearsal or a genuine
      // inbound on the same thread can never be reported as this turn's. (The engine-turn table
      // itself is written through RPCs and is not readable by the service role.)
      const [receiptResult, conversationResult, attemptResult] = await Promise.all([
        client.from("webhook_events").select("status,error").eq("tenant_id", tenantId).eq("id", receiptId).single(),
        client.from("conversations").select("status").eq("tenant_id", tenantId).eq("id", conversationId).single(),
        client.from("outbound_send_attempts").select("message_id")
          .eq("tenant_id", tenantId).eq("conversation_id", conversationId)
          .eq("origin_webhook_event_id", receiptId).not("message_id", "is", null)
          .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      ]);
      if (receiptResult.error || !receiptResult.data) throw new Error("REHEARSAL_READBACK_FAILED:receipt");
      if (conversationResult.error || !conversationResult.data) throw new Error("REHEARSAL_READBACK_FAILED:conversation");
      if (attemptResult.error) throw new Error("REHEARSAL_READBACK_FAILED:attempt");
      let reply: { id: string; body: string; provider_message_id: string | null } | null = null;
      if (typeof attemptResult.data?.message_id === "string") {
        const replyResult = await client.from("messages").select("id,body,provider_message_id")
          .eq("tenant_id", tenantId).eq("id", attemptResult.data.message_id).single();
        if (replyResult.error || !replyResult.data) throw new Error("REHEARSAL_READBACK_FAILED:reply");
        reply = replyResult.data;
      }
      const receipt = receiptResult.data;
      const conversation = conversationResult.data;
      const status = receipt.status;
      return {
        receiptStatus: status === "processed" || status === "failed" || status === "skipped" ? status : "received",
        error: typeof receipt.error === "string" && receipt.error ? receipt.error : null,
        conversationStatus: typeof conversation.status === "string" ? conversation.status : null,
        reply: reply
          ? {
              messageId: reply.id,
              body: reply.body,
              providerMessageId: reply.provider_message_id ?? null,
              simulated: typeof reply.provider_message_id === "string" && reply.provider_message_id.startsWith("simulated:"),
            }
          : null,
      };
    },
  };
}
