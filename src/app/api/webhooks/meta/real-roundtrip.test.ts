import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { environmentValue, type EnvironmentName } from "@/lib/env-contract";
import { META_GRAPH_VERSION, createRealMetaDriver } from "@/lib/integrations/meta";

const REQUIRED_NAMES = [
  "APP_BASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "META_APP_ID",
  "META_APP_SECRET",
  "META_SYSTEM_USER_TOKEN",
  "META_WEBHOOK_VERIFY_TOKEN",
  "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
  "META_WHATSAPP_SYSTEM_USER_TOKEN",
  "META_WABA_ID",
  "META_WHATSAPP_PHONE_NUMBER_ID",
] as const satisfies readonly EnvironmentName[];

function skipReason() {
  const missing = REQUIRED_NAMES.filter((name) => !environmentValue(name));
  const reasons = [];
  if (environmentValue("SETTERFI_META_DRIVER") !== "real") {
    reasons.push("SETTERFI_META_DRIVER=real is required");
  }
  if (process.env.SETTERFI_META_REAL_ROUNDTRIP?.trim() !== "confirmed") {
    reasons.push("SETTERFI_META_REAL_ROUNDTRIP=confirmed is required");
  }
  if (missing.length > 0) reasons.push(`${missing.join(", ")} are missing`);
  return reasons.length > 0 ? reasons.join("; ") : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function events(payload: unknown) {
  const normalized = record(record(payload)?.normalized);
  return Array.isArray(normalized?.events)
    ? normalized.events.map(record).filter((event): event is Record<string, unknown> => event !== null)
    : [];
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const armSkipReason = skipReason();

describe.skipIf(Boolean(armSkipReason))(
  `Meta signed real round trip — SKIPPED: ${armSkipReason ?? "configured"}`,
  () => {
    it("requires provider response ID, signed receipt, and persisted readback", async (context) => {
      const appBaseUrl = new URL(environmentValue("APP_BASE_URL")!);
      const databaseUrl = new URL(environmentValue("NEXT_PUBLIC_SUPABASE_URL")!);
      if ([appBaseUrl.hostname, databaseUrl.hostname].some((host) =>
        host === "127.0.0.1" || host === "localhost" || host === "::1"
      )) {
        context.skip("APP_BASE_URL and NEXT_PUBLIC_SUPABASE_URL must name the deployed callback and database");
        return;
      }

      const client = createClient(
        databaseUrl.toString(),
        environmentValue("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { autoRefreshToken: false, persistSession: false } },
      );
      const phoneId = environmentValue("META_WHATSAPP_PHONE_NUMBER_ID")!;
      const recent = await client
        .from("webhook_events")
        .select("id,tenant_id,provider_event_id,signature_verified,payload,status,received_at")
        .eq("provider", "meta")
        .eq("signature_verified", true)
        .order("received_at", { ascending: false })
        .limit(100);
      if (recent.error) throw new Error(`META_REAL_RECEIPT_READ_FAILED:${recent.error.message}`);
      const candidate = (recent.data ?? []).flatMap((receipt) =>
        events(receipt.payload).map((event) => ({ receipt, event }))
      ).find(({ receipt, event }) => {
        const identity = record(event.identity);
        const providerWindow = record(event.providerWindow);
        return receipt.tenant_id
          && event.kind === "message"
          && event.externalAccountId === phoneId
          && identity?.channel === "whatsapp"
          && identity.provider === "meta_direct"
          && typeof identity.externalId === "string"
          && typeof providerWindow?.expiresAt === "string"
          && new Date(providerWindow.expiresAt).getTime() > Date.now();
      });
      if (!candidate) {
        context.skip("a current provider-signed WhatsApp test inbound is required before any outbound call");
        return;
      }

      const tenantId = String(candidate.receipt.tenant_id);
      const identity = record(candidate.event.identity)!;
      const recipientExternalId = String(identity.externalId);
      const [tenant, identityRows] = await Promise.all([
        client.from("tenants").select("id,is_demo").eq("id", tenantId).single(),
        client.from("contact_identities").select("contact_id")
          .eq("tenant_id", tenantId)
          .eq("provider", "meta_direct")
          .eq("channel", "whatsapp")
          .eq("provider_identity_id", recipientExternalId),
      ]);
      if (tenant.error || identityRows.error) throw new Error("META_REAL_TEST_BOUNDARY_READ_FAILED");
      if (tenant.data.is_demo !== true || identityRows.data.length !== 1) {
        context.skip("the signed inbound must resolve to exactly one identity in an is_demo tenant");
        return;
      }
      const contact = await client.from("contacts").select("id,is_test")
        .eq("id", identityRows.data[0].contact_id).eq("tenant_id", tenantId).single();
      if (contact.error) throw new Error("META_REAL_TEST_CONTACT_READ_FAILED");
      if (contact.data.is_test !== true) {
        context.skip("the designated signed inbound contact must be persisted as is_test");
        return;
      }

      const token = environmentValue("META_WHATSAPP_SYSTEM_USER_TOKEN")!;
      const driver = createRealMetaDriver({
        appId: environmentValue("META_APP_ID")!,
        appSecret: environmentValue("META_APP_SECRET")!,
        systemUserToken: environmentValue("META_SYSTEM_USER_TOKEN")!,
        webhookVerifyToken: environmentValue("META_WEBHOOK_VERIFY_TOKEN")!,
      }, {
        resolveConnection: async () => ({
          senderId: phoneId,
          accessToken: token,
          host: "https://graph.facebook.com",
        }),
      });
      const sent = await driver.send({
        kind: "freeform",
        recipientExternalId,
        channel: "whatsapp",
        body: "SETTERFI_DEMO_PLACEHOLDER_REAL_ROUNDTRIP",
      });
      expect(sent.providerMessageId).toEqual(expect.any(String));

      const providerEventId = `${tenantId}:${sent.providerMessageId}:no-message`;
      let signedReceipt: Record<string, unknown> | null = null;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const receipt = await client.from("webhook_events")
          .select("id,tenant_id,provider_event_id,signature_verified,payload,status")
          .eq("provider", "meta").eq("provider_event_id", providerEventId).maybeSingle();
        if (receipt.error) throw new Error(`META_REAL_STATUS_RECEIPT_FAILED:${receipt.error.message}`);
        if (receipt.data?.signature_verified === true) {
          signedReceipt = receipt.data;
          break;
        }
        await delay(1_000);
      }
      if (!signedReceipt) throw new Error("META_REAL_SIGNED_RECEIPT_TIMEOUT");
      expect(signedReceipt).toMatchObject({
        tenant_id: tenantId,
        provider_event_id: providerEventId,
        signature_verified: true,
      });

      const persistedReadback = await client.from("webhook_events")
        .select("id,tenant_id,provider_event_id,signature_verified,status")
        .eq("id", String(signedReceipt.id)).single();
      if (persistedReadback.error) {
        throw new Error(`META_REAL_PERSISTED_READBACK_FAILED:${persistedReadback.error.message}`);
      }
      expect(persistedReadback.data).toMatchObject({
        tenant_id: tenantId,
        provider_event_id: providerEventId,
        signature_verified: true,
      });
      expect(META_GRAPH_VERSION).toBe("v25.0");
    }, 90_000);
  },
);
