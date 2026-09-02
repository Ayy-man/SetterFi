import { describe, expect, it, vi } from "vitest";

import type { SuppressionProviderInput } from "@/lib/sends/contracts";

import {
  createGhlSuppressionProviderPort,
  GhlSuppressionProviderError,
} from "./ghl-provider";

const input: SuppressionProviderInput = {
  tenantId: "tenant-a",
  identityId: "identity-a",
  provider: "ghl",
  channel: "sms",
  providerIdentityId: "provider/contact-a",
  idempotencyKey: "control:stop:a",
};

function harness(responses: Response[]) {
  const fetcher = vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  });
  const provider = createGhlSuppressionProviderPort({
    fetch: fetcher,
    loadLocationId: vi.fn(async () => "location-a"),
    getLocationAccessToken: vi.fn(async () => "secret-access-token"),
    now: () => new Date("2026-08-27T00:00:00.000Z"),
  });
  return { provider, fetcher };
}

describe("GHL suppression provider", () => {
  it("sets channel DND and proves it with a separate contact read", async () => {
    const test = harness([
      Response.json({ succeeded: true, contact: { id: input.providerIdentityId } }),
      Response.json({
        contact: {
          id: input.providerIdentityId,
          dndSettings: { SMS: { status: "active", message: "SetterFi opt-out" } },
        },
      }),
    ]);

    const mutation = await test.provider.suppress(input);
    const readback = await test.provider.readBack(input);

    expect(readback).toMatchObject({
      providerOperationId: mutation.providerOperationId,
      suppressed: true,
      observedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(test.fetcher).toHaveBeenNthCalledWith(
      1,
      "https://services.leadconnectorhq.com/contacts/provider%2Fcontact-a",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          dndSettings: { SMS: { status: "active", message: "SetterFi opt-out" } },
        }),
      }),
    );
  });

  it("clears only the selected provider channel and verifies inactive state", async () => {
    const whatsapp = { ...input, channel: "whatsapp" as const, idempotencyKey: "control:start:a" };
    const test = harness([
      Response.json({ succeeded: true, contact: { id: input.providerIdentityId } }),
      Response.json({
        contact: {
          id: input.providerIdentityId,
          dndSettings: { WhatsApp: { status: "inactive" } },
        },
      }),
    ]);

    const mutation = await test.provider.clear(whatsapp);
    await expect(test.provider.readBack(whatsapp)).resolves.toMatchObject({
      providerOperationId: mutation.providerOperationId,
      suppressed: false,
    });
  });

  it("fails closed for providers and channels without a documented DND contract", async () => {
    const meta = harness([]);
    await expect(meta.provider.suppress({ ...input, provider: "meta_direct" })).rejects.toEqual(
      new GhlSuppressionProviderError("SUPPRESSION_PROVIDER_UNSUPPORTED"),
    );
    const instagram = harness([]);
    await expect(instagram.provider.suppress({ ...input, channel: "instagram" })).rejects.toEqual(
      new GhlSuppressionProviderError("GHL_SUPPRESSION_CHANNEL_UNSUPPORTED"),
    );
  });

  it("rejects malformed mutation and readback envelopes", async () => {
    const mutation = harness([Response.json({ succeeded: false, contact: { id: input.providerIdentityId } })]);
    await expect(mutation.provider.suppress(input)).rejects.toEqual(
      new GhlSuppressionProviderError("GHL_SUPPRESSION_MUTATION_UNCONFIRMED"),
    );
    const readback = harness([Response.json({ contact: { id: input.providerIdentityId } })]);
    await expect(readback.provider.readBack(input)).rejects.toEqual(
      new GhlSuppressionProviderError("GHL_SUPPRESSION_READBACK_ENVELOPE_INVALID"),
    );
  });
});
