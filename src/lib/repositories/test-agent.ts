/**
 * Persisted Meet Your Agent sessions with no real-world effect ports.
 *
 * The database owns tenant, actor, test inheritance, history, and receipts. This repository runs
 * only the side-effect-free engine preview, then accepts success after every persisted row reads
 * back as test data and the appointment, billable, and follow-up counts remain zero.
 */

import { pickPlatformDemoTenant } from "@/lib/demo-tenant";
import { driverSelection, type DriverSelection } from "@/lib/env-contract";
import type { EngineTurnResult } from "@/lib/engine/types";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  runLivePreviewTurn,
  type LivePreviewHistoryEntry,
} from "@/lib/webhooks/live-preview";

const HISTORY_LIMIT = 12;

export type TestAgentActor = {
  userId: string;
  role: "owner" | "admin" | "success" | "coach" | "coach_member";
  tenantId: string | null;
};

export type TestAgentHistoryEntry = LivePreviewHistoryEntry & {
  messageId: string;
  isTest: true;
};

type TestAgentSessionRead = {
  id: string;
  tenantId: string;
  startedBy: string;
  closedAt: string | null;
  conversation: {
    id: string;
    state: "agent";
    currentStep: string | null;
    currentStepAsks: number;
    disclosurePending: boolean;
    isTest: true;
  } | null;
};

type TestAgentRpcReceipt = {
  contactId: string;
  conversationId: string;
  leadMessageId: string;
  agentMessageId: string;
  resolvedDriverArm: DriverSelection;
  contactIsTest: true;
  conversationIsTest: true;
  leadIsTest: true;
  agentIsTest: true;
  traceIsTest: true;
  stepRowsIsTest: true;
  appointmentRows: 0;
  billableRows: 0;
  followupRows: 0;
};

export type TestAgentTurnReadback = TestAgentRpcReceipt & {
  sessionId: string;
  tenantId: string;
  trace: Readonly<Record<string, unknown>>;
};

export type TestAgentEffectSpies = {
  send(): Promise<never> | never;
  calendar(): Promise<never> | never;
  appointment(): Promise<never> | never;
  billable(): Promise<never> | never;
  followup(): Promise<never> | never;
};

export type TestAgentDependencies = {
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  loadSession(expectedTenant: string, sessionId: string): Promise<TestAgentSessionRead | null>;
  loadHistory(conversationId: string): Promise<readonly TestAgentHistoryEntry[]>;
  runPreview(input: Parameters<typeof runLivePreviewTurn>[0]): Promise<EngineTurnResult>;
  readTurn(input: {
    expectedTenant: string;
    sessionId: string;
    receipt: TestAgentRpcReceipt;
  }): Promise<TestAgentTurnReadback | null>;
  resolvedDriverArm(): DriverSelection;
  effects: TestAgentEffectSpies;
};

export type TestAgentTurnReceipt = {
  state: "persisted";
  sessionId: string;
  tenantId: string;
  contactId: string;
  conversationId: string;
  leadMessageId: string;
  agentMessageId: string;
  isTest: true;
  resolvedDriverArm: DriverSelection;
  history: readonly TestAgentHistoryEntry[];
  turn: {
    reply: string;
    state: EngineTurnResult["response"]["state"];
    booking: EngineTurnResult["response"]["booking"];
    decision: "BOOK" | "SOFT_DQ" | "HARD_DQ" | "NONE";
    stage: "qualify" | "book" | "guardrail" | "closing";
    grounded: boolean;
    ruleFired: string | null;
    model: string | null;
    tokenCount: number | null;
  };
  trace: {
    promptHash: string | null;
    ruleFired: string | null;
    moderator: EngineTurnResult["trace"]["moderator"];
    sourceIds: readonly string[];
    checks: readonly { class: string; passed: boolean; ruleIds: readonly string[] }[];
  };
};

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, code: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], code: string) {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error(code);
}

