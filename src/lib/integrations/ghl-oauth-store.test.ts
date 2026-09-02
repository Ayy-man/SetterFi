import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGhlAgencyInstallCustody,
  createGhlOAuthStateStore,
  createGhlSubAccountInstallCustody,
  persistGhlAgencyInstall,
  persistGhlSubAccountInstall,
  resolveGhlAgencyAccessToken,
  resolveGhlProvisioningAccessToken,
} from "./ghl-oauth-store";
import { encryptCredential, type CredentialEnvelopeV1 } from "./credential-envelope";
import type { GhlTokenGrant } from "./ghl-oauth";

beforeEach(() => vi.stubEnv("SETTERFI_META_DRIVER", "mock"));
afterEach(() => vi.unstubAllEnvs());

type Recorded = {
  table: string;
  op: string;
  payload?: Record<string, unknown>;
  options?: Record<string, unknown>;
  filters: [string, unknown][];
};

type Result = { data?: unknown; error?: unknown };
type Node = Record<string, (...args: never[]) => unknown>;

/**
 * A recorder shaped like the query builder. It exists so the tests can assert *how* a write is
 * expressed — an upsert with a conflict target, a predicate on the update itself — rather than only
 * what it returns, because that expression is the whole idempotency and locking argument.
 */
function fakeSupabase(handler: (call: Recorded) => Result) {
  const calls: Recorded[] = [];
  const node = (call: Recorded): Node => {
    const result = () => handler(call);
    const self: Node = {
      insert: (payload: never) => { call.op = "insert"; call.payload = payload; return self; },
      update: (payload: never) => { call.op = "update"; call.payload = payload; return self; },
      upsert: (payload: never, options: never) => {
        call.op = "upsert";
        call.payload = payload;
        call.options = options;
        return self;
      },
      select: () => { call.op ||= "select"; return self; },
      eq: (column: never, value: never) => { call.filters.push([column, value]); return self; },
      is: (column: never, value: never) => { call.filters.push([column, value]); return self; },
      or: (filter: never) => { call.filters.push(["or", filter]); return self; },
      limit: () => self,
      maybeSingle: async () => result(),
      single: async () => result(),
      then: (resolve: never, reject: never) =>
        Promise.resolve(result()).then(resolve as never, reject as never),
    };
    return self;
  };
  const client = {
    from: (table: string) => {
      const call: Recorded = { table, op: "", filters: [] };
      calls.push(call);
      return node(call);
    },
  };
  return { client: client as never, calls };
}

const encrypt = ((value: string) => ({ plaintext: value }) as unknown as CredentialEnvelopeV1);

const agencyGrant: GhlTokenGrant = {
  accessToken: "synthetic-access",
  refreshToken: "synthetic-refresh",
  tokenExpiresAt: "2030-01-01T00:00:00.000Z",
  userType: "Company",
  companyId: "company-1",
  locationId: null,
  approveAllLocations: true,
  isBulkInstallation: true,
  // The shape the client's own install actually has, and the one nobody could read back off our
  // rows: false here means new sub-accounts do not inherit the app.
  installToFutureLocations: false,
};

const locationGrant: GhlTokenGrant = {
  ...agencyGrant,
  userType: "Location",
  locationId: "location-1",
  // Both of these are documented "only for company tokens", so a location grant simply does not
  // answer them and the row must say so rather than say "no".
  approveAllLocations: null,
  installToFutureLocations: null,
};

/**
 * A location that already belongs to a tenant, so the store has something to be authoritative
 * about. `null` stands for a location nobody has claimed yet.
 */
function subAccountClient(existing: { id: string; tenant_id: string | null } | null) {
  return fakeSupabase((call) => {
    if (call.table === "ghl_installs" && call.op === "select") return { data: existing };
    return { data: { id: existing?.id ?? "install-1" } };
  });
}

