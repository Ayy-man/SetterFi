import { describe, expect, it } from "vitest";

import {
  GhlProviderError,
  createMockGhlDriver,
  createRealGhlDriver,
  normalizeGhlInbound,
  normalizeGhlInstall,
  resolveGhlInstallAccessToken,
} from "./ghl";

const inbound = {
  webhookId: "event-1",
  locationId: "location-1",
  contactId: "contact-1",
  messageId: "message-1",
  messageType: "SMS",
  body: "Hello",
};

describe("GHL payload normalization", () => {
  it("normalizes provider identifiers without deriving a tenant from the signature", () => {
    expect(normalizeGhlInbound(inbound)).toEqual({
      events: [{
        kind: "message",
        eventId: "event-1",
        providerMessageId: "message-1",
        body: "Hello",
        externalAccountId: "location-1",
        identity: {
          channel: "sms",
          provider: "ghl",
          externalId: "contact-1",
          normalizedPhone: null,
          normalizedEmail: null,
        },
        providerWindow: null,
      }],
    });
  });

  it("normalizes message, echo, and status records into one explicit batch", () => {
    expect(normalizeGhlInbound([
      inbound,
      { webhookId: "echo-1", locationId: "location-1", isEcho: true },
      { webhookId: "status-1", locationId: "location-1", type: "MessageStatus", status: "delivered" },
    ])).toMatchObject({
      events: [
        { kind: "message", eventId: "event-1" },
        { kind: "ignored", eventId: "echo-1", reason: "echo" },
        { kind: "status", eventId: "status-1", status: "delivered" },
      ],
    });
  });

  it("accepts an agency install without inventing a location identifier", () => {
    expect(normalizeGhlInstall({ webhookId: "install-1", companyId: "company-1" })).toEqual({
      eventId: "install-1",
      locationId: null,
      companyId: "company-1",
    });
  });

  it("rejects incomplete or unsupported inbound envelopes", () => {
    expect(() => normalizeGhlInbound({ ...inbound, messageId: null })).toThrow(
      /GHL_INBOUND_ENVELOPE_INVALID/,
    );
    expect(() => normalizeGhlInbound({ ...inbound, messageType: "GMB" })).toThrow(
      /GHL_INBOUND_CHANNEL_UNSUPPORTED/,
    );
  });
});

describe("GHL drivers", () => {
  it("keeps mock sends deterministic and independent of fetch", async () => {
    const driver = createMockGhlDriver();
    const input = {
      kind: "freeform" as const,
      recipientExternalId: "contact-1",
      channel: "sms" as const,
      body: "Hello",
    };
    expect(await driver.send(input)).toEqual(await driver.send(input));
    expect(await driver.verifyWebhook(new Uint8Array(), "mock-signature")).toBe(true);
    expect(driver.provider).toBe("ghl");
    expect(driver.capabilities("whatsapp")).toEqual({
      windowed: false,
      postWindow: "none",
      templates: false,
    });
  });

  it("attaches the route-specific GHL headers and narrows a send success", async () => {
    let captured: RequestInit | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      captured = init;
      return new Response(JSON.stringify({ messageId: "provider-message-1" }), { status: 200 });
    };
    const driver = createRealGhlDriver(
      { clientId: "client", clientSecret: "secret", webhookPublicKey: "invalid-for-this-test" },
      {
        fetch: fetcher,
        locationId: "location-1",
        getLocationAccessToken: async () => "injected-access-token",
      },
    );
    await expect(
      driver.send({
        kind: "freeform",
        recipientExternalId: "contact-1",
        channel: "instagram",
        body: "Hello",
      }),
    ).resolves.toEqual({ providerMessageId: "provider-message-1" });

    expect(captured?.headers).toMatchObject({
      Authorization: "Bearer injected-access-token",
      Version: "2021-04-15",
      "Content-Type": "application/json",
    });
  });

  it("rejects malformed success and error envelopes without copying response values", async () => {
    const malformed = createRealGhlDriver(
      { clientId: "client", clientSecret: "secret", webhookPublicKey: "invalid" },
      {
        fetch: async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }),
        locationId: "location-1",
        getLocationAccessToken: async () => "injected-access-token",
      },
    );
    await expect(
      malformed.send({
        kind: "freeform",
        recipientExternalId: "contact-1",
        channel: "sms",
        body: "Hello",
      }),
    ).rejects.toThrow(/GHL_SEND_SUCCESS_ENVELOPE_INVALID/);

    const failed = createRealGhlDriver(
      { clientId: "client", clientSecret: "secret", webhookPublicKey: "invalid" },
      {
        fetch: async () => new Response(JSON.stringify({ privateDetail: "not-repeated" }), { status: 401 }),
        locationId: "location-1",
        getLocationAccessToken: async () => "injected-access-token",
      },
    );
    try {
      await failed.send({
        kind: "freeform",
        recipientExternalId: "contact-1",
        channel: "sms",
        body: "Hello",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(GhlProviderError);
      expect(String(error)).not.toContain("not-repeated");
    }
  });

  it("resolves an installed access token only through the secret envelope", async () => {
    const decryptCredential = (value: unknown) => {
      expect(value).toEqual({ version: 1, ciphertext: "synthetic" });
      return "resolved-token";
    };
    await expect(resolveGhlInstallAccessToken("location-1", {
      loadInstall: async () => ({
        id: "install-1",
        installState: "installed",
        accessCredentialEnvelope: { version: 1, ciphertext: "synthetic" },
      }),
      decryptCredential,
    })).resolves.toBe("resolved-token");
    await expect(resolveGhlInstallAccessToken("location-1", {
      loadInstall: async () => null,
      decryptCredential,
    })).rejects.toThrow("GHL_INSTALL_UNAVAILABLE");
  });

  it("refreshes rather than handing back a token inside its expiry margin", async () => {
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    const row = (tokenExpiresAt: string) => ({
      id: "install-1",
      installState: "token_ok",
      accessCredentialEnvelope: { version: 1, ciphertext: "synthetic" },
      tokenExpiresAt,
    });
    const decryptCredential = () => "stored-token";

    await expect(resolveGhlInstallAccessToken("location-1", {
      loadInstall: async () => row("2030-01-01T06:00:00.000Z"),
      decryptCredential,
      now: () => now,
      resolveRefreshed: async () => "refreshed-token",
    })).resolves.toBe("stored-token");

    // Four minutes of life left is inside the safety margin, so an in-flight call would straddle
    // the boundary; the resolver refreshes instead.
    await expect(resolveGhlInstallAccessToken("location-1", {
      loadInstall: async () => row("2030-01-01T00:04:00.000Z"),
      decryptCredential,
      now: () => now,
      resolveRefreshed: async () => "refreshed-token",
    })).resolves.toBe("refreshed-token");

    // With no way to refresh it refuses, because a stale token is the thing we stopped serving.
    await expect(resolveGhlInstallAccessToken("location-1", {
      loadInstall: async () => row("2029-12-31T00:00:00.000Z"),
      decryptCredential,
      now: () => now,
    })).rejects.toThrow("GHL_INSTALL_TOKEN_EXPIRED");
  });

  it("refuses an install the provider has already revoked", async () => {
    await expect(resolveGhlInstallAccessToken("location-1", {
      loadInstall: async () => ({
        id: "install-1",
        installState: "failed",
        accessCredentialEnvelope: { version: 1, ciphertext: "synthetic" },
        tokenExpiresAt: "2030-01-01T06:00:00.000Z",
        reauthorizationRequiredAt: "2030-01-01T00:00:00.000Z",
      }),
      decryptCredential: () => expect.unreachable("a revoked install must not be decrypted"),
      now: () => Date.parse("2030-01-01T00:00:00.000Z"),
      resolveRefreshed: async () => expect.unreachable("a revoked install must not be refreshed"),
    })).rejects.toThrow("GHL_INSTALL_REAUTHORIZATION_REQUIRED");
  });
});

