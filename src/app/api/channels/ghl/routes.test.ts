import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only `createSupabaseServerClient` is replaced. The service client the callbacks use is left
// alone, because the point of this seam is which claims the install starter can see.
const claims = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/supabase/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/supabase/server")>(),
  createSupabaseServerClient: async () => ({
    auth: { getClaims: async () => ({ data: { claims: claims.value }, error: null }) },
  }),
}));

import {
  completeGhlAgencyInstall,
  createGhlAgencyCallbackHandler,
} from "@/app/api/channels/messaging/agency-callback/handler";
import {
  completeGhlAgentInstall,
  createGhlCallbackHandler,
} from "@/app/api/channels/messaging/callback/handler";
import {
  beginGhlInstall,
  createGhlInstallStartHandler,
  loadInstallStartActor,
  type GhlInstallStartDependencies,
} from "@/app/api/channels/ghl/install-start/handler";
import type { UserRole } from "@/lib/auth/claims";
import { DriverConfigurationError } from "@/lib/env-contract";
import {
  GhlOAuthError,
  consumeGhlOAuthState,
  issueGhlOAuthState,
  type GhlOAuthApp,
  type GhlOAuthStateRecord,
  type GhlOAuthStateStore,
  type GhlTokenGrant,
} from "@/lib/integrations/ghl-oauth";
import {
  INSTALL_EVENT_UNKNOWN_CODE,
  installEventStateRef,
  recordInstallCallbackEvent,
  type GhlInstallCallbackEvent,
  type GhlInstallStartRefusal,
} from "@/lib/integrations/install-events";

const APP_BASE_URL = "https://setterfi.test";
const INSTALL_URL = "https://marketplace.example.test/oauth/chooselocation?appId=synthetic-app";
const ACTOR = "00000000-0000-4000-8000-000000000001";

function stateStore() {
  const rows = new Map<string, GhlOAuthStateRecord & { consumedAt: string | null }>();
  const store: GhlOAuthStateStore = {
    save: async (record) => void rows.set(record.stateHash, { ...record, consumedAt: null }),
    consume: async (stateHash, consumedAt, app) => {
      const row = rows.get(stateHash);
      // The app is part of the predicate, so a state issued for the other app matches nothing and
      // — the point of the whole change — is left unconsumed for the callback it belongs to.
      if (!row || row.consumedAt || row.app !== app) return null;
      row.consumedAt = consumedAt;
      return { ...row };
    },
    describe: async (stateHash) => {
      const row = rows.get(stateHash);
      return row ? { app: row.app, consumedAt: row.consumedAt } : null;
    },
  };
  return store;
}

async function issue(
  store: GhlOAuthStateStore,
  app: GhlOAuthApp,
  returnPath?: string,
  now?: () => number,
) {
  const issued = await issueGhlOAuthState({
    app,
    actorId: ACTOR,
    tenantId: "tenant-1",
    returnPath: returnPath ?? null,
    appBaseUrl: APP_BASE_URL,
    installUrl: INSTALL_URL,
  }, { states: store, now });
  return new URL(issued.authorizationUrl).searchParams.get("state") ?? "";
}

