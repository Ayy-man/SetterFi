import { createHash, createHmac, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createHumanTaggedCommand, authorizeHumanActor } from "./types";
import {
  META_GRAPH_VERSION,
  MetaProviderError,
  createMockMetaDriver,
  createRealMetaDriver,
  normalizeMetaInbound,
  verifyMetaWebhookHandshake,
  verifyMetaWebhookSignature,
} from "./meta";

const syntheticCredential = () => randomBytes(32).toString("base64url");
const configuration = {
  appId: "app",
  appSecret: syntheticCredential(),
  systemUserToken: syntheticCredential(),
  webhookVerifyToken: syntheticCredential(),
};

const EVENT_AT = Date.UTC(2026, 7, 17);

const messengerEvent = (
  mid: string,
  text: string,
  overrides: Record<string, unknown> = {},
) => ({
  sender: { id: `lead-${mid}` },
  recipient: { id: "page-1" },
  timestamp: EVENT_AT,
  message: { mid, text },
  ...overrides,
});

describe("Meta webhook boundaries", () => {
  it("verifies X-Hub-Signature-256 over the raw bytes and rejects mutations", async () => {
    const raw = new TextEncoder().encode('{"entry":[]}');
    const signature = `sha256=${createHmac("sha256", configuration.appSecret).update(raw).digest("hex")}`;
    expect(verifyMetaWebhookSignature(raw, signature, configuration.appSecret)).toBe(true);
    expect(
      verifyMetaWebhookSignature(
        new TextEncoder().encode('{"entry":[1]}'),
        signature,
        configuration.appSecret,
      ),
    ).toBe(false);
    expect(verifyMetaWebhookSignature(raw, "sha256=not-hex", configuration.appSecret)).toBe(false);

    const mockRaw = new TextEncoder().encode('{"object":"page"}');
    const mockAppSecret = createHash("sha256")
      .update("setterfi-meta-mock-signature-fixture")
      .digest("hex");
    const mockSignature = `sha256=${createHmac("sha256", mockAppSecret)
      .update(mockRaw)
      .digest("hex")}`;
    await expect(createMockMetaDriver().verifyWebhook(mockRaw, mockSignature)).resolves.toBe(true);
  });

  it("returns a challenge only for the configured webhook verify token", () => {
    const query = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": configuration.webhookVerifyToken,
      "hub.challenge": "challenge",
    });
    expect(verifyMetaWebhookHandshake(query, configuration.webhookVerifyToken)).toBe("challenge");
    expect(verifyMetaWebhookHandshake(query, "different-token")).toBeNull();
  });

  it("emits every distinct message in every entry with mandatory identity and window facts", () => {
    const batch = normalizeMetaInbound({
      object: "page",
      entry: [
        { id: "page-1", messaging: [messengerEvent("m-1", "Hi")] },
        { id: "page-1", messaging: [messengerEvent("m-2", "Hello")] },
      ],
    });
    expect(batch.events).toHaveLength(2);
    expect(batch.events.map((event) => event.eventId)).toEqual(["m-1", "m-2"]);
    expect(batch.events[0]).toEqual({
      kind: "message",
      eventId: "m-1",
      providerMessageId: "m-1",
      body: "Hi",
      externalAccountId: "page-1",
      identity: {
        channel: "messenger",
        provider: "meta_direct",
        externalId: "lead-m-1",
        normalizedPhone: null,
        normalizedEmail: null,
      },
      providerWindow: {
        observedAt: "2026-08-17T00:00:00.000Z",
        expiresAt: "2026-08-18T00:00:00.000Z",
        source: "derived_24h",
      },
      attribution: null,
    });
  });

  it("allowlists Messenger and Instagram ad referral attribution", () => {
    for (const object of ["page", "instagram"] as const) {
      const batch = normalizeMetaInbound({
        object,
        entry: [{
          id: object === "page" ? "page-1" : "ig-business-1",
          messaging: [messengerEvent(`${object}-message`, "funding", {
            referral: {
              source: "ADS",
              ad_id: `ad-${object}`,
              ref: "funding-campaign",
              ads_context_data: {
                ad_title: "Funding guide",
                post_id: "post-1",
                ignored_secret: "must-not-survive",
              },
              ignored_raw_field: "must-not-survive",
            },
          })],
        }],
      });

      expect(batch.events[0]).toMatchObject({
        kind: "message",
        attribution: {
          adId: `ad-${object}`,
          source: "ADS",
          ref: "funding-campaign",
          adsContextData: { adTitle: "Funding guide", postId: "post-1" },
          ctwaClid: null,
        },
      });
      expect(JSON.stringify(batch.events[0])).not.toContain("ignored");
    }
  });

  it("captures WhatsApp ctwa_clid without retaining the referral object", () => {
    const batch = normalizeMetaInbound({
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: "phone-1" },
            messages: [{
              id: "w-ad-1",
              from: "15551234567",
              timestamp: "1786886400",
              text: { body: "funding" },
              referral: {
                ctwa_clid: "ctwa-click-1",
                source_url: "https://example.com/secret-campaign",
              },
            }],
          },
        }],
      }],
    });

    expect(batch.events[0]).toMatchObject({
      kind: "message",
      attribution: {
        adId: null,
        source: null,
        ref: null,
        adsContextData: {},
        ctwaClid: "ctwa-click-1",
      },
    });
    expect(JSON.stringify(batch.events[0])).not.toContain("source_url");
  });

  it("keeps valid messages when optional referral data is absent or malformed", () => {
    const absent = normalizeMetaInbound({
      object: "page",
      entry: [{ id: "page-1", messaging: [messengerEvent("no-ref", "Hello")] }],
    });
    const malformed = normalizeMetaInbound({
      object: "page",
      entry: [{
        id: "page-1",
        messaging: [messengerEvent("bad-ref", "Hello", {
          referral: {
            source: 42,
            ad_id: {},
            ref: [],
            ads_context_data: { ad_title: false, post_id: {} },
          },
        })],
      }],
    });

    expect(absent.events[0]).toMatchObject({ kind: "message", attribution: null });
    expect(malformed.events[0]).toMatchObject({
      kind: "message",
      attribution: {
        adId: null,
        source: null,
        ref: null,
        adsContextData: {},
        ctwaClid: null,
      },
    });
  });

  it("normalizes WhatsApp messages and statuses without treating statuses as messages", () => {
    const batch = normalizeMetaInbound({
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: "phone-1" },
            messages: [{
              id: "w-1",
              from: "15551234567",
              timestamp: "1786886400",
              text: { body: "Hello" },
            }],
            statuses: [{ id: "w-out-1", status: "delivered", timestamp: "1786886401" }],
          },
        }],
      }],
    });
    expect(batch.events).toMatchObject([
      {
        kind: "message",
        providerMessageId: "w-1",
        externalAccountId: "phone-1",
        identity: { channel: "whatsapp", externalId: "15551234567" },
        attribution: null,
      },
      { kind: "status", eventId: "w-out-1", status: "delivered" },
    ]);
  });

  it("turns duplicate, echo, delivery, read, and unsupported events into non-message records", () => {
    const duplicate = messengerEvent("m-1", "Hi again");
    const batch = normalizeMetaInbound({
      object: "page",
      entry: [{
        id: "page-1",
        messaging: [
          messengerEvent("m-1", "Hi"),
          duplicate,
          messengerEvent("m-echo", "Our reply", {
            message: { mid: "m-echo", text: "Our reply", is_echo: true },
          }),
          { recipient: { id: "page-1" }, timestamp: 1_786_886_400_001, delivery: { mids: ["m-out"] } },
          { recipient: { id: "page-1" }, timestamp: 1_786_886_400_002, read: { watermark: 12 } },
          { recipient: { id: "page-1" }, timestamp: 1_786_886_400_003, postback: { payload: "x" } },
        ],
      }],
    });
    expect(batch.events.filter((event) => event.kind === "message")).toHaveLength(1);
    expect(batch.events.slice(1).map((event) => event.kind)).toEqual([
      "ignored",
      "ignored",
      "status",
      "status",
      "ignored",
    ]);
  });

  it("fails a message before persistence when its identity, account, ID, or window is empty", () => {
    const payload = (event: Record<string, unknown>, id: string | null = "page-1") => ({
      object: "page",
      entry: [{ id, messaging: [event] }],
    });
    expect(() => normalizeMetaInbound(payload(messengerEvent("m-1", "Hi", { sender: {} }))))
      .toThrow(/META_INBOUND_IDENTITY_REQUIRED/);
    expect(() => normalizeMetaInbound(payload(messengerEvent("m-1", "Hi", {
      recipient: {},
    }), null)))
      .toThrow(/META_INBOUND_ACCOUNT_REQUIRED/);
    expect(() => normalizeMetaInbound(payload(messengerEvent("m-1", "Hi", {
      message: { text: "Hi" },
    })))).toThrow(/META_INBOUND_MESSAGE_ID_REQUIRED/);
    expect(() => normalizeMetaInbound(payload(messengerEvent("m-1", "Hi", {
      timestamp: undefined,
    })))).toThrow(/META_INBOUND_WINDOW_REQUIRED/);
  });
});

