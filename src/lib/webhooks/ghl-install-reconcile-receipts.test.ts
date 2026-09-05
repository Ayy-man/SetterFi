import { afterEach, describe, expect, it, vi } from "vitest";

import { GhlProviderError } from "@/lib/integrations/ghl";
import type { GhlMessagingAdapter } from "@/lib/integrations/types";
import {
  installReconcileReceiptError,
  reconcileGhlInstallReceipts,
} from "./process-inbound";

/**
 * The 2026-09-02 agency install fired 77 signed INSTALL webhooks, one per sub-account, and the
 * reconcile job labelled 38 of them with a bare `INSTALL_RECONCILE_FAILED` for three days. The cause
 * was a provider 400, "Location is not active", answered by the location-token mint for every
 * paused or deleted sub-account. Nothing in the receipt said so, because the catch relabelled every
 * non-refusal to the same word. These tests pin three things: the tenant is decided before the
 * provider is called, so an unowned location is refused without spending a mint; an inactive
 * location is a named refusal like its siblings; and any other failure keeps its own name in the
 * receipt behind the blanket prefix.
 */

type Recorded = {
  table: string;
  op: string;
  payload?: unknown;
  filters: Array<[string, string, unknown]>;
};

type Result = { data?: unknown; error?: { message: string } | null };

function fakeSupabase(handler: (call: Recorded) => Result) {
  const calls: Recorded[] = [];
  const node = (call: Recorded) => {
    const chain = {
      select: (columns: string) => { call.op ||= "select"; call.payload ??= columns; return chain; },
      update: (payload: unknown) => { call.op = "update"; call.payload = payload; return chain; },
      eq: (column: string, value: unknown) => { call.filters.push(["eq", column, value]); return chain; },
      in: (column: string, value: unknown) => { call.filters.push(["in", column, value]); return chain; },
      maybeSingle: async () => ({ data: null, error: null, ...handler(call) }),
      then: (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null, ...handler(call) }).then(resolve, reject),
    };
    return chain;
  };
  const client = {
    rpc: async (operation: string, payload: Record<string, unknown>) => {
      const call: Recorded = { table: "$rpc", op: operation, payload, filters: [] };
      calls.push(call);
      return { data: null, error: null, ...handler(call) };
    },
    from: (table: string) => {
      const call: Recorded = { table, op: "", filters: [] };
      calls.push(call);
      return node(call);
    },
  };
  return { client: client as never, calls };
}

function installReceipt(overrides: { tenant_id?: string | null; locationId?: string } = {}) {
  return {
    id: "receipt-1",
    tenant_id: overrides.tenant_id ?? null,
    event_type: "INSTALL",
    payload: {
      raw: { type: "INSTALL", installType: "Location" },
      normalized: {
        eventId: "event-1",
        locationId: overrides.locationId ?? "BGdfGG6xjP3JjyeTMVu5",
      },
    },
  };
}

function harness(options: {
  receipt: ReturnType<typeof installReceipt>;
  existingInstall?: { id: string; tenant_id: string | null } | null;
  reconcile: GhlMessagingAdapter["reconcileInstall"];
  persistError?: { message: string } | null;
}) {
  const reconcileInstall = vi.fn(options.reconcile);
  const { client, calls } = fakeSupabase((call) => {
    if (call.table === "$rpc" && call.op === "claim_fair_ghl_lifecycle_receipt_batch") {
      return { data: [{ receipt_id: options.receipt.id }] };
    }
    if (call.table === "$rpc" && call.op === "persist_ghl_install_credentials_atomic") {
      return { error: options.persistError ?? null };
    }
    if (call.table === "webhook_events" && call.op === "select") return { data: [options.receipt] };
    if (call.table === "ghl_installs") return { data: options.existingInstall ?? null };
    return {};
  });
  const driver = () => ({ reconcileInstall } as unknown as GhlMessagingAdapter);
  const run = () => reconcileGhlInstallReceipts(25, { client, driver });
  const receiptWrite = () =>
    calls.find((call) => call.table === "webhook_events" && call.op === "update")?.payload as
      | { status: string; error: string | null }
      | undefined;
  const persisted = () =>
    calls.find((call) => call.table === "$rpc" && call.op === "persist_ghl_install_credentials_atomic");
  return { run, calls, reconcileInstall, receiptWrite, persisted };
}

const minted = async () => ({
  companyId: "l3rQ9bypJYMWUEsVl4Nu",
  accessToken: "location-access",
  refreshToken: "location-refresh",
  tokenExpiresAt: "2026-09-06T20:16:22.403Z",
});

