import { describe, expect, it, vi } from "vitest";

import {
  GHL_OAUTH_AUTHORIZATION_ENDPOINT,
  GHL_OAUTH_CALLBACK_PATHS,
  GHL_OAUTH_SCOPES,
  GhlOAuthError,
  buildGhlAuthorizationUrl,
  consumeGhlOAuthState,
  exchangeGhlAuthorizationCode,
  ghlOAuthStateHash,
  ghlRedirectUri,
  issueGhlOAuthState,
  refreshGhlGrant,
  resolveRefreshingAccessToken,
  validateGhlReturnPath,
  type GhlCustodyRow,
  type GhlOAuthStateRecord,
  type GhlOAuthStateStore,
  type GhlRefreshableCustody,
} from "./ghl-oauth";

const APP_BASE_URL = "https://setterfi.test";
const INSTALL_URL = "https://marketplace.example.test/oauth/chooselocation?appId=synthetic-app";
const CLIENT = { clientId: "synthetic-client-id", clientSecret: "synthetic-client-secret" };
const ACTOR = "00000000-0000-4000-8000-000000000001";

function stateStore() {
  const rows = new Map<string, GhlOAuthStateRecord & { consumedAt: string | null }>();
  const store: GhlOAuthStateStore = {
    save: async (record) => void rows.set(record.stateHash, { ...record, consumedAt: null }),
    consume: async (stateHash, consumedAt, app) => {
      const row = rows.get(stateHash);
      // App-scoped, matching the SQL predicate: a cross-app callback consumes nothing.
      if (!row || row.consumedAt || row.app !== app) return null;
      row.consumedAt = consumedAt;
      return { ...row };
    },
    describe: async (stateHash) => {
      const row = rows.get(stateHash);
      return row ? { app: row.app, consumedAt: row.consumedAt } : null;
    },
  };
  return { store, rows };
}

function fixedRandomBytes(seed: string) {
  return (size: number) => Buffer.alloc(size, seed.charCodeAt(0));
}

