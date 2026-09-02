import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMetaAssetsHandlers } from "@/app/api/channels/meta/assets/handler";
import {
  META_SESSION_COOKIE,
  createMetaCallbackHandler,
} from "@/app/api/channels/meta/callback/handler";
import { createMetaConnectHandler } from "@/app/api/channels/meta/connect/handler";
import {
  createEmbeddedSignupHandlers,
  createLiveEmbeddedSignupRepository,
} from "@/app/api/channels/meta/embedded-signup/handler";
import type { RouteActor } from "@/app/api/conversations/[id]/claim/handler";
import { NO_CLAIMS } from "@/lib/auth/claims";
import {
  createMockWhatsAppEmbeddedSignupService,
  type WhatsAppEmbeddedSignupRepository,
} from "@/lib/integrations/meta-embedded-signup";
import {
  createMockMetaOAuthService,
  type MetaOAuthRepositories,
  type MetaOAuthSessionRecord,
  type MetaOAuthStateRecord,
} from "@/lib/integrations/meta-oauth";

const actor: RouteActor = {
  ...NO_CLAIMS,
  userId: "actor-1",
  tenantId: "tenant-1",
  role: "coach",
};

const impersonatedActor: RouteActor = {
  ...actor,
  impersonatingTenant: "tenant-1",
};

const mockMetaEnvironment = { SETTERFI_META_DRIVER: "mock" };

function jsonRequest(path: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request(`https://setterfi.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function getRequest(path: string, cookie?: string) {
  return new Request(`https://setterfi.test${path}`, {
    headers: cookie ? { cookie } : undefined,
  });
}

function expectNoStore(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
}

function oauthStore() {
  const states = new Map<string, MetaOAuthStateRecord>();
  const sessions = new Map<string, MetaOAuthSessionRecord>();
  const saveState = vi.fn(async (record: MetaOAuthStateRecord) => void states.set(record.stateHash, record));
  const consumeState = vi.fn(async (stateHash: string) => {
    const state = states.get(stateHash) ?? null;
    states.delete(stateHash);
    return state;
  });
  const saveSession = vi.fn(async (record: MetaOAuthSessionRecord) => {
    const sessionId = `session-${sessions.size + 1}`;
    sessions.set(sessionId, record);
    return { sessionId };
  });
  const loadSession = vi.fn(async (sessionId: string) => sessions.get(sessionId) ?? null);
  const markSubscribed = vi.fn(async () => ({ connectionId: "connection-1" }));
  const repositories: MetaOAuthRepositories = {
    saveState,
    consumeState,
    saveSession,
    loadSession,
    markSubscribed,
  };
  const channelForState = vi.fn(async (oauthState: string) => {
    const hash = createHash("sha256").update(oauthState).digest("hex");
    return states.get(hash)?.channel ?? null;
  });
  return {
    repositories,
    states,
    sessions,
    saveState,
    consumeState,
    saveSession,
    loadSession,
    markSubscribed,
    channelForState,
  };
}

beforeEach(() => {
  vi.stubEnv("SETTERFI_PHASE4_LIVE", "true");
  vi.stubEnv("SETTERFI_WHATSAPP_EMBEDDED_SIGNUP", "");
  vi.stubEnv("SETTERFI_META_DRIVER", "mock");
});

afterEach(() => vi.unstubAllEnvs());

