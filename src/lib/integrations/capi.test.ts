import { describe, expect, it, vi } from "vitest";

import {
  CapiContractError,
  CapiProviderError,
  createMockCapiDriver,
  createRealCapiDriver,
  type CapiEvent,
} from "./capi";

const qualified: CapiEvent = {
  datasetId: "dataset-1",
  eventName: "QualifiedLead",
  eventTime: "2026-09-01T12:00:00.000Z",
  identity: { channel: "messenger", pageId: "page-1", pageScopedUserId: "psid-1" },
  currency: null,
  value: null,
};

describe("Meta CAPI for Business Messaging driver", () => {
  it("returns a deterministic receipt that is visibly mock", async () => {
    const driver = createMockCapiDriver();
    await expect(driver.dispatchEvent(qualified)).resolves.toEqual(await driver.dispatchEvent(qualified));
    await expect(driver.dispatchEvent(qualified)).resolves.toMatchObject({
      mode: "mock",
      provider: "meta",
      receiptId: expect.stringMatching(/^mock-capi-/u),
    });
  });

  it("emits only the fixed business-messaging payload and channel identity", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ events_received: 1 }), {
      status: 200,
      headers: { "x-fb-trace-id": "trace-1" },
    }));
    const driver = createRealCapiDriver({ accessToken: "secret" }, { fetch: fetcher });
    await expect(driver.dispatchEvent({
      datasetId: "dataset-ig",
      eventName: "QualifiedLead",
      eventTime: "2026-09-01T12:00:00.000Z",
      identity: {
        channel: "instagram",
        instagramBusinessAccountId: "ig-business-1",
        igSid: "igsid-1",
      },
      currency: null,
      value: null,
    })).resolves.toMatchObject({ mode: "real", receiptId: "trace-1", received: 1 });
    expect(fetcher).toHaveBeenCalledWith(
      "https://graph.facebook.com/dataset-ig/events",
      expect.objectContaining({ method: "POST" }),
    );
    const request = fetcher.mock.calls[0]![1]!;
    expect(JSON.parse(String(request.body))).toEqual({
      data: [{
        event_name: "QualifiedLead",
        event_time: 1_788_264_000,
        action_source: "business_messaging",
        messaging_channel: "instagram",
        user_data: {
          instagram_business_account_id: "ig-business-1",
          ig_sid: "igsid-1",
        },
      }],
    });
  });

  it("refuses invalid identities and an unvalued Purchase before network I/O", async () => {
    const fetcher = vi.fn();
    const driver = createRealCapiDriver({ accessToken: "secret" }, { fetch: fetcher });
    await expect(driver.dispatchEvent({
      ...qualified,
      eventName: "Purchase",
    })).rejects.toMatchObject({ code: "CAPI_PURCHASE_VALUE_UNCONFIGURED" } satisfies Partial<CapiContractError>);
    await expect(driver.dispatchEvent({
      ...qualified,
      identity: { channel: "whatsapp", whatsappBusinessAccountId: "waba-1", ctwaClid: "" },
    })).rejects.toMatchObject({ code: "CAPI_CTWA_CLID_REQUIRED" } satisfies Partial<CapiContractError>);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("classifies only network, 429, and 5xx failures as retryable", async () => {
    const network = createRealCapiDriver({ accessToken: "secret" }, {
      fetch: vi.fn(async () => { throw new Error("contains a provider secret"); }),
    });
    await expect(network.dispatchEvent(qualified)).rejects.toMatchObject({
      code: "CAPI_PROVIDER_NETWORK_FAILED",
      retryable: true,
    } satisfies Partial<CapiProviderError>);
    const invalid = createRealCapiDriver({ accessToken: "secret" }, {
      fetch: vi.fn(async () => new Response("sensitive body", { status: 400 })),
    });
    await expect(invalid.dispatchEvent(qualified)).rejects.toEqual(
      new CapiProviderError("CAPI_PROVIDER_REQUEST_FAILED", 400, false),
    );
  });
});