describe("GHL install state", () => {
  it("adds only our redirect and state to the provider's own install link", async () => {
    const { store, rows } = stateStore();
    const issued = await issueGhlOAuthState({
      app: "agent",
      actorId: ACTOR,
      tenantId: "tenant-1",
      returnPath: "/coach/integrations",
      appBaseUrl: APP_BASE_URL,
      installUrl: INSTALL_URL,
    }, { states: store, now: () => 1_000, randomBytes: fixedRandomBytes("a") });

    const url = new URL(issued.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://marketplace.example.test/oauth/chooselocation");
    expect(url.searchParams.get("appId")).toBe("synthetic-app");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://setterfi.test/api/channels/messaging/callback",
    );
    const state = url.searchParams.get("state") ?? "";
    // Only the digest is durable; the state itself never lands in a row.
    expect([...rows.keys()]).toEqual([ghlOAuthStateHash(state)]);
    expect(rows.get(ghlOAuthStateHash(state))).toMatchObject({
      app: "agent",
      tenantId: "tenant-1",
      returnPath: "/coach/integrations",
      expiresAt: new Date(1_000 + 10 * 60 * 1_000).toISOString(),
    });
  });

  it("refuses an off-origin return path and a non-https install link", async () => {
    const { store } = stateStore();
    expect(() => validateGhlReturnPath("//evil.test/steal", APP_BASE_URL)).toThrow(
      /GHL_OAUTH_RETURN_PATH_INVALID/,
    );
    expect(() => validateGhlReturnPath("https://evil.test/steal", APP_BASE_URL)).toThrow(
      /GHL_OAUTH_RETURN_PATH_INVALID/,
    );
    await expect(issueGhlOAuthState({
      app: "provisioning",
      actorId: ACTOR,
      appBaseUrl: APP_BASE_URL,
      installUrl: "http://marketplace.example.test/install",
    }, { states: store })).rejects.toThrow(/GHL_OAUTH_INSTALL_URL_INVALID/);
    expect(ghlRedirectUri("provisioning", APP_BASE_URL)).toBe(
      "https://setterfi.test/api/channels/messaging/agency-callback",
    );
  });

  it("keeps the provider's brand out of every callback path a coach's browser lands on", () => {
    for (const path of Object.values(GHL_OAUTH_CALLBACK_PATHS)) {
      expect(path).not.toMatch(/ghl/i);
    }
  });

  it("consumes a state exactly once and refuses replay, forgery, mismatch, and expiry", async () => {
    const { store } = stateStore();
    const issued = await issueGhlOAuthState({
      app: "agent",
      actorId: ACTOR,
      appBaseUrl: APP_BASE_URL,
      installUrl: INSTALL_URL,
    }, { states: store, now: () => 0, randomBytes: fixedRandomBytes("b") });
    const state = new URL(issued.authorizationUrl).searchParams.get("state") ?? "";

    await expect(consumeGhlOAuthState({ app: "agent", state }, {
      states: store,
      now: () => 1_000,
    })).resolves.toMatchObject({ app: "agent", returnPath: "/coach/integrations" });
    // A replay of a state that was already spent, named apart from a forgery: it is the ending of
    // an attempt that succeeded, and the routes rely on being able to tell the two apart.
    await expect(consumeGhlOAuthState({ app: "agent", state }, {
      states: store,
      now: () => 1_000,
    })).rejects.toThrow(/GHL_OAUTH_STATE_ALREADY_COMPLETED/);
    await expect(consumeGhlOAuthState({ app: "agent", state: "never-issued" }, {
      states: store,
    })).rejects.toThrow(/GHL_OAUTH_STATE_INVALID_OR_REPLAYED/);

    const second = await issueGhlOAuthState({
      app: "agent",
      actorId: ACTOR,
      appBaseUrl: APP_BASE_URL,
      installUrl: INSTALL_URL,
    }, { states: store, now: () => 0, randomBytes: fixedRandomBytes("c") });
    const secondState = new URL(second.authorizationUrl).searchParams.get("state") ?? "";
    await expect(consumeGhlOAuthState({ app: "provisioning", state: secondState }, {
      states: store,
      now: () => 1_000,
    })).rejects.toThrow(/GHL_OAUTH_STATE_APP_MISMATCH/);
    // Refused without being spent, so the callback it was actually issued for still works. The
    // other order let one app's callback burn the other app's state on its way to refusing it.
    await expect(consumeGhlOAuthState({ app: "agent", state: secondState }, {
      states: store,
      now: () => 1_000,
    })).resolves.toMatchObject({ app: "agent" });

    const third = await issueGhlOAuthState({
      app: "agent",
      actorId: ACTOR,
      appBaseUrl: APP_BASE_URL,
      installUrl: INSTALL_URL,
    }, { states: store, now: () => 0, randomBytes: fixedRandomBytes("d") });
    const thirdState = new URL(third.authorizationUrl).searchParams.get("state") ?? "";
    await expect(consumeGhlOAuthState({ app: "agent", state: thirdState }, {
      states: store,
      now: () => 10 * 60 * 1_000 + 1,
    })).rejects.toThrow(/GHL_OAUTH_STATE_EXPIRED/);
  });
});

