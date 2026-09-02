import { createHash, randomBytes } from "node:crypto";

import { verifyConsentBinding } from "@/lib/compliance/consent-binding";
import { environmentValue } from "@/lib/env-contract";
import { consumeTenantRateLimit, tenantRateLimitCallerKey } from "@/lib/rate-limit/tenant-rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { runLivePreviewTurn, type LivePreviewHistoryEntry } from "@/lib/webhooks/process-inbound";

import { createConsumerBookingService } from "./booking";

export const CONSUMER_LIMIT = { limit: 20, windowMs: 60_000 };
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

export type ConsumerSession = {
  tenantId: string;
  sessionId: string;
  conversationId: string;
  contactId: string;
  revision: number;
  status: string;
  currentStep: string | null;
  currentStepAsks: number;
  disclosurePending: boolean;
};

export function consumerSessionDigest(reference: string) {
  return createHash("sha256").update(reference, "utf8").digest("hex");
}

function sessionReference() {
  return randomBytes(32).toString("base64url");
}

function row(value: unknown, error: string) {
  const selected = Array.isArray(value) ? value[0] : value;
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) throw new Error(error);
  return selected as Record<string, unknown>;
}

function sessionFromRow(value: unknown): ConsumerSession {
  const selected = row(value, "CONSUMER_SESSION_READ_INVALID");
  if (["tenant_id", "session_id", "conversation_id", "contact_id", "conversation_status"].some(
    (key) => typeof selected[key] !== "string",
  ) || !Number.isInteger(selected.revision) || !Number.isInteger(selected.current_step_asks) ||
    typeof selected.disclosure_pending !== "boolean") throw new Error("CONSUMER_SESSION_READ_INVALID");
  return {
    tenantId: selected.tenant_id as string, sessionId: selected.session_id as string,
    conversationId: selected.conversation_id as string, contactId: selected.contact_id as string,
    revision: selected.revision as number, status: selected.conversation_status as string,
    currentStep: typeof selected.current_step === "string" ? selected.current_step : null,
    currentStepAsks: selected.current_step_asks as number, disclosurePending: selected.disclosure_pending as boolean,
  };
}

async function consume(request: Request, tenantId: string) {
  const client = createSupabaseServiceClient();
  return consumeTenantRateLimit({ tenantId, routeKey: "consumer-agent", callerKey: tenantRateLimitCallerKey(request), ...CONSUMER_LIMIT }, {
    client: { rpc: async (name, args) => { const { data, error } = await client.rpc(name, args); return { data, error }; } },
  });
}

export async function startConsumerSession(input: { request: Request; tenantSlug: string; consentToken: string }) {
  const secret = environmentValue("SETTERFI_TAG_SECRET");
  if (!secret) throw new Error("CONSUMER_CONSENT_BINDING_UNAVAILABLE");
  const client = createSupabaseServiceClient();
  const { data: tenant, error: tenantError } = await client.from("tenants").select("id,slug")
    .eq("slug", input.tenantSlug).eq("status", "active").maybeSingle();
  if (tenantError) throw new Error("CONSUMER_TENANT_READ_FAILED");
  if (!tenant) throw new Error("CONSUMER_TENANT_UNAVAILABLE");
  const limited = await consume(input.request, tenant.id);
  if (!limited.allowed) throw new Error(limited.reason ?? "CONSUMER_RATE_LIMITED");
  // The artifact id is read from the signed payload only so that it can be supplied back to the
  // verifier; it is not trusted until the HMAC and redemption row both agree with it.
  const [payload] = input.consentToken.split(".");
  let artifactId = "";
  try { artifactId = String(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).artifactId ?? ""); } catch { throw new Error("CONSUMER_CONSENT_BINDING_INVALID"); }
  const bound = verifyConsentBinding({ token: input.consentToken, secret, tenantId: tenant.id, artifactId, now: new Date() });
  if (!bound) throw new Error("CONSUMER_CONSENT_BINDING_INVALID");
  const { data: redemption, error: redemptionError } = await client.from("consent_binding_redemptions")
    .select("tenant_id,artifact_id,contact_identity_id,redeemed_at")
    .eq("form_submission_id", bound.formSubmissionId).maybeSingle();
  if (redemptionError) throw new Error("CONSUMER_CONSENT_READ_FAILED");
  if (!redemption || redemption.tenant_id !== tenant.id || redemption.artifact_id !== artifactId ||
    redemption.contact_identity_id !== bound.contactIdentityId || !redemption.redeemed_at) {
    throw new Error("CONSUMER_CONSENT_REQUIRED");
  }
  const reference = sessionReference();
  const { data, error } = await client.rpc("start_consumer_conversation_session", {
    p_tenant_slug: input.tenantSlug, p_contact_identity_id: bound.contactIdentityId,
    p_session_secret_hash: consumerSessionDigest(reference), p_expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });
  if (error) throw new Error(`CONSUMER_SESSION_START_FAILED:${error.message}`);
  const started = row(data, "CONSUMER_SESSION_START_EMPTY");
  return { sessionReference: reference, tenantId: String(started.tenant_id), conversationId: String(started.conversation_id),
    brand: { name: String(started.business_name), programName: String(started.program_name), privacyUrl: String(started.privacy_url ?? "") } };
}

