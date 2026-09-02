import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  DriverConfigurationError,
  environmentValue,
  type EnvironmentName,
} from "@/lib/env-contract";

import { META_GRAPH_VERSION, createMockMetaDriver, createRealMetaDriver } from "./meta";
import { selectMetaDriver } from "./selector";

const required = [
  "META_APP_ID",
  "META_APP_SECRET",
  "META_SYSTEM_USER_TOKEN",
  "META_WEBHOOK_VERIFY_TOKEN",
  "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
  "META_WHATSAPP_SYSTEM_USER_TOKEN",
  "META_WABA_ID",
  "META_WHATSAPP_PHONE_NUMBER_ID",
] as const satisfies readonly EnvironmentName[];

function metaRealSkipReason() {
  const missing = required.filter((name) => !environmentValue(name));
  if (environmentValue("SETTERFI_META_DRIVER") !== "real") {
    return `SETTERFI_META_DRIVER=real is required; ${required.join(", ")} are required by the complete probe`;
  }
  return missing.length > 0 ? `${missing.join(", ")} are missing` : null;
}

const skipReason = metaRealSkipReason();

describe("Meta real-arm configuration", () => {
  it("fails closed by exact variable name when Real is selected without usable keys", () => {
    expect(() => selectMetaDriver({
      environment: { SETTERFI_META_DRIVER: "real" },
      factories: { mock: createMockMetaDriver, real: createRealMetaDriver },
    })).toThrowError(DriverConfigurationError);
    try {
      selectMetaDriver({
        environment: { SETTERFI_META_DRIVER: "real" },
        factories: { mock: createMockMetaDriver, real: createRealMetaDriver },
      });
    } catch (error) {
      expect(error).toMatchObject({
        variableNames: [
          "META_APP_ID",
          "META_APP_SECRET",
          "META_SYSTEM_USER_TOKEN",
          "META_WEBHOOK_VERIFY_TOKEN",
          "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
        ],
      });
    }
  });
});

describe.skipIf(Boolean(skipReason))(
  `Meta real arm — SKIPPED: ${skipReason ?? "configured"}`,
  () => {
    it("verifies the raw-body signature without making a provider call", async () => {
      const appSecret = environmentValue("META_APP_SECRET")!;
      const raw = new TextEncoder().encode('{"entry":[]}');
      const signature = `sha256=${createHmac("sha256", appSecret).update(raw).digest("hex")}`;
      const driver = createRealMetaDriver({
        appId: environmentValue("META_APP_ID")!,
        appSecret,
        systemUserToken: environmentValue("META_SYSTEM_USER_TOKEN")!,
        webhookVerifyToken: environmentValue("META_WEBHOOK_VERIFY_TOKEN")!,
      });
      await expect(driver.verifyWebhook(raw, signature)).resolves.toBe(true);
      expect(META_GRAPH_VERSION).toBe("v25.0");
    });

    it("reads the configured WABA subscription and phone shape without sending", async () => {
      const appId = environmentValue("META_APP_ID")!;
      const appSecret = environmentValue("META_APP_SECRET")!;
      const token = environmentValue("META_WHATSAPP_SYSTEM_USER_TOKEN")!;
      const wabaId = environmentValue("META_WABA_ID")!;
      const phoneId = environmentValue("META_WHATSAPP_PHONE_NUMBER_ID")!;
      const appAccess = `${appId}|${appSecret}`;
      const graph = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
      const inspected = await fetch(
        `${graph}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appAccess)}`,
      );
      expect(inspected.ok).toBe(true);
      const inspection = await inspected.json();
      expect(inspection).toMatchObject({ data: { app_id: appId, is_valid: true } });
      expect(inspection.data.scopes).toEqual(expect.arrayContaining([
        "whatsapp_business_management",
        "whatsapp_business_messaging",
      ]));

      const headers = { Authorization: `Bearer ${token}` };
      const [subscription, phone] = await Promise.all([
        fetch(`${graph}/${encodeURIComponent(wabaId)}/subscribed_apps`, { headers }),
        fetch(
          `${graph}/${encodeURIComponent(phoneId)}?fields=id,code_verification_status,status`,
          { headers },
        ),
      ]);
      expect(subscription.ok).toBe(true);
      expect(phone.ok).toBe(true);
      const phoneReadback = await phone.json();
      expect(phoneReadback).toMatchObject({ id: phoneId });
      expect(Object.keys(phoneReadback)).toEqual(expect.arrayContaining([
        "id",
        "code_verification_status",
        "status",
      ]));
    });
  },
);