describe("GHL authorization URL", () => {
  // The shape both stored portal links were observed to have on 2026-08-19 and re-parsed
  // 2026-09-02 (param names only): the whitelabel host, the v2 chooselocation path, and
  // client_id / redirect_uri / response_type / scope. `version_id` is the one param we cannot
  // reproduce, because the provider does not document it.
  const STORED_LINK_HOST_AND_PATH =
    "https://marketplace.leadconnectorhq.com/v2/oauth/chooselocation";

  it.each([
    ["agent", "synthetic-agent-client-id", "/api/channels/messaging/callback"],
    ["provisioning", "synthetic-agency-client-id", "/api/channels/messaging/agency-callback"],
  ] as const)(
    "builds %s's authorization URL at the stored link's host, path, and param set",
    (app, clientId, callbackPath) => {
      const url = new URL(buildGhlAuthorizationUrl({ app, appBaseUrl: APP_BASE_URL, clientId }));

      expect(url.origin + url.pathname).toBe(STORED_LINK_HOST_AND_PATH);
      expect([...url.searchParams.keys()].sort()).toEqual(
        ["client_id", "redirect_uri", "response_type", "scope"],
      );
      expect(url.searchParams.get("client_id")).toBe(clientId);
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("redirect_uri")).toBe(`${APP_BASE_URL}${callbackPath}`);
      // Order is server-assigned in the portal's own links, so only the set is asserted.
      expect((url.searchParams.get("scope") ?? "").split(" ").sort()).toEqual(
        [...GHL_OAUTH_SCOPES[app]].sort(),
      );
    },
  );

  it("gives each app exactly its own scopes and never the other app's", () => {
    expect(GHL_OAUTH_SCOPES.agent).toHaveLength(9);
    expect(GHL_OAUTH_SCOPES.provisioning).toHaveLength(4);
    const agencyOnly = GHL_OAUTH_SCOPES.provisioning.filter(
      (scope) => !GHL_OAUTH_SCOPES.agent.includes(scope),
    );
    // App 2 is Agency-target and cannot hold sub-account scopes at all, so a builder that handed
    // it app 1's list would be asking for scopes the app was never granted.
    expect(agencyOnly).toEqual(["locations.write", "locations.readonly", "snapshots.readonly"]);
    expect(GHL_OAUTH_SCOPES.agent).not.toContain("locations.write");
    expect(GHL_OAUTH_SCOPES.provisioning).not.toContain("conversations/message.write");
    expect(GHL_OAUTH_AUTHORIZATION_ENDPOINT).toBe(STORED_LINK_HOST_AND_PATH);
  });

  it("refuses to build without a client id rather than send the provider an empty one", () => {
    expect(() => buildGhlAuthorizationUrl({
      app: "agent",
      appBaseUrl: APP_BASE_URL,
      clientId: "  ",
    })).toThrow(/GHL_OAUTH_CLIENT_ID_REQUIRED/);
  });

  it("builds the link when no install-url override is configured, and still carries state", async () => {
    const { store } = stateStore();
    const issued = await issueGhlOAuthState({
      app: "provisioning",
      actorId: ACTOR,
      appBaseUrl: APP_BASE_URL,
      installUrl: "",
      clientId: "synthetic-agency-client-id",
    }, { states: store, now: () => 0, randomBytes: fixedRandomBytes("e") });

    const url = new URL(issued.authorizationUrl);
    expect(url.origin + url.pathname).toBe(STORED_LINK_HOST_AND_PATH);
    expect(url.searchParams.get("client_id")).toBe("synthetic-agency-client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://setterfi.test/api/channels/messaging/agency-callback",
    );
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("prefers a configured install link over the builder, and still sets redirect and state", async () => {
    const { store, rows } = stateStore();
    const issued = await issueGhlOAuthState({
      app: "agent",
      actorId: ACTOR,
      appBaseUrl: APP_BASE_URL,
      // A portal link carries `version_id`, which is undocumented and so unbuildable; when one is
      // configured it wins, and the builder's host never appears.
      installUrl: `${INSTALL_URL}&version_id=synthetic-version`,
      clientId: "synthetic-agent-client-id",
    }, { states: store, now: () => 0, randomBytes: fixedRandomBytes("f") });

    const url = new URL(issued.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://marketplace.example.test/oauth/chooselocation");
    expect(url.searchParams.get("version_id")).toBe("synthetic-version");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://setterfi.test/api/channels/messaging/callback",
    );
    const state = url.searchParams.get("state") ?? "";
    expect([...rows.keys()]).toEqual([ghlOAuthStateHash(state)]);
  });
});

describe("GHL token endpoint", () => {
  const grantPayload = {
    access_token: "synthetic-access-1",
    refresh_token: "synthetic-refresh-1",
    expires_in: 86_399,
    userType: "Location",
    companyId: "company-1",
    locationId: "location-1",
  };

  it("form-encodes an authorization-code exchange and dates the expiry from the response", async () => {
    let captured: { url: string; init: RequestInit | undefined } | null = null;
    const fetcher: typeof fetch = async (input, init) => {
      captured = { url: String(input), init };
      return Response.json(grantPayload);
    };
    const grant = await exchangeGhlAuthorizationCode({
      app: "agent",
      code: "synthetic-code",
      client: CLIENT,
      redirectUri: "https://setterfi.test/api/channels/messaging/callback",
    }, { fetch: fetcher, now: () => 1_700_000_000_000 });

    expect(grant).toEqual({
      accessToken: "synthetic-access-1",
      refreshToken: "synthetic-refresh-1",
      tokenExpiresAt: new Date(1_700_000_000_000 + 86_399_000).toISOString(),
      userType: "Location",
      companyId: "company-1",
      locationId: "location-1",
      // Absent in the response, so absent in the grant. A missing answer is not a "no".
      approveAllLocations: null,
      isBulkInstallation: null,
      installToFutureLocations: null,
    });
    const call = captured as unknown as { url: string; init: RequestInit };
    expect(call.url).toBe("https://services.leadconnectorhq.com/oauth/token");
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = call.init.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
      grant_type: "authorization_code",
      code: "synthetic-code",
      user_type: "Location",
      redirect_uri: "https://setterfi.test/api/channels/messaging/callback",
    });
  });

  /**
   * The three install-shape flags the provider returns beside the tokens. They are the only record
   * of what the consent screen offered the installer and what they picked, and the provider does
   * not tell us again later: `installToFutureLocations = false` on a stored company grant is
   * otherwise observable only by asking the provider.
   *
   * https://marketplace.gohighlevel.com/docs/ghl/oauth/get-access-token/ (checked 2026-08-22): all
   * three are optional booleans, and `approveAllLocations` / `installToFutureLocations` are
   * documented "only for company tokens".
   */
  it("carries the three install-shape flags through, keeping false apart from absent", async () => {
    const fetcher: typeof fetch = async () => Response.json({
      ...grantPayload,
      userType: "Company",
      isBulkInstallation: true,
      installToFutureLocations: false,
      // Not a boolean, so not an answer. Coercing this would invent a decision nobody made.
      approveAllLocations: "true",
    });
    const grant = await exchangeGhlAuthorizationCode({
      app: "agent",
      code: "synthetic-code",
      client: CLIENT,
      redirectUri: "https://setterfi.test/api/channels/messaging/callback",
    }, { fetch: fetcher, now: () => 0 });

    expect(grant.isBulkInstallation).toBe(true);
    expect(grant.installToFutureLocations).toBe(false);
    expect(grant.approveAllLocations).toBeNull();
  });

  it("sends the agency user type and a refresh grant when refreshing", async () => {
    let body: URLSearchParams | null = null;
    const fetcher: typeof fetch = async (_input, init) => {
      body = init?.body as URLSearchParams;
      return Response.json({ ...grantPayload, userType: "Company", locationId: undefined });
    };
    await refreshGhlGrant({
      app: "provisioning",
      refreshToken: "synthetic-refresh-0",
      client: CLIENT,
    }, { fetch: fetcher, now: () => 0 });
    expect(Object.fromEntries(body as unknown as URLSearchParams)).toEqual({
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
      grant_type: "refresh_token",
      refresh_token: "synthetic-refresh-0",
      user_type: "Company",
    });
  });

  it("classifies a refused grant as terminal and never repeats a provider body", async () => {
    const refused: typeof fetch = async () => Response.json(
      { message: "refresh token has already been used", trace: "not-repeated" },
      { status: 401 },
    );
    try {
      await refreshGhlGrant({ app: "agent", refreshToken: "spent", client: CLIENT }, { fetch: refused });
      expect.unreachable("a refused grant must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GhlOAuthError);
      expect((error as GhlOAuthError).code).toBe("GHL_OAUTH_GRANT_REVOKED");
      expect(String(error)).not.toContain("not-repeated");
    }

    const flaky: typeof fetch = async () => Response.json({ message: "upstream" }, { status: 503 });
    await expect(
      refreshGhlGrant({ app: "agent", refreshToken: "live", client: CLIENT }, { fetch: flaky }),
    ).rejects.toThrow(/GHL_OAUTH_REFRESH_FAILED/);

    const truncated: typeof fetch = async () => Response.json({ access_token: "only-half" });
    await expect(
      exchangeGhlAuthorizationCode({
        app: "agent",
        code: "synthetic-code",
        client: CLIENT,
        redirectUri: "https://setterfi.test/api/channels/messaging/callback",
      }, { fetch: truncated }),
    ).rejects.toThrow(/GHL_OAUTH_TOKEN_ENVELOPE_INVALID/);

    const network: typeof fetch = async () => {
      throw new Error("connect ECONNREFUSED https://services.leadconnectorhq.com/oauth/token?secret");
    };
    try {
      await exchangeGhlAuthorizationCode({
        app: "agent",
        code: "synthetic-code",
        client: CLIENT,
        redirectUri: "https://setterfi.test/api/channels/messaging/callback",
      }, { fetch: network });
      expect.unreachable("a network failure must throw");
    } catch (error) {
      expect(String(error)).toBe("GhlOAuthError: GHL_OAUTH_TOKEN_EXCHANGE_FAILED_NETWORK");
      expect(String(error)).not.toContain("services.leadconnectorhq.com");
    }
  });
});

