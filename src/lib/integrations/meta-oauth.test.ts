import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { realArmSkipReason } from "@/lib/env-contract";

import {
  createMetaOAuthService,
  createMockMetaOAuthService,
  selectMetaOAuthService,
  validateMetaReturnPath,
  type MetaOAuthRepositories,
  type MetaOAuthSessionRecord,
  type MetaOAuthStateRecord,
} from "./meta-oauth";
import { META_OAUTH_CONFIGURATION_NAMES } from "./selector";

function repositories() {
  const states = new Map<string, MetaOAuthStateRecord>();
  const sessions = new Map<string, MetaOAuthSessionRecord>();
  let connection = 0;
  const repository: MetaOAuthRepositories = {
    saveState: async (record) => void states.set(record.stateHash, record),
    consumeState: async (stateHash) => {
      const state = states.get(stateHash) ?? null;
      states.delete(stateHash);
      return state;
    },
    saveSession: async (record) => {
      const sessionId = `session-${sessions.size + 1}`;
      sessions.set(sessionId, record);
      return { sessionId };
    },
    loadSession: async (sessionId) => sessions.get(sessionId) ?? null,
    markSubscribed: async () => ({ connectionId: `connection-${(connection += 1)}` }),
  };
  return { repository, states, sessions };
}

const fixedNow = () => new Date("2026-08-17T12:00:00.000Z");
const fixedBytes = (size: number) => Buffer.alloc(size, 7);
const mockEnvironment = { SETTERFI_META_DRIVER: "mock" };