describe("Meta OAuth route composition", () => {
  it("runs mock connect, callback, discovered asset selection, subscription, and ready", async () => {
    const store = oauthStore();
    const service = createMockMetaOAuthService({
      repositories: store.repositories,
      environment: mockMetaEnvironment,
      now: () => new Date("2026-08-17T12:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
    const connect = createMetaConnectHandler({
      session: async () => actor,
      begin: service.begin,
    });
    const startedResponse = await connect(jsonRequest("/api/channels/meta/connect", {
      channel: "messenger",
      returnPath: "/coach/settings?tab=channels",
    }));
    expect(startedResponse.status).toBe(201);
    expectNoStore(startedResponse);
    const started = await startedResponse.json();
    expect(Object.keys(started).sort()).toEqual(["authorizationUrl", "expiresAt", "state"]);
    expect(started.state).toBe("connecting");
    const oauthState = new URL(started.authorizationUrl).searchParams.get("state");
    expect(oauthState).toBeTruthy();

    const callback = createMetaCallbackHandler({
      session: async () => actor,
      complete: async (input) => {
        const channel = await store.channelForState(input.oauthState);
        if (!channel) throw new Error("META_OAUTH_STATE_INVALID_OR_REPLAYED");
        return service.complete({ ...input, channel });
      },
    });
    const callbackResponse = await callback(getRequest(
      `/api/channels/meta/callback?code=synthetic-code&state=${encodeURIComponent(oauthState!)}`,
    ));
    expect(callbackResponse.status).toBe(303);
    expect(callbackResponse.headers.get("Location")).toBe("/coach/settings?tab=channels&meta=select_asset");
    expectNoStore(callbackResponse);
    const setCookie = callbackResponse.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain(`${META_SESSION_COOKIE}=session-1`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    const cookie = setCookie.split(";", 1)[0];

    const assets = createMetaAssetsHandlers({
      session: async () => actor,
      loadSession: store.repositories.loadSession,
      subscribe: service.subscribe,
    });
    const assetsResponse = await assets.GET(getRequest("/api/channels/meta/assets", cookie));
    expect(assetsResponse.status).toBe(200);
    expectNoStore(assetsResponse);
    const discovered = await assetsResponse.json();
    expect(discovered).toEqual({
      items: [{
        assetId: "mock-page-1",
        channel: "messenger",
        label: "Demo Page",
        eligible: true,
      }],
    });
    expect(JSON.stringify(discovered)).not.toMatch(/token|verifier|secret|ciphertext/i);

    const selectedResponse = await assets.POST(jsonRequest("/api/channels/meta/assets", {
      assetId: "mock-page-1",
      channel: "messenger",
    }, cookie));
    expect(selectedResponse.status).toBe(202);
    expectNoStore(selectedResponse);
    expect(await selectedResponse.json()).toEqual({ connectionId: "connection-1", state: "ready" });
    expect(store.markSubscribed).toHaveBeenCalledOnce();
  });

  it("rejects an external return before state persistence", async () => {
    const store = oauthStore();
    const service = createMockMetaOAuthService({
      repositories: store.repositories,
      environment: mockMetaEnvironment,
    });
    const response = await createMetaConnectHandler({
      session: async () => actor,
      begin: service.begin,
    })(jsonRequest("/api/channels/meta/connect", {
      channel: "instagram",
      returnPath: "https://external.invalid/return",
    }));
    expect(response.status).toBe(400);
    expectNoStore(response);
    expect(store.saveState).not.toHaveBeenCalled();
  });

  it("refuses a replay before another exchange or session write", async () => {
    const store = oauthStore();
    const service = createMockMetaOAuthService({
      repositories: store.repositories,
      environment: mockMetaEnvironment,
      randomBytes: (size) => Buffer.alloc(size, 8),
    });
    const completeOAuth = vi.spyOn(service, "complete");
    const started = await service.begin({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      channel: "instagram",
      returnPath: "/coach/settings",
    });
    const complete = vi.fn(async (input: {
      tenantId: string;
      actorId: string;
      code: string;
      oauthState: string;
    }) => {
      const channel = await store.channelForState(input.oauthState);
      if (!channel) throw new Error("raw-provider-error-with-sensitive-material");
      return service.complete({ ...input, channel });
    });
    const callback = createMetaCallbackHandler({ session: async () => actor, complete });
    const request = () => getRequest(
      `/api/channels/meta/callback?code=synthetic-code&state=${encodeURIComponent(started.oauthState)}`,
    );
    expect((await callback(request())).status).toBe(303);
    const replay = await callback(request());
    expect(replay.status).toBe(303);
    expect(replay.headers.get("Location")).toBe("/coach/settings?meta=connection_error");
    expect(replay.headers.get("Location")).not.toContain("raw-provider-error");
    expectNoStore(replay);
    expect(completeOAuth).toHaveBeenCalledOnce();
    expect(store.consumeState).toHaveBeenCalledOnce();
    expect(store.saveSession).toHaveBeenCalledOnce();
  });

  it("rejects cross-tenant and browser-substituted assets before subscription", async () => {
    const subscribe = vi.fn(async () => ({ connectionId: "connection-1", state: "ready" as const }));
    const session: MetaOAuthSessionRecord = {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      channel: "instagram",
      returnPath: "/coach/settings",
      tokenExpiresAt: null,
      scopes: [],
      assets: [],
    };
    const handlers = createMetaAssetsHandlers({
      session: async () => ({ ...actor, tenantId: "tenant-2" }),
      loadSession: async () => session,
      subscribe,
    });
    const response = await handlers.POST(jsonRequest("/api/channels/meta/assets", {
      assetId: "browser-asset",
      channel: "instagram",
    }, `${META_SESSION_COOKIE}=session-1`));
    expect(response.status).toBe(404);
    expectNoStore(response);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("fails unauthenticated and impersonated requests before route operations", async () => {
    const begin = vi.fn();
    const complete = vi.fn();
    const loadSession = vi.fn();
    const subscribe = vi.fn();
    const connectRequest = () => jsonRequest("/api/channels/meta/connect", {
      channel: "messenger",
      returnPath: "/coach/settings",
    });
    const callbackRequest = () => getRequest("/api/channels/meta/callback?code=x&state=y");
    const assetRequest = () => getRequest("/api/channels/meta/assets", `${META_SESSION_COOKIE}=session-1`);

    for (const routeActor of [null, impersonatedActor]) {
      const expected = routeActor ? 403 : 401;
      const responses = [
        await createMetaConnectHandler({
          session: async () => routeActor,
          begin,
        })(connectRequest()),
        await createMetaCallbackHandler({
          session: async () => routeActor,
          complete,
        })(callbackRequest()),
        await createMetaAssetsHandlers({
          session: async () => routeActor,
          loadSession,
          subscribe,
        }).GET(assetRequest()),
      ];
      for (const response of responses) {
        expect(response.status).toBe(expected);
        expectNoStore(response);
      }
    }
    expect(begin).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(loadSession).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("returns 404 with Phase 4 off before authentication or operations", async () => {
    vi.stubEnv("SETTERFI_PHASE4_LIVE", "");
    const session = vi.fn();
    const begin = vi.fn();
    const complete = vi.fn();
    const loadSession = vi.fn();
    const subscribe = vi.fn();
    const responses = [
      await createMetaConnectHandler({ session, begin })(jsonRequest("/api/channels/meta/connect", {})),
      await createMetaCallbackHandler({ session, complete })(getRequest("/api/channels/meta/callback")),
      await createMetaAssetsHandlers({ session, loadSession, subscribe }).GET(
        getRequest("/api/channels/meta/assets"),
      ),
    ];
    for (const response of responses) {
      expect(response.status).toBe(404);
      expectNoStore(response);
    }
    expect(session).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(loadSession).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe("WhatsApp Embedded Signup routes", () => {
  it("persists readiness evidence and credential custody through one atomic RPC", async () => {
    const rpc = vi.fn(async () => ({ data: "connection-1", error: null }));
    const repository = createLiveEmbeddedSignupRepository({ rpc } as never);
    const credentialEnvelope = {
      version: 1 as const,
      keyVersion: 1 as const,
      algorithm: "A256GCM" as const,
      iv: "synthetic-iv",
      ciphertext: "synthetic-ciphertext",
      tag: "synthetic-tag",
    };

    await expect(repository.persistConnection({
      tenantId: "tenant-1",
      actorId: "actor-1",
      wabaId: "waba-1",
      phoneNumberId: "phone-1",
      credentialEnvelope,
      tokenExpiresAt: "2030-01-01T00:00:00.000Z",
      scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
      webhookSubscribedAt: "2026-08-27T00:00:00.000Z",
      phoneVerifiedAt: "2026-08-27T00:00:00.000Z",
      state: "ready",
    })).resolves.toEqual({ connectionId: "connection-1" });

    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("persist_meta_whatsapp_connection_atomic", {
      p_expected_tenant: "tenant-1",
      p_actor_id: "actor-1",
      p_waba_id: "waba-1",
      p_phone_number_id: "phone-1",
      p_state: "ready",
      p_credential_envelope: credentialEnvelope,
      p_token_expires_at: "2030-01-01T00:00:00.000Z",
      p_scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
      p_completed_at: "2026-08-27T00:00:00.000Z",
      p_phone_verified_at: "2026-08-27T00:00:00.000Z",
    });
  });

  it("stays disabled without the second flag and performs no authentication or provider work", async () => {
    const session = vi.fn();
    const service = vi.fn();
    const handlers = createEmbeddedSignupHandlers({ session, service });
    for (const response of [
      await handlers.GET(),
      await handlers.POST(jsonRequest("/api/channels/meta/embedded-signup", {})),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "WhatsApp Embedded Signup is disabled." });
      expectNoStore(response);
    }
    expect(session).not.toHaveBeenCalled();
    expect(service).not.toHaveBeenCalled();
  });

  it("returns launcher metadata and an honest ready completion without exposing custody fields", async () => {
    vi.stubEnv("SETTERFI_WHATSAPP_EMBEDDED_SIGNUP", "true");
    const writes: Parameters<WhatsAppEmbeddedSignupRepository["persistConnection"]>[0][] = [];
    const repository: WhatsAppEmbeddedSignupRepository = {
      persistConnection: async (input) => {
        writes.push(input);
        return { connectionId: "connection-1" };
      },
    };
    const service = createMockWhatsAppEmbeddedSignupService({
      repository,
      environment: {
        SETTERFI_PHASE4_LIVE: "true",
        SETTERFI_WHATSAPP_EMBEDDED_SIGNUP: "true",
        SETTERFI_META_DRIVER: "mock",
      },
    });
    const handlers = createEmbeddedSignupHandlers({ session: async () => actor, service: () => service });
    const launcher = await handlers.GET();
    expect(launcher.status).toBe(200);
    expectNoStore(launcher);
    expect(Object.keys(await launcher.json()).sort()).toEqual(["launcher"]);

    const completed = await handlers.POST(jsonRequest("/api/channels/meta/embedded-signup", {
      code: "synthetic-code",
      wabaId: "mock-waba-1",
      phoneNumberId: "mock-phone-1",
    }));
    expect(completed.status).toBe(202);
    expectNoStore(completed);
    const body = await completed.json();
    expect(body).toEqual({ connectionId: "connection-1", state: "ready" });
    expect(body.state).not.toBe("live");
    expect(JSON.stringify(body)).not.toMatch(/token|verifier|secret|ciphertext/i);
    expect(writes).toHaveLength(1);
  });

  it("rejects impersonation and redacts raw provider failures", async () => {
    vi.stubEnv("SETTERFI_WHATSAPP_EMBEDDED_SIGNUP", "true");
    const service = {
      launcher: vi.fn(() => ({ appId: "mock-app", configurationId: "mock-config", sessionInfoVersion: "4" as const })),
      complete: vi.fn(async () => {
        throw new Error("raw-provider-error-with-sensitive-material");
      }),
    };
    const blocked = createEmbeddedSignupHandlers({
      session: async () => impersonatedActor,
      service: () => service,
    });
    expect((await blocked.GET()).status).toBe(403);
    expect(service.launcher).not.toHaveBeenCalled();

    const handlers = createEmbeddedSignupHandlers({ session: async () => actor, service: () => service });
    const response = await handlers.POST(jsonRequest("/api/channels/meta/embedded-signup", {
      code: "synthetic-code",
      wabaId: "mock-waba-1",
      phoneNumberId: "mock-phone-1",
    }));
    expect(response.status).toBe(409);
    expectNoStore(response);
    expect(JSON.stringify(await response.json())).not.toContain("raw-provider-error");
  });
});