describe("Meta Contract A drivers", () => {
  it("declares direct Meta capabilities without making SMS or webchat Meta send channels", () => {
    const driver = createMockMetaDriver();
    expect(driver.provider).toBe("meta_direct");
    expect(driver.capabilities("instagram")).toEqual({
      windowed: true,
      postWindow: "none",
      templates: false,
    });
    expect(driver.capabilities("messenger")).toEqual({
      windowed: true,
      postWindow: "none",
      templates: false,
    });
    expect(driver.capabilities("whatsapp")).toEqual({
      windowed: true,
      postWindow: "template",
      templates: true,
    });
  });

  it("keeps sealed mock sends deterministic and rejects unsupported command/channel pairs", async () => {
    const driver = createMockMetaDriver();
    const input = {
      kind: "freeform" as const,
      recipientExternalId: "lead-1",
      channel: "instagram" as const,
      body: "Hello",
    };
    expect(await driver.send(input)).toEqual(await driver.send(input));
    await expect(driver.send({ ...input, channel: "sms" })).rejects.toThrow(
      /META_CHANNEL_UNSUPPORTED/,
    );
    await expect(driver.send({
      kind: "approved_template",
      recipientExternalId: "lead-1",
      channel: "messenger",
      templateId: "template-1",
      providerTemplateName: "booking_confirmation",
      locale: "en_US",
      bodyHash: "hash",
      variables: {},
    })).rejects.toThrow(/META_TEMPLATE_CHANNEL_UNSUPPORTED/);
  });

  it("allows HUMAN_AGENT only for an authorized human command", async () => {
    const driver = createMockMetaDriver();
    const command = createHumanTaggedCommand(
      { channel: "messenger", recipientExternalId: "lead-1", body: "A person is replying." },
      authorizeHumanActor({ userId: "user-1", authorized: true }),
    );
    await expect(driver.send(command)).resolves.toMatchObject({
      providerMessageId: expect.stringMatching(/^mock-meta-message-/),
    });
    await expect(driver.send({
      kind: "human_tag",
      channel: "messenger",
      recipientExternalId: "lead-1",
      body: "AI-selected tag",
    } as unknown as typeof command)).rejects.toThrow(/META_HUMAN_ACTOR_REQUIRED/);
  });

  it("uses one resolver-produced connection and the one Graph-version constant", async () => {
    let capturedUrl: string | URL | Request | null = null;
    let capturedInit: RequestInit | undefined;
    let resolutionCount = 0;
    const accessToken = syntheticCredential();
    const driver = createRealMetaDriver(configuration, {
      fetch: async (input, init) => {
        capturedUrl = input;
        capturedInit = init;
        return new Response(JSON.stringify({ message_id: "message-1" }), { status: 200 });
      },
      resolveConnection: async () => {
        resolutionCount += 1;
        return {
          senderId: "page-1",
          accessToken,
          host: "https://graph.facebook.com",
        };
      },
    });
    await expect(driver.send({
      kind: "freeform",
      recipientExternalId: "lead-1",
      channel: "messenger",
      body: "Hello",
    })).resolves.toEqual({ providerMessageId: "message-1" });
    expect(resolutionCount).toBe(1);
    expect(META_GRAPH_VERSION).toBe("v25.0");
    expect(capturedUrl).toBe(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/page-1/messages`,
    );
    expect(capturedInit?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${accessToken}`,
    );
    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
      messaging_type: "RESPONSE",
    });
  });

  it("sends approved WhatsApp templates with provider name, locale, and variables", async () => {
    let capturedBody: unknown;
    const accessToken = syntheticCredential();
    const driver = createRealMetaDriver(configuration, {
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ message_id: "message-2" }), { status: 200 });
      },
      resolveConnection: async () => ({
        senderId: "phone-1",
        accessToken,
        host: "https://graph.facebook.com",
      }),
    });
    await driver.send({
      kind: "approved_template",
      recipientExternalId: "15551234567",
      channel: "whatsapp",
      templateId: "template-1",
      providerTemplateName: "booking_confirmation",
      locale: "en_US",
      bodyHash: "hash",
      variables: { first_name: "Taylor" },
    });
    expect(capturedBody).toEqual({
      messaging_product: "whatsapp",
      to: "15551234567",
      type: "template",
      template: {
        name: "booking_confirmation",
        language: { code: "en_US" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Taylor" }] }],
      },
    });
  });

  it("rejects malformed provider success and error envelopes without leaking response values", async () => {
    const real = (response: Response) => createRealMetaDriver(configuration, {
      fetch: async () => response,
      resolveConnection: async () => ({
        senderId: "page-1",
        accessToken: syntheticCredential(),
        host: "https://graph.facebook.com",
      }),
    });
    await expect(real(new Response(JSON.stringify({ accepted: true }), { status: 200 })).send({
      kind: "freeform",
      recipientExternalId: "lead-1",
      channel: "instagram",
      body: "Hello",
    })).rejects.toThrow(/META_SEND_SUCCESS_ENVELOPE_INVALID/);
    const error = await real(new Response(JSON.stringify({ error: "canary-provider-secret" }), {
      status: 429,
    })).send({
      kind: "freeform",
      recipientExternalId: "lead-1",
      channel: "instagram",
      body: "Hello",
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MetaProviderError);
    expect(String(error)).not.toContain("canary-provider-secret");
  });
});