describe("install persistence is idempotent by conflict target", () => {
  it("upserts the agency install on its app and company, and clears any re-authorization flag", async () => {
    const { client, calls } = fakeSupabase(() => ({ data: { id: "agency-install-1" } }));
    await expect(persistGhlAgencyInstall(agencyGrant, "provisioning", client, encrypt)).resolves.toEqual({
      id: "agency-install-1",
      companyId: "company-1",
      locationId: null,
      tenantId: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe("upsert");
    expect(calls[0].options).toEqual({ onConflict: "app,company_id" });
    expect(calls[0].payload).toMatchObject({
      app: "provisioning",
      company_id: "company-1",
      install_state: "token_ok",
      access_credential_envelope: { plaintext: "synthetic-access" },
      refresh_credential_envelope: { plaintext: "synthetic-refresh" },
      token_expires_at: "2030-01-01T00:00:00.000Z",
      refresh_lock_expires_at: null,
      reauthorization_required_at: null,
    });
  });

  it("puts the agent app's own Company grant in its own row, not on top of the agency one", async () => {
    const { client, calls } = fakeSupabase(() => ({ data: { id: "agency-install-2" } }));
    await persistGhlAgencyInstall(agencyGrant, "agent", client, encrypt);
    // Same company, different app: the composite conflict target is what keeps these two apart,
    // and they are different credentials with independently rotating refresh tokens.
    expect(calls[0].options).toEqual({ onConflict: "app,company_id" });
    expect(calls[0].payload).toMatchObject({ app: "agent", company_id: "company-1" });
  });

  /**
   * The receipt of what the installer was offered and picked. Nothing else records it: the client
   * walked an install we could not reconstruct afterwards, and `installToFutureLocations = false`
   * on a stored company grant was readable only by asking the provider.
   */
  it("writes the three install-shape flags onto the agency row", async () => {
    const { client, calls } = fakeSupabase(() => ({ data: { id: "agency-install-1" } }));
    await persistGhlAgencyInstall(agencyGrant, "provisioning", client, encrypt);
    expect(calls[0].payload).toMatchObject({
      approve_all_locations: true,
      is_bulk_installation: true,
      install_to_future_locations: false,
    });
  });

  it("persists an unanswered flag as null rather than as a no", async () => {
    const { client, calls } = fakeSupabase(() => ({ data: { id: "agency-install-1" } }));
    await persistGhlAgencyInstall(
      { ...agencyGrant, approveAllLocations: null, isBulkInstallation: null, installToFutureLocations: null },
      "provisioning",
      client,
      encrypt,
    );
    // `false` here would be a fabricated answer, and one nobody could later tell apart from a real
    // one. The row has to be able to say "the response did not carry this".
    expect(calls[0].payload).toMatchObject({
      approve_all_locations: null,
      is_bulk_installation: null,
      install_to_future_locations: null,
    });
  });

  it("refuses an agency grant that did not name a company", async () => {
    const { client } = fakeSupabase(() => ({ data: { id: "agency-install-1" } }));
    await expect(
      persistGhlAgencyInstall({ ...agencyGrant, companyId: null }, "provisioning", client, encrypt),
    ).rejects.toThrow(/GHL_AGENCY_INSTALL_COMPANY_UNKNOWN/);
  });

  it("writes a location install and never erases a tenant provisioning already matched", async () => {
    const { client, calls } = subAccountClient({ id: "install-1", tenant_id: "tenant-established" });
    await expect(persistGhlSubAccountInstall(locationGrant, null, client, encrypt)).resolves.toEqual({
      id: "install-1",
      companyId: "company-1",
      locationId: "location-1",
      tenantId: "tenant-established",
    });
    const writes = calls.filter((call) => call.table === "ghl_installs" && call.op === "update");
    expect(writes[0].payload).toMatchObject({
      company_id: "company-1",
      tenant_id: "tenant-established",
      install_state: "installed",
      reauthorization_required_at: null,
    });
    // Secrets stay in their own service-only table; the metadata row never carries a token.
    expect(writes[0].payload).not.toHaveProperty("access_credential_envelope");
    const secretUpsert = calls.find((call) => call.table === "ghl_install_secrets");
    expect(secretUpsert?.options).toEqual({ onConflict: "ghl_install_id" });
    expect(secretUpsert?.payload).toMatchObject({
      ghl_install_id: "install-1",
      access_credential_envelope: { plaintext: "synthetic-access" },
      refresh_credential_envelope: { plaintext: "synthetic-refresh" },
      refresh_lock_expires_at: null,
    });
    expect(writes[1].payload).toMatchObject({
      install_state: "token_ok",
      token_expires_at: "2030-01-01T00:00:00.000Z",
      reauthorization_required_at: null,
      last_error: null,
    });
  });

  it("carries the same three flags onto a location row, unanswered ones included", async () => {
    const { client, calls } = subAccountClient({ id: "install-1", tenant_id: "tenant-a" });
    await persistGhlSubAccountInstall(locationGrant, "tenant-a", client, encrypt);
    const binding = calls.find(
      (call) => call.table === "ghl_installs"
        && (call.payload as { install_state?: string })?.install_state === "installed",
    );
    // A Location grant answers only `isBulkInstallation`; the other two are documented
    // company-token-only, so the row says "not recorded" instead of "no".
    expect(binding?.payload).toMatchObject({
      is_bulk_installation: true,
      approve_all_locations: null,
      install_to_future_locations: null,
    });
  });
});

describe("the store is authoritative about which tenant a location belongs to", () => {
  it("refuses a grant whose location resolves to no tenant, and writes nothing at all", async () => {
    const { client, calls } = subAccountClient(null);
    await expect(persistGhlSubAccountInstall(locationGrant, null, client, encrypt))
      .rejects.toThrow(/GHL_INSTALL_TENANT_UNRESOLVED/);
    // The lie this replaces: a tenant_id-null row reading `install_state: 'token_ok'`, which the
    // browser was told was `linked` and which no inbound message could ever be routed to.
    expect(calls.filter((call) => call.op !== "select")).toEqual([]);
  });

  it("refuses to rebind a location the caller does not already own", async () => {
    const { client, calls } = subAccountClient({ id: "install-1", tenant_id: "tenant-b" });
    await expect(persistGhlSubAccountInstall(locationGrant, "tenant-a", client, encrypt))
      .rejects.toThrow(/GHL_INSTALL_LOCATION_BOUND_ELSEWHERE/);
    expect(calls.filter((call) => call.op !== "select")).toEqual([]);
  });

  it("carries the binding as a predicate on the write, so the database arbitrates the race", async () => {
    const { client, calls } = subAccountClient({ id: "install-1", tenant_id: "tenant-a" });
    await persistGhlSubAccountInstall(locationGrant, "tenant-a", client, encrypt);
    const bindingWrite = calls.find(
      (call) => call.table === "ghl_installs"
        && call.op === "update"
        && (call.payload as { install_state?: string })?.install_state === "installed",
    );
    expect(bindingWrite?.filters).toContainEqual(["location_id", "location-1"]);
    expect(bindingWrite?.filters).toContainEqual(["or", "tenant_id.is.null,tenant_id.eq.tenant-a"]);
  });

  it("treats a zero-row binding write as the refusal, because the read that preceded it can be stale", async () => {
    // The read says tenant-a; between the read and the write another request bound it elsewhere,
    // so the predicate matches nothing. That is the half of the check that survives the TOCTOU.
    const { client } = fakeSupabase((call) => {
      if (call.table !== "ghl_installs") return { data: { id: "install-1" } };
      if (call.op === "select") return { data: { id: "install-1", tenant_id: "tenant-a" } };
      return { data: null };
    });
    await expect(persistGhlSubAccountInstall(locationGrant, "tenant-a", client, encrypt))
      .rejects.toThrow(/GHL_INSTALL_LOCATION_BOUND_ELSEWHERE/);
  });

  it("never lets the metadata row claim token_ok before the secret is on disk", async () => {
    const payloads: Record<string, unknown>[] = [];
    const { client } = fakeSupabase((call) => {
      if (call.table === "ghl_installs" && call.op === "select") {
        return { data: { id: "install-1", tenant_id: "tenant-a" } };
      }
      if (call.table === "ghl_installs" && call.payload) payloads.push(call.payload);
      if (call.table === "ghl_install_secrets") return { error: { message: "disk is full" } };
      return { data: { id: "install-1" } };
    });
    await expect(persistGhlSubAccountInstall(locationGrant, "tenant-a", client, encrypt))
      .rejects.toThrow(/GHL_INSTALL_SECRET_WRITE_FAILED/);
    expect(payloads.map((payload) => payload.install_state)).toEqual(["installed"]);
  });

  it("inserts the first install for an unclaimed location once a tenant is named", async () => {
    const { client, calls } = subAccountClient(null);
    await expect(persistGhlSubAccountInstall(locationGrant, "tenant-a", client, encrypt)).resolves
      .toMatchObject({ id: "install-1", tenantId: "tenant-a" });
    const insert = calls.find((call) => call.table === "ghl_installs" && call.op === "insert");
    expect(insert?.payload).toMatchObject({
      location_id: "location-1",
      company_id: "company-1",
      tenant_id: "tenant-a",
      install_state: "installed",
    });
  });
});

describe("the agent app's Company grant is the one the location-token mint needs", () => {
  const environment = {
    GHL_AGENCY_COMPANY_ID: "company-1",
    GHL_AGENCY_ACCESS_TOKEN: "bootstrap-token",
    SETTERFI_META_DRIVER: "mock",
  };

  it("looks for the agent row first and the provisioning row second", async () => {
    const { client, calls } = fakeSupabase(() => ({ data: null }));
    await expect(resolveGhlAgencyAccessToken(environment, client)).resolves.toEqual({
      companyId: "company-1",
      accessToken: "bootstrap-token",
    });
    const apps = calls
      .filter((call) => call.table === "ghl_agency_installs")
      .map((call) => call.filters.find(([column]) => column === "app")?.[1]);
    // ghl.ts:400 sends POST /oauth/locationToken with app 1's X-Client-Id, so the Bearer it pairs
    // with has to be app 1's Company token. The agency app's row is only the fallback.
    expect(apps).toEqual(["agent", "provisioning"]);
  });

  it("still fails closed when neither row exists and no bootstrap token was set", async () => {
    const { client } = fakeSupabase(() => ({ data: null }));
    await expect(resolveGhlAgencyAccessToken({ GHL_AGENCY_COMPANY_ID: "company-1" }, client))
      .rejects.toThrow(/GHL_AGENCY_INSTALL_UNAVAILABLE/);
  });
});

describe("the agency app's own grant is the one POST /locations/ needs", () => {
  const environment = {
    GHL_AGENCY_COMPANY_ID: "company-1",
    GHL_AGENCY_ACCESS_TOKEN: "bootstrap-token",
    SETTERFI_META_DRIVER: "mock",
  };

  /** A live provisioning row, sealed with the same key the resolver will open it with. */
  function provisioningRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "agency-install-1",
      app: "provisioning",
      company_id: "company-1",
      install_state: "token_ok",
      access_credential_envelope: encryptCredential(
        "stored-provisioning-token",
        { SETTERFI_META_DRIVER: "mock" },
      ),
      refresh_credential_envelope: encryptCredential(
        "stored-provisioning-refresh",
        { SETTERFI_META_DRIVER: "mock" },
      ),
      token_expires_at: "2030-01-01T00:00:00.000Z",
      reauthorization_required_at: null,
      ...overrides,
    };
  }

  it("reads the provisioning row and never falls through to the agent one", async () => {
    const { client, calls } = fakeSupabase(() => ({ data: provisioningRow() }));
    const resolved = await resolveGhlProvisioningAccessToken(environment, client);
    expect(resolved).toEqual({ companyId: "company-1", accessToken: "stored-provisioning-token" });
    // POST /locations/ is an agency-app call, so the agent row is not a fallback here — it is the
    // wrong credential, and reaching for it would authorize the create with the other client.
    const apps = calls
      .filter((call) => call.table === "ghl_agency_installs")
      .map((call) => call.filters.find(([column]) => column === "app")?.[1]);
    expect(apps.length).toBeGreaterThan(0);
    expect(new Set(apps)).toEqual(new Set(["provisioning"]));
  });

  it("ignores the hand-pasted bootstrap token once a grant is stored", async () => {
    const { client } = fakeSupabase(() => ({ data: provisioningRow() }));
    const resolved = await resolveGhlProvisioningAccessToken(environment, client);
    // The env var holds a value HighLevel expires about a day after a human pasted it. Once the
    // database has a grant that renews itself, that string must never reach the provider again.
    expect(resolved.accessToken).not.toBe("bootstrap-token");
  });

  it("still answers from the bootstrap token while no install has been stored", async () => {
    const { client } = fakeSupabase(() => ({ data: null }));
    await expect(resolveGhlProvisioningAccessToken(environment, client))
      .resolves.toEqual({ companyId: "company-1", accessToken: "bootstrap-token" });
  });

  it("fails closed when no row exists and nothing was pasted either", async () => {
    const { client } = fakeSupabase(() => ({ data: null }));
    await expect(
      resolveGhlProvisioningAccessToken({ GHL_AGENCY_COMPANY_ID: "company-1" }, client),
    ).rejects.toThrow(/GHL_AGENCY_INSTALL_UNAVAILABLE/);
  });

  it("propagates a stored grant's own refusal instead of quietly reaching for the env var", async () => {
    const { client } = fakeSupabase(() => ({
      data: provisioningRow({ reauthorization_required_at: "2026-08-21T00:00:00.000Z" }),
    }));
    // A grant the provider revoked is a fact the operator has to see by name. Substituting a stale
    // pasted token turns that nameable refusal into an unexplained 401 from HighLevel.
    await expect(resolveGhlProvisioningAccessToken(environment, client))
      .rejects.toThrow(/GHL_AGENCY_INSTALL_REAUTHORIZATION_REQUIRED/);
  });

  it("refuses a row whose expiry was never recorded rather than guessing it is live", async () => {
    const { client } = fakeSupabase(() => ({ data: provisioningRow({ token_expires_at: null }) }));
    await expect(resolveGhlProvisioningAccessToken(environment, client))
      .rejects.toThrow(/GHL_AGENCY_INSTALL_EXPIRY_UNKNOWN/);
  });
});

