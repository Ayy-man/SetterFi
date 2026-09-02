import { describe, expect, it, vi } from "vitest";

import { environmentValue } from "@/lib/env-contract";
import { EMAIL_CONFIGURATION_NAMES } from "@/lib/integrations/selector";

import {
  createRealEmailDriver,
  RESEND_DEFAULT_REQUESTS_PER_SECOND,
  RESEND_EMAIL_ENDPOINT,
  RESEND_IDEMPOTENCY_RETENTION_HOURS,
} from "./real";
import { resolveEmailDriver } from "./selector";

const NOW = new Date("2026-08-18T08:00:00.000Z");
const RESEND_ALLOWLISTED_TEST_RECIPIENT = "delivered@resend.dev";

function configuredValue(name: string) {
  return `configured-value-for-${name.toLowerCase()}`;
}

const configuration = {
  apiKey: configuredValue("RESEND_API_KEY"),
  from: "notifications@example.test",
};

function input(overrides: Partial<Parameters<ReturnType<typeof createRealEmailDriver>["deliverEmail"]>[0]> = {}) {
  return {
    deliveryId: "delivery-synthetic",
    attemptNumber: 1,
    to: "recipient@example.test",
    from: configuration.from,
    subject: "Synthetic alert",
    text: "Synthetic alert body.",
    ...overrides,
  };
}

describe("real Resend email adapter", () => {
  it("posts one accepted request with the stable 24-hour idempotency contract", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ id: "email-provider-reference" }), { status: 200 })
    );
    const driver = createRealEmailDriver(configuration, { fetch: fetcher });

    await expect(driver.deliverEmail(input())).resolves.toEqual({
      kind: "accepted",
      providerReference: "email-provider-reference",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(RESEND_EMAIL_ENDPOINT);
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect([...headers.keys()].sort()).toEqual([
      "authorization",
      "content-type",
      "idempotency-key",
    ]);
    expect(headers.get("authorization")).toBe(`Bearer ${configuration.apiKey}`);
    expect(headers.get("idempotency-key")).toBe(
      "notification:delivery-synthetic:attempt:1",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      from: configuration.from,
      to: ["recipient@example.test"],
      subject: "Synthetic alert",
      text: "Synthetic alert body.",
    });
    expect(RESEND_IDEMPOTENCY_RETENTION_HOURS).toBe(24);
    expect(RESEND_DEFAULT_REQUESTS_PER_SECOND).toBe(10);
  });

  it("refuses seeded placeholder copy before constructing a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const driver = createRealEmailDriver(configuration, { fetch: fetcher });
    await expect(driver.deliverEmail(input({
      subject: "SETTERFI_DEMO_PLACEHOLDER_SUBJECT",
    }))).resolves.toEqual({
      kind: "terminal",
      errorCode: "ALERT_COPY_UNAPPROVED",
      safeDetail: "Alert copy has not been approved for delivery.",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("honors Retry-After and rate-limit pacing on 429 and 5xx outcomes", async () => {
    const responses = [
      new Response("provider detail", {
        status: 429,
        headers: { "retry-after": "17", "ratelimit-reset": "3" },
      }),
      new Response("provider detail", {
        status: 503,
        headers: { "ratelimit-reset": "4" },
      }),
    ];
    const driver = createRealEmailDriver(configuration, {
      fetch: async () => responses.shift()!,
      now: () => new Date(NOW),
    });
    await expect(driver.deliverEmail(input())).resolves.toEqual({
      kind: "retry",
      retryAfterSeconds: 17,
      errorCode: "RESEND_HTTP_429",
    });
    await expect(driver.deliverEmail(input({ attemptNumber: 2 }))).resolves.toEqual({
      kind: "retry",
      retryAfterSeconds: 4,
      errorCode: "RESEND_HTTP_503",
    });
  });

  it.each([301, 400, 401, 422])(
    "maps HTTP %i to a terminal redacted outcome rather than exposing the body",
    async (status) => {
      const providerDetail = `provider-detail-${status}`;
      const driver = createRealEmailDriver(configuration, {
        fetch: async () => new Response(providerDetail, { status }),
      });
      const outcome = await driver.deliverEmail(input());
      expect(outcome).toEqual({
        kind: "terminal",
        errorCode: `RESEND_HTTP_${status}`,
        safeDetail: `Resend rejected the request with HTTP ${status}.`,
      });
      expect(JSON.stringify(outcome)).not.toContain(providerDetail);
      expect(JSON.stringify(outcome)).not.toContain(configuration.apiKey);
    },
  );

  it("retries a network failure and terminates a malformed 200 without leaking details", async () => {
    const networkDriver = createRealEmailDriver(configuration, {
      fetch: async () => { throw new Error(`private-${configuration.apiKey}`); },
    });
    await expect(networkDriver.deliverEmail(input())).resolves.toEqual({
      kind: "retry",
      retryAfterSeconds: null,
      errorCode: "RESEND_NETWORK_ERROR",
    });

    const malformedDriver = createRealEmailDriver(configuration, {
      fetch: async () => new Response(JSON.stringify({ error: "private-provider-detail" })),
    });
    const outcome = await malformedDriver.deliverEmail(input());
    expect(outcome).toEqual({
      kind: "terminal",
      errorCode: "RESEND_RESPONSE_INVALID",
      safeDetail: "Resend returned an invalid acceptance response.",
    });
    expect(JSON.stringify(outcome)).not.toContain("private-provider-detail");
  });

  it("refuses an overlong idempotency key before fetch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const driver = createRealEmailDriver(configuration, { fetch: fetcher });
    await expect(driver.deliverEmail(input({ deliveryId: "x".repeat(240) }))).resolves.toEqual({
      kind: "terminal",
      errorCode: "RESEND_IDEMPOTENCY_KEY_INVALID",
      safeDetail: "The delivery attempt identifier is invalid.",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

const emailRealArmNames = ["SETTERFI_EMAIL_DRIVER", ...EMAIL_CONFIGURATION_NAMES] as const;
const emailRealArmMissing = emailRealArmNames.filter((name) => {
  if (name === "SETTERFI_EMAIL_DRIVER") return environmentValue(name) !== "real";
  return !environmentValue(name);
});
const emailRealArmSkipReason = emailRealArmMissing.length > 0
  ? `${emailRealArmMissing.join(", ")} ${emailRealArmMissing.length === 1 ? "is" : "are"} required`
  : null;

describe.skipIf(Boolean(emailRealArmSkipReason))(
  `Resend configuration-gated arm — SKIPPED: ${emailRealArmSkipReason ?? "configured"}`,
  () => {
    it("uses only Resend's allowlisted test recipient through an injected fetch", async () => {
      let observedRecipient: unknown;
      const driver = resolveEmailDriver({
        environment: process.env,
        factories: {
          mock: () => { throw new Error("REAL_EMAIL_ARM_NOT_SELECTED"); },
          real: (realConfiguration) => createRealEmailDriver(realConfiguration, {
            fetch: async (_url, init) => {
              observedRecipient = JSON.parse(String(init?.body)).to;
              return new Response(JSON.stringify({ id: "configured-arm-reference" }));
            },
          }),
        },
      });
      await expect(driver.deliverEmail({
        ...input({
          to: RESEND_ALLOWLISTED_TEST_RECIPIENT,
          from: environmentValue("SETTERFI_EMAIL_FROM")!,
        }),
      })).resolves.toMatchObject({ kind: "accepted" });
      expect(observedRecipient).toEqual([RESEND_ALLOWLISTED_TEST_RECIPIENT]);
    });
  },
);