function parseRpcReceipt(value: unknown, expectedArm: DriverSelection): TestAgentRpcReceipt {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("TEST_AGENT_RECEIPT_INVALID");
  const row = record(value[0], "TEST_AGENT_RECEIPT_INVALID");
  exactKeys(row, [
    "agent_is_test",
    "agent_message_id",
    "appointment_rows",
    "billable_rows",
    "contact_id",
    "contact_is_test",
    "conversation_id",
    "conversation_is_test",
    "followup_rows",
    "lead_is_test",
    "lead_message_id",
    "resolved_driver_arm",
    "step_rows_is_test",
    "trace_is_test",
  ], "TEST_AGENT_RECEIPT_INVALID");
  const flags = [
    row.contact_is_test,
    row.conversation_is_test,
    row.lead_is_test,
    row.agent_is_test,
    row.trace_is_test,
    row.step_rows_is_test,
  ];
  if (flags.some((flag) => flag !== true)) throw new Error("TEST_AGENT_TEST_INHERITANCE_INVALID");
  if (row.appointment_rows !== 0 || row.billable_rows !== 0 || row.followup_rows !== 0) {
    throw new Error("TEST_AGENT_SIDE_EFFECT_DETECTED");
  }
  if (row.resolved_driver_arm !== expectedArm) throw new Error("TEST_AGENT_DRIVER_ARM_MISMATCH");
  return {
    contactId: requiredString(row.contact_id, "TEST_AGENT_RECEIPT_INVALID"),
    conversationId: requiredString(row.conversation_id, "TEST_AGENT_RECEIPT_INVALID"),
    leadMessageId: requiredString(row.lead_message_id, "TEST_AGENT_RECEIPT_INVALID"),
    agentMessageId: requiredString(row.agent_message_id, "TEST_AGENT_RECEIPT_INVALID"),
    resolvedDriverArm: expectedArm,
    contactIsTest: true,
    conversationIsTest: true,
    leadIsTest: true,
    agentIsTest: true,
    traceIsTest: true,
    stepRowsIsTest: true,
    appointmentRows: 0,
    billableRows: 0,
    followupRows: 0,
  };
}

function assertAlternatingHistory(history: readonly TestAgentHistoryEntry[]) {
  if (history.length > HISTORY_LIMIT) throw new Error("TEST_AGENT_HISTORY_UNBOUNDED");
  for (const [index, entry] of history.entries()) {
    if (entry.isTest !== true || !entry.messageId.trim() || !entry.content.trim()) {
      throw new Error("TEST_AGENT_HISTORY_INVALID");
    }
    const expectedRole = index % 2 === 0 ? "user" : "assistant";
    if (entry.role !== expectedRole) throw new Error("TEST_AGENT_HISTORY_NOT_ALTERNATING");
  }
}

function stepKeys(result: EngineTurnResult) {
  const answered = result.commands.find(
    (command) => command.kind === "advance_step" && command.valuePersisted,
  );
  const reasked = result.commands.find((command) => command.kind === "increment_step_asks");
  return {
    answered: answered?.kind === "advance_step" ? answered.stepId : null,
    asked: reasked?.kind === "increment_step_asks" ? reasked.stepId : null,
  };
}

function boundedTrace(result: EngineTurnResult) {
  return {
    promptHash: result.trace.promptHash,
    ruleFired: result.trace.ruleFired,
    moderator: result.trace.moderator,
    sourceIds: result.trace.sources.slice(0, 6).map((source) => source.entryId),
    checks: result.trace.checks.slice(0, 8).map((check) => ({
      class: check.class,
      passed: check.passed,
      ruleIds: check.ruleIds.slice(0, 8),
    })),
  };
}

function decision(result: EngineTurnResult): TestAgentTurnReceipt["turn"]["decision"] {
  if (result.response.booking) return "BOOK";
  if (result.commands.some((command) => command.kind === "record_hard_dq")) return "HARD_DQ";
  if (result.response.state === "nurture") return "SOFT_DQ";
  return "NONE";
}

function stage(result: EngineTurnResult): TestAgentTurnReceipt["turn"]["stage"] {
  if (result.response.booking) return "book";
  if (result.trace.screen.verdict === "held") return "guardrail";
  if (result.response.state === "closed") return "closing";
  return "qualify";
}

