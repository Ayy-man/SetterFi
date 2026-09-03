/**
 * Tenant-scoped view and mutations for the platform-owned Brain question library.
 *
 * The browser never chooses a tenant or an actor for the database. Callers pass the server-verified
 * route claims through this boundary; the RPC then re-verifies the actor and tenant before reading
 * or writing the sparse tenant overlay.
 */

import type { RouteActor } from "@/lib/auth/actors";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type CoachQuestionActor = Pick<RouteActor, "userId" | "tenantId">;

export type CoachQuestion = {
  id: string;
  text: string;
  tag: string;
  enabled: boolean;
  position: number;
};

export type CoachQuestionReadSource = (actorId: string, tenantId: string) => Promise<unknown>;

type CoachQuestionWriteSource = {
  reorder(actorId: string, tenantId: string, questionIds: readonly string[]): Promise<unknown>;
  toggle(actorId: string, tenantId: string, questionId: string, enabled: boolean): Promise<unknown>;
};

function required(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function readActor(actor: CoachQuestionActor) {
  return {
    actorId: required(actor?.userId, "COACH_QUESTION_ACTOR_REQUIRED"),
    tenantId: required(actor?.tenantId, "EXPECTED_TENANT_REQUIRED"),
  };
}

function readPosition(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error("COACH_QUESTION_SNAPSHOT_INVALID");
  }
  return value as number;
}

function parseQuestions(value: unknown, tenantId: string): CoachQuestion[] {
  const snapshot = record(value, "COACH_QUESTION_SNAPSHOT_INVALID");
  if (snapshot.tenantId !== tenantId || !Array.isArray(snapshot.questions)) {
    throw new Error(snapshot.tenantId === tenantId
      ? "COACH_QUESTION_SNAPSHOT_INVALID"
      : "COACH_QUESTION_SCOPE_MISMATCH");
  }
  const questions = snapshot.questions.map((value) => {
    const row = record(value, "COACH_QUESTION_SNAPSHOT_INVALID");
    if (typeof row.enabled !== "boolean") throw new Error("COACH_QUESTION_SNAPSHOT_INVALID");
    return {
      id: required(row.id, "COACH_QUESTION_SNAPSHOT_INVALID"),
      text: required(row.text, "COACH_QUESTION_SNAPSHOT_INVALID"),
      tag: required(row.tag, "COACH_QUESTION_SNAPSHOT_INVALID"),
      enabled: row.enabled,
      position: readPosition(row.position),
    };
  });
  if (new Set(questions.map((question) => question.id)).size !== questions.length
    || questions.some((question, index) => index > 0
      && question.position <= questions[index - 1].position)) {
    throw new Error("COACH_QUESTION_SNAPSHOT_INVALID");
  }
  return questions;
}

async function liveRead(actorId: string, tenantId: string): Promise<unknown> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("read_coach_questions_for_actor", {
    p_actor_id: actorId,
    p_expected_tenant: tenantId,
  });
  if (error) throw new Error("COACH_QUESTION_READ_FAILED");
  return data;
}

function auditId(value: unknown, code: string): string {
  const row = Array.isArray(value) ? value[0] : value;
  const recordValue = record(row, code);
  if (typeof recordValue.audit_id !== "string" && typeof recordValue.audit_id !== "number") {
    throw new Error(code);
  }
  return String(recordValue.audit_id);
}

function liveWrites(): CoachQuestionWriteSource {
  const client = createSupabaseServiceClient();
  return {
    reorder: async (actorId, tenantId, questionIds) => {
      const { data, error } = await client.rpc("reorder_coach_questions", {
        p_actor_id: actorId,
        p_expected_tenant: tenantId,
        p_question_ids: [...questionIds],
      });
      if (error) throw new Error("COACH_QUESTION_REORDER_FAILED");
      return data;
    },
    toggle: async (actorId, tenantId, questionId, enabled) => {
      const { data, error } = await client.rpc("set_coach_question_enabled", {
        p_actor_id: actorId,
        p_expected_tenant: tenantId,
        p_question_id: questionId,
        p_enabled: enabled,
      });
      if (error) throw new Error("COACH_QUESTION_TOGGLE_FAILED");
      return data;
    },
  };
}

/** Reads platform defaults merged with this tenant's enabled and order overrides. */
export async function readCoachQuestions(
  actor: CoachQuestionActor,
  source: CoachQuestionReadSource = liveRead,
): Promise<readonly CoachQuestion[]> {
  const { actorId, tenantId } = readActor(actor);
  return parseQuestions(await source(actorId, tenantId), tenantId);
}

/** Persists a complete order, then reloads the canonical merged series. */
export async function reorderCoachQuestions(
  actor: CoachQuestionActor,
  questionIds: readonly string[],
  dependencies: { read?: CoachQuestionReadSource; write?: CoachQuestionWriteSource } = {},
): Promise<{ questions: readonly CoachQuestion[]; auditId: string }> {
  const { actorId, tenantId } = readActor(actor);
  const ids = questionIds.map((id) => required(id, "COACH_QUESTION_ID_REQUIRED"));
  if (new Set(ids).size !== ids.length) throw new Error("COACH_QUESTION_ORDER_INVALID");
  const write = dependencies.write ?? liveWrites();
  const writtenAuditId = auditId(
    await write.reorder(actorId, tenantId, ids),
    "COACH_QUESTION_REORDER_RECEIPT_INVALID",
  );
  const questions = await readCoachQuestions(actor, dependencies.read ?? liveRead);
  if (questions.map((question) => question.id).join("\u0000") !== ids.join("\u0000")) {
    throw new Error("COACH_QUESTION_REORDER_READBACK_INVALID");
  }
  return { questions, auditId: writtenAuditId };
}

/** Changes one tenant override, then reloads the canonical merged series. */
export async function setCoachQuestionEnabled(
  actor: CoachQuestionActor,
  questionId: string,
  enabled: boolean,
  dependencies: { read?: CoachQuestionReadSource; write?: CoachQuestionWriteSource } = {},
): Promise<{ questions: readonly CoachQuestion[]; auditId: string }> {
  const { actorId, tenantId } = readActor(actor);
  if (typeof enabled !== "boolean") throw new Error("COACH_QUESTION_ENABLED_INVALID");
  const id = required(questionId, "COACH_QUESTION_ID_REQUIRED");
  const write = dependencies.write ?? liveWrites();
  const writtenAuditId = auditId(
    await write.toggle(actorId, tenantId, id, enabled),
    "COACH_QUESTION_TOGGLE_RECEIPT_INVALID",
  );
  const questions = await readCoachQuestions(actor, dependencies.read ?? liveRead);
  const updated = questions.find((question) => question.id === id);
  if (!updated || updated.enabled !== enabled) throw new Error("COACH_QUESTION_TOGGLE_READBACK_INVALID");
  return { questions, auditId: writtenAuditId };
}
