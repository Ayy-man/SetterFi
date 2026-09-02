import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decryptCredential, encryptCredential } from "./credential-envelope";
import { GoogleCalendarOAuthError } from "./google-calendar-oauth";
import {
  createGoogleOAuthStateStore,
  deleteGoogleCalendarGrant,
  loadGoogleCalendarGrant,
  persistGoogleCalendarGrant,
  resolveGoogleAccessToken,
} from "./google-calendar-oauth-store";

beforeEach(() => {
  vi.stubEnv("SETTERFI_META_DRIVER", "mock");
  vi.stubEnv("APP_BASE_URL", "https://setterfi.test");
  vi.stubEnv("GOOGLE_CALENDAR_CLIENT_ID", "client-id");
  vi.stubEnv("GOOGLE_CALENDAR_CLIENT_SECRET", "client-secret");
});
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
 * A recorder shaped like the query builder, so a test can assert how a write is expressed and not
 * only what it returned. The consume predicate is the reason this exists: whether the null check
 * rides inside the update or sits in a separate read is the entire single-use argument, and only
 * the recorded filters can tell the two apart.
 */
function fakeSupabase(handler: (call: Recorded) => Result) {
  const calls: Recorded[] = [];
  const node = (call: Recorded): Node => {
    const result = () => handler(call);
    const self: Node = {
      insert: (payload: never) => { call.op = "insert"; call.payload = payload; return self; },
      update: (payload: never) => { call.op = "update"; call.payload = payload; return self; },
      delete: () => { call.op = "delete"; return self; },
      upsert: (payload: never, options: never) => {
        call.op = "upsert";
        call.payload = payload;
        call.options = options;
        return self;
      },
      select: () => { call.op ||= "select"; return self; },
      eq: (column: never, value: never) => { call.filters.push([column, value]); return self; },
      is: (column: never, value: never) => { call.filters.push([column, value]); return self; },
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

const STATE_ROW = {
  state_hash: "a".repeat(64),
  tenant_id: "tenant-1",
  actor_id: "coach-1",
  return_path: "/onboarding/calendar",
  expires_at: "2026-09-02T00:10:00.000Z",
};

function grantRowFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "grant-1",
    tenant_id: "tenant-1",
    google_account_email: "coach@livelegacystrong.test",
    access_credential_envelope: { sealed: "access" },
    refresh_credential_envelope: { sealed: "refresh" },
    granted_scopes: ["a", "b", "c"],
    token_expires_at: "2026-09-02T01:00:00.000Z",
    refresh_token_expires_at: "2026-09-09T00:00:00.000Z",
    pending_calendars: [{ id: "cal-1", name: "Coach", timeZone: "America/Chicago" }],
    reauthorization_required_at: null,
    revoked_at: null,
    ...overrides,
  };
}

describe("google oauth state store", () => {
  it("consumes a state with the unconsumed predicate inside the update itself", async () => {
    const { client, calls } = fakeSupabase(() => ({ data: STATE_ROW }));
    const record = await createGoogleOAuthStateStore(client).consume(
      STATE_ROW.state_hash,
      "2026-09-02T00:01:00.000Z",
    );
    expect(record).toEqual({
      stateHash: STATE_ROW.state_hash,
      tenantId: "tenant-1",
      actorId: "coach-1",
      returnPath: "/onboarding/calendar",
      expiresAt: STATE_ROW.expires_at,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("google_oauth_states");
    expect(calls[0].op).toBe("update");
    expect(calls[0].payload).toEqual({ consumed_at: "2026-09-02T00:01:00.000Z" });
    expect(calls[0].filters).toEqual([
      ["state_hash", STATE_ROW.state_hash],
      ["consumed_at", null],
    ]);
  });

  it("returns null when a second consume matches nothing", async () => {
    const { client } = fakeSupabase(() => ({ data: null }));
    await expect(
      createGoogleOAuthStateStore(client).consume(STATE_ROW.state_hash, "2026-09-02T00:01:00.000Z"),
    ).resolves.toBeNull();
  });

  it("treats a returned error object as a failure rather than trusting a catch", async () => {
    const { client } = fakeSupabase(() => ({ error: { message: "boom" } }));
    await expect(
      createGoogleOAuthStateStore(client).consume(STATE_ROW.state_hash, "2026-09-02T00:01:00.000Z"),
    ).rejects.toBeInstanceOf(GoogleCalendarOAuthError);
  });

  it("saves only the hash and the routing fields", async () => {
    const { client, calls } = fakeSupabase(() => ({ error: null }));
    await createGoogleOAuthStateStore(client).save({
      stateHash: STATE_ROW.state_hash,
      tenantId: "tenant-1",
      actorId: "coach-1",
      returnPath: "/onboarding/calendar",
      expiresAt: STATE_ROW.expires_at,
    });
    expect(calls[0].op).toBe("insert");
    expect(Object.keys(calls[0].payload ?? {}).sort()).toEqual([
      "actor_id", "expires_at", "return_path", "state_hash", "tenant_id",
    ]);
  });
});

describe("google calendar grant custody", () => {
  it("encrypts both tokens and writes no plaintext token to any column", async () => {
    const { client, calls } = fakeSupabase((call) =>
      call.op === "upsert" ? { data: grantRowFixture() } : { data: null });
    await persistGoogleCalendarGrant({
      tenantId: "tenant-1",
      googleAccountEmail: "coach@livelegacystrong.test",
      accessToken: "plaintext-access-value",
      refreshToken: "plaintext-refresh-value",
      tokenExpiresAt: "2026-09-02T01:00:00.000Z",
      refreshTokenExpiresAt: "2026-09-09T00:00:00.000Z",
      grantedScopes: ["a", "b", "c"],
      pendingCalendars: [{ id: "cal-1", name: "Coach", timeZone: "America/Chicago" }],
    }, client);

    const payload = calls[0].payload ?? {};
    expect(calls[0].op).toBe("upsert");
    expect(calls[0].options).toEqual({ onConflict: "tenant_id" });
    expect(JSON.stringify(payload)).not.toContain("plaintext-access-value");
    expect(JSON.stringify(payload)).not.toContain("plaintext-refresh-value");
    expect(decryptCredential(payload.access_credential_envelope)).toBe("plaintext-access-value");
    expect(decryptCredential(payload.refresh_credential_envelope)).toBe("plaintext-refresh-value");
  });

  it("returns null for a tenant with no grant", async () => {
    const { client } = fakeSupabase(() => ({ data: null }));
    await expect(loadGoogleCalendarGrant("tenant-1", client)).resolves.toBeNull();
  });

  it("drops a stored pending calendar that lost its zone rather than surfacing it", async () => {
    const { client } = fakeSupabase(() => ({
      data: grantRowFixture({
        pending_calendars: [
          { id: "cal-1", name: "Coach", timeZone: "America/Chicago" },
          { id: "cal-2", name: "Zoneless" },
        ],
      }),
    }));
    const grant = await loadGoogleCalendarGrant("tenant-1", client);
    expect(grant?.pendingCalendars).toEqual([
      { id: "cal-1", name: "Coach", timeZone: "America/Chicago" },
    ]);
  });

  it("deletes the grant and stays quiet when there was nothing to delete", async () => {
    const { client, calls } = fakeSupabase(() => ({ error: null }));
    await expect(deleteGoogleCalendarGrant("tenant-1", client)).resolves.toBeUndefined();
    await expect(deleteGoogleCalendarGrant("tenant-1", client)).resolves.toBeUndefined();
    expect(calls.map((call) => call.op)).toEqual(["delete", "delete"]);
    expect(calls[0].filters).toEqual([["tenant_id", "tenant-1"]]);
  });
});

describe("resolveGoogleAccessToken", () => {
  const now = () => Date.parse("2026-09-02T00:00:00.000Z");

  function storedGrant(overrides: Record<string, unknown> = {}) {
    // Encrypted with the same mock deployment key the module reads, so the round trip is real
    // rather than a stand-in that would pass whether or not the module decrypts at all.
    return grantRowFixture({
      access_credential_envelope: encryptCredential("stored-access-token"),
      refresh_credential_envelope: encryptCredential("stored-refresh-token"),
      ...overrides,
    });
  }

  it("returns the stored token when the expiry is outside the safety margin", async () => {
    const { client, calls } = fakeSupabase(() => ({ data: storedGrant() }));
    const refresh = vi.fn();
    const resolved = await resolveGoogleAccessToken({ tenantId: "tenant-1" }, {
      client, now, refresh: refresh as never,
    });
    expect(resolved.accessToken).toBe("stored-access-token");
    expect(resolved.refreshed).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(calls.map((call) => call.op)).toEqual(["select"]);
  });

  it("refreshes inside the margin and writes back the access half only", async () => {
    const { client, calls } = fakeSupabase((call) =>
      call.op === "select"
        ? { data: storedGrant({ token_expires_at: "2026-09-02T00:02:00.000Z" }) }
        : { error: null });
    const refresh = vi.fn().mockResolvedValue({
      accessToken: "renewed-access-token",
      expiresAt: "2026-09-02T01:00:00.000Z",
      grantedScopes: ["a", "b", "c"],
    });
    const resolved = await resolveGoogleAccessToken({ tenantId: "tenant-1" }, {
      client, now, refresh: refresh as never,
    });

    expect(resolved.accessToken).toBe("renewed-access-token");
    expect(resolved.refreshed).toBe(true);
    expect(refresh.mock.calls[0][0].refreshToken).toBe("stored-refresh-token");
    const write = calls.find((call) => call.op === "update");
    expect(Object.keys(write?.payload ?? {}).sort()).toEqual([
      "access_credential_envelope", "last_error", "token_expires_at",
    ]);
    expect(decryptCredential((write?.payload ?? {}).access_credential_envelope))
      .toBe("renewed-access-token");
  });

  it("marks the grant and the connection expired on invalid_grant, then rethrows", async () => {
    const { client, calls } = fakeSupabase((call) =>
      call.op === "select"
        ? { data: storedGrant({ token_expires_at: "2026-09-02T00:02:00.000Z" }) }
        : { error: null });
    const refresh = vi.fn().mockRejectedValue(
      new GoogleCalendarOAuthError("GOOGLE_OAUTH_GRANT_INVALID", 400, "error"),
    );
    await expect(resolveGoogleAccessToken({ tenantId: "tenant-1" }, {
      client, now, refresh: refresh as never,
    })).rejects.toBeInstanceOf(GoogleCalendarOAuthError);

    const grantWrite = calls.find((call) => call.table === "google_calendar_grants" && call.op === "update");
    expect(grantWrite?.payload).toEqual({
      reauthorization_required_at: "2026-09-02T00:00:00.000Z",
      last_error: "GOOGLE_OAUTH_GRANT_INVALID",
    });
    const connectionWrite = calls.find((call) => call.table === "calendar_connections");
    expect(connectionWrite?.payload).toEqual({ state: "expired" });
    expect(connectionWrite?.filters).toEqual([
      ["tenant_id", "tenant-1"],
      ["provider", "google"],
      ["is_primary", true],
    ]);
  });

  it("leaves both rows alone when the refresh fails for any other reason", async () => {
    const { client, calls } = fakeSupabase((call) =>
      call.op === "select"
        ? { data: storedGrant({ token_expires_at: "2026-09-02T00:02:00.000Z" }) }
        : { error: null });
    const refresh = vi.fn().mockRejectedValue(
      new GoogleCalendarOAuthError("GOOGLE_OAUTH_REFRESH_FAILED", 503, "error"),
    );
    await expect(resolveGoogleAccessToken({ tenantId: "tenant-1" }, {
      client, now, refresh: refresh as never,
    })).rejects.toBeInstanceOf(GoogleCalendarOAuthError);
    expect(calls.filter((call) => call.op === "update")).toHaveLength(0);
  });
});
