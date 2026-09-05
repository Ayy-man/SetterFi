import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveReconciledInstallTenant } from "./process-inbound";

/**
 * The reconcile worker used to write `row.tenant_id ?? existing?.tenant_id ?? null`, which is the
 * exact row `persistGhlSubAccountInstall` was hardened against on 2026-08-20: a connection with no
 * tenant, which neither the inbound nor the outbound path can route. These tests pin the decision
 * itself, and then pin the call site, because the decision is only worth anything if it runs before
 * the write.
 */
describe("resolveReconciledInstallTenant", () => {
  it("takes the tenant the receipt names when the location is unclaimed", () => {
    expect(
      resolveReconciledInstallTenant({ receiptTenantId: "tenant-a", existingTenantId: null }),
    ).toBe("tenant-a");
  });

  it("keeps the tenant provisioning already bound when the receipt names none", () => {
    expect(
      resolveReconciledInstallTenant({ receiptTenantId: null, existingTenantId: "tenant-a" }),
    ).toBe("tenant-a");
  });

  it("agrees with itself when both name the same tenant", () => {
    expect(
      resolveReconciledInstallTenant({ receiptTenantId: "tenant-a", existingTenantId: "tenant-a" }),
    ).toBe("tenant-a");
  });

  it("refuses to move a location that already belongs to another client", () => {
    let thrown: unknown;
    try {
      resolveReconciledInstallTenant({ receiptTenantId: "tenant-b", existingTenantId: "tenant-a" });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe("GHL_INSTALL_LOCATION_BOUND_ELSEWHERE");
  });

  it("refuses a receipt that names no tenant for a location nothing has claimed", () => {
    let thrown: unknown;
    try {
      resolveReconciledInstallTenant({ receiptTenantId: null, existingTenantId: undefined });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe("GHL_INSTALL_TENANT_UNRESOLVED");
  });

  it("treats an empty or whitespace tenant id as absent rather than as an id", () => {
    expect(() =>
      resolveReconciledInstallTenant({ receiptTenantId: "   ", existingTenantId: "" }),
    ).toThrow("GHL_INSTALL_TENANT_UNRESOLVED");
    expect(
      resolveReconciledInstallTenant({ receiptTenantId: "  ", existingTenantId: "tenant-a" }),
    ).toBe("tenant-a");
    // Blank on both sides of a disagreement is not a disagreement.
    expect(
      resolveReconciledInstallTenant({ receiptTenantId: "tenant-b", existingTenantId: "  " }),
    ).toBe("tenant-b");
  });
});

describe("reconcileGhlInstallReceipts source", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/lib/webhooks/process-inbound.ts"),
    "utf8",
  );

  it("no longer carries the null-tenant fallback", () => {
    expect(source).not.toContain("?? existing?.tenant_id ?? null");
  });

  it("refuses before it writes", () => {
    const decision = source.indexOf("resolveReconciledInstallTenant({");
    const write = source.indexOf('client.rpc("persist_ghl_install_credentials_atomic"');
    expect(decision).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(decision).toBeLessThan(write);
  });

  it("writes install metadata and secret custody through one database transaction", () => {
    expect(source).toContain('client.rpc("persist_ghl_install_credentials_atomic"');
    expect(source).not.toContain('.from("ghl_installs").upsert(');
    expect(source).not.toContain('.from("ghl_install_secrets").upsert(');
  });

  it("retires uninstall metadata and secret custody through one database transaction", () => {
    expect(source).toContain('client.rpc("mark_ghl_uninstalled_atomic"');
    expect(source).not.toContain('.from("ghl_install_secrets")\n    .delete()');
    expect(source).not.toContain('.update({ install_state: "uninstalled" })');
  });

  it("writes the refusal's own code into the receipt so an operator can read it", () => {
    expect(source).toContain("GHL_INSTALL_TENANT_UNRESOLVED");
    expect(source).toContain("GHL_INSTALL_LOCATION_BOUND_ELSEWHERE");
    expect(source).toContain("GHL_INSTALL_LOCATION_INACTIVE");
    expect(source).toContain("INSTALL_RECONCILE_FAILED");
  });

  it("decides the tenant before it asks the provider to mint a location token", () => {
    const decision = source.indexOf("resolveReconciledInstallTenant({");
    const mint = source.indexOf("driver.reconcileInstall({ eventId, locationId })");
    expect(mint).toBeGreaterThan(-1);
    expect(decision).toBeLessThan(mint);
  });

  it("retries both received and failed INSTALL and UNINSTALL lifecycle receipts", () => {
    expect(source).toContain("claimFairGhlLifecycleReceiptIds(client, limit)");
    expect(source).toContain('.in("event_type", ["INSTALL", "UNINSTALL"])');
    expect(source).toContain('.in("status", ["received", "failed"])');
    expect(source).toContain("UNINSTALL_RECONCILE_FAILED");
    expect(source).not.toContain('.order("received_at", { ascending: true })');
  });
});
