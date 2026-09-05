import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { EngineTurnResult } from "@/lib/engine/types";

import {
  createTestAgentSession,
  runTestAgentTurn,
  type TestAgentDependencies,
} from "./test-agent";

const tenantId = "tenant-synthetic";
const actorId = "actor-synthetic";
const sessionId = "session-synthetic";

const engineResult = {
  response: {
    reply: "A synthetic persisted reply.",
    state: "agent",
    booking: null,
  },
  commands: [
    { kind: "advance_step", stepId: "credit", valuePersisted: true, nextAskCount: 0 },
    { kind: "increment_step_asks", stepId: "goal", nextAskCount: 1 },
  ],
  trace: {
    brainVersion: 7,
    offerVersion: 3,
    brainContentHash: null,
    offerContentHash: null,
    knowledgeMode: "inline",
    promptHash: "prompt-synthetic",
    model: "mock/model",
    paramsHash: "params-synthetic",
    ruleFired: null,
    sources: [],
    declaredEntryId: null,
    declaredEntryVerified: false,
    retrievalTopThree: [],
    droppedEntryIds: [],
    numberAllowlist: [],
    objection: null,
    checks: [],
    violations: [],
    rejectedDrafts: [],
    attempts: 1,
    screen: { verdict: "continue", reason: null },
    latencyMs: 12,
    usage: { promptTokens: 10, completionTokens: 6, totalTokens: 16 },
    cost: 0,
    moderator: "allowed",
    moderatorReason: null,
    moderatorClass: "JUDGE",
    moderatorRuleId: null,
    moderatorModelConfigId: "10000000-0000-4000-8000-000000000002",
  },
} satisfies EngineTurnResult;

function dependencies(overrides: Partial<TestAgentDependencies> = {}) {
  const send = vi.fn(() => { throw new Error("send called"); });
  const calendar = vi.fn(() => { throw new Error("calendar called"); });
  const appointment = vi.fn(() => { throw new Error("appointment called"); });
  const billable = vi.fn(() => { throw new Error("billable called"); });
  const followup = vi.fn(() => { throw new Error("followup called"); });
  const rpc = vi.fn(async (name: string) => name === "create_test_agent_session"
    ? sessionId
    : [{
        contact_id: "contact-synthetic",
        conversation_id: "conversation-synthetic",
        lead_message_id: "lead-message-synthetic",
        agent_message_id: "agent-message-synthetic",
        resolved_driver_arm: "mock",
        contact_is_test: true,
        conversation_is_test: true,
        lead_is_test: true,
        agent_is_test: true,
        trace_is_test: true,
        step_rows_is_test: true,
        appointment_rows: 0,
        billable_rows: 0,
        followup_rows: 0,
      }]);
  const values: TestAgentDependencies = {
    rpc,
    loadSession: async () => ({
      id: sessionId,
      tenantId,
      startedBy: actorId,
      closedAt: null,
      conversation: {
        id: "conversation-synthetic",
        state: "agent",
        currentStep: "goal",
        currentStepAsks: 0,
        disclosurePending: false,
        isTest: true,
      },
    }),
    loadHistory: async () => [
      { messageId: "message-1", role: "user", content: "Earlier lead turn", isTest: true },
      { messageId: "message-2", role: "assistant", content: "Earlier agent turn", isTest: true },
    ],
    runPreview: async () => engineResult,
    readTurn: async ({ expectedTenant, sessionId: expectedSession, receipt }) => ({
      ...receipt,
      sessionId: expectedSession,
      tenantId: expectedTenant,
      trace: { driverArm: receipt.resolvedDriverArm },
    }),
    resolvedDriverArm: () => "mock",
    effects: { send, calendar, appointment, billable, followup },
    ...overrides,
  };
  return { values, rpc, effects: { send, calendar, appointment, billable, followup } };
}

