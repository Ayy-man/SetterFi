import { describe, expect, it } from "vitest";

import {
  GhlInstallsRepositoryError,
  listGhlInstallLocationsForTenant,
  listGhlInstallsByTenant,
} from "./ghl-installs";

type Recorded = { table: string; columns: string; filters: [string, unknown][] };
type Result = { data?: unknown; error?: unknown };
type Node = Record<string, (...args: never[]) => unknown>;

/**
 * The same recorder shape `ghl-oauth-store.test.ts` uses: it records which table was read and which
 * columns were asked for, so the tests can assert that a platform-wide read stays on the metadata
 * table and never reaches into the envelopes.
 */
function fakeSupabase(handler: (call: Recorded) => Result) {
  const calls: Recorded[] = [];
  const node = (call: Recorded): Node => {
    const result = () => handler(call);
    const self: Node = {
      select: (columns: never) => { call.columns = String(columns ?? ""); return self; },
      eq: (column: never, value: never) => { call.filters.push([column, value]); return self; },
      in: (column: never, value: never) => { call.filters.push([column, value]); return self; },
      order: () => self,
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
      const call: Recorded = { table, columns: "", filters: [] };
      calls.push(call);
      return node(call);
    },
  };
  return { client: client as never, calls };
}

function clientWith(installs: unknown[], tenants: unknown[], failures: Record<string, string> = {}) {
  return fakeSupabase((call) => {
    if (failures[call.table]) return { error: { message: failures[call.table] } };
    return { data: call.table === "ghl_installs" ? installs : tenants };
  });
}

const install = (over: Partial<Record<string, unknown>> = {}) => ({
  tenant_id: "tenant-a",
  location_id: "loc-1",
  install_state: "token_ok",
  reauthorization_required_at: null,
  updated_at: "2026-08-22T00:00:00.000Z",
  ...over,
});

describe("listGhlInstallsByTenant", () => {
  it("folds two locations under one client into a single group", async () => {
    const { client } = clientWith(
      [install(), install({ location_id: "loc-2" })],
      [{ id: "tenant-a", name: "Legacy Strong", is_demo: false }],
    );
    const groups = await listGhlInstallsByTenant(client);
    expect(groups).toHaveLength(1);
    expect(groups[0].tenantName).toBe("Legacy Strong");
    expect(groups[0].locations.map((entry) => entry.locationId)).toEqual(["loc-1", "loc-2"]);
  });

  it("counts a client connected only when a location reads token_ok and needs no re-approval", async () => {
    const cases: [string, string | null, boolean][] = [
      ["token_ok", null, true],
      ["token_ok", "2026-08-20T00:00:00.000Z", false],
      ["installed", null, false],
      ["failed", null, false],
      ["uninstalled", null, false],
    ];
    for (const [state, reauth, expected] of cases) {
      const { client } = clientWith(
        [install({ install_state: state, reauthorization_required_at: reauth })],
        [{ id: "tenant-a", name: "Legacy Strong", is_demo: false }],
      );
      const [group] = await listGhlInstallsByTenant(client);
      expect(group.connected, `${state}/${reauth}`).toBe(expected);
    }
  });

  it("counts the client connected when one of its locations is usable", async () => {
    const { client } = clientWith(
      [install({ install_state: "failed" }), install({ location_id: "loc-2" })],
      [{ id: "tenant-a", name: "Legacy Strong", is_demo: false }],
    );
    const [group] = await listGhlInstallsByTenant(client);
    expect(group.connected).toBe(true);
  });

  it("flags a demo client so a surface can label it rather than count it", async () => {
    const { client } = clientWith(
      [install()],
      [{ id: "tenant-a", name: "Seeded demo", is_demo: true }],
    );
    const [group] = await listGhlInstallsByTenant(client);
    expect(group.isDemo).toBe(true);
  });

  it("keeps rows with no tenant as one unmatched group, sorted last", async () => {
    const { client } = clientWith(
      [install({ tenant_id: null, location_id: "loc-orphan" }), install()],
      [{ id: "tenant-a", name: "Legacy Strong", is_demo: false }],
    );
    const groups = await listGhlInstallsByTenant(client);
    expect(groups).toHaveLength(2);
    expect(groups[1]).toMatchObject({ tenantId: null, tenantName: null, isDemo: false });
    expect(groups[1].locations).toHaveLength(1);
  });

  it("skips the tenant read entirely when nothing named a tenant", async () => {
    const { client, calls } = clientWith([install({ tenant_id: null })], []);
    await listGhlInstallsByTenant(client);
    expect(calls.map((call) => call.table)).toEqual(["ghl_installs"]);
  });

  it("throws rather than reporting an empty platform when the install read fails", async () => {
    const { client } = clientWith([], [], { ghl_installs: "boom" });
    await expect(listGhlInstallsByTenant(client)).rejects.toBeInstanceOf(GhlInstallsRepositoryError);
    await expect(listGhlInstallsByTenant(client)).rejects.toThrow("GHL_INSTALLS_READ_FAILED");
  });

  it("throws when the client names cannot be read", async () => {
    const { client } = clientWith([install()], [], { tenants: "boom" });
    await expect(listGhlInstallsByTenant(client)).rejects.toThrow("GHL_INSTALL_TENANTS_READ_FAILED");
  });

  it("never asks the metadata read for a credential envelope", async () => {
    const { client, calls } = clientWith(
      [install()],
      [{ id: "tenant-a", name: "Legacy Strong", is_demo: false }],
    );
    await listGhlInstallsByTenant(client);
    for (const call of calls) {
      expect(call.columns).not.toContain("access_credential_envelope");
      expect(call.columns).not.toContain("refresh_credential_envelope");
      expect(call.table).not.toBe("ghl_install_secrets");
    }
  });
});

describe("listGhlInstallLocationsForTenant", () => {
  it("filters on the tenant it was given and reads no other client's rows", async () => {
    const { client, calls } = clientWith([install()], []);
    await listGhlInstallLocationsForTenant("tenant-a", client);
    expect(calls.map((call) => call.table)).toEqual(["ghl_installs"]);
    expect(calls[0].filters).toContainEqual(["tenant_id", "tenant-a"]);
  });

  it("returns the locations it read", async () => {
    const { client } = clientWith(
      [install(), install({ location_id: "loc-2", install_state: "installed" })],
      [],
    );
    const locations = await listGhlInstallLocationsForTenant("tenant-a", client);
    expect(locations.map((entry) => entry.locationId)).toEqual(["loc-1", "loc-2"]);
    expect(locations[1].installState).toBe("installed");
  });

  it("throws rather than reporting an unconnected client when the read fails", async () => {
    const { client } = clientWith([], [], { ghl_installs: "boom" });
    await expect(listGhlInstallLocationsForTenant("tenant-a", client))
      .rejects.toBeInstanceOf(GhlInstallsRepositoryError);
    await expect(listGhlInstallLocationsForTenant("tenant-a", client))
      .rejects.toThrow("GHL_INSTALLS_READ_FAILED");
  });

  it("refuses to run without a tenant rather than reading every client's rows", async () => {
    const { client, calls } = clientWith([install()], []);
    await expect(listGhlInstallLocationsForTenant("", client))
      .rejects.toThrow("GHL_INSTALLS_TENANT_REQUIRED");
    expect(calls).toHaveLength(0);
  });

  it("never asks for a credential envelope", async () => {
    const { client, calls } = clientWith([install()], []);
    await listGhlInstallLocationsForTenant("tenant-a", client);
    expect(calls[0].columns).not.toContain("credential_envelope");
    expect(calls[0].table).not.toBe("ghl_install_secrets");
  });
});
