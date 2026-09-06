import { describe, expect, it, vi } from "vitest";

import { DriverConfigurationError } from "@/lib/env-contract";
import { BrainRuntimeReadinessError } from "@/lib/repositories/brain-runtime";
import type { BrainTestTurnResult } from "@/lib/repositories/brain-test-turn";

import { createBrainTestTurnHandler, parseTestTurnBody } from "./handler";

const admin = { userId: "platform-admin", role: "admin" as const };
const body = {
  coachTenantId: "tenant-1",
  revision: "draft",
  channel: "sms",
  message: "Is this legitimate?",
  history: [{ role: "assistant", content: "Hi there." }],
};
const request = (payload: unknown) => new Request("http://localhost/api/admin/brain/test-turn", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: typeof payload === "string" ? payload : JSON.stringify(payload),
});

const completed = {
  reply: "Yes.",
  held: false,
  heldReason: null,
  conversationState: "agent",
  evidence: {
    citations: [], qualification: { step: 0, of: 1, nextStep: null },
    safety: { checks: [], moderator: { verdict: "allowed", ms: 4, class: null, ruleId: null, reason: null } },
    promptHash: "a".repeat(64), tokens: { prompt: 1, completion: 1, total: 2 }, channelLength: { chars: 4, soft: 160, hard: 320 },
  },
  revision: { kind: "draft", snapshotId: "s", brainVersion: 8, contentHash: "b".repeat(64), offerVersion: 1, draftId: "d", retrievalMode: "draft_in_process" },
  model: "m", latencyMs: 10, attempts: 1,
} satisfies BrainTestTurnResult;

function handler(overrides: Partial<Parameters<typeof createBrainTestTurnHandler>[0]> = {}) {
  return createBrainTestTurnHandler({
    enabled: () => true,
    session: async () => admin,
    consume: async () => ({ allowed: true, retryAfter: 0 }),
    run: async () => completed,
    ...overrides,
  });
}

describe("POST /api/admin/brain/test-turn", () => {
  it("404s before auth when Phase 2 is off", async () => {
    const session = vi.fn(async () => admin);
    const run = vi.fn();
    const response = await handler({ enabled: () => false, session, run })(request(body));
    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("403s every role below admin, including success, and unauthenticated callers", async () => {
    for (const actor of [null, { userId: "s", role: "success" as const }, { userId: "c", role: "coach" as const }]) {
      const run = vi.fn();
      const response = await handler({ session: async () => actor, run })(request(body));
      expect(response.status).toBe(403);
      expect(run).not.toHaveBeenCalled();
    }
    expect((await handler({ session: async () => ({ userId: "o", role: "owner" }) })(request(body))).status).toBe(200);
  });

  it("refuses malformed bodies before consuming the limiter", async () => {
    const consume = vi.fn(async () => ({ allowed: true, retryAfter: 0 }));
    const bad = [
      "not json",
      { ...body, extra: true },
      { ...body, revision: "published" },
      { ...body, channel: "email" },
      { ...body, message: "   " },
      { ...body, message: "x".repeat(801) },
      { ...body, history: [{ role: "system", content: "x" }] },
      { ...body, history: [{ role: "user", content: "x", extra: 1 }] },
      { ...body, history: "none" },
      { ...body, coachTenantId: "" },
    ];
    for (const payload of bad) {
      const response = await handler({ consume })(request(payload));
      expect(response.status, JSON.stringify(payload)).toBe(400);
      expect(await response.json()).toEqual({ state: "refused", code: "BRAIN_TEST_TURN_BODY_INVALID" });
    }
    expect(consume).not.toHaveBeenCalled();
  });

  it("rate limits per coach with Retry-After and never runs the turn", async () => {
    const run = vi.fn();
    const consume = vi.fn(async (_request: Request, _tenantId: string) => ({ allowed: false, retryAfter: 17 }));
    const response = await handler({ consume, run })(request(body));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("17");
    expect(consume.mock.calls[0][1]).toBe("tenant-1");
    expect(run).not.toHaveBeenCalled();
  });

  it("passes the narrowed input through and returns the completed envelope", async () => {
    const run = vi.fn(async () => completed);
    const response = await handler({ run })(request({ ...body, message: "  Is this legitimate?  " }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(run).toHaveBeenCalledWith({
      coachTenantId: "tenant-1", revision: "draft", channel: "sms", message: "Is this legitimate?",
      history: [{ role: "assistant", content: "Hi there." }],
    });
    expect(await response.json()).toEqual({ state: "completed", ...completed });
  });

  it("maps driver configuration to 503, readiness to 409, and anything else to a generic 400", async () => {
    const configuration = await handler({
      run: async () => { throw new DriverConfigurationError("openrouter", ["OPENROUTER_API_KEY"]); },
    })(request(body));
    expect(configuration.status).toBe(503);
    expect(await configuration.json()).toMatchObject({ state: "not_ready", code: "DRIVER_CONFIGURATION_ERROR", requiredNames: ["OPENROUTER_API_KEY"] });

    const runtime = await handler({
      run: async () => { throw new BrainRuntimeReadinessError("RUNTIME_OFFER_NOT_PUBLISHED"); },
    })(request(body));
    expect(runtime.status).toBe(409);
    expect(await runtime.json()).toEqual({ state: "not_ready", code: "RUNTIME_OFFER_NOT_PUBLISHED" });

    const content = await handler({
      run: async () => { throw new Error("PLATFORM_AGENT_CONTENT_UNAPPROVED_NON_DEMO"); },
    })(request(body));
    expect(content.status).toBe(409);
    expect(await content.json()).toEqual({ state: "not_ready", code: "PLATFORM_AGENT_CONTENT_UNAPPROVED_NON_DEMO" });

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const other = await handler({ run: async () => { throw new Error("BRAIN_RETRIEVAL_RPC_FAILED:boom"); } })(request(body));
    expect(other.status).toBe(400);
    expect(await other.json()).toEqual({ state: "refused", code: "BRAIN_TEST_TURN_REFUSED" });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("parseTestTurnBody", () => {
  it("accepts every channel and both revisions with an empty history", () => {
    for (const channel of ["sms", "instagram", "messenger", "whatsapp", "webchat"]) {
      for (const revision of ["draft", "live"]) {
        expect(parseTestTurnBody({ ...body, channel, revision, history: [] })).toMatchObject({ channel, revision, history: [] });
      }
    }
  });
});
