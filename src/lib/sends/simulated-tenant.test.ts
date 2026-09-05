import { afterEach, describe, expect, it, vi } from "vitest";

import { tenantSimulates } from "@/lib/sends/simulated-tenant";

type Row = { is_demo: boolean } | null;

function clientReturning(result: { data: Row; error: { message: string } | null }) {
  const maybeSingle = vi.fn(async () => result);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { client: { from } as never, from, select, eq };
}

describe("tenantSimulates", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers false without reading the tenant when simulated sends are off", async () => {
    vi.stubEnv("SETTERFI_SIMULATED_SENDS_LIVE", "false");
    const { client, from } = clientReturning({ data: { is_demo: true }, error: null });
    await expect(tenantSimulates(client, "tenant-1")).resolves.toBe(false);
    expect(from).not.toHaveBeenCalled();
  });

  it.each([
    [true, true],
    [false, false],
  ])("reads is_demo=%s from the tenant row when the flag is on", async (isDemo, expected) => {
    vi.stubEnv("SETTERFI_SIMULATED_SENDS_LIVE", "true");
    const { client, from, select, eq } = clientReturning({ data: { is_demo: isDemo }, error: null });
    await expect(tenantSimulates(client, "tenant-1")).resolves.toBe(expected);
    expect(from).toHaveBeenCalledWith("tenants");
    expect(select).toHaveBeenCalledWith("is_demo");
    expect(eq).toHaveBeenCalledWith("id", "tenant-1");
  });

  it("throws the read code, not the scope code, when Supabase fails", async () => {
    vi.stubEnv("SETTERFI_SIMULATED_SENDS_LIVE", "true");
    const { client } = clientReturning({ data: null, error: { message: "fetch failed" } });
    await expect(tenantSimulates(client, "tenant-1")).rejects.toThrow("SIMULATED_TENANT_READ_FAILED");
  });

  it("throws the scope code when the tenant row does not exist", async () => {
    vi.stubEnv("SETTERFI_SIMULATED_SENDS_LIVE", "true");
    const { client } = clientReturning({ data: null, error: null });
    await expect(tenantSimulates(client, "tenant-missing")).rejects.toThrow("PROVIDER_ROUTE_SCOPE_FAILED");
  });
});