function callbackRequest(path: string, query: Record<string, string>) {
  const url = new URL(`${APP_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new Request(url.toString());
}

function liveCallbackHandler(store: GhlOAuthStateStore, complete = vi.fn(async () => {})) {
  const record = vi.fn<(event: GhlInstallCallbackEvent) => Promise<void>>(async () => {});
  return {
    complete,
    record,
    handler: createGhlCallbackHandler({
      enabled: () => true,
      consumeState: (state) => consumeGhlOAuthState({ app: "agent", state }, { states: store }),
      complete,
      record,
    }),
  };
}

describe("GHL OAuth callback routes", () => {
  it("stays a 404 until the phase flag and the OAuth flag are both on", async () => {
    const off = { enabled: () => false, consumeState: vi.fn(), complete: vi.fn(), record: vi.fn() };
    for (const response of [
      await createGhlCallbackHandler(off)(callbackRequest("/api/channels/messaging/callback", {})),
      await createGhlAgencyCallbackHandler(off)(
        callbackRequest("/api/channels/messaging/agency-callback", {}),
      ),
    ]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(off.consumeState).not.toHaveBeenCalled();

    const start = await createGhlInstallStartHandler({
      enabled: () => false,
      session: vi.fn(),
      begin: vi.fn(),
      record: vi.fn(),
    })(new Request(`${APP_BASE_URL}/api/channels/ghl/install-start`, {
      method: "POST",
      body: JSON.stringify({ app: "agent" }),
    }));
    expect(start.status).toBe(404);
  });

  it("sends a stateless or forged callback to the default landing without exchanging anything", async () => {
    const store = stateStore();
    const { handler, complete } = liveCallbackHandler(store);

    const stateless = await handler(callbackRequest("/api/channels/messaging/callback", {
      code: "synthetic-code",
    }));
    expect(stateless.status).toBe(303);
    expect(stateless.headers.get("Location")).toBe("/coach/integrations?messaging=error");

    const forged = await handler(callbackRequest("/api/channels/messaging/callback", {
      code: "synthetic-code",
      state: "not-a-state-we-issued",
    }));
    expect(forged.headers.get("Location")).toBe("/coach/integrations?messaging=error");
    expect(complete).not.toHaveBeenCalled();
  });

  it("refuses a replayed callback because the state it carries is already spent", async () => {
    const store = stateStore();
    const { handler, complete } = liveCallbackHandler(store);
    const state = await issue(store, "agent");
    const request = () => callbackRequest("/api/channels/messaging/callback", {
      code: "synthetic-code",
      state,
    });

    const first = await handler(request());
    expect(first.headers.get("Location")).toBe("/coach/integrations?messaging=linked");
    const replay = await handler(request());
    expect(replay.headers.get("Location")).toBe("/coach/integrations?messaging=error");
    // The exchange happens once, so a replayed code can never mint a second install.
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("reports a declined install without repeating the provider's description", async () => {
    const store = stateStore();
    const { handler, complete } = liveCallbackHandler(store);
    const state = await issue(store, "agent");
    const response = await handler(callbackRequest("/api/channels/messaging/callback", {
      state,
      error: "access_denied",
      error_description: "user-identifiable-detail-not-for-the-browser",
    }));
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/coach/integrations?messaging=declined");
    expect(await response.text()).toBe("");
    expect(response.headers.get("Location")).not.toContain("user-identifiable-detail");
    expect(complete).not.toHaveBeenCalled();
  });

  it("lands on the return path the state carried and collapses an exchange failure", async () => {
    const store = stateStore();
    const failing = vi.fn(async () => { throw new Error("GHL_OAUTH_TOKEN_EXCHANGE_FAILED"); });
    const { handler } = liveCallbackHandler(store, failing);
    const state = await issue(store, "agent", "/coach/get-started");
    const response = await handler(callbackRequest("/api/channels/messaging/callback", {
      state,
      code: "synthetic-code",
    }));
    expect(response.headers.get("Location")).toBe("/coach/get-started?messaging=error");

    const stateless = await handler(callbackRequest("/api/channels/messaging/callback", {
      state: await issue(store, "agent"),
    }));
    expect(stateless.headers.get("Location")).toBe("/coach/integrations?messaging=error");
  });

  it("keeps the agency callback on its own app, landing, and state namespace", async () => {
    const store = stateStore();
    const complete = vi.fn(async () => {});
    const record = vi.fn<(event: GhlInstallCallbackEvent) => Promise<void>>(async () => {});
    const handler = createGhlAgencyCallbackHandler({
      enabled: () => true,
      consumeState: (state) =>
        consumeGhlOAuthState({ app: "provisioning", state }, { states: store }),
      complete,
      record,
    });

    // A state issued for the sub-account app must not satisfy the agency callback.
    const agentState = await issue(store, "agent");
    const crossed = await handler(callbackRequest("/api/channels/messaging/agency-callback", {
      state: agentState,
      code: "synthetic-code",
    }));
    expect(crossed.headers.get("Location")).toBe("/admin/provisioning?provisioning=error");
    expect(complete).not.toHaveBeenCalled();
    expect(record.mock.calls[0][0]).toMatchObject({ code: "GHL_OAUTH_STATE_APP_MISMATCH" });

    // And it was refused without being spent, so the callback it was issued for still works.
    const agentHandler = createGhlCallbackHandler({
      enabled: () => true,
      consumeState: (state) => consumeGhlOAuthState({ app: "agent", state }, { states: store }),
      complete: vi.fn(async () => {}),
      record: vi.fn(async () => {}),
    });
    const legitimate = await agentHandler(callbackRequest("/api/channels/messaging/callback", {
      state: agentState,
      code: "synthetic-code",
    }));
    expect(legitimate.headers.get("Location")).toBe("/coach/integrations?messaging=linked");

    const agencyState = await issue(store, "provisioning");
    const accepted = await handler(callbackRequest("/api/channels/messaging/agency-callback", {
      state: agencyState,
      code: "synthetic-code",
    }));
    expect(accepted.headers.get("Location")).toBe("/admin/provisioning?provisioning=linked");
    expect(complete).toHaveBeenCalledWith({
      state: expect.objectContaining({ app: "provisioning" }),
      code: "synthetic-code",
    });
  });
});

describe("GHL install start", () => {
  const begin = vi.fn(async () => ({
    authorizationUrl: `${INSTALL_URL}&state=synthetic-state`,
    expiresAt: "2030-01-01T00:00:00.000Z",
  }));

  function post(body: unknown) {
    return new Request(`${APP_BASE_URL}/api/channels/ghl/install-start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  type Session = () => Promise<{
    userId: string;
    role: UserRole;
    tenantId?: string | null;
    impersonatingTenant?: string | null;
  } | null>;

  function startHandler(session: Session, over: { begin?: typeof begin } = {}) {
    const record = vi.fn<(refusal: GhlInstallStartRefusal) => Promise<void>>(async () => {});
    return {
      record,
      handler: createGhlInstallStartHandler({
        enabled: () => true,
        session,
        begin: over.begin ?? begin,
        record,
      }),
    };
  }

  function handler(session: Session) {
    return startHandler(session).handler;
  }

  it("refuses an unauthenticated, non-owning, or impersonated caller", async () => {
    expect((await handler(async () => null)(post({ app: "agent" }))).status).toBe(401);
    expect(
      (await handler(async () => ({ userId: ACTOR, role: "coach" as UserRole }))(post({ app: "agent" }))).status,
    ).toBe(403);
    expect(
      (await handler(async () => ({
        userId: ACTOR,
        role: "admin" as UserRole,
        impersonatingTenant: "tenant-1",
      }))(post({ app: "agent" }))).status,
    ).toBe(403);
  });

  it("issues an install link for a named app and rejects an unnamed one", async () => {
    const authorized = handler(async () => ({ userId: ACTOR, role: "owner" as UserRole }));
    const created = await authorized(post({ app: "provisioning", tenantId: "tenant-1" }));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      authorizationUrl: `${INSTALL_URL}&state=synthetic-state`,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(begin).toHaveBeenCalledWith({
      app: "provisioning",
      actorId: ACTOR,
      tenantId: "tenant-1",
      returnPath: null,
    });
    expect((await authorized(post({ app: "everything" }))).status).toBe(400);
  });
});

