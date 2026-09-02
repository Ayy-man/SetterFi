import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { realArmSkipReason } from "@/lib/env-contract";

import {
  META_WHATSAPP_EMBEDDED_SIGNUP_CONFIGURATION_NAMES,
  createMockWhatsAppEmbeddedSignupService,
  createWhatsAppEmbeddedSignupService,
  selectWhatsAppEmbeddedSignupService,
  type WhatsAppEmbeddedSignupConfiguration,
  type WhatsAppEmbeddedSignupRepository,
} from "./meta-embedded-signup";

const enabledEnvironment = {
  SETTERFI_PHASE4_LIVE: "true",
  SETTERFI_WHATSAPP_EMBEDDED_SIGNUP: "true",
  SETTERFI_META_DRIVER: "mock",
};

function repository() {
  const writes: Parameters<WhatsAppEmbeddedSignupRepository["persistConnection"]>[0][] = [];
  const value: WhatsAppEmbeddedSignupRepository = {
    persistConnection: async (input) => {
      writes.push(input);
      return { connectionId: `connection-${writes.length}` };
    },
  };
  return { value, writes };
}

describe("WhatsApp Embedded Signup", () => {
  it("stays disabled unless both Phase 4 and Embedded Signup flags are true", async () => {
    const store = repository();
    for (const environment of [
      {},
      { SETTERFI_PHASE4_LIVE: "true" },
      { SETTERFI_WHATSAPP_EMBEDDED_SIGNUP: "true" },
    ]) {
      const service = createMockWhatsAppEmbeddedSignupService({
        repository: store.value,
        environment,
      });
      expect(() => service.launcher()).toThrow(/WHATSAPP_EMBEDDED_SIGNUP_DISABLED/);
      await expect(service.complete({
        tenantId: "tenant-1",
        actorId: "user-1",
        code: "server-code",
        wabaId: "mock-waba-1",
        phoneNumberId: "mock-phone-1",
      })).rejects.toThrow(/WHATSAPP_EMBEDDED_SIGNUP_DISABLED/);
    }
    expect(store.writes).toHaveLength(0);
  });

  it("runs the network-free v4 code, WABA subscription, and phone readback sequence", async () => {
    const store = repository();
    const service = createMockWhatsAppEmbeddedSignupService({
      repository: store.value,
      environment: enabledEnvironment,
      now: () => new Date("2026-08-17T12:00:00.000Z"),
    });
    expect(service.launcher()).toEqual({
      appId: "setterfi-whatsapp-mock-app",
      configurationId: "setterfi-whatsapp-mock-login-config",
      sessionInfoVersion: "4",
    });
    await expect(service.complete({
      tenantId: "tenant-1",
      actorId: "user-1",
      code: "server-code",
      wabaId: "mock-waba-1",
      phoneNumberId: "mock-phone-1",
    })).resolves.toEqual({ connectionId: "connection-1", state: "ready" });
    expect(store.writes).toMatchObject([{
      tenantId: "tenant-1",
      actorId: "user-1",
      wabaId: "mock-waba-1",
      phoneNumberId: "mock-phone-1",
      state: "ready",
      webhookSubscribedAt: "2026-08-17T12:00:00.000Z",
      phoneVerifiedAt: "2026-08-17T12:00:00.000Z",
      scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
      credentialEnvelope: { version: 1, algorithm: "A256GCM" },
    }]);
  });

  it("rejects browser-substituted WABA or phone identifiers unless the exchanged grant proves them", async () => {
    const store = repository();
    const service = createMockWhatsAppEmbeddedSignupService({
      repository: store.value,
      environment: enabledEnvironment,
    });
    await expect(service.complete({
      tenantId: "tenant-1",
      actorId: "user-1",
      code: "server-code",
      wabaId: "browser-waba",
      phoneNumberId: "mock-phone-1",
    })).rejects.toThrow(/WHATSAPP_SIGNUP_ASSET_MISMATCH/);
    expect(store.writes).toHaveLength(0);
  });

  it("keeps an unverified phone pending instead of claiming the connection is live", async () => {
    const store = repository();
    const configuration: WhatsAppEmbeddedSignupConfiguration = {
      appBaseUrl: "https://setterfi.test",
      appId: "test-app",
      appSecret: randomBytes(32).toString("base64url"),
      loginConfigId: "test-login-config",
    };
    const service = createWhatsAppEmbeddedSignupService(configuration, {
      repository: store.value,
      environment: enabledEnvironment,
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/oauth/access_token")) {
          return Response.json({ access_token: randomBytes(32).toString("base64url") });
        }
        if (path.endsWith("/debug_token")) {
          return Response.json({
            data: {
              app_id: configuration.appId,
              is_valid: true,
              scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
              granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["waba-1"] }],
            },
          });
        }
        if (path.endsWith("/waba-1/phone_numbers")) {
          return Response.json({ data: [{ id: "phone-1" }] });
        }
        if (path.endsWith("/subscribed_apps") && init?.method === "POST") {
          return Response.json({ success: true });
        }
        return Response.json({
          id: "phone-1",
          code_verification_status: "PENDING",
          status: "PENDING",
        });
      },
    });
    await expect(service.complete({
      tenantId: "tenant-1",
      actorId: "user-1",
      code: "server-code",
      wabaId: "waba-1",
      phoneNumberId: "phone-1",
    })).resolves.toEqual({ connectionId: "connection-1", state: "pending_review" });
    expect(store.writes[0].phoneVerifiedAt).toBeNull();
  });

  it("requires the regenerated token to carry WhatsApp messaging scope", async () => {
    const store = repository();
    const configuration: WhatsAppEmbeddedSignupConfiguration = {
      appBaseUrl: "https://setterfi.test",
      appId: "test-app",
      appSecret: randomBytes(32).toString("base64url"),
      loginConfigId: "test-login-config",
    };
    let providerCalls = 0;
    const service = createWhatsAppEmbeddedSignupService(configuration, {
      repository: store.value,
      environment: enabledEnvironment,
      fetch: async (input) => {
        providerCalls += 1;
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/oauth/access_token")) {
          return Response.json({ access_token: randomBytes(32).toString("base64url") });
        }
        return Response.json({
          data: { app_id: configuration.appId, is_valid: true, scopes: [] },
        });
      },
    });
    await expect(service.complete({
      tenantId: "tenant-1",
      actorId: "user-1",
      code: "server-code",
      wabaId: "waba-1",
      phoneNumberId: "phone-1",
    })).rejects.toThrow(/WHATSAPP_CAPABLE_TOKEN_REQUIRED/);
    expect(providerCalls).toBe(2);
    expect(store.writes).toHaveLength(0);
  });

  it("does not serialize exchanged business tokens into outputs, errors, or stored plaintext", async () => {
    const store = repository();
    const service = createMockWhatsAppEmbeddedSignupService({
      repository: store.value,
      environment: enabledEnvironment,
    });
    const result = await service.complete({
      tenantId: "tenant-1",
      actorId: "user-1",
      code: "server-code",
      wabaId: "mock-waba-1",
      phoneNumberId: "mock-phone-1",
    });
    const serialized = JSON.stringify({ result, writes: store.writes });
    expect(serialized).not.toContain("embedded-signup-exchanged-token");
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("systemUserToken");
  });

  it("collapses token-bearing network failures to value-free errors", async () => {
    const store = repository();
    const appSecret = randomBytes(32).toString("base64url");
    const code = randomBytes(32).toString("base64url");
    const service = createWhatsAppEmbeddedSignupService({
      appBaseUrl: "https://setterfi.test",
      appId: "test-app",
      appSecret,
      loginConfigId: "test-login-config",
    }, {
      repository: store.value,
      environment: enabledEnvironment,
      fetch: async (input) => {
        throw new Error(String(input));
      },
    });
    const error = await service.complete({
      tenantId: "tenant-1",
      actorId: "user-1",
      code,
      wabaId: "waba-1",
      phoneNumberId: "phone-1",
    }).catch((cause: unknown) => cause);
    expect(String(error)).toContain("WHATSAPP_SIGNUP_CODE_EXCHANGE_FAILED_NETWORK");
    expect(String(error)).not.toContain(appSecret);
    expect(String(error)).not.toContain(code);
  });

  it("uses an explicit mock without provider keys and fails explicit real by exact variable names", () => {
    const store = repository();
    expect(() => selectWhatsAppEmbeddedSignupService({
      environment: enabledEnvironment,
      dependencies: { repository: store.value },
    })).not.toThrow();
    expect(() => selectWhatsAppEmbeddedSignupService({
      environment: { ...enabledEnvironment, SETTERFI_META_DRIVER: "real" },
      dependencies: { repository: store.value },
    })).toThrow(/APP_BASE_URL, META_APP_ID, META_APP_SECRET, META_LOGIN_CONFIG_ID, SETTERFI_CREDENTIAL_ENCRYPTION_KEY/);
  });
});

const missingRealConfiguration = realArmSkipReason(
  "meta",
  "SETTERFI_META_DRIVER",
  [
    "SETTERFI_PHASE4_LIVE",
    "SETTERFI_WHATSAPP_EMBEDDED_SIGNUP",
    ...META_WHATSAPP_EMBEDDED_SIGNUP_CONFIGURATION_NAMES,
  ],
);
const realSkipReason = missingRealConfiguration
  ? `${missingRealConfiguration}; Embedded Signup must return a tenant-scoped business token with `
    + "WhatsApp management and messaging scopes"
  : null;

describe.skipIf(Boolean(realSkipReason))(
  `WhatsApp Embedded Signup real arm — SKIPPED: ${realSkipReason ?? "configured"}`,
  () => {
    it("selects the real service without contacting a provider", () => {
      const store = repository();
      expect(() => selectWhatsAppEmbeddedSignupService({
        dependencies: { repository: store.value },
      })).not.toThrow();
    });
  },
);