describe("single-use and lease predicates live on the write", () => {
  it("consumes an install state through the update predicate, not a read-then-write", async () => {
    const { client, calls } = fakeSupabase(() => ({
      data: {
        app: "agent",
        state_hash: "a".repeat(64),
        tenant_id: null,
        actor_id: "actor-1",
        return_path: "/coach/integrations",
        expires_at: "2030-01-01T00:00:00.000Z",
      },
    }));
    await expect(
      createGhlOAuthStateStore(client).consume("a".repeat(64), "2030-01-01T00:00:00.000Z", "agent"),
    ).resolves.toMatchObject({ app: "agent", actorId: "actor-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe("update");
    // The app is in the predicate, so a callback for the other app matches nothing here and the
    // row survives unconsumed for the callback it was issued for.
    expect(calls[0].filters).toEqual([
      ["state_hash", "a".repeat(64)],
      ["app", "agent"],
      ["consumed_at", null],
    ]);
  });

  it("describes a state without touching it, which is what the refusal path needs", async () => {
    const { client, calls } = fakeSupabase(() => ({
      data: { app: "provisioning", consumed_at: "2030-01-01T00:00:00.000Z" },
    }));
    await expect(createGhlOAuthStateStore(client).describe("a".repeat(64)))
      .resolves.toEqual({ app: "provisioning", consumedAt: "2030-01-01T00:00:00.000Z" });
    expect(calls[0].op).toBe("select");
  });

  it("takes the refresh lease with a compare-and-set the database arbitrates", async () => {
    const { client, calls } = fakeSupabase(() => ({ data: null }));
    const custody = createGhlAgencyInstallCustody("company-1", client);
    await expect(custody.claim({
      id: "agency-install-1",
      nowIso: "2030-01-01T00:00:00.000Z",
      leaseUntilIso: "2030-01-01T00:01:00.000Z",
    })).resolves.toBeNull();
    expect(calls[0].op).toBe("update");
    expect(calls[0].payload).toMatchObject({ refresh_lock_expires_at: "2030-01-01T00:01:00.000Z" });
    expect(calls[0].filters).toEqual([
      ["id", "agency-install-1"],
      ["app", "provisioning"],
      ["or", 'refresh_lock_expires_at.is.null,refresh_lock_expires_at.lt."2030-01-01T00:00:00.000Z"'],
    ]);
  });

  it("scopes every custody read and write to the app whose grant the row holds", async () => {
    const { client, calls } = fakeSupabase(() => ({ data: null }));
    const custody = createGhlAgencyInstallCustody("company-1", client, "agent");
    await custody.load();
    await custody.release("agency-install-1", "44444444-4444-4444-8444-444444444444");
    await custody.markReauthorizationRequired({
      id: "agency-install-1",
      at: "2030-01-01T00:00:00.000Z",
      reason: "GHL_OAUTH_GRANT_REVOKED",
      leaseToken: "44444444-4444-4444-8444-444444444444",
    });
    for (const call of calls.filter((entry) => entry.table === "ghl_agency_installs")) {
      expect(call.filters).toContainEqual(["app", "agent"]);
    }
  });

  it("writes a lease token with the lease, and hands it back to whoever took it", async () => {
    const { client, calls } = fakeSupabase(() => ({ data: { id: "agency-install-1", app: "provisioning" } }));
    const claimed = await createGhlAgencyInstallCustody("company-1", client).claim({
      id: "agency-install-1",
      nowIso: "2030-01-01T00:00:00.000Z",
      leaseUntilIso: "2030-01-01T00:01:00.000Z",
    });
    const written = calls[0].payload as { refresh_lock_token: string };
    expect(written.refresh_lock_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(claimed?.leaseToken).toBe(written.refresh_lock_token);
  });

  it("fences the commit on the lease it holds, and says so rather than throwing", async () => {
    // A row the winner already took over: the predicate matches nothing, and the caller needs to
    // tell that apart from an unreachable database, which is why this returns false.
    const fenced = fakeSupabase(() => ({ data: null }));
    await expect(createGhlAgencyInstallCustody("company-1", fenced.client).commit({
      id: "agency-install-1",
      leaseToken: "44444444-4444-4444-8444-444444444444",
      accessCredentialEnvelope: encrypt("rotated-access"),
      refreshCredentialEnvelope: encrypt("rotated-refresh"),
      tokenExpiresAt: "2030-01-02T00:00:00.000Z",
    })).resolves.toBe(false);
    expect(fenced.calls[0].filters).toContainEqual([
      "refresh_lock_token",
      "44444444-4444-4444-8444-444444444444",
    ]);
  });

  it("fences the release and the re-authorization marker on the same identity", async () => {
    const { client, calls } = fakeSupabase(() => ({ data: null }));
    const custody = createGhlAgencyInstallCustody("company-1", client);
    const leaseToken = "44444444-4444-4444-8444-444444444444";
    await custody.release("agency-install-1", leaseToken);
    await custody.markReauthorizationRequired({
      id: "agency-install-1",
      at: "2030-01-01T00:00:00.000Z",
      reason: "GHL_OAUTH_GRANT_REVOKED",
      leaseToken,
    });
    for (const call of calls.filter((entry) => entry.table === "ghl_agency_installs")) {
      expect(call.filters).toContainEqual(["refresh_lock_token", leaseToken]);
    }
  });

  it("fences the sub-account custody on the table that actually holds its lease", async () => {
    // The lease lives on ghl_install_secrets for a sub-account and on ghl_agency_installs for the
    // agency, so the fence has to follow the lease rather than the metadata.
    const { client, calls } = fakeSupabase(() => ({ data: null }));
    const leaseToken = "44444444-4444-4444-8444-444444444444";
    await expect(createGhlSubAccountInstallCustody("location-1", client).commit({
      id: "install-1",
      leaseToken,
      accessCredentialEnvelope: encrypt("rotated-access"),
      refreshCredentialEnvelope: encrypt("rotated-refresh"),
      tokenExpiresAt: "2030-01-02T00:00:00.000Z",
    })).resolves.toBe(false);
    const secretWrite = calls.find((call) => call.table === "ghl_install_secrets");
    expect(secretWrite?.filters).toContainEqual(["refresh_lock_token", leaseToken]);
    // Fenced out before the metadata mirror, so a stale holder cannot move the expiry either.
    expect(calls.some((call) => call.table === "ghl_installs")).toBe(false);
  });

  it("commits both rotated halves of the grant in one statement", async () => {
    const { client, calls } = fakeSupabase(() => ({ data: { id: "agency-install-1" } }));
    await createGhlAgencyInstallCustody("company-1", client).commit({
      id: "agency-install-1",
      leaseToken: "44444444-4444-4444-8444-444444444444",
      accessCredentialEnvelope: encrypt("rotated-access"),
      refreshCredentialEnvelope: encrypt("rotated-refresh"),
      tokenExpiresAt: "2030-01-02T00:00:00.000Z",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toMatchObject({
      access_credential_envelope: { plaintext: "rotated-access" },
      refresh_credential_envelope: { plaintext: "rotated-refresh" },
      token_expires_at: "2030-01-02T00:00:00.000Z",
      install_state: "token_ok",
      refresh_lock_expires_at: null,
      last_error: null,
    });
  });
});