// The two callbacks are the same shape over different apps, so every exit is driven over both.
const CALLBACKS = [
  {
    app: "agent" as const,
    create: createGhlCallbackHandler,
    path: "/api/channels/messaging/callback",
    key: "messaging",
    landing: "/coach/integrations",
  },
  {
    app: "provisioning" as const,
    create: createGhlAgencyCallbackHandler,
    path: "/api/channels/messaging/agency-callback",
    key: "provisioning",
    landing: "/admin/provisioning",
  },
];

describe.each(CALLBACKS)("$app callback events", (entry) => {
  function build(
    complete = vi.fn(async () => {}),
    write: (event: GhlInstallCallbackEvent) => Promise<void> = async () => {},
  ) {
    const record = vi.fn(write);
    const store = stateStore();
    return {
      store,
      complete,
      record,
      handler: entry.create({
        enabled: () => true,
        consumeState: (state) => consumeGhlOAuthState({ app: entry.app, state }, { states: store }),
        complete,
        record,
      }),
    };
  }

  const error = `${entry.landing}?${entry.key}=error`;
  const declined = `${entry.landing}?${entry.key}=declined`;
  const linked = `${entry.landing}?${entry.key}=linked`;

  it("records a missing state without a ref, because there is nothing to hash", async () => {
    const { handler, record } = build();
    const response = await handler(callbackRequest(entry.path, { code: "synthetic-code" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(error);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toEqual({
      app: entry.app,
      outcome: "failed",
      code: "GHL_OAUTH_STATE_MISSING",
      tenantId: null,
    });
  });

  it("records a state we never issued, and carries the ref that proves which one", async () => {
    const { handler, record } = build();
    const response = await handler(callbackRequest(entry.path, {
      code: "synthetic-code",
      state: "not-a-state-we-issued",
    }));
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(error);
    expect(record.mock.calls[0][0]).toMatchObject({
      app: entry.app,
      outcome: "failed",
      code: "GHL_OAUTH_STATE_INVALID_OR_REPLAYED",
      stateRef: installEventStateRef("not-a-state-we-issued"),
    });
  });

  it("records a replay once, by name, and never under the state the success already claimed", async () => {
    const { handler, store, record } = build();
    const state = await issue(store, entry.app);
    const request = () => callbackRequest(entry.path, { code: "synthetic-code", state });
    expect((await handler(request())).headers.get("Location")).toBe(linked);
    const replay = await handler(request());
    expect(replay.headers.get("Location")).toBe(error);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({ code: "GHL_OAUTH_STATE_ALREADY_COMPLETED" });
    // The attempts panel reads the last event under a state_ref as that attempt's ending, so a
    // replay writing there would end a successful install with a failure that never happened.
    expect(record.mock.calls[0][0]).not.toHaveProperty("stateRef");
  });

  it("records an expired state, which is the failure nobody can currently see", async () => {
    const { handler, store, record } = build();
    const state = await issue(store, entry.app, undefined, () => Date.now() - 60 * 60 * 1_000);
    const response = await handler(callbackRequest(entry.path, { code: "synthetic-code", state }));
    expect(response.headers.get("Location")).toBe(error);
    expect(record.mock.calls[0][0]).toMatchObject({
      outcome: "failed",
      code: "GHL_OAUTH_STATE_EXPIRED",
      stateRef: installEventStateRef(state),
    });
  });

  it("records a decline with the provider's code, and drops its prose", async () => {
    const short = build();
    const state = await issue(short.store, entry.app);
    const response = await short.handler(callbackRequest(entry.path, {
      state,
      error: "access_denied",
      error_description: "user-identifiable-detail-not-for-the-browser",
    }));
    expect(response.headers.get("Location")).toBe(declined);
    expect(short.record.mock.calls[0][0]).toMatchObject({
      app: entry.app,
      outcome: "declined",
      code: "GHL_OAUTH_PROVIDER_DECLINED",
      providerError: "access_denied",
      tenantId: "tenant-1",
    });

    // Driven through the real recorder against a fake client, because dropping prose is the
    // module's rule and the property worth proving is that no row carries it.
    const rows: Record<string, unknown>[] = [];
    const client = {
      from: () => ({
        insert: async (row: Record<string, unknown>) => {
          rows.push(row);
          return { error: null };
        },
      }),
    };
    const prose = build(undefined, (event) => recordInstallCallbackEvent(event, client as never));
    const proseState = await issue(prose.store, entry.app);
    const sentence = "The user at user@example.com declined this install from 203.0.113.9 at 14:02";
    const wordy = await prose.handler(callbackRequest(entry.path, {
      state: proseState,
      error: sentence,
    }));
    expect(wordy.headers.get("Location")).toBe(declined);
    expect(JSON.stringify(rows)).not.toContain("user@example.com");
    expect((rows[0].payload as { after: Record<string, unknown> }).after)
      .not.toHaveProperty("provider_error");
  });

  it("records a callback that carried a state but no code", async () => {
    const { handler, store, record } = build();
    const state = await issue(store, entry.app);
    const response = await handler(callbackRequest(entry.path, { state }));
    expect(response.headers.get("Location")).toBe(error);
    expect(record.mock.calls[0][0]).toMatchObject({
      outcome: "failed",
      code: "GHL_OAUTH_CODE_MISSING",
      stateRef: installEventStateRef(state),
      tenantId: "tenant-1",
    });
  });

  it("records the exchange failure's own code, status, and body key names", async () => {
    const failing = vi.fn(async () => {
      throw new GhlOAuthError("GHL_OAUTH_GRANT_REVOKED", 401, "error,message");
    });
    const { handler, store, record } = build(failing);
    const state = await issue(store, entry.app);
    const response = await handler(callbackRequest(entry.path, { state, code: "synthetic-code" }));
    expect(response.headers.get("Location")).toBe(error);
    expect(record.mock.calls[0][0]).toMatchObject({
      outcome: "failed",
      code: "GHL_OAUTH_GRANT_REVOKED",
      providerStatus: 401,
      bodyShape: "error,message",
    });
  });

  it("collapses an exchange failure that was only prose", async () => {
    const failing = vi.fn(async () => {
      throw new Error("invalid_grant: the authorization code has expired");
    });
    const { handler, store, record } = build(failing);
    const state = await issue(store, entry.app);
    const response = await handler(callbackRequest(entry.path, { state, code: "synthetic-code" }));
    expect(response.headers.get("Location")).toBe(error);
    expect(record.mock.calls[0][0]).toMatchObject({ code: INSTALL_EVENT_UNKNOWN_CODE });
  });

  it("writes no failure event on the path that worked", async () => {
    const { handler, store, record } = build();
    const state = await issue(store, entry.app);
    const response = await handler(callbackRequest(entry.path, { state, code: "synthetic-code" }));
    expect(response.headers.get("Location")).toBe(linked);
    expect(record).not.toHaveBeenCalled();
  });

  it("lets a broken recorder change nothing a browser can see", async () => {
    const rejecting = vi.fn(async () => { throw new Error("audit is down"); });
    const { handler, store } = build(vi.fn(async () => {}), rejecting);
    const state = await issue(store, entry.app);
    const response = await handler(callbackRequest(entry.path, { state }));
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(error);
  });
});

// The branch the client's first real install walks. Driven against the exported completions rather
// than the injected fakes, because what is being proved is which store call each grant type
// reaches and what the audit row says afterwards.
describe("what a completed install actually stores", () => {
  const STATE_HASH = "b".repeat(64);

  function auditClient(mode: "ok" | "always-fails" | "fails-once" = "ok") {
    const inserts: Record<string, unknown>[] = [];
    let attempts = 0;
    const client = {
      from: (table: string) => ({
        insert: async (row: Record<string, unknown>) => {
          inserts.push({ table, ...row });
          attempts += 1;
          const failing = mode === "always-fails" || (mode === "fails-once" && attempts === 1);
          return { error: failing ? { message: "audit is down" } : null };
        },
      }),
    };
    return { client: client as never, inserts, attempts: () => attempts };
  }

  const record: GhlOAuthStateRecord = {
    app: "agent",
    stateHash: STATE_HASH,
    tenantId: "tenant-1",
    actorId: ACTOR,
    returnPath: "/coach/integrations",
    expiresAt: "2030-01-01T00:00:00.000Z",
  };

  function grant(userType: "Company" | "Location"): GhlTokenGrant {
    return {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      tokenExpiresAt: "2030-01-01T00:00:00.000Z",
      userType,
      companyId: "company-1",
      locationId: userType === "Location" ? "location-1" : null,
      isBulkInstallation: userType === "Company",
      // Documented "only for company tokens", so a Location grant leaves both unanswered.
      approveAllLocations: userType === "Company" ? true : null,
      installToFutureLocations: userType === "Company" ? false : null,
    };
  }

  function after(row: Record<string, unknown>) {
    return (row.payload as { after: Record<string, unknown> }).after;
  }

  it("stores an agency-level agent install as the agent app's own Company grant", async () => {
    const audit = auditClient();
    const persistAgency = vi.fn(async () => ({
      id: "agency-install-1",
      companyId: "company-1",
      locationId: null,
      tenantId: null,
    }));
    const persistSubAccount = vi.fn();
    await completeGhlAgentInstall({ state: record, code: "synthetic-code" }, {
      exchange: async () => grant("Company"),
      client: () => audit.client,
      persistAgency,
      persistSubAccount: persistSubAccount as never,
    });
    // The whole point: this used to be refused with GHL_INSTALL_TARGET_UNKNOWN.
    expect(persistAgency).toHaveBeenCalledWith(grant("Company"), "agent", audit.client);
    expect(persistSubAccount).not.toHaveBeenCalled();
    expect(audit.inserts[0]).toMatchObject({
      action: "channel.messaging_install.completed",
      target_type: "ghl_agency_install",
      target_id: "agency-install-1",
      tenant_id: null,
      actor_id: ACTOR,
    });
    expect(after(audit.inserts[0])).toMatchObject({
      install_target: "company",
      user_type: "Company",
      // The audit row is the receipt an operator actually reads on the attempts panel, so it
      // carries the same three flags the install row does.
      is_bulk_installation: true,
      approve_all_locations: true,
      install_to_future_locations: false,
    });
  });

  it("keeps the per-tenant path for a Location grant and says so in the row", async () => {
    const audit = auditClient();
    const persistSubAccount = vi.fn(async () => ({
      id: "install-1",
      companyId: "company-1",
      locationId: "location-1",
      tenantId: "tenant-1",
    }));
    await completeGhlAgentInstall({ state: record, code: "synthetic-code" }, {
      exchange: async () => grant("Location"),
      client: () => audit.client,
      persistAgency: vi.fn() as never,
      persistSubAccount,
    });
    expect(persistSubAccount).toHaveBeenCalledWith(grant("Location"), "tenant-1", audit.client);
    expect(audit.inserts[0]).toMatchObject({
      target_type: "ghl_install",
      target_id: "install-1",
      tenant_id: "tenant-1",
    });
    expect(after(audit.inserts[0])).toMatchObject({
      install_target: "location",
      user_type: "Location",
      state_ref: STATE_HASH.slice(0, 12),
      is_bulk_installation: false,
      // Written as null rather than omitted: a key that is missing from one row and present in
      // another reads as an inconsistency, while an explicit null says the grant did not answer.
      approve_all_locations: null,
      install_to_future_locations: null,
    });
  });

  it("records what the agency install was offered, on the row an operator reads", async () => {
    const audit = auditClient();
    await completeGhlAgencyInstall({ state: record, code: "synthetic-code" }, {
      exchange: async () => grant("Company"),
      client: () => audit.client,
      persistAgency: async () => ({
        id: "agency-install-1",
        companyId: "company-1",
        locationId: null,
        tenantId: null,
      }),
    });
    // An install row is overwritten by the next reinstall; this row is not, so it is where the
    // answers to one particular consent screen survive.
    expect(after(audit.inserts[0])).toMatchObject({
      install_target: "company",
      is_bulk_installation: true,
      approve_all_locations: true,
      install_to_future_locations: false,
    });
  });

  it("refuses a Location grant at the agency callback by name, before storing anything", async () => {
    const audit = auditClient();
    const persistAgency = vi.fn();
    await expect(completeGhlAgencyInstall({ state: record, code: "synthetic-code" }, {
      exchange: async () => grant("Location"),
      client: () => audit.client,
      persistAgency: persistAgency as never,
    })).rejects.toThrow(/GHL_AGENCY_INSTALL_USER_TYPE_UNEXPECTED/);
    expect(persistAgency).not.toHaveBeenCalled();
    expect(audit.inserts).toEqual([]);
  });

  it("retries a failed completion audit once and then stops calling it an error", async () => {
    const retried = auditClient("fails-once");
    await completeGhlAgentInstall({ state: record, code: "synthetic-code" }, {
      exchange: async () => grant("Location"),
      client: () => retried.client,
      persistAgency: vi.fn() as never,
      persistSubAccount: async () => ({
        id: "install-1",
        companyId: "company-1",
        locationId: "location-1",
        tenantId: "tenant-1",
      }),
    });
    expect(retried.attempts()).toBe(2);

    // The credential is on disk and the connection works. Throwing here would redirect the browser
    // to ?messaging=error and send a coach to reconnect an install that was already fine.
    const console_ = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = auditClient("always-fails");
    await expect(completeGhlAgentInstall({ state: record, code: "synthetic-code" }, {
      exchange: async () => grant("Location"),
      client: () => failed.client,
      persistAgency: vi.fn() as never,
      persistSubAccount: async () => ({
        id: "install-1",
        companyId: "company-1",
        locationId: "location-1",
        tenantId: "tenant-1",
      }),
    })).resolves.toBeUndefined();
    expect(failed.attempts()).toBe(2);
    expect(console_).toHaveBeenCalled();
    // And the log line carries no state, code, or token — only what it takes to find the install.
    expect(JSON.stringify(console_.mock.calls)).not.toContain("synthetic");
    console_.mockRestore();
  });
});

describe("GHL install start events", () => {
  const owner = async () => ({ userId: ACTOR, role: "owner" as UserRole });

  function post(body: unknown) {
    return new Request(`${APP_BASE_URL}/api/channels/ghl/install-start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  function start(
    session: () => Promise<{
      userId: string;
      role: UserRole;
      tenantId?: string | null;
      impersonatingTenant?: string | null;
    } | null>,
    begin: GhlInstallStartDependencies["begin"] = async () => ({
      authorizationUrl: `${INSTALL_URL}&state=synthetic-state`,
      expiresAt: "2030-01-01T00:00:00.000Z",
    }),
  ) {
    const record = vi.fn<(refusal: GhlInstallStartRefusal) => Promise<void>>(async () => {});
    return {
      record,
      handler: createGhlInstallStartHandler({ enabled: () => true, session, begin, record }),
    };
  }

  it("records an impersonated caller, naming the app the request asked for", async () => {
    const { handler, record } = start(async () => ({
      userId: ACTOR,
      role: "admin" as UserRole,
      impersonatingTenant: "tenant-1",
    }));
    const response = await handler(post({ app: "agent" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden." });
    expect(record.mock.calls[0][0]).toEqual({
      app: "agent",
      actorId: ACTOR,
      tenantId: null,
      code: "GHL_INSTALL_START_IMPERSONATION_FORBIDDEN",
    });
  });

  it("records a caller whose role may not start an install", async () => {
    const { handler, record } = start(async () => ({ userId: ACTOR, role: "coach" as UserRole }));
    const response = await handler(post({ app: "provisioning" }));
    expect(response.status).toBe(403);
    expect(record.mock.calls[0][0]).toMatchObject({
      app: "provisioning",
      code: "GHL_INSTALL_START_ROLE_FORBIDDEN",
    });
  });

  it("records an unparseable request against an unknown app", async () => {
    for (const body of [{ app: "nope" }, "\"not-an-object\"", "{"]) {
      const { handler, record } = start(owner);
      const response = await handler(post(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid install request." });
      expect(record.mock.calls[0][0]).toEqual({
        app: "unknown",
        actorId: ACTOR,
        tenantId: null,
        code: "GHL_INSTALL_START_REQUEST_INVALID",
      });
    }
  });

  it("records the missing variable names when configuration is why nothing was issued", async () => {
    const { handler, record } = start(owner, async () => {
      throw new DriverConfigurationError("ghl_provisioning", ["GHL_AGENCY_CLIENT_SECRET"]);
    });
    const response = await handler(post({ app: "provisioning", tenantId: "tenant-1" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Messaging install could not be started." });
    expect(record.mock.calls[0][0]).toEqual({
      app: "provisioning",
      actorId: ACTOR,
      tenantId: "tenant-1",
      code: "DRIVER_CONFIGURATION_ERROR",
      missingEnv: ["GHL_AGENCY_CLIENT_SECRET"],
    });
  });

  it("writes nothing before the caller is known", async () => {
    const anonymous = start(async () => null);
    expect((await anonymous.handler(post({ app: "agent" }))).status).toBe(401);
    expect(anonymous.record).not.toHaveBeenCalled();

    const record = vi.fn<(refusal: GhlInstallStartRefusal) => Promise<void>>(async () => {});
    const off = createGhlInstallStartHandler({
      enabled: () => false,
      session: vi.fn(),
      begin: vi.fn(),
      record,
    });
    expect((await off(post({ app: "agent" }))).status).toBe(404);
    expect(record).not.toHaveBeenCalled();
  });

  it("writes no refusal on the path that issued a link", async () => {
    const { handler, record } = start(owner);
    const response = await handler(post({ app: "agent" }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      authorizationUrl: `${INSTALL_URL}&state=synthetic-state`,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(record).not.toHaveBeenCalled();
  });

  it("lets a broken recorder change nothing a browser can see", async () => {
    const record = vi.fn(async () => { throw new Error("audit is down"); });
    const handler = createGhlInstallStartHandler({
      enabled: () => true,
      session: owner,
      begin: async () => { throw new Error("GHL_INSTALL_START_AUDIT_FAILED"); },
      record,
    });
    const response = await handler(post({ app: "agent" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Messaging install could not be started." });
  });

  it("refuses a tenant-scoped actor who names a tenant that is not their own", async () => {
    const coachOwner = async () => ({
      userId: ACTOR,
      role: "owner" as UserRole,
      tenantId: "tenant-mine",
    });
    const foreign = start(coachOwner);
    const refused = await foreign.handler(post({ app: "agent", tenantId: "tenant-theirs" }));
    expect(refused.status).toBe(403);
    expect(foreign.record.mock.calls[0][0]).toMatchObject({
      code: "GHL_INSTALL_START_TENANT_FORBIDDEN",
      tenantId: "tenant-theirs",
    });

    // Their own tenant, and naming none at all, both stay allowed.
    for (const body of [{ app: "agent", tenantId: "tenant-mine" }, { app: "agent" }]) {
      const allowed = start(coachOwner);
      expect((await allowed.handler(post(body))).status).toBe(201);
      expect(allowed.record).not.toHaveBeenCalled();
    }

    // A platform actor carries no tenant claim and may still name one; which locations that lets
    // them bind is the store's decision, not this route's.
    const platform = start(owner);
    expect((await platform.handler(post({ app: "agent", tenantId: "tenant-theirs" }))).status)
      .toBe(201);
  });

  it("puts the impersonation refusal ahead of the tenant one, so it reads as what it is", async () => {
    const { handler, record } = start(async () => ({
      userId: ACTOR,
      role: "owner" as UserRole,
      tenantId: "tenant-mine",
      impersonatingTenant: "tenant-theirs",
    }));
    expect((await handler(post({ app: "agent", tenantId: "tenant-theirs" }))).status).toBe(403);
    expect(record.mock.calls[0][0]).toMatchObject({
      code: "GHL_INSTALL_START_IMPERSONATION_FORBIDDEN",
    });
  });
});

describe("who the install starter is allowed to see", () => {
  it("reports an impersonating actor instead of collapsing them to nobody", async () => {
    // loadPlatformActor returns null the moment impersonatingTenant is set, which is correct for
    // the route that exports it and is why the impersonation refusal here could never run: the
    // handler saw no actor at all and answered 401 with nothing recorded.
    claims.value = {
      sub: ACTOR,
      app_metadata: {
        role: "admin",
        tenant_id: null,
        impersonating_tenant: "tenant-1",
      },
    };
    await expect(loadInstallStartActor()).resolves.toEqual({
      userId: ACTOR,
      role: "admin",
      tenantId: null,
      impersonatingTenant: "tenant-1",
      impersonationSessionId: null,
    });
  });

  it("still refuses a token carrying no user or no role", async () => {
    claims.value = { sub: ACTOR, app_metadata: { role: "not-a-role" } };
    await expect(loadInstallStartActor()).resolves.toBeNull();
    claims.value = { app_metadata: { role: "admin" } };
    await expect(loadInstallStartActor()).resolves.toBeNull();
    claims.value = null;
    await expect(loadInstallStartActor()).resolves.toBeNull();
  });
});

describe("an install start that could not be recorded leaves no state behind", () => {
  const input = { app: "agent" as const, actorId: ACTOR, tenantId: null, returnPath: null };
  const failingAudit = {
    from: () => ({ insert: async () => ({ error: { message: "audit is down" } }) }),
  };

  beforeEach(() => {
    vi.stubEnv("APP_BASE_URL", APP_BASE_URL);
    vi.stubEnv("GHL_INSTALL_URL", INSTALL_URL);
    vi.stubEnv("GHL_CLIENT_ID", "synthetic-client-id");
    vi.stubEnv("GHL_CLIENT_SECRET", "synthetic-client-secret");
    vi.stubEnv("SETTERFI_CREDENTIAL_ENCRYPTION_KEY", "0".repeat(64));
  });
  afterEach(() => vi.unstubAllEnvs());

  it("consumes the state it issued before it reports the failure", async () => {
    const store = stateStore();
    const consume = vi.spyOn(store, "consume");
    await expect(beginGhlInstall(input, store, failingAudit as never))
      .rejects.toThrow(/GHL_INSTALL_START_AUDIT_FAILED/);
    // An unconsumed state row outliving an attempt that produced no link is a live credential
    // nobody is waiting for; the raw state never leaves this function, so nothing else can spend it.
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0][2]).toBe("agent");
  });

  it("swallows a failure to consume, because the caller already has its 503", async () => {
    const store = stateStore();
    vi.spyOn(store, "consume").mockRejectedValue(new Error("the state table is down"));
    await expect(beginGhlInstall(input, store, failingAudit as never))
      .rejects.toThrow(/GHL_INSTALL_START_AUDIT_FAILED/);
  });

  it("writes no consume on the path that issued a link", async () => {
    const store = stateStore();
    const consume = vi.spyOn(store, "consume");
    const okAudit = { from: () => ({ insert: async () => ({ error: null }) }) };
    await expect(beginGhlInstall(input, store, okAudit as never))
      .resolves.toMatchObject({ authorizationUrl: expect.stringContaining("state=") });
    expect(consume).not.toHaveBeenCalled();
  });
});
