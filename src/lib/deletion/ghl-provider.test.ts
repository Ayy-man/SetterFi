import { describe, expect, it, vi } from "vitest";

import type { DeletionProviderInput } from "@/lib/sends/contracts";

import {
  createGhlDeletionProviderPort,
  GhlDeletionProviderError,
} from "./ghl-provider";

const input: DeletionProviderInput = {
  tenantId: "tenant-a",
  contactId: "contact-a",
  providerContactId: "provider/contact-a",
  providerAccountId: "location-a",
  ghlInstallId: "install-a",
  idempotencyKey: "delete-a:provider:0",
};

function harness(responses: Response[]) {
  const fetcher = vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  });
  const loadLocationId = vi.fn(async () => "location-a");
  const getLocationAccessToken = vi.fn(async () => "secret-access-token");
  const provider = createGhlDeletionProviderPort({
    fetch: fetcher,
    loadLocationId,
    getLocationAccessToken,
    now: () => new Date("2026-08-27T00:00:00.000Z"),
  });
  return { provider, fetcher, loadLocationId, getLocationAccessToken };
}

describe("GHL deletion provider", () => {
  it("deletes with the tenant-scoped token and proves absence independently", async () => {
    const test = harness([
      Response.json({ succeeded: true }),
      new Response(null, { status: 404 }),
    ]);

    const deleted = await test.provider.deleteContact(input);
    const absent = await test.provider.readAbsent(input);

    expect(deleted.providerOperationId).toBe(absent.providerOperationId);
    expect(absent).toMatchObject({ absent: true, observedAt: "2026-08-27T00:00:00.000Z" });
    expect(test.loadLocationId).toHaveBeenNthCalledWith(
      1, "tenant-a", "install-a", "location-a",
    );
    expect(test.loadLocationId).toHaveBeenCalledTimes(2);
    expect(test.getLocationAccessToken).toHaveBeenCalledWith("location-a");
    expect(test.fetcher).toHaveBeenNthCalledWith(
      1,
      "https://services.leadconnectorhq.com/contacts/provider%2Fcontact-a",
      expect.objectContaining({
        method: "DELETE",
        cache: "no-store",
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          Authorization: "Bearer secret-access-token",
          Version: "v3",
        }),
      }),
    );
    expect(JSON.stringify({ deleted, absent })).not.toContain(input.providerContactId);
  });

  it("treats an already-absent delete as accepted but still requires GET readback", async () => {
    const test = harness([
      new Response(null, { status: 404 }),
      new Response(null, { status: 404 }),
    ]);

    await expect(test.provider.deleteContact(input)).resolves.toMatchObject({
      acceptedAt: "2026-08-27T00:00:00.000Z",
    });
    await expect(test.provider.readAbsent(input)).resolves.toMatchObject({ absent: true });
    expect(test.fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not claim absence while the provider still returns the contact", async () => {
    const test = harness([Response.json({ contact: { id: input.providerContactId } })]);
    await expect(test.provider.readAbsent(input)).resolves.toMatchObject({ absent: false });
  });

  it("fails closed on malformed success envelopes and provider errors", async () => {
    const malformedDelete = harness([Response.json({ succeeded: false })]);
    await expect(malformedDelete.provider.deleteContact(input)).rejects.toEqual(
      new GhlDeletionProviderError("GHL_CONTACT_DELETE_UNCONFIRMED"),
    );

    const malformedRead = harness([Response.json({ contact: { id: "somebody-else" } })]);
    await expect(malformedRead.provider.readAbsent(input)).rejects.toEqual(
      new GhlDeletionProviderError("GHL_CONTACT_READBACK_ENVELOPE_INVALID"),
    );

    const unavailable = harness([new Response(null, { status: 503 })]);
    await expect(unavailable.provider.readAbsent(input)).rejects.toEqual(
      new GhlDeletionProviderError("GHL_CONTACT_READBACK_FAILED"),
    );
  });

  it("refuses an A-origin contact after A is uninstalled instead of querying replacement B", async () => {
    const fetcher = vi.fn();
    const provider = createGhlDeletionProviderPort({
      fetch: fetcher,
      loadLocationId: async (tenantId, installId, accountId) => {
        expect({ tenantId, installId, accountId }).toEqual({
          tenantId: "tenant-a",
          installId: "install-a",
          accountId: "location-a",
        });
        throw new GhlDeletionProviderError("GHL_CONTACT_INSTALL_CREDENTIAL_UNAVAILABLE");
      },
      getLocationAccessToken: async () => "replacement-b-token",
    });

    await expect(provider.readAbsent(input)).rejects.toEqual(
      new GhlDeletionProviderError("GHL_CONTACT_INSTALL_CREDENTIAL_UNAVAILABLE"),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("length-frames operation identity so delimiter-bearing targets cannot collide", async () => {
    const provider = createGhlDeletionProviderPort({
      fetch: vi.fn(async () => new Response(null, { status: 404 })),
      loadLocationId: async (_tenantId, _installId, accountId) => accountId,
      getLocationAccessToken: async () => "secret-access-token",
      now: () => new Date("2026-08-27T00:00:00.000Z"),
    });
    const first = await provider.readAbsent({
      ...input, ghlInstallId: "a:b", providerAccountId: "c",
    });
    const second = await provider.readAbsent({
      ...input, ghlInstallId: "a", providerAccountId: "b:c",
    });

    expect(first.providerOperationId).not.toBe(second.providerOperationId);
  });

  it("aborts a provider fetch on a deadline well below the deletion lease", async () => {
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })
    );
    const provider = createGhlDeletionProviderPort({
      fetch: fetcher as typeof fetch,
      loadLocationId: async () => "location-a",
      getLocationAccessToken: async () => "secret-access-token",
      requestTimeoutMs: 100,
    });

    vi.useFakeTimers();
    try {
      const request = provider.readAbsent(input);
      const outcome = expect(request).rejects.toEqual(
        new GhlDeletionProviderError("GHL_CONTACT_GET_NETWORK_FAILED"),
      );
      await vi.advanceTimersByTimeAsync(101);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the deadline active while validating a DELETE success body", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const provider = createGhlDeletionProviderPort({
      fetch: fetcher as typeof fetch,
      loadLocationId: async () => "location-a",
      getLocationAccessToken: async () => "secret-access-token",
      requestTimeoutMs: 100,
    });

    vi.useFakeTimers();
    try {
      const request = provider.deleteContact(input);
      const outcome = expect(request).rejects.toEqual(
        new GhlDeletionProviderError("GHL_CONTACT_DELETE_ENVELOPE_INVALID"),
      );
      await vi.advanceTimersByTimeAsync(101);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });
});
