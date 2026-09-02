import { createHmac, timingSafeEqual } from "node:crypto";

import { phase8AlertsLive } from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };
const MAX_WEBHOOK_BYTES = 256 * 1024;
export const RESEND_SIGNATURE_TOLERANCE_SECONDS = 300;
const EVENT_TYPES = ["email.delivered", "email.bounced", "email.complained", "email.failed"] as const;
type ResendEventType = (typeof EVENT_TYPES)[number];

export type VerifiedResendEvent = {
  providerEventId: string;
  eventType: ResendEventType;
  providerReference: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};

type Receipt = { inserted: boolean; status: "received" | "processed" | "failed" };
type Dependencies = {
  enabled(): boolean;
  signingSecret: string | null;
  now(): Date;
  persist(event: VerifiedResendEvent): Promise<Receipt>;
  apply(event: VerifiedResendEvent): Promise<void>;
};

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers });
}

function signingKey(secret: string | null) {
  if (!secret?.startsWith("whsec_")) return null;
  const suffix = secret.slice(6);
  if (!suffix || !/^[A-Za-z0-9+/]+={0,2}$/.test(suffix)) return null;
  const key = Buffer.from(suffix, "base64");
  const normalized = suffix.replace(/=+$/, "");
  if (!key.length || key.toString("base64").replace(/=+$/, "") !== normalized) return null;
  return key;
}

function signatureMatches(input: {
  key: Buffer;
  providerEventId: string;
  timestamp: string;
  rawBody: Uint8Array;
  signatureHeader: string;
}) {
  const expected = createHmac("sha256", input.key)
    .update(Buffer.from(`${input.providerEventId}.${input.timestamp}.`, "utf8"))
    .update(input.rawBody)
    .digest();
  let matched = false;
  for (const entry of input.signatureHeader.split(/\s+/).filter(Boolean)) {
    const separator = entry.indexOf(",");
    if (separator < 0 || entry.slice(0, separator) !== "v1") continue;
    const encoded = entry.slice(separator + 1);
    let candidate: Buffer;
    try {
      candidate = Buffer.from(encoded, "base64");
    } catch {
      candidate = Buffer.alloc(0);
    }
    const comparable = Buffer.alloc(expected.length);
    candidate.copy(comparable, 0, 0, expected.length);
    const equal = timingSafeEqual(expected, comparable) && candidate.length === expected.length;
    matched = equal || matched;
  }
  return matched;
}

function parseVerifiedEvent(rawBody: Uint8Array, providerEventId: string): VerifiedResendEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const data = record.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const eventType = record.type;
  const providerReference = (data as Record<string, unknown>).email_id;
  const occurredAt = record.created_at;
  if (!EVENT_TYPES.includes(eventType as ResendEventType)
    || typeof providerReference !== "string" || !providerReference.trim()
    || typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt))) return null;
  return {
    providerEventId,
    eventType: eventType as ResendEventType,
    providerReference,
    occurredAt,
    payload: record,
  };
}

export function createResendWebhookHandler(dependencies: Dependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) return json({ error: "Not found." }, 404);
    const providerEventId = request.headers.get("svix-id")?.trim() ?? "";
    const timestamp = request.headers.get("svix-timestamp")?.trim() ?? "";
    const signatureHeader = request.headers.get("svix-signature")?.trim() ?? "";
    const key = signingKey(dependencies.signingSecret);
    const seconds = Number(timestamp);
    const nowSeconds = Math.floor(dependencies.now().getTime() / 1_000);
    if (!providerEventId || !signatureHeader || !key || !Number.isSafeInteger(seconds)
      || Math.abs(nowSeconds - seconds) > RESEND_SIGNATURE_TOLERANCE_SECONDS) {
      return json({ error: "Invalid webhook signature." }, 401);
    }

    let rawBody: Uint8Array;
    try {
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return json({ error: "Webhook body is too large." }, 413);
      rawBody = new Uint8Array(await request.arrayBuffer());
      if (rawBody.byteLength > MAX_WEBHOOK_BYTES) return json({ error: "Webhook body is too large." }, 413);
    } catch {
      return json({ error: "Webhook body could not be read." }, 503);
    }
    if (!signatureMatches({ key, providerEventId, timestamp, rawBody, signatureHeader })) {
      return json({ error: "Invalid webhook signature." }, 401);
    }

    // JSON parsing and every write happen only after the exact raw bytes verify.
    const event = parseVerifiedEvent(rawBody, providerEventId);
    if (!event) return json({ error: "Invalid webhook event." }, 400);
    try {
      const receipt = await dependencies.persist(event);
      if (receipt.status !== "processed") await dependencies.apply(event);
      return json({ received: true, duplicate: !receipt.inserted }, 200);
    } catch {
      return json({ error: "Webhook receipt unavailable." }, 503);
    }
  };
}

function createLiveDependencies(): Pick<Dependencies, "persist" | "apply"> {
  const client = createSupabaseServiceClient();
  return {
    persist: async (event) => {
      const inserted = await client.from("webhook_events").insert({
        provider: "resend", provider_event_id: event.providerEventId,
        tenant_id: null, event_type: event.eventType, signature_verified: true,
        payload: event.payload, status: "received",
      }).select("status").single();
      if (!inserted.error && inserted.data) return { inserted: true, status: inserted.data.status as Receipt["status"] };
      if (inserted.error?.code !== "23505") throw new Error("RESEND_RECEIPT_WRITE_FAILED");
      const existing = await client.from("webhook_events").select("status")
        .eq("provider", "resend").eq("provider_event_id", event.providerEventId).single();
      if (existing.error || !existing.data) throw new Error("RESEND_RECEIPT_DEDUPE_READ_FAILED");
      return { inserted: false, status: existing.data.status as Receipt["status"] };
    },
    apply: async (event) => {
      if (event.eventType === "email.delivered" || event.eventType === "email.bounced") {
        const { error } = await client.rpc("apply_resend_delivery_receipt", {
          p_provider_event_id: event.providerEventId,
          p_provider_reference: event.providerReference,
          p_event_type: event.eventType,
          p_occurred_at: event.occurredAt,
        });
        if (error) throw new Error("RESEND_RECEIPT_APPLY_FAILED");
        return;
      }
      const code = event.eventType === "email.complained" ? "RESEND_COMPLAINED" : "RESEND_FAILED";
      const delivery = await client.from("notification_deliveries").update({
        status: "unavailable", terminal_at: event.occurredAt, next_attempt_at: null,
        delivered_at: null, lease_token: null, lease_expires_at: null, last_error_code: code,
        error: "Signed provider terminal receipt",
      }).eq("destination", "email").eq("provider_reference", event.providerReference)
        .in("status", ["accepted", "delivered", "unavailable"]).select("id").single();
      if (delivery.error || !delivery.data) throw new Error("RESEND_RECEIPT_DELIVERY_NOT_FOUND");
      const receipt = await client.from("webhook_events").update({
        status: "processed", processed_at: new Date().toISOString(), error: null,
      }).eq("provider", "resend").eq("provider_event_id", event.providerEventId)
        .eq("signature_verified", true).neq("status", "processed");
      if (receipt.error) throw new Error("RESEND_RECEIPT_FINISH_FAILED");
    },
  };
}

const live = () => createLiveDependencies();
export const POST = createResendWebhookHandler({
  enabled: phase8AlertsLive,
  signingSecret: process.env.RESEND_WEBHOOK_SIGNING_SECRET?.trim() || null,
  now: () => new Date(),
  persist: (event) => live().persist(event),
  apply: (event) => live().apply(event),
});
