import { describe, expect, it, vi } from "vitest";

import { environmentValue } from "@/lib/env-contract";
import { SLACK_CONFIGURATION_NAMES } from "@/lib/integrations/selector";

import { createRealSlackDriver, SLACK_TEXT_LIMIT_EXCLUSIVE } from "./real";
import { resolveSlackDriver } from "./selector";

const NOW = new Date("2026-08-18T08:00:00.000Z");

function destination(name: string) {
  return `https://hooks.slack.com/services/T00000000/B00000000/${name}`;
}

const configuration = { platformFallbackUrl: destination("PLATFORM_FALLBACK") };

function input(overrides: Partial<Parameters<ReturnType<typeof createRealSlackDriver>["postSlack"]>[0]> = {}) {
  return {
    deliveryId: "delivery-synthetic",
    attemptNumber: 1,
    text: "Synthetic Slack alert.",
    destinationUrl: destination("TENANT_OVERRIDE"),
    ...overrides,
  };
}

describe("real Slack webhook adapter", () => {
  it("delivers only HTTP 200 with exact body ok and always includes text", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("ok", { status: 200 }));
    const driver = createRealSlackDriver(configuration, { fetch: fetcher });
    await expect(driver.postSlack(input())).resolves.toEqual({
      kind: "delivered",
      providerReference: "slack-webhook:delivery-synthetic:attempt:1",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(destination("TENANT_OVERRIDE"));
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({ text: "Synthetic Slack alert." });
  });

  it.each([
    "http://hooks.slack.com/services/T/B/credential",
    "https://hooks.slack.com.evil.test/services/T/B/credential",
    "https://user:pass@hooks.slack.com/services/T/B/credential",
    "https://hooks.slack.com:444/services/T/B/credential",
    "https://hooks.slack.com/services/T/B",
    "https://hooks.slack.com/services/T/B/credential/extra",
    "https://hooks.slack.com/services/T/B/credential?redirect=evil",
    "https://hooks.slack.com/services/T/B/credential#fragment",
  ])("refuses a non-canonical Slack webhook destination: %s", async (destinationUrl) => {
    const fetcher = vi.fn<typeof fetch>();
    const driver = createRealSlackDriver(configuration, { fetch: fetcher });

    await expect(driver.postSlack(input({ destinationUrl }))).resolves.toEqual({
      kind: "terminal",
      errorCode: "SLACK_DESTINATION_MISSING",
      safeDetail: "A valid Slack destination is required.",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts Slack's government webhook host without widening to sibling domains", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("ok"));
    const driver = createRealSlackDriver(configuration, { fetch: fetcher });
    const destinationUrl = "https://hooks.slack-gov.com/services/T000/B000/credential";

    await expect(driver.postSlack(input({ destinationUrl }))).resolves.toMatchObject({
      kind: "delivered",
    });
    expect(fetcher).toHaveBeenCalledWith(destinationUrl, expect.objectContaining({
      redirect: "error",
    }));
  });

  it("uses the platform fallback only when the tenant destination is absent", async () => {
    const destinations: string[] = [];
    const driver = createRealSlackDriver(configuration, {
      fetch: async (url) => {
        destinations.push(String(url));
        return new Response("ok");
      },
    });
    await expect(driver.postSlack(input({ destinationUrl: " " }))).resolves.toMatchObject({
      kind: "delivered",
    });
    expect(destinations).toEqual([configuration.platformFallbackUrl]);
  });

  it("refuses placeholder copy and a missing destination before constructing a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const driver = createRealSlackDriver({ platformFallbackUrl: "" }, { fetch: fetcher });
    await expect(driver.postSlack(input({
      text: "SETTERFI_DEMO_PLACEHOLDER_SLACK",
      destinationUrl: destination("TENANT_OVERRIDE"),
    }))).resolves.toEqual({
      kind: "terminal",
      errorCode: "ALERT_COPY_UNAPPROVED",
      safeDetail: "Alert copy has not been approved for delivery.",
    });
    await expect(driver.postSlack(input({ destinationUrl: null }))).resolves.toEqual({
      kind: "terminal",
      errorCode: "SLACK_DESTINATION_MISSING",
      safeDetail: "A valid Slack destination is required.",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps text below 3000 characters before posting", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("ok"));
    const driver = createRealSlackDriver(configuration, { fetch: fetcher });
    await expect(driver.postSlack(input({
      text: "x".repeat(SLACK_TEXT_LIMIT_EXCLUSIVE - 1),
    }))).resolves.toMatchObject({ kind: "delivered" });
    await expect(driver.postSlack(input({
      text: "x".repeat(SLACK_TEXT_LIMIT_EXCLUSIVE),
    }))).resolves.toEqual({
      kind: "terminal",
      errorCode: "SLACK_TEXT_INVALID",
      safeDetail: "Slack text must contain fewer than 3000 characters.",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ["invalid_payload", "SLACK_INVALID_PAYLOAD"],
    ["invalid_token", "SLACK_INVALID_TOKEN"],
    ["channel_not_found", "SLACK_CHANNEL_NOT_FOUND"],
    ["action_prohibited", "SLACK_ACTION_PROHIBITED"],
    ["no_service", "SLACK_NO_SERVICE"],
  ])("maps documented body %s to terminal %s without echoing it", async (body, errorCode) => {
    const driver = createRealSlackDriver(configuration, {
      fetch: async () => new Response(body, { status: 400 }),
    });
    const outcome = await driver.postSlack(input());
    expect(outcome).toMatchObject({ kind: "terminal", errorCode });
    expect(JSON.stringify(outcome)).not.toContain(configuration.platformFallbackUrl);
    expect(JSON.stringify(outcome)).not.toContain(destination("TENANT_OVERRIDE"));
  });

  it("treats HTTP 200 with a non-ok body as terminal rather than delivered", async () => {
    const driver = createRealSlackDriver(configuration, {
      fetch: async () => new Response("unexpected-success-body", { status: 200 }),
    });
    const outcome = await driver.postSlack(input());
    expect(outcome).toEqual({
      kind: "terminal",
      errorCode: "SLACK_RESPONSE_INVALID",
      safeDetail: "Slack returned an unrecognized success response.",
    });
    expect(JSON.stringify(outcome)).not.toContain("unexpected-success-body");
  });

  it("maps 429 and 5xx to retries while honoring only Slack's Retry-After", async () => {
    const responses = [
      new Response("rate_limited", { status: 429, headers: { "retry-after": "8" } }),
      new Response("server_error", { status: 502 }),
    ];
    const driver = createRealSlackDriver(configuration, {
      fetch: async () => responses.shift()!,
      now: () => new Date(NOW),
    });
    await expect(driver.postSlack(input())).resolves.toEqual({
      kind: "retry",
      retryAfterSeconds: 8,
      errorCode: "SLACK_HTTP_429",
    });
    await expect(driver.postSlack(input({ attemptNumber: 2 }))).resolves.toEqual({
      kind: "retry",
      retryAfterSeconds: null,
      errorCode: "SLACK_HTTP_502",
    });
  });

  it("redacts destination and thrown detail from network failure outcomes", async () => {
    const privateDestination = destination("PRIVATE_DESTINATION");
    const driver = createRealSlackDriver(configuration, {
      fetch: async () => { throw new Error(privateDestination); },
    });
    const outcome = await driver.postSlack(input({ destinationUrl: privateDestination }));
    expect(outcome).toEqual({
      kind: "retry",
      retryAfterSeconds: null,
      errorCode: "SLACK_NETWORK_ERROR",
    });
    expect(JSON.stringify(outcome)).not.toContain(privateDestination);
  });
});

const slackRealArmNames = ["SETTERFI_SLACK_DRIVER", ...SLACK_CONFIGURATION_NAMES] as const;
const slackRealArmMissing = slackRealArmNames.filter((name) => {
  if (name === "SETTERFI_SLACK_DRIVER") return environmentValue(name) !== "real";
  return !environmentValue(name);
});
const slackRealArmSkipReason = slackRealArmMissing.length > 0
  ? `${slackRealArmMissing.join(", ")} ${slackRealArmMissing.length === 1 ? "is" : "are"} required`
  : null;

describe.skipIf(Boolean(slackRealArmSkipReason))(
  `Slack configuration-gated arm — SKIPPED: ${slackRealArmSkipReason ?? "configured"}`,
  () => {
    it("constructs the selected arm against an injected fetch without contacting Slack", async () => {
      const driver = resolveSlackDriver({
        environment: process.env,
        factories: {
          mock: () => { throw new Error("REAL_SLACK_ARM_NOT_SELECTED"); },
          real: (realConfiguration) => createRealSlackDriver(realConfiguration, {
            fetch: async () => new Response("ok"),
          }),
        },
      });
      await expect(driver.postSlack(input({ destinationUrl: "" }))).resolves.toMatchObject({
        kind: "delivered",
      });
    });
  },
);