// ---------------------------------------------------------------------------
// Refreshing custody
// ---------------------------------------------------------------------------

const IDENTITY_CRYPTO = {
  encryptCredential: ((value: string) => ({ plaintext: value })) as never,
  decryptCredential: ((value: unknown) => (value as { plaintext: string }).plaintext) as never,
};

function custody(initial: Partial<GhlCustodyRow> & { tokenExpiresAt: string | null }) {
  const row: GhlCustodyRow = {
    id: "install-1",
    installState: "token_ok",
    accessCredentialEnvelope: { plaintext: "stored-access" },
    refreshCredentialEnvelope: { plaintext: "stored-refresh" },
    reauthorizationRequiredAt: null,
    companyId: "company-1",
    ...initial,
  };
  let lease: { token: string; until: number } | null = null;
  let issued = 0;
  const calls = { claim: 0, renew: 0, commit: 0, release: 0, revoked: 0, fenced: 0 };
  // Every write past the claim is fenced on the lease's identity, exactly as the SQL predicate
  // behaves: a holder presenting a token the row no longer carries matches nothing.
  const holds = (leaseToken: string) => {
    if (lease?.token === leaseToken) return true;
    calls.fenced += 1;
    return false;
  };
  const port: GhlRefreshableCustody = {
    load: async () => ({ ...row }),
    claim: async ({ nowIso, leaseUntilIso }) => {
      calls.claim += 1;
      // Compare-and-set, exactly as the SQL predicate behaves: the loser sees the winner's lease.
      if (lease !== null && lease.until >= Date.parse(nowIso)) return null;
      issued += 1;
      lease = { token: `lease-${issued}`, until: Date.parse(leaseUntilIso) };
      return { ...row, leaseToken: lease.token };
    },
    renew: async ({ leaseToken, nowIso, leaseUntilIso }) => {
      calls.renew += 1;
      if (!holds(leaseToken) || !lease || lease.until <= Date.parse(nowIso)) return false;
      lease.until = Date.parse(leaseUntilIso);
      return true;
    },
    commit: async ({ leaseToken, accessCredentialEnvelope, refreshCredentialEnvelope, tokenExpiresAt }) => {
      calls.commit += 1;
      if (!holds(leaseToken)) return false;
      row.accessCredentialEnvelope = accessCredentialEnvelope;
      row.refreshCredentialEnvelope = refreshCredentialEnvelope;
      row.tokenExpiresAt = tokenExpiresAt;
      lease = null;
      return true;
    },
    release: async (_id, leaseToken) => {
      calls.release += 1;
      if (!holds(leaseToken)) return;
      lease = null;
    },
    markReauthorizationRequired: async ({ at, leaseToken }) => {
      calls.revoked += 1;
      if (!holds(leaseToken)) return;
      row.reauthorizationRequiredAt = at;
      row.installState = "failed";
      lease = null;
    },
  };
  // Standing in for a sixty-second lease that ran out while its holder was at the provider.
  const expireLease = () => { if (lease) lease.until = 0; };
  return { port, row, calls, expireLease };
}

