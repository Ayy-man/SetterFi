/**
 * Source-locked eval-case promotion with exact case and registry-backed audit read-back.
 *
 * The route supplies only source ids and confirmed redacted material. This repository derives the
 * source tenant from the persisted conversation, lets one SQL transaction write case plus audit,
 * and refuses success unless both rows and the action registry read back exactly.
 */

import { createHash } from "node:crypto";

import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import {
  assertPromotionRedacted,
  EVAL_PROMOTION_SUITES,
  type EvalPromotionSuite,
  type RedactedEvalTurn,
  type RedactionManifest,
} from "@/lib/evals/redaction";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const ACTION_KEY = "eval.case.promoted" as const;

export type EvalPromotionInput = {
  actorId: string;
  conversationId: string;
  messageId: string;
  contactId: string;
  redactedTurns: readonly RedactedEvalTurn[];
  expectation: Readonly<Record<string, unknown>>;
  suite: EvalPromotionSuite;
  redactionManifest: RedactionManifest;
  sourceHash: string;
  confirmedRedactedHash: string;
  notes: string;
};

type PromotedEvalCaseRead = {
  id: string;
  category: "qualification" | "voice";
  suite: EvalPromotionSuite;
  kind: "engine";
  sourceTenantId: string;
  sourceConversationId: string;
  sourceMessageId: string;
  sourceContactId: string;
  promotedBy: string;
  sourceHash: string;
  confirmedRedactedHash: string;
  promotionAuditId: string;
};

type PromotionAuditRead = {
  id: string;
  action: string;
  actorId: string | null;
  targetType: string | null;
  targetId: string | null;
  payload: Readonly<Record<string, unknown>>;
};

type PromotionActionRead = {
  key: string;
  microcopy: string;
  ariaLabel: string;
};

export type EvalPromotionDependencies = {
  loadSourceTenant(conversationId: string): Promise<string | null>;
  rpc(args: Record<string, unknown>): Promise<unknown>;
  loadCase(evalCaseId: string): Promise<PromotedEvalCaseRead | null>;
  loadAudit(auditId: string): Promise<PromotionAuditRead | null>;
  loadAction(actionKey: string): Promise<PromotionActionRead | null>;
};

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function hash(value: string, code: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(code);
  return value;
}

function jsonbKeyOrder(left: string, right: string) {
  return left.length - right.length || left.localeCompare(right, "en", { sensitivity: "variant" });
}