async function liveDependencies(): Promise<TestAgentDependencies> {
  const client = createSupabaseServiceClient();
  const forbiddenEffect = () => {
    throw new Error("TEST_AGENT_EFFECT_PORT_FORBIDDEN");
  };
  return {
    rpc: async (name, args) => {
      const { data, error } = await client.rpc(name, args);
      if (error) throw new Error(`${name.toUpperCase()}_FAILED`);
      return data;
    },
    loadSession: async (expectedTenant, sessionId) => {
      const { data: session, error: sessionError } = await client
        .from("test_agent_sessions")
        .select("id,tenant_id,started_by,closed_at")
        .eq("id", sessionId)
        .eq("tenant_id", expectedTenant)
        .maybeSingle();
      if (sessionError) throw new Error("TEST_AGENT_SESSION_READ_FAILED");
      if (!session) return null;
      const { data: contact, error: contactError } = await client
        .from("contacts")
        .select("id")
        .eq("test_session_id", sessionId)
        .maybeSingle();
      if (contactError) throw new Error("TEST_AGENT_CONTACT_READ_FAILED");
      if (!contact) {
        return {
          id: session.id,
          tenantId: session.tenant_id,
          startedBy: session.started_by,
          closedAt: session.closed_at,
          conversation: null,
        };
      }
      const { data: conversation, error: conversationError } = await client
        .from("conversations")
        .select("id,status,current_step,current_step_asks,disclosure_pending,is_test")
        .eq("contact_id", contact.id)
        .maybeSingle();
      if (conversationError) throw new Error("TEST_AGENT_CONVERSATION_READ_FAILED");
      if (!conversation) throw new Error("TEST_AGENT_CONVERSATION_READ_FAILED");
      if (conversation.status !== "agent" || conversation.is_test !== true) {
        throw new Error("TEST_AGENT_CONVERSATION_INVALID");
      }
      return {
        id: session.id,
        tenantId: session.tenant_id,
        startedBy: session.started_by,
        closedAt: session.closed_at,
        conversation: {
          id: conversation.id,
          state: "agent",
          currentStep: conversation.current_step,
          currentStepAsks: conversation.current_step_asks,
          disclosurePending: conversation.disclosure_pending,
          isTest: true,
        },
      };
    },
    loadHistory: async (conversationId) => {
      const { data, error } = await client
        .from("messages")
        .select("id,direction,author,body,is_test,created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(HISTORY_LIMIT);
      if (error) throw new Error("TEST_AGENT_HISTORY_READ_FAILED");
      return (data ?? []).reverse().map((row) => ({
        messageId: row.id,
        role: row.direction === "in" && row.author === "lead" ? "user" as const : "assistant" as const,
        content: row.body,
        isTest: row.is_test as true,
      }));
    },
    runPreview: runLivePreviewTurn,
    readTurn: async ({ expectedTenant, sessionId, receipt }) => {
      const { data: contact, error: contactError } = await client
        .from("contacts")
        .select("id,tenant_id,test_session_id,is_test")
        .eq("id", receipt.contactId)
        .single();
      const { data: conversation, error: conversationError } = await client
        .from("conversations")
        .select("id,tenant_id,contact_id,is_test")
        .eq("id", receipt.conversationId)
        .single();
      const { data: messages, error: messagesError } = await client
        .from("messages")
        .select("id,tenant_id,conversation_id,is_test")
        .in("id", [receipt.leadMessageId, receipt.agentMessageId]);
      const { data: trace, error: traceError } = await client
        .from("message_traces")
        .select("message_id,tenant_id,trace")
        .eq("message_id", receipt.agentMessageId)
        .single();
      if (contactError || conversationError || messagesError || traceError || !contact ||
        !conversation || !trace || messages?.length !== 2) return null;
      if (contact.tenant_id !== expectedTenant || contact.test_session_id !== sessionId ||
        contact.is_test !== true || conversation.tenant_id !== expectedTenant ||
        conversation.contact_id !== contact.id || conversation.is_test !== true ||
        messages.some((message) => message.tenant_id !== expectedTenant ||
          message.conversation_id !== conversation.id || message.is_test !== true) ||
        trace.tenant_id !== expectedTenant ||
        record(trace.trace, "TEST_AGENT_TRACE_READBACK_INVALID").driverArm !== receipt.resolvedDriverArm) {
        return null;
      }
      return {
        ...receipt,
        sessionId,
        tenantId: expectedTenant,
        trace: trace.trace as Readonly<Record<string, unknown>>,
      };
    },
    resolvedDriverArm: () => driverSelection("openrouter", "SETTERFI_OPENROUTER_DRIVER"),
    effects: {
      send: forbiddenEffect,
      calendar: forbiddenEffect,
      appointment: forbiddenEffect,
      billable: forbiddenEffect,
      followup: forbiddenEffect,
    },
  };
}

export async function createTestAgentSession(
  input: { expectedTenant: string; actorId: string },
  dependencies?: Pick<TestAgentDependencies, "rpc">,
) {
  const expectedTenant = requiredString(input.expectedTenant, "TEST_AGENT_TENANT_REQUIRED");
  const actorId = requiredString(input.actorId, "TEST_AGENT_ACTOR_REQUIRED");
  const deps = dependencies ?? (await liveDependencies());
  return requiredString(await deps.rpc("create_test_agent_session", {
    p_expected_tenant: expectedTenant,
    p_actor_id: actorId,
  }), "TEST_AGENT_SESSION_RECEIPT_INVALID");
}

export async function runTestAgentTurn(
  input: {
    expectedTenant: string;
    actorId: string;
    sessionId: string;
    message: string;
  },
  dependencies?: TestAgentDependencies,
): Promise<TestAgentTurnReceipt> {
  const expectedTenant = requiredString(input.expectedTenant, "TEST_AGENT_TENANT_REQUIRED");
  const actorId = requiredString(input.actorId, "TEST_AGENT_ACTOR_REQUIRED");
  const sessionId = requiredString(input.sessionId, "TEST_AGENT_SESSION_REQUIRED");
  const message = requiredString(input.message, "TEST_AGENT_MESSAGE_REQUIRED");
  if (message.length > 800) throw new Error("TEST_AGENT_MESSAGE_INVALID");
  const deps = dependencies ?? (await liveDependencies());
  const session = await deps.loadSession(expectedTenant, sessionId);
  if (!session || session.id !== sessionId || session.tenantId !== expectedTenant ||
    session.startedBy !== actorId || session.closedAt !== null) {
    throw new Error("TEST_AGENT_SESSION_MISMATCH");
  }
  const history = session.conversation ? await deps.loadHistory(session.conversation.id) : [];
  assertAlternatingHistory(history);
  const resolvedDriverArm = deps.resolvedDriverArm();
  const result = await deps.runPreview({
    tenantId: expectedTenant,
    message,
    history: history.map(({ role, content }) => ({ role, content })),
    mode: "test",
    channel: "sms",
    ...(session.conversation ? { conversation: {
      state: "agent" as const,
      currentStep: session.conversation.currentStep,
      currentStepAsks: session.conversation.currentStepAsks,
      disclosurePending: session.conversation.disclosurePending,
    } } : {}),
  });
  const keys = stepKeys(result);
  const trace = boundedTrace(result);
  const receipt = parseRpcReceipt(await deps.rpc("persist_test_agent_turn", {
    p_expected_tenant: expectedTenant,
    p_actor_id: actorId,
    p_session_id: sessionId,
    p_lead_body: message,
    p_agent_body: result.response.reply,
    p_trace: {
      ...trace,
      model: result.trace.model,
      params: {},
      outcome: result.trace.screen.verdict === "held" ? "held" : "successful",
    },
    p_resolved_driver_arm: resolvedDriverArm,
    p_answered_step_key: keys.answered,
    p_asked_step_key: keys.asked,
  }), resolvedDriverArm);
  const persisted = await deps.readTurn({ expectedTenant, sessionId, receipt });
  if (!persisted) throw new Error("TEST_AGENT_READBACK_MISMATCH");
  const persistedHistory: TestAgentHistoryEntry[] = [
    ...history,
    { messageId: persisted.leadMessageId, role: "user", content: message, isTest: true },
    { messageId: persisted.agentMessageId, role: "assistant", content: result.response.reply, isTest: true },
  ];
  return {
    state: "persisted",
    sessionId,
    tenantId: expectedTenant,
    contactId: persisted.contactId,
    conversationId: persisted.conversationId,
    leadMessageId: persisted.leadMessageId,
    agentMessageId: persisted.agentMessageId,
    isTest: true,
    resolvedDriverArm: persisted.resolvedDriverArm,
    history: persistedHistory.slice(-HISTORY_LIMIT),
    turn: {
      reply: result.response.reply,
      state: result.response.state,
      booking: result.response.booking,
      decision: decision(result),
      stage: stage(result),
      grounded: result.trace.sources.length > 0,
      ruleFired: result.trace.ruleFired,
      model: result.trace.model,
      tokenCount: result.trace.usage?.totalTokens ?? null,
    },
    trace,
  };
}

export async function resolveTestAgentTenant(actor: TestAgentActor) {
  if (actor.role === "coach" || actor.role === "coach_member") {
    return requiredString(actor.tenantId, "TEST_AGENT_TENANT_REQUIRED");
  }
  const client = createSupabaseServiceClient();
  const { data, error } = await client.from("tenants").select("id, created_at").eq("is_demo", true);
  if (error) throw new Error("TEST_AGENT_PLATFORM_TENANT_UNAVAILABLE");
  // More than one demo tenant is the normal state of a project that has been seeded more than
  // once, not a misconfiguration, so the choice is made rather than refused. See demo-tenant.ts.
  const tenantId = pickPlatformDemoTenant(data ?? []);
  if (!tenantId) throw new Error("TEST_AGENT_PLATFORM_TENANT_UNAVAILABLE");
  return tenantId;
}