describe("persisted test-agent repository", () => {
  it("creates a session from server tenant and actor authority only", async () => {
    const deps = dependencies();

    await expect(createTestAgentSession(
      { expectedTenant: tenantId, actorId },
      deps.values,
    )).resolves.toBe(sessionId);
    expect(deps.rpc).toHaveBeenCalledWith("create_test_agent_session", {
      p_expected_tenant: tenantId,
      p_actor_id: actorId,
    });
  });

  it("loads alternating persisted history and returns test ids with a separate mock arm", async () => {
    const deps = dependencies();

    const receipt = await runTestAgentTurn({
      expectedTenant: tenantId,
      actorId,
      sessionId,
      message: "  New synthetic turn  ",
    }, deps.values);

    expect(receipt).toMatchObject({
      state: "persisted",
      sessionId,
      tenantId,
      contactId: "contact-synthetic",
      conversationId: "conversation-synthetic",
      leadMessageId: "lead-message-synthetic",
      agentMessageId: "agent-message-synthetic",
      isTest: true,
      resolvedDriverArm: "mock",
    });
    expect(receipt.history.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "Earlier lead turn" },
      { role: "assistant", content: "Earlier agent turn" },
      { role: "user", content: "New synthetic turn" },
      { role: "assistant", content: "A synthetic persisted reply." },
    ]);
    expect(deps.rpc).toHaveBeenCalledWith("persist_test_agent_turn", expect.objectContaining({
      p_expected_tenant: tenantId,
      p_actor_id: actorId,
      p_session_id: sessionId,
      p_lead_body: "New synthetic turn",
      p_resolved_driver_arm: "mock",
      p_answered_step_key: "credit",
      p_asked_step_key: "goal",
      p_trace: expect.objectContaining({
        moderator: "allowed",
        moderatorClass: "JUDGE",
        moderatorRuleId: null,
        moderatorModelConfigId: "10000000-0000-4000-8000-000000000002",
      }),
    }));
  });

  it("refuses a non-test or consequential receipt instead of reporting a safe turn", async () => {
    const deps = dependencies({
      rpc: async () => [{
        contact_id: "contact-synthetic",
        conversation_id: "conversation-synthetic",
        lead_message_id: "lead-message-synthetic",
        agent_message_id: "agent-message-synthetic",
        resolved_driver_arm: "mock",
        contact_is_test: false,
        conversation_is_test: true,
        lead_is_test: true,
        agent_is_test: true,
        trace_is_test: true,
        step_rows_is_test: true,
        appointment_rows: 1,
        billable_rows: 1,
        followup_rows: 1,
      }],
    });

    await expect(runTestAgentTurn({
      expectedTenant: tenantId,
      actorId,
      sessionId,
      message: "Synthetic turn",
    }, deps.values)).rejects.toThrow("TEST_AGENT_TEST_INHERITANCE_INVALID");
  });

  it("keeps booking-shaped engine output away from every effect port", async () => {
    const deps = dependencies({
      runPreview: async () => ({
        ...engineResult,
        response: {
          ...engineResult.response,
          booking: {
            id: "test-booking-intent",
            startAt: "2026-08-19T14:00:00.000Z",
            timezone: "America/New_York",
          },
        },
      }),
    });

    await expect(runTestAgentTurn({
      expectedTenant: tenantId,
      actorId,
      sessionId,
      message: "Synthetic booking request",
    }, deps.values)).resolves.toMatchObject({ turn: { decision: "BOOK" } });
    for (const effect of Object.values(deps.effects)) expect(effect).not.toHaveBeenCalled();
  });
});

const IMPORT_PATTERN = /(?:\b(?:import|export)\s[\s\S]*?\sfrom\s*|\bimport\s*\()\s*["']([^"']+)["']/g;

function localModule(fromFile: string, specifier: string) {
  if (!specifier.startsWith("@/") && !specifier.startsWith(".")) return null;
  const base = specifier.startsWith("@/")
    ? resolve(process.cwd(), "src", specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  const candidates = extname(base)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`TEST_AGENT_IMPORT_UNREADABLE:${specifier}`);
  return found;
}

function importClosure(roots: readonly string[]) {
  const pending = roots.map((root) => resolve(process.cwd(), root));
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      throw new Error(`TEST_AGENT_IMPORT_UNREADABLE:${file}`);
    }
    visited.add(file);
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const imported = localModule(file, match[1]);
      if (imported) pending.push(imported);
    }
  }
  return [...visited];
}

describe("test-agent effect import boundary", () => {
  it("keeps the repository and live route transitively outside send, booking, and billable modules", () => {
    const closure = importClosure([
      "src/lib/repositories/test-agent.ts",
      "src/app/api/agent/route.ts",
    ]);
    const forbidden = closure.filter((file) =>
      file.includes("/src/lib/sends/") ||
      file.includes("/src/lib/booking/") ||
      file.endsWith("/src/lib/billing/allowances.ts") ||
      file.endsWith("/src/lib/repositories/billing.ts"),
    );

    expect(forbidden).toEqual([]);
  });
});