describe("refreshing token custody", () => {
  const NOW = 1_700_000_000_000;
  const fresh = new Date(NOW + 60 * 60 * 1_000).toISOString();
  const stale = new Date(NOW + 60 * 1_000).toISOString();

  it("returns the stored token untouched while it is comfortably short of expiry", async () => {
    const { port, calls } = custody({ tokenExpiresAt: fresh });
    const refresh = vi.fn();
    await expect(resolveRefreshingAccessToken("install", {
      custody: port,
      refresh,
      now: () => NOW,
      ...IDENTITY_CRYPTO,
    })).resolves.toBe("stored-access");
    expect(refresh).not.toHaveBeenCalled();
    expect(calls.claim).toBe(0);
  });

  it("refreshes inside the safety margin and persists the rotated refresh token", async () => {
    const { port, row, calls } = custody({ tokenExpiresAt: stale });
    const refresh = vi.fn(async (token: string) => {
      expect(token).toBe("stored-refresh");
      return {
        accessToken: "rotated-access",
        refreshToken: "rotated-refresh",
        tokenExpiresAt: fresh,
        userType: "Company" as const,
        companyId: "company-1",
        locationId: null,
        approveAllLocations: null,
        isBulkInstallation: null,
        installToFutureLocations: null,
      };
    });
    await expect(resolveRefreshingAccessToken("agency", {
      custody: port,
      refresh,
      now: () => NOW,
      ...IDENTITY_CRYPTO,
    })).resolves.toBe("rotated-access");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls.commit).toBe(1);
    // Losing the rotated refresh token loses the install permanently, so it must be stored.
    expect(row.refreshCredentialEnvelope).toEqual({ plaintext: "rotated-refresh" });
    expect(row.accessCredentialEnvelope).toEqual({ plaintext: "rotated-access" });
    expect(row.tokenExpiresAt).toBe(fresh);
  });

  it("renews the fenced lease while a slow provider refresh is in flight", async () => {
    const { port, calls } = custody({ tokenExpiresAt: stale });
    const startedAt = Date.now();
    await expect(resolveRefreshingAccessToken("install", {
      custody: port,
      leaseMs: 30,
      now: () => startedAt + (Date.now() - startedAt),
      ...IDENTITY_CRYPTO,
      refresh: async () => {
        await new Promise((resolve) => setTimeout(resolve, 55));
        return {
          accessToken: "rotated-access",
          refreshToken: "rotated-refresh",
          tokenExpiresAt: new Date(startedAt + 60 * 60 * 1_000).toISOString(),
          userType: "Location" as const,
          companyId: "company-1",
          locationId: "location-1",
          approveAllLocations: null,
          isBulkInstallation: null,
          installToFutureLocations: null,
        };
      },
    })).resolves.toBe("rotated-access");
    expect(calls.renew).toBeGreaterThanOrEqual(2);
    expect(calls.commit).toBe(1);
  });

  it("spends the single-use refresh token once when two callers race", async () => {
    const { port, calls } = custody({ tokenExpiresAt: stale });
    let refreshes = 0;
    const refresh = async () => {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        accessToken: "rotated-access",
        refreshToken: "rotated-refresh",
        tokenExpiresAt: fresh,
        userType: "Company" as const,
        companyId: "company-1",
        locationId: null,
        approveAllLocations: null,
        isBulkInstallation: null,
        installToFutureLocations: null,
      };
    };
    const options = {
      custody: port,
      refresh,
      now: () => NOW,
      waitIntervalMs: 1,
      ...IDENTITY_CRYPTO,
    };
    const [first, second] = await Promise.all([
      resolveRefreshingAccessToken("agency", options),
      resolveRefreshingAccessToken("agency", options),
    ]);
    expect(refreshes).toBe(1);
    expect(calls.claim).toBe(2);
    expect(first).toBe("rotated-access");
    // The loser waits for the winner's committed row rather than burning the token again.
    expect(second).toBe("rotated-access");
  });

  it("fails closed when the lease holder never publishes a result", async () => {
    const { port } = custody({ tokenExpiresAt: stale });
    // Take the lease and never release it, standing in for an instance that died mid-refresh.
    await port.claim({
      id: "install-1",
      nowIso: new Date(NOW).toISOString(),
      leaseUntilIso: new Date(NOW + 60_000).toISOString(),
    });
    await expect(resolveRefreshingAccessToken("install", {
      custody: port,
      refresh: async () => expect.unreachable("the lease was not available"),
      now: () => NOW,
      waitAttempts: 2,
      waitIntervalMs: 1,
      ...IDENTITY_CRYPTO,
    })).rejects.toThrow(/GHL_INSTALL_REFRESH_LOCK_UNAVAILABLE/);
  });

  it("marks a revoked grant for re-authorization instead of retrying or serving a stale token", async () => {
    const { port, row, calls } = custody({ tokenExpiresAt: stale });
    await expect(resolveRefreshingAccessToken("agency", {
      custody: port,
      refresh: async () => { throw new GhlOAuthError("GHL_OAUTH_GRANT_REVOKED", 401, "message"); },
      now: () => NOW,
      ...IDENTITY_CRYPTO,
    })).rejects.toThrow(/GHL_AGENCY_INSTALL_REAUTHORIZATION_REQUIRED/);
    expect(calls.revoked).toBe(1);
    expect(calls.commit).toBe(0);
    expect(row.accessCredentialEnvelope).toEqual({ plaintext: "stored-access" });

    // And every later call refuses from storage without touching the provider again.
    await expect(resolveRefreshingAccessToken("agency", {
      custody: port,
      refresh: async () => expect.unreachable("a revoked grant must not be retried"),
      now: () => NOW,
      ...IDENTITY_CRYPTO,
    })).rejects.toThrow(/GHL_AGENCY_INSTALL_REAUTHORIZATION_REQUIRED/);
  });

  it("releases the lease and rethrows when a refresh fails for a reason that is not revocation", async () => {
    const { port, calls } = custody({ tokenExpiresAt: stale });
    await expect(resolveRefreshingAccessToken("install", {
      custody: port,
      refresh: async () => { throw new GhlOAuthError("GHL_OAUTH_REFRESH_FAILED", 503, "message"); },
      now: () => NOW,
      ...IDENTITY_CRYPTO,
    })).rejects.toThrow(/GHL_OAUTH_REFRESH_FAILED/);
    expect(calls.release).toBe(1);
    expect(calls.revoked).toBe(0);
  });

  // The lease's expiry is what stops a crashed instance wedging an install forever, and it is also
  // what lets a holder come back from the provider holding a lease somebody else now owns. Without
  // a fence that holder's commit would overwrite the grant the winner actually persisted, and the
  // winner's rotated refresh token — spent the moment it is used — would be gone for good.
  const winnerGrant = {
    accessToken: "winner-access",
    refreshToken: "winner-refresh",
    tokenExpiresAt: "",
    userType: "Company" as const,
    companyId: "company-1",
    locationId: null,
    approveAllLocations: null,
    isBulkInstallation: null,
    installToFutureLocations: null,
  };

  it("refuses a stale holder's commit and hands back the grant that replaced it", async () => {
    const { port, row, calls, expireLease } = custody({ tokenExpiresAt: stale });
    const fresher = new Date(NOW + 24 * 60 * 60 * 1_000).toISOString();
    const loser = await resolveRefreshingAccessToken("install", {
      custody: port,
      now: () => NOW,
      ...IDENTITY_CRYPTO,
      refresh: async () => {
        // While this holder is at the provider its lease runs out, another instance takes the row
        // over and commits its own rotated grant.
        expireLease();
        const winner = await port.claim({
          id: "install-1",
          nowIso: new Date(NOW).toISOString(),
          leaseUntilIso: new Date(NOW + 60_000).toISOString(),
        });
        await port.commit({
          id: "install-1",
          leaseToken: winner!.leaseToken,
          accessCredentialEnvelope: { plaintext: "winner-access" } as never,
          refreshCredentialEnvelope: { plaintext: "winner-refresh" } as never,
          tokenExpiresAt: fresher,
        });
        return { ...winnerGrant, accessToken: "loser-access", refreshToken: "loser-refresh", tokenExpiresAt: fresher };
      },
    });
    expect(loser).toBe("winner-access");
    expect(calls.fenced).toBe(1);
    // The winner's grant survives untouched. The loser's rotated refresh token is lost, which is
    // the correct trade: the alternative overwrites a grant the provider has already honoured.
    expect(row.accessCredentialEnvelope).toEqual({ plaintext: "winner-access" });
    expect(row.refreshCredentialEnvelope).toEqual({ plaintext: "winner-refresh" });
  });

  it("throws the scoped lease-lost code rather than return a token it failed to persist", async () => {
    const { port, row, expireLease } = custody({ tokenExpiresAt: stale });
    await expect(resolveRefreshingAccessToken("agency", {
      custody: port,
      now: () => NOW,
      ...IDENTITY_CRYPTO,
      refresh: async () => {
        // The successor takes the lease and then dies, so nothing usable was left behind.
        expireLease();
        await port.claim({
          id: "install-1",
          nowIso: new Date(NOW).toISOString(),
          leaseUntilIso: new Date(NOW + 60_000).toISOString(),
        });
        return { ...winnerGrant, tokenExpiresAt: fresh };
      },
    })).rejects.toThrow(/GHL_AGENCY_INSTALL_LEASE_LOST/);
    expect(row.accessCredentialEnvelope).toEqual({ plaintext: "stored-access" });
  });

  it("fences a stale holder out of releasing and out of marking re-authorization required", async () => {
    const { port, row, expireLease } = custody({ tokenExpiresAt: stale });
    const stalled = await port.claim({
      id: "install-1",
      nowIso: new Date(NOW).toISOString(),
      leaseUntilIso: new Date(NOW + 60_000).toISOString(),
    });
    expireLease();
    const winner = await port.claim({
      id: "install-1",
      nowIso: new Date(NOW).toISOString(),
      leaseUntilIso: new Date(NOW + 60_000).toISOString(),
    });

    // A stale release must not clear the lease the new holder is refreshing under.
    await port.release("install-1", stalled!.leaseToken);
    expect(await port.commit({
      id: "install-1",
      leaseToken: winner!.leaseToken,
      accessCredentialEnvelope: { plaintext: "winner-access" } as never,
      refreshCredentialEnvelope: { plaintext: "winner-refresh" } as never,
      tokenExpiresAt: fresh,
    })).toBe(true);

    // And a stale re-authorization marker must not fail an install that is working.
    await port.markReauthorizationRequired({
      id: "install-1",
      at: new Date(NOW).toISOString(),
      reason: "GHL_OAUTH_GRANT_REVOKED",
      leaseToken: stalled!.leaseToken,
    });
    expect(row.reauthorizationRequiredAt).toBeNull();
    expect(row.installState).toBe("token_ok");
  });

  it("refuses an uninstalled, credential-less, or expiry-less row rather than guessing", async () => {
    const uninstalled = custody({ tokenExpiresAt: fresh, installState: "uninstalled" });
    await expect(resolveRefreshingAccessToken("agency", {
      custody: uninstalled.port,
      refresh: async () => expect.unreachable("no refresh for an uninstalled row"),
      now: () => NOW,
      ...IDENTITY_CRYPTO,
    })).rejects.toThrow(/GHL_AGENCY_INSTALL_UNAVAILABLE/);

    const credentialLess = custody({ tokenExpiresAt: fresh, accessCredentialEnvelope: null });
    await expect(resolveRefreshingAccessToken("install", {
      custody: credentialLess.port,
      refresh: async () => expect.unreachable("no refresh without a credential"),
      now: () => NOW,
      ...IDENTITY_CRYPTO,
    })).rejects.toThrow(/GHL_INSTALL_CREDENTIAL_UNAVAILABLE/);

    const undated = custody({ tokenExpiresAt: null });
    await expect(resolveRefreshingAccessToken("install", {
      custody: undated.port,
      refresh: async () => expect.unreachable("no refresh without a known expiry"),
      now: () => NOW,
      ...IDENTITY_CRYPTO,
    })).rejects.toThrow(/GHL_INSTALL_EXPIRY_UNKNOWN/);
  });
});
