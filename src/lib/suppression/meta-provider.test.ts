import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import type { SuppressionProviderInput } from "@/lib/sends/contracts";

import { createMetaSuppressionProviderPort, MetaSuppressionProviderError } from "./meta-provider";
import { createSuppressionProviderRouter } from "./provider";

const input: SuppressionProviderInput = {
  tenantId: "tenant-a",
  identityId: "identity-meta-a",
  provider: "meta_direct",
  channel: "whatsapp",
  providerIdentityId: "15555550123",
  idempotencyKey: "start:whatsapp:message-a",
};

describe("Meta Direct suppression adapter", () => {
  it("clears START through a deterministic no-remote-state receipt and matching readback", async () => {
    const provider = createMetaSuppressionProviderPort(() => new Date("2026-08-27T12:00:00.000Z"));
    const mutation = await provider.clear(input);
    const readback = await provider.readBack(input);

    expect(mutation.providerOperationId).toBe(readback.providerOperationId);
    expect(readback).toEqual({
      providerOperationId: mutation.providerOperationId,
      suppressed: false,
      observedAt: "2026-08-27T12:00:00.000Z",
    });
  });

  it("does not claim that Meta persisted a remote STOP suppression", async () => {
    const provider = createMetaSuppressionProviderPort();
    await expect(provider.suppress({ ...input, idempotencyKey: "stop:whatsapp:message-a" }))
      .rejects.toEqual(new MetaSuppressionProviderError("META_REMOTE_SUPPRESSION_UNAVAILABLE"));
  });

  it("dispatches Meta identities away from the GHL-only adapter", async () => {
    const ghlClear = vi.fn();
    const meta = createMetaSuppressionProviderPort(() => new Date(0));
    const router = createSuppressionProviderRouter({
      ghl: { suppress: vi.fn(), clear: ghlClear, readBack: vi.fn() },
      meta,
    });

    await expect(router.clear(input)).resolves.toMatchObject({ acceptedAt: new Date(0).toISOString() });
    expect(ghlClear).not.toHaveBeenCalled();
  });

  it("uses the provider router in both live inbound START and background reconciliation", () => {
    const inbound = readFileSync(new URL("../webhooks/process-inbound.ts", import.meta.url), "utf8");
    const reconciliation = readFileSync(
      new URL("../../app/api/jobs/compliance-reconcile/handler.ts", import.meta.url),
      "utf8",
    );
    expect(inbound).toContain("createLiveSuppressionProviderPort()");
    expect(reconciliation).toContain("createLiveSuppressionProviderPort()");
    expect(inbound).not.toContain("createLiveGhlSuppressionProviderPort()");
  });
});
