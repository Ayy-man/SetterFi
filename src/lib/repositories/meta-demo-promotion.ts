/**
 * Promotes a demo tenant's Meta connection from `ready` to `live` with a synthetic signed
 * round-trip receipt, so Setup and Home read "Connected" and "Answering" right after the demo
 * connect flow -- the same receipt-backed truth a real tenant only earns once an actual inbound
 * and outbound message clear the webhook.
 *
 * `channel_connections_meta_live_receipt_chk` (20260820000001_phase4_channels.sql) requires a
 * `live` `meta_direct` connection to carry a verified asset, a subscribed webhook, a signed
 * round trip, and both a `last_signed_inbound_receipt_id` and a `last_signed_outbound_message_id`
 * that resolve to real `webhook_events` and `messages` rows. There is no shortcut around that
 * constraint, so this seeds a genuine (`is_test = true`) contact, conversation, message pair and
 * webhook event rather than writing a receipt id that points nowhere.
 *
 * Every row this writes is keyed off the connection id, so a second call (a coach reconnecting,
 * or a retried request) reuses the same synthetic contact/conversation/messages/event instead of
 * multiplying demo data.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type PromoteDemoConnectionInput = {
  tenantId: string;
  connectionId: string;
  channel: "instagram" | "messenger";
  assetId: string;
  assetLabel: string;
};

const DEMO_RECEIPT_BODY = "Demo signed round trip (SetterFi demo Meta connect).";

export async function promoteDemoMetaConnectionToLive(
  input: PromoteDemoConnectionInput,
): Promise<{ promoted: boolean }> {
  const tenantId = input.tenantId.trim();
  const connectionId = input.connectionId.trim();
  if (!tenantId || !connectionId) throw new Error("DEMO_META_PROMOTION_INPUT_REQUIRED");

  const client = createSupabaseServiceClient();
  const now = new Date().toISOString();
  const demoContactKey = `demo-meta-connect-${input.channel}`;
  const inboundKey = `demo-meta-connect-inbound-${connectionId}`;
  const outboundKey = `demo-meta-connect-outbound-${connectionId}`;
  const receiptKey = `demo-meta-connect-round-trip-${connectionId}`;

  const { data: connection, error: connectionReadError } = await client
    .from("channel_connections")
    .select("id, tenant_id, external_ref, signed_round_trip_at")
    .eq("id", connectionId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (connectionReadError || !connection) throw new Error("DEMO_META_PROMOTION_CONNECTION_MISSING");

  // Already promoted: idempotent no-op rather than a second receipt chain.
  if (connection.signed_round_trip_at) return { promoted: true };

  const { data: contact, error: contactError } = await client
    .from("contacts")
    .upsert({
      tenant_id: tenantId,
      ghl_contact_id: demoContactKey,
      channel: input.channel,
      name: assetLabelToContactName(input.assetLabel),
      is_test: true,
    }, { onConflict: "tenant_id,ghl_contact_id" })
    .select("id")
    .single();
  if (contactError || !contact) throw new Error("DEMO_META_PROMOTION_CONTACT_FAILED");

  const { data: existingConversation, error: existingConversationError } = await client
    .from("conversations")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contact.id)
    .eq("channel", input.channel)
    .maybeSingle();
  if (existingConversationError) throw new Error("DEMO_META_PROMOTION_CONVERSATION_READ_FAILED");

  const conversationId = existingConversation?.id ?? await (async () => {
    const { data: created, error: createError } = await client
      .from("conversations")
      .insert({
        tenant_id: tenantId,
        contact_id: contact.id,
        channel: input.channel,
        status: "agent",
        is_test: true,
        unread_by_coach: false,
        last_message_at: now,
      })
      .select("id")
      .single();
    if (createError || !created) throw new Error("DEMO_META_PROMOTION_CONVERSATION_FAILED");
    return created.id as string;
  })();

  // The inbound leg of the round trip: not itself referenced by the connection row (the check
  // constraint wants the webhook receipt, not the message), but written so the demo conversation
  // shows a real inbound/outbound pair rather than an outbound message with nothing to answer.
  await upsertDemoMessage(client, {
    tenantId,
    conversationId,
    direction: "in",
    author: "lead",
    providerMessageId: inboundKey,
  });
  const outboundMessage = await upsertDemoMessage(client, {
    tenantId,
    conversationId,
    direction: "out",
    author: "agent",
    providerMessageId: outboundKey,
  });

  const webhookEventId = await upsertDemoWebhookEvent(client, {
    tenantId,
    providerEventId: receiptKey,
  });

  const mergedExternalRef = {
    ...(isRecord(connection.external_ref) ? connection.external_ref : {}),
    account_id: input.assetId,
    demo: true,
    demo_promoted_at: now,
  };

  const { error: updateError } = await client
    .from("channel_connections")
    .update({
      state: "live",
      is_test: true,
      signed_round_trip_at: now,
      last_signed_inbound_receipt_id: webhookEventId,
      last_signed_outbound_message_id: outboundMessage,
      external_ref: mergedExternalRef,
      updated_at: now,
    })
    .eq("id", connectionId)
    .eq("tenant_id", tenantId);
  if (updateError) throw new Error("DEMO_META_PROMOTION_UPDATE_FAILED");

  return { promoted: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assetLabelToContactName(label: string) {
  return `${label.trim() || "Demo lead"} (demo)`;
}

type ServiceClient = ReturnType<typeof createSupabaseServiceClient>;

async function upsertDemoMessage(
  client: ServiceClient,
  input: {
    tenantId: string;
    conversationId: string;
    direction: "in" | "out";
    author: string;
    providerMessageId: string;
  },
): Promise<string> {
  const { data: existing, error: existingError } = await client
    .from("messages")
    .select("id")
    .eq("provider_message_id", input.providerMessageId)
    .maybeSingle();
  if (existingError) throw new Error("DEMO_META_PROMOTION_MESSAGE_READ_FAILED");
  if (existing) return existing.id as string;

  const { data: created, error: createError } = await client
    .from("messages")
    .insert({
      tenant_id: input.tenantId,
      conversation_id: input.conversationId,
      direction: input.direction,
      author: input.author,
      body: DEMO_RECEIPT_BODY,
      provider: "meta_direct",
      provider_message_id: input.providerMessageId,
      is_test: true,
    })
    .select("id")
    .single();
  if (createError || !created) throw new Error("DEMO_META_PROMOTION_MESSAGE_FAILED");
  return created.id as string;
}

async function upsertDemoWebhookEvent(
  client: ServiceClient,
  input: { tenantId: string; providerEventId: string },
): Promise<string> {
  const { data: existing, error: existingError } = await client
    .from("webhook_events")
    .select("id")
    .eq("provider", "meta")
    .eq("provider_event_id", input.providerEventId)
    .maybeSingle();
  if (existingError) throw new Error("DEMO_META_PROMOTION_WEBHOOK_READ_FAILED");
  if (existing) return existing.id as string;

  const now = new Date().toISOString();
  const { data: created, error: createError } = await client
    .from("webhook_events")
    .insert({
      provider: "meta",
      provider_event_id: input.providerEventId,
      tenant_id: input.tenantId,
      event_type: "demo.round_trip",
      signature_verified: true,
      payload: { demo: true, note: DEMO_RECEIPT_BODY },
      status: "processed",
      received_at: now,
      processed_at: now,
    })
    .select("id")
    .single();
  if (createError || !created) throw new Error("DEMO_META_PROMOTION_WEBHOOK_FAILED");
  return created.id as string;
}