export async function loadConsumerSession(reference: string): Promise<ConsumerSession> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("load_consumer_conversation_session", { p_session_secret_hash: consumerSessionDigest(reference) });
  if (error || !Array.isArray(data) || data.length !== 1) throw new Error("CONSUMER_SESSION_UNAVAILABLE");
  return sessionFromRow(data[0]);
}

export async function runConsumerTurn(input: { request: Request; sessionReference: string; message: string }) {
  const session = await loadConsumerSession(input.sessionReference);
  if (session.status !== "agent") throw new Error("CONSUMER_CONVERSATION_UNAVAILABLE");
  const limited = await consume(input.request, session.tenantId);
  if (!limited.allowed) throw new Error(limited.reason ?? "CONSUMER_RATE_LIMITED");
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("load_consumer_conversation_history", {
    p_session_secret_hash: consumerSessionDigest(input.sessionReference), p_limit: 20,
  });
  if (error || !Array.isArray(data)) throw new Error("CONSUMER_HISTORY_READ_FAILED");
  const history: LivePreviewHistoryEntry[] = [...data].reverse().flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    return (value.role === "user" || value.role === "assistant") && typeof value.content === "string"
      ? [{ role: value.role, content: value.content.slice(0, 800) } as LivePreviewHistoryEntry] : [];
  });
  const result = await runLivePreviewTurn({ tenantId: session.tenantId, message: input.message, history, mode: "production",
    channel: "sms", conversation: { state: "agent", currentStep: session.currentStep, currentStepAsks: session.currentStepAsks,
      disclosurePending: session.disclosurePending } });
  const nextStatus = result.response.state === "needs_human" ? "needs_human" : result.response.state === "nurture" ? "nurture" : result.response.state === "closed" ? "closed" : "agent";
  const { error: appendError } = await client.rpc("append_consumer_conversation_turn", {
    p_session_secret_hash: consumerSessionDigest(input.sessionReference), p_expected_revision: session.revision,
    p_lead_body: input.message, p_agent_body: result.response.reply, p_next_status: nextStatus,
  });
  if (appendError) throw new Error("CONSUMER_TRANSCRIPT_WRITE_FAILED");
  return { reply: result.response.reply, state: nextStatus === "needs_human" ? "handoff" : nextStatus === "agent" ? "active" : nextStatus,
    booking: result.response.booking ? {
      id: result.response.booking.id,
      slot: result.response.booking.startAt,
      label: result.response.booking.timezone,
    } : null,
    author: nextStatus === "needs_human" ? { role: "system" as const } : { role: "assistant" as const } };
}

export async function confirmConsumerBooking(input: { request: Request; sessionReference: string; selectedSlotId: string }) {
  const session = await loadConsumerSession(input.sessionReference);
  const limited = await consume(input.request, session.tenantId);
  if (!limited.allowed) throw new Error(limited.reason ?? "CONSUMER_RATE_LIMITED");
  const result = await createConsumerBookingService().bookDirectAppointment({ tenantId: session.tenantId,
    conversationId: session.conversationId, selectedSlotId: input.selectedSlotId });
  if (result.kind !== "booked") throw new Error(`CONSUMER_BOOKING_REFUSED:${result.kind}`);
  /*
   * `endAt` travels with `startAt` so the booked screen can offer a calendar file with a real
   * DTEND. It is the slot the provider confirmed, never a duration this code assumed: `appointments`
   * holds `end_at` as `not null` under an `end_at > start_at` check, `bookDirectAppointment` already
   * had it in hand, and it was simply being dropped here. An .ics whose length is guessed puts a
   * wrong-length block in a lead's calendar, which is worse than offering no file at all -- so if
   * this ever arrives absent, the screen renders no download rather than defaulting to half an hour.
   */
  return { appointmentId: result.appointment.appointmentId, startAt: result.slot.startAt,
    endAt: result.slot.endAt, timezone: result.slot.timezone,
    providerExternalId: result.providerExternalId, auditId: result.appointment.auditId };
}
