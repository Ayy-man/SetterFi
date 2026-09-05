import { describe, expect, it, vi } from "vitest";

import { DriverConfigurationError } from "@/lib/env-contract";

import {
  createLiveAgentHandler,
  createTestAgentSessionHandler,
} from "./handler";

const actor = {
  userId: "coach-synthetic",
  role: "coach" as const,
  tenantId: "tenant-synthetic",
};

const post = (body: unknown) => new Request("http://localhost/api/agent", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function dependencies() {
  const resolveTenant = vi.fn(async () => "tenant-synthetic");
  const createSession = vi.fn(async () => "session-synthetic");
  const consume = vi.fn(async () => ({ allowed: true, retryAfter: 0 }));
  const execute = vi.fn(async () => ({
    state: "persisted" as const,
    sessionId: "session-synthetic",
    tenantId: "tenant-synthetic",
    contactId: "contact-synthetic",
    conversationId: "conversation-synthetic",
    leadMessageId: "lead-synthetic",
    agentMessageId: "agent-synthetic",
    isTest: true as const,
    resolvedDriverArm: "mock" as const,
    history: [],
    turn: {
      reply: "Synthetic reply",
      state: "agent" as const,
      booking: null,
      decision: "NONE" as const,
      stage: "qualify" as const,
      grounded: true,
      ruleFired: null,
      model: "mock/model",
      tokenCount: 12,
    },
    trace: {
      promptHash: "prompt-synthetic",
      ruleFired: null,
      moderator: "allowed" as const,
      moderatorClass: "JUDGE" as const,
      moderatorRuleId: null,
      moderatorModelConfigId: "10000000-0000-4000-8000-000000000002",
      sourceIds: [],
      checks: [],
    },
  }));
  return {
    resolveTenant,
    createSession,
    consume,
    execute,
    values: {
      enabled: () => true,
      session: async () => actor,
      resolveTenant,
      createSession,
      consume,
      execute,
    },
  };
}

describe("authenticated test-agent route", () => {
  it("creates a server session without accepting tenant or test authority from a body", async () => {
    const deps = dependencies();
    const response = await createTestAgentSessionHandler(deps.values)();

    expect(response.status).toBe(200);
    expect(deps.createSession).toHaveBeenCalledWith({
      expectedTenant: "tenant-synthetic",
      actorId: "coach-synthetic",
    });
    expect(await response.json()).toEqual({ sessionId: "session-synthetic" });
  });

  it.each(["tenantId", "isTest", "history", "outcomes", "offer", "version", "destination"])(
    "refuses caller field %s before rate limiting or engine work",
    async (field) => {
      const deps = dependencies();
      const response = await createLiveAgentHandler(deps.values)(post({
        message: "Hello",
        sessionId: "session-synthetic",
        [field]: "caller-value",
      }));

      expect(response.status).toBe(400);
      expect(deps.consume).not.toHaveBeenCalled();
      expect(deps.execute).not.toHaveBeenCalled();
    },
  );

  it("passes only server actor, server tenant, session id, and the normalized new message", async () => {
    const deps = dependencies();
    const response = await createLiveAgentHandler(deps.values)(post({
      message: "  Hello  ",
      sessionId: "session-synthetic",
    }));

    expect(response.status).toBe(200);
    expect(deps.execute).toHaveBeenCalledWith({
      expectedTenant: "tenant-synthetic",
      actorId: "coach-synthetic",
      sessionId: "session-synthetic",
      message: "Hello",
    });
    expect(await response.json()).toMatchObject({
      state: "persisted",
      isTest: true,
      resolvedDriverArm: "mock",
      leadMessageId: "lead-synthetic",
      agentMessageId: "agent-synthetic",
    });
  });

  it("refuses empty or oversized messages before rate limiting or engine work", async () => {
    for (const message of [" ", "x".repeat(801)]) {
      const deps = dependencies();
      const response = await createLiveAgentHandler(deps.values)(post({
        message,
        sessionId: "session-synthetic",
      }));
      expect(response.status).toBe(400);
      expect(deps.consume).not.toHaveBeenCalled();
      expect(deps.execute).not.toHaveBeenCalled();
    }
  });

  it("makes disabled mode inert before authentication, session creation, or turn work", async () => {
    const deps = dependencies();
    const session = vi.fn(async () => actor);
    const values = { ...deps.values, enabled: () => false, session };

    const [getResponse, postResponse] = await Promise.all([
      createTestAgentSessionHandler(values)(),
      createLiveAgentHandler(values)(post({ message: "Hello", sessionId: "session-synthetic" })),
    ]);

    expect(getResponse.status).toBe(404);
    expect(postResponse.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(deps.createSession).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("rejects anonymous and unsupported sessions without creating or running a test session", async () => {
    const deps = dependencies();
    const values = { ...deps.values, session: async () => null };

    expect((await createTestAgentSessionHandler(values)()).status).toBe(401);
    expect((await createLiveAgentHandler(values)(post({
      message: "Hello",
      sessionId: "session-synthetic",
    }))).status).toBe(401);
    expect(deps.createSession).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("fails explicit real selection with names only instead of falling through to mock", async () => {
    const deps = dependencies();
    deps.execute.mockRejectedValueOnce(new DriverConfigurationError(
      "openrouter",
      ["OPENROUTER_API_KEY"],
    ));

    const response = await createLiveAgentHandler(deps.values)(post({
      message: "Hello",
      sessionId: "session-synthetic",
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "The selected agent driver is not configured.",
      code: "DRIVER_CONFIGURATION_ERROR",
      requiredNames: ["OPENROUTER_API_KEY"],
    });
  });
});