describe("Meta OAuth state and asset flow", () => {
  it("runs mock begin, exchange, inspection, discovery, and subscription without network", async () => {
    const store = repositories();
    const service = createMockMetaOAuthService({
      repositories: store.repository,
      now: fixedNow,
      randomBytes: fixedBytes,
      environment: mockEnvironment,
    });
    const started = await service.begin({
      tenantId: "tenant-1",
      actorId: "user-1",
      channel: "instagram",
      returnPath: "/coach/settings?tab=integrations",
    });
    expect(started).toMatchObject({
      expiresAt: "2026-08-17T12:10:00.000Z",
      state: "connecting",
    });
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.pathname).toContain("/v25.0/dialog/oauth");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect([...store.states.values()][0]).toMatchObject({
      tenantId: "tenant-1",
      actorId: "user-1",
      channel: "instagram",
      returnPath: "/coach/settings?tab=integrations",
    });

    const completed = await service.complete({
      tenantId: "tenant-1",
      actorId: "user-1",
      channel: "instagram",
      code: "server-code",
      oauthState: started.oauthState,
    });
    expect(completed).toEqual({
      sessionId: "session-1",
      returnPath: "/coach/settings?tab=integrations",
      assets: [{
        assetId: "mock-instagram-1",
        channel: "instagram",
        label: "Demo Instagram",
        eligible: true,
      }],
    });
    await expect(service.subscribe({
      tenantId: "tenant-1",
      actorId: "user-1",
      sessionId: completed.sessionId,
      assetId: completed.assets[0].assetId,
    })).resolves.toEqual({ connectionId: "connection-1", state: "ready" });
  });

  it("consumes state once and rejects replay before a token exchange", async () => {
    const store = repositories();
    let fetchCalls = 0;
    const base = createMockMetaOAuthService({
      repositories: store.repository,
      now: fixedNow,
      randomBytes: (size) => randomBytes(size),
      environment: mockEnvironment,
    });
    const started = await base.begin({
      tenantId: "tenant-1",
      actorId: "user-1",
      channel: "messenger",
      returnPath: "/coach/settings",
    });
    const service = selectMetaOAuthService({
      environment: mockEnvironment,
      dependencies: {
        repositories: store.repository,
        now: fixedNow,
        fetch: async () => {
          fetchCalls += 1;
          return Response.json({});
        },
      },
    });
    await expect(service.complete({
      tenantId: "another-tenant",
      actorId: "user-1",
      channel: "messenger",
      code: "server-code",
      oauthState: started.oauthState,
    })).rejects.toThrow(/META_OAUTH_STATE_BINDING_MISMATCH/);
    await expect(service.complete({
      tenantId: "tenant-1",
      actorId: "user-1",
      channel: "messenger",
      code: "server-code",
      oauthState: started.oauthState,
    })).rejects.toThrow(/META_OAUTH_STATE_INVALID_OR_REPLAYED/);
    expect(fetchCalls).toBe(0);
  });

  it("rejects expired state before exchange", async () => {
    const store = repositories();
    const service = createMockMetaOAuthService({
      repositories: store.repository,
      now: fixedNow,
      randomBytes: fixedBytes,
      environment: mockEnvironment,
    });
    const started = await service.begin({
      tenantId: "tenant-1",
      actorId: "user-1",
      channel: "instagram",
      returnPath: "/coach/settings",
    });
    const expired = createMockMetaOAuthService({
      repositories: store.repository,
      now: () => new Date("2026-08-17T12:10:00.000Z"),
      environment: mockEnvironment,
    });
    await expect(expired.complete({
      tenantId: "tenant-1",
      actorId: "user-1",
      channel: "instagram",
      code: "server-code",
      oauthState: started.oauthState,
    })).rejects.toThrow(/META_OAUTH_STATE_EXPIRED/);
  });

  it("rejects external and protocol-relative returns before state persistence", async () => {
    expect(() => validateMetaReturnPath("https://example.test/steal", "https://setterfi.test"))
      .toThrow(/META_OAUTH_RETURN_PATH_INVALID/);
    expect(() => validateMetaReturnPath("//example.test/steal", "https://setterfi.test"))
      .toThrow(/META_OAUTH_RETURN_PATH_INVALID/);
    const store = repositories();
    const service = createMockMetaOAuthService({
      repositories: store.repository,
      environment: mockEnvironment,
    });
    await expect(service.begin({
      tenantId: "tenant-1",
      actorId: "user-1",
      channel: "instagram",
      returnPath: "https://example.test/steal",
    })).rejects.toThrow(/META_OAUTH_RETURN_PATH_INVALID/);
    expect(store.states.size).toBe(0);
  });

  it("rejects browser-substituted assets before a subscription call", async () => {
    const store = repositories();
    const service = createMockMetaOAuthService({
      repositories: store.repository,
      now: fixedNow,
      randomBytes: fixedBytes,
      environment: mockEnvironment,
    });
    const started = await service.begin({
      tenantId: "tenant-1",
      actorId: "user-1",
      channel: "messenger",
      returnPath: "/coach/settings",
    });
    const completed = await service.complete({
      tenantId: "tenant-1",
      actorId: "user-1",
      channel: "messenger",
      code: "server-code",
      oauthState: started.oauthState,
    });
    await expect(service.subscribe({
      tenantId: "tenant-1",
      actorId: "user-1",
      sessionId: completed.sessionId,
      assetId: "browser-supplied-asset",
    })).rejects.toThrow(/META_OAUTH_ASSET_NOT_DISCOVERED/);
  });

  it("keeps the existing connection custody intact when reauthorization does not complete", async () => {
    const store = repositories();
    const existingCredential = { envelope: "prior-credential" };
    const service = createMockMetaOAuthService({
      repositories: store.repository,
      now: fixedNow,
      randomBytes: fixedBytes,
      environment: mockEnvironment,
    });
    const started = await service.begin({
      tenantId: "tenant-1",
      actorId: "user-1",
      channel: "instagram",
      connectionId: "connection-existing",
      returnPath: "/coach/integrations",
    });
    expect([...store.states.values()][0]).toMatchObject({ connectionId: "connection-existing" });
    // A declined/failed callback never reaches markSubscribed, the only persistence boundary that
    // replaces the connection secret, so the prior grant remains usable for recovery.
    expect(existingCredential).toEqual({ envelope: "prior-credential" });
    await expect(service.complete({
      tenantId: "tenant-1", actorId: "user-1", channel: "instagram", code: "", oauthState: started.oauthState,
    })).rejects.toThrow(/META_OAUTH_CODE_REQUIRED/);
    expect(existingCredential).toEqual({ envelope: "prior-credential" });
  });

  it("never serializes plaintext token or verifier values", async () => {
    const store = repositories();
    let fixtureByte = 7;
    const service = createMockMetaOAuthService({
      repositories: store.repository,
      now: fixedNow,
      randomBytes: (size) => Buffer.alloc(size, fixtureByte++),
      environment: mockEnvironment,
    });
    const started = await service.begin({
      tenantId: "tenant-1",
      actorId: "user-1",
      channel: "messenger",
      returnPath: "/coach/settings",
    });
    const completed = await service.complete({
      tenantId: "tenant-1",
      actorId: "user-1",
      channel: "messenger",
      code: "server-code",
      oauthState: started.oauthState,
    });
    const serialized = JSON.stringify({
      started,
      completed,
      storedState: [...store.states.values()],
      storedSessions: [...store.sessions.values()],
    });
    expect(serialized).not.toContain(
      createHash("sha256").update("meta-oauth-user-token").digest("base64url"),
    );
    expect(serialized).not.toContain(
      createHash("sha256").update("meta-oauth-page-token").digest("base64url"),
    );
    expect(serialized).not.toContain(Buffer.alloc(32, 8).toString("base64url"));
  });

  it("collapses token-bearing network failures to value-free errors", async () => {
    const store = repositories();
    const appSecret = randomBytes(32).toString("base64url");
    const code = randomBytes(32).toString("base64url");
    const service = createMetaOAuthService({
      appBaseUrl: "https://setterfi.test",
      appId: "test-app",
      appSecret,
      loginConfigId: "test-config",
    }, {
      repositories: store.repository,
      now: fixedNow,
      randomBytes: fixedBytes,
      environment: mockEnvironment,
      fetch: async (input) => {
        throw new Error(String(input));
      },
    });
    const started = await service.begin({
      tenantId: "tenant-1",
      actorId: "user-1",
      channel: "messenger",
      returnPath: "/coach/settings",
    });
    const error = await service.complete({
      tenantId: "tenant-1",
      actorId: "user-1",
      channel: "messenger",
      code,
      oauthState: started.oauthState,
    }).catch((cause: unknown) => cause);
    expect(String(error)).toContain("META_OAUTH_CODE_EXCHANGE_FAILED_NETWORK");
    expect(String(error)).not.toContain(appSecret);
    expect(String(error)).not.toContain(code);
  });

  it("keeps missing credentials on the explicit mock arm and fails real by variable name", () => {
    const store = repositories();
    expect(() => selectMetaOAuthService({
      environment: mockEnvironment,
      dependencies: { repositories: store.repository },
    })).not.toThrow();
    expect(() => selectMetaOAuthService({
      environment: { SETTERFI_META_DRIVER: "real" },
      dependencies: { repositories: store.repository },
    })).toThrow(/APP_BASE_URL, META_APP_ID, META_APP_SECRET, META_LOGIN_CONFIG_ID/);
  });
});

const realSkipReason = realArmSkipReason(
  "meta",
  "SETTERFI_META_DRIVER",
  META_OAUTH_CONFIGURATION_NAMES,
);

describe.skipIf(Boolean(realSkipReason))(
  `Meta OAuth real arm — SKIPPED: ${realSkipReason ?? "configured"}`,
  () => {
    it("selects the real service without making a provider request", () => {
      const store = repositories();
      expect(() => selectMetaOAuthService({
        dependencies: { repositories: store.repository },
      })).not.toThrow();
    });
  },
);