describe("GHL install reconcile", () => {
  const driver = (fetcher: typeof fetch) => createRealGhlDriver(
    { clientId: "client", clientSecret: "secret", webhookPublicKey: "invalid" },
    {
      fetch: fetcher,
      now: () => Date.parse("2026-09-05T20:16:22.403Z"),
      getCompanyInstall: async () => ({ companyId: "company-1", accessToken: "agency-access" }),
    },
  );

  it("names a paused or deleted sub-account's 400 as GHL_INSTALL_LOCATION_INACTIVE, keys only", async () => {
    // The body the provider actually answered on 2026-09-05 for the 38 unexplained receipts.
    const body = {
      message: "Location is not active",
      error: "Bad Request",
      statusCode: 400,
      traceId: "723053d5-d35b-4f9a-94b6-fe6f61fd8f6e",
    };
    const inactive = driver(async () => new Response(JSON.stringify(body), { status: 400 }));
    let thrown: unknown;
    try {
      await inactive.reconcileInstall({ eventId: "event-1", locationId: "BGdfGG6xjP3JjyeTMVu5" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GhlProviderError);
    expect((thrown as GhlProviderError).code).toBe("GHL_INSTALL_LOCATION_INACTIVE");
    expect((thrown as GhlProviderError).status).toBe(400);
    expect((thrown as GhlProviderError).bodyShape).toBe("error,message,statusCode,traceId");
    expect(String(thrown)).not.toContain("723053d5");
  });

  it("keeps every other 400 under the general reconcile failure", async () => {
    const other = driver(async () =>
      new Response(JSON.stringify({ message: "locationId must be a string" }), { status: 400 }));
    await expect(
      other.reconcileInstall({ eventId: "event-1", locationId: "loc-1" }),
    ).rejects.toMatchObject({ code: "GHL_INSTALL_RECONCILE_FAILED", status: 400 });
  });

  it("mints a location token from the company grant when the location is active", async () => {
    const seen: Array<{ url: string; body: string; clientId: string | null }> = [];
    const active = driver(async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(input),
        body: String(init?.body),
        clientId: headers.get("X-Client-Id"),
      });
      return new Response(JSON.stringify({
        access_token: "location-access",
        refresh_token: "location-refresh",
        expires_in: 86_400,
        companyId: "company-1",
      }), { status: 200 });
    });
    await expect(active.reconcileInstall({ eventId: "event-1", locationId: "loc-1" })).resolves.toEqual({
      companyId: "company-1",
      accessToken: "location-access",
      refreshToken: "location-refresh",
      tokenExpiresAt: "2026-09-06T20:16:22.403Z",
    });
    expect(seen).toEqual([{
      url: "https://services.leadconnectorhq.com/oauth/locationToken",
      body: "companyId=company-1&locationId=loc-1",
      clientId: "client",
    }]);
  });
});