describe("reconcileGhlInstallReceipts", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a location no client owns before asking the provider for anything", async () => {
    const { run, reconcileInstall, receiptWrite, persisted } = harness({
      receipt: installReceipt({ tenant_id: null }),
      existingInstall: null,
      reconcile: minted,
    });
    await expect(run()).resolves.toEqual({ checked: 1, processed: 0, failed: 1 });
    expect(reconcileInstall).not.toHaveBeenCalled();
    expect(persisted()).toBeUndefined();
    expect(receiptWrite()).toMatchObject({ status: "failed", error: "GHL_INSTALL_TENANT_UNRESOLVED" });
  });

  it("names an inactive sub-account as its own refusal, the same way an unowned one is named", async () => {
    const { run, receiptWrite, persisted } = harness({
      receipt: installReceipt({ tenant_id: "tenant-1" }),
      reconcile: async () => {
        throw new GhlProviderError(
          "GHL_INSTALL_LOCATION_INACTIVE",
          400,
          "error,message,statusCode,traceId",
        );
      },
    });
    await expect(run()).resolves.toEqual({ checked: 1, processed: 0, failed: 1 });
    expect(persisted()).toBeUndefined();
    expect(receiptWrite()).toMatchObject({ status: "failed", error: "GHL_INSTALL_LOCATION_INACTIVE" });
  });

  it("keeps the provider error's own name in the receipt instead of the blanket label", async () => {
    const { run, receiptWrite } = harness({
      receipt: installReceipt({ tenant_id: "tenant-1" }),
      reconcile: async () => {
        throw new GhlProviderError("GHL_INSTALL_RECONCILE_FAILED", 502, "message");
      },
    });
    await run();
    expect(receiptWrite()).toMatchObject({
      status: "failed",
      error: "INSTALL_RECONCILE_FAILED:GHL_INSTALL_RECONCILE_FAILED (HTTP 502)",
    });
  });

  it("names a failed custody write the same way", async () => {
    vi.stubEnv("SETTERFI_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64url"));
    const { run, receiptWrite } = harness({
      receipt: installReceipt({ tenant_id: "tenant-1" }),
      reconcile: minted,
      persistError: { message: "boom" },
    });
    await run();
    expect(receiptWrite()).toMatchObject({
      status: "failed",
      error: "INSTALL_RECONCILE_FAILED:INSTALL_ATOMIC_WRITE_FAILED",
    });
  });

  it("mints and persists for a location whose tenant is known, then marks the receipt processed", async () => {
    vi.stubEnv("SETTERFI_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64url"));
    const { run, reconcileInstall, receiptWrite, persisted } = harness({
      receipt: installReceipt({ tenant_id: null }),
      existingInstall: { id: "install-1", tenant_id: "tenant-1" },
      reconcile: minted,
    });
    await expect(run()).resolves.toEqual({ checked: 1, processed: 1, failed: 0 });
    expect(reconcileInstall).toHaveBeenCalledWith({
      eventId: "event-1",
      locationId: "BGdfGG6xjP3JjyeTMVu5",
    });
    expect(persisted()?.payload).toMatchObject({
      p_expected_tenant: "tenant-1",
      p_location_id: "BGdfGG6xjP3JjyeTMVu5",
      p_company_id: "l3rQ9bypJYMWUEsVl4Nu",
    });
    expect(receiptWrite()).toMatchObject({ status: "processed", error: null });
  });
});

describe("installReconcileReceiptError", () => {
  it("passes a refusal through by code or by message", () => {
    expect(installReconcileReceiptError(new Error("GHL_INSTALL_TENANT_UNRESOLVED")))
      .toBe("GHL_INSTALL_TENANT_UNRESOLVED");
    expect(installReconcileReceiptError(new GhlProviderError("GHL_INSTALL_LOCATION_INACTIVE", 400)))
      .toBe("GHL_INSTALL_LOCATION_INACTIVE");
  });

  it("prefixes any other error with the blanket label and keeps its name", () => {
    expect(installReconcileReceiptError(new Error("INSTALL_TENANT_LOOKUP_FAILED")))
      .toBe("INSTALL_RECONCILE_FAILED:INSTALL_TENANT_LOOKUP_FAILED");
    expect(installReconcileReceiptError(new GhlProviderError("GHL_AGENCY_INSTALL_UNAVAILABLE:loc-1", null)))
      .toBe("INSTALL_RECONCILE_FAILED:GHL_AGENCY_INSTALL_UNAVAILABLE:loc-1");
  });

  it("falls back to the bare label for a throw that carries no name, and keeps the text bounded and single-line", () => {
    expect(installReconcileReceiptError(undefined)).toBe("INSTALL_RECONCILE_FAILED");
    expect(installReconcileReceiptError(new Error("   "))).toBe("INSTALL_RECONCILE_FAILED");
    expect(installReconcileReceiptError(new Error("line one\n  line two"))).toBe(
      "INSTALL_RECONCILE_FAILED:line one line two",
    );
    expect(installReconcileReceiptError(new Error("x".repeat(500))).length).toBe(200);
  });
});
