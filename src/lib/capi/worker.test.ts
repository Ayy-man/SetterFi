import { describe, expect, it, vi } from "vitest";

import { CapiProviderError, createMockCapiDriver, type CapiDriver } from "@/lib/integrations/capi";
import {
  capiDatasetLookup,
  dispatchCapiEvents,
  type CapiWorkerDependencies,
  type ClaimedCapiEvent,
  type ResolvedCapiEvent,
} from "./worker";

const claimed: ClaimedCapiEvent = {
  eventId: "event-1", tenantId: "tenant-1", conversationId: "conversation-1",
  datasetRowId: "dataset-row-1", channel: "messenger", eventName: "QualifiedLead",
  eventTime: "2026-09-01T12:00:00.000Z", currency: null, value: null,
  isTest: false, isDemo: false, attemptNumber: 1, maxAttempts: 3, claimToken: "claim-1",
};

const resolved: ResolvedCapiEvent = {
  connectionId: "connection-1",
  event: {
    datasetId: "dataset-1", eventName: "QualifiedLead",
    eventTime: "2026-09-01T12:00:00.000Z",
    identity: { channel: "messenger", pageId: "page-1", pageScopedUserId: "psid-1" },
    currency: null, value: null,
  },
};

function dependencies(overrides: Partial<CapiWorkerDependencies> = {}) {
  const base: CapiWorkerDependencies = {
    claim: vi.fn(async () => [claimed]),
    resolve: vi.fn(async () => resolved),
    liveEnabled: vi.fn(() => false),
    createMock: vi.fn(createMockCapiDriver),
    createReal: vi.fn(async () => createMockCapiDriver()),
    dispatch: vi.fn((driver, event) => driver.dispatchEvent(event)),
    finish: vi.fn(async () => true),
    now: vi.fn(() => new Date("2026-09-01T12:00:00.000Z")),
  };
  return { ...base, ...overrides };
}

describe("CAPI outbox worker", () => {
  it.each([
    { isTest: true, isDemo: false },
    { isTest: false, isDemo: true },
  ])("excludes $isTest/$isDemo before resolution or real-driver construction", async (flags) => {
    const deps = dependencies({ claim: vi.fn(async () => [{ ...claimed, ...flags }]) });
    await expect(dispatchCapiEvents(25, deps)).resolves.toMatchObject({ excluded: 1 });
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(deps.createMock).not.toHaveBeenCalled();
    expect(deps.createReal).not.toHaveBeenCalled();
    expect(deps.finish).toHaveBeenCalledWith(expect.objectContaining({
      status: "excluded_test", providerMode: "none",
    }));
  });

  it("stores a mock receipt without producing a real-send audit state", async () => {
    const deps = dependencies();
    await expect(dispatchCapiEvents(25, deps)).resolves.toMatchObject({ mockSent: 1, sent: 0 });
    expect(deps.finish).toHaveBeenCalledWith(expect.objectContaining({
      status: "mock_sent", providerMode: "mock",
      providerReceipt: expect.objectContaining({ mode: "mock" }),
    }));
    expect(deps.createReal).not.toHaveBeenCalled();
  });

  it("marks successful live sends with the real mode consumed by transactional audit", async () => {
    const real: CapiDriver = {
      mode: "real",
      dispatchEvent: vi.fn(async () => ({
        provider: "meta" as const, mode: "real" as const,
        receiptId: "trace-1", accepted: true as const, received: 1,
      })),
    };
    const deps = dependencies({
      liveEnabled: vi.fn(() => true),
      createReal: vi.fn(async () => real),
    });
    await expect(dispatchCapiEvents(25, deps)).resolves.toMatchObject({ sent: 1 });
    expect(deps.finish).toHaveBeenCalledWith(expect.objectContaining({
      status: "sent", providerMode: "real",
    }));
  });

  it("retries only retryable failures and stops at the attempt budget", async () => {
    const failing: CapiDriver = {
      mode: "real",
      dispatchEvent: vi.fn(async () => {
        throw new CapiProviderError("CAPI_PROVIDER_REQUEST_FAILED", 503, true);
      }),
    };
    const retry = dependencies({
      liveEnabled: () => true,
      createReal: vi.fn(async () => failing),
    });
    await expect(dispatchCapiEvents(25, retry)).resolves.toMatchObject({ retried: 1 });
    expect(retry.finish).toHaveBeenCalledWith(expect.objectContaining({
      status: "retry", error: "CAPI_PROVIDER_REQUEST_FAILED", retryAt: expect.any(String),
    }));

    const terminal = dependencies({
      claim: vi.fn(async () => [{ ...claimed, attemptNumber: 3 }]),
      liveEnabled: () => true,
      createReal: vi.fn(async () => failing),
    });
    await expect(dispatchCapiEvents(25, terminal)).resolves.toMatchObject({ terminalFailed: 1 });
    expect(terminal.finish).toHaveBeenCalledWith(expect.objectContaining({
      status: "terminal_failed",
      error: "CAPI_ATTEMPT_BUDGET_EXHAUSTED:CAPI_PROVIDER_REQUEST_FAILED",
      retryAt: null,
    }));
  });

  it("terminally refuses invalid contracts without dispatching a provider", async () => {
    const deps = dependencies({
      resolve: vi.fn(async (): Promise<ResolvedCapiEvent> => ({
        ...resolved,
        event: { ...resolved.event, eventName: "Purchase" as const, currency: null, value: null },
      })),
    });
    await expect(dispatchCapiEvents(25, deps)).resolves.toMatchObject({ terminalFailed: 1 });
    expect(deps.finish).toHaveBeenCalledWith(expect.objectContaining({
      status: "terminal_failed", error: "CAPI_PURCHASE_VALUE_UNCONFIGURED",
    }));
  });

  it("discovers a newly connected channel dataset when enqueue had no dataset snapshot", () => {
    expect(capiDatasetLookup({ ...claimed, datasetRowId: null })).toEqual({
      tenantId: "tenant-1", datasetRowId: null, channel: "messenger",
    });
    expect(capiDatasetLookup(claimed)).toEqual({
      tenantId: "tenant-1", datasetRowId: "dataset-row-1", channel: null,
    });
  });
});