/** Matches PostgreSQL jsonb text output used by app.phase2_json_hash. */
export function jsonbText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(", ")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort(jsonbKeyOrder)
      .map((key) => `${JSON.stringify(key)}: ${jsonbText(row[key])}`).join(", ")}}`;
  }
  throw new Error("EVAL_PROMOTION_JSON_INVALID");
}

export function promotionJsonHash(value: unknown) {
  return createHash("sha256").update(jsonbText(value)).digest("hex");
}

function categoryFor(suite: EvalPromotionSuite) {
  return suite === "qualification_accuracy" ? "qualification" as const : "voice" as const;
}

function rpcReceipt(value: unknown) {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] ||
    typeof value[0] !== "object" || Array.isArray(value[0])) {
    throw new Error("EVAL_PROMOTION_RECEIPT_INVALID");
  }
  const row = value[0] as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "audit_id,eval_case_id") {
    throw new Error("EVAL_PROMOTION_RECEIPT_INVALID");
  }
  return {
    evalCaseId: required(String(row.eval_case_id ?? ""), "EVAL_PROMOTION_RECEIPT_INVALID"),
    auditId: required(String(row.audit_id ?? ""), "EVAL_PROMOTION_RECEIPT_INVALID"),
  };
}

function expectation(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new Error("EVAL_PROMOTION_EXPECTATION_INVALID");
  }
  return value as Readonly<Record<string, unknown>>;
}

async function liveDependencies(): Promise<EvalPromotionDependencies> {
  const client = createSupabaseServiceClient();
  return {
    loadSourceTenant: async (conversationId) => {
      const { data, error } = await client.from("conversations")
        .select("tenant_id").eq("id", conversationId).maybeSingle();
      return error || !data ? null : data.tenant_id;
    },
    rpc: async (args) => {
      const { data, error } = await client.rpc("promote_eval_case", args);
      if (error) throw new Error("EVAL_PROMOTION_REFUSED");
      return data;
    },
    loadCase: async (evalCaseId) => {
      const { data, error } = await client.from("eval_cases").select(
        "id,category,suite,kind,source_tenant_id,source_conversation_id,source_message_id,source_contact_id,promoted_by,source_hash,confirmed_redacted_hash,promotion_audit_id",
      ).eq("id", evalCaseId).maybeSingle();
      if (error || !data) return null;
      return {
        id: data.id,
        category: data.category as PromotedEvalCaseRead["category"],
        suite: data.suite as EvalPromotionSuite,
        kind: data.kind as "engine",
        sourceTenantId: data.source_tenant_id,
        sourceConversationId: data.source_conversation_id,
        sourceMessageId: data.source_message_id,
        sourceContactId: data.source_contact_id,
        promotedBy: data.promoted_by,
        sourceHash: data.source_hash,
        confirmedRedactedHash: data.confirmed_redacted_hash,
        promotionAuditId: String(data.promotion_audit_id),
      };
    },
    loadAudit: async (auditId) => {
      const { data, error } = await client.from("audit_log").select(
        "id,action,actor_id,target_type,target_id,payload",
      ).eq("id", auditId).maybeSingle();
      if (error || !data) return null;
      return {
        id: String(data.id),
        action: data.action,
        actorId: data.actor_id,
        targetType: data.target_type,
        targetId: data.target_id,
        payload: data.payload as Readonly<Record<string, unknown>>,
      };
    },
    loadAction: async (actionKey) => {
      const { data, error } = await client.from("audit_actions")
        .select("key,microcopy,aria_label").eq("key", actionKey).maybeSingle();
      return error || !data ? null : {
        key: data.key,
        microcopy: data.microcopy,
        ariaLabel: data.aria_label,
      };
    },
  };
}

export async function promoteEvalCase(
  input: EvalPromotionInput,
  dependencies?: EvalPromotionDependencies,
) {
  const actorId = required(input.actorId, "EVAL_PROMOTION_ACTOR_REQUIRED");
  const conversationId = required(input.conversationId, "EVAL_PROMOTION_SOURCE_REQUIRED");
  const messageId = required(input.messageId, "EVAL_PROMOTION_SOURCE_REQUIRED");
  const contactId = required(input.contactId, "EVAL_PROMOTION_SOURCE_REQUIRED");
  const notes = required(input.notes, "EVAL_PROMOTION_NOTES_REQUIRED");
  if (!EVAL_PROMOTION_SUITES.includes(input.suite)) throw new Error("EVAL_PROMOTION_SUITE_INVALID");
  const sourceHash = hash(input.sourceHash, "EVAL_PROMOTION_SOURCE_HASH_INVALID");
  const confirmedRedactedHash = hash(
    input.confirmedRedactedHash,
    "EVAL_PROMOTION_REDACTED_HASH_INVALID",
  );
  assertPromotionRedacted(input.redactedTurns, input.redactionManifest);
  if (promotionJsonHash(input.redactedTurns) !== confirmedRedactedHash) {
    throw new Error("EVAL_PROMOTION_UNCONFIRMED_EDIT");
  }
  const parsedExpectation = expectation(input.expectation);
  const deps = dependencies ?? (await liveDependencies());
  const expectedTenant = await deps.loadSourceTenant(conversationId);
  if (!expectedTenant) throw new Error("EVAL_PROMOTION_SOURCE_NOT_FOUND");
  const receipt = rpcReceipt(await deps.rpc({
    p_actor_id: actorId,
    p_expected_tenant: expectedTenant,
    p_conversation_id: conversationId,
    p_message_id: messageId,
    p_contact_id: contactId,
    p_redacted_turns: input.redactedTurns,
    p_expectation: parsedExpectation,
    p_suite: input.suite,
    p_redaction_manifest: input.redactionManifest,
    p_source_hash: sourceHash,
    p_confirmed_redacted_hash: confirmedRedactedHash,
    p_notes: notes,
  }));
  const [persistedCase, audit, action] = await Promise.all([
    deps.loadCase(receipt.evalCaseId),
    deps.loadAudit(receipt.auditId),
    deps.loadAction(ACTION_KEY),
  ]);
  const expectedAction = AUDIT_ACTIONS[ACTION_KEY];
  if (!persistedCase || persistedCase.id !== receipt.evalCaseId ||
    persistedCase.category !== categoryFor(input.suite) || persistedCase.suite !== input.suite ||
    persistedCase.kind !== "engine" || persistedCase.sourceTenantId !== expectedTenant ||
    persistedCase.sourceConversationId !== conversationId || persistedCase.sourceMessageId !== messageId ||
    persistedCase.sourceContactId !== contactId || persistedCase.promotedBy !== actorId ||
    persistedCase.sourceHash !== sourceHash ||
    persistedCase.confirmedRedactedHash !== confirmedRedactedHash ||
    persistedCase.promotionAuditId !== receipt.auditId || !audit || audit.id !== receipt.auditId ||
    audit.action !== ACTION_KEY || audit.actorId !== actorId || audit.targetType !== "eval_case" ||
    audit.targetId !== receipt.evalCaseId || !action || action.key !== ACTION_KEY ||
    action.microcopy !== expectedAction.microcopy || action.ariaLabel !== expectedAction.ariaLabel) {
    throw new Error("EVAL_PROMOTION_READBACK_MISMATCH");
  }
  const auditPayload = JSON.stringify(audit.payload);
  if (auditPayload.includes(JSON.stringify(input.redactedTurns)) ||
    auditPayload.includes(JSON.stringify(input.redactionManifest))) {
    throw new Error("EVAL_PROMOTION_AUDIT_PAYLOAD_INVALID");
  }
  return {
    state: "promoted" as const,
    evalCaseId: receipt.evalCaseId,
    auditId: receipt.auditId,
    actionKey: ACTION_KEY,
  };
}
