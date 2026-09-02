import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { PROVISIONING_STEPS, type ProvisioningStep } from "@/lib/onboarding/contracts";

export type CommandState = "applied" | "intent_recorded" | "recorded" | "undone";

type CommandReceipt<Action extends string, State extends CommandState> = {
  commandId: string;
  tenantId: string;
  action: Action;
  state: State;
  tenantStatus: string | null;
  auditId: number;
  undoAvailable: boolean;
};

type ClientAppliedAction = "client_pause" | "client_resume" | "client_archive";
type ClientIntentAction = "client_resend_signup" | "client_nudge_onboarding";

export type ClientCommandReceipt =
  | CommandReceipt<ClientAppliedAction, "applied">
  | CommandReceipt<ClientIntentAction, "intent_recorded">
  | CommandReceipt<"client_note", "recorded">;

type ProvisioningAppliedAction = "provisioning_reassign";
type ProvisioningIntentAction = "provisioning_nudge" | "provisioning_resend";

export type ProvisioningCommandReceipt = (
  | CommandReceipt<ProvisioningAppliedAction, "applied">
  | CommandReceipt<ProvisioningIntentAction, "intent_recorded">
) & {
  step: ProvisioningStep | null;
  platformOwnerId: string | null;
};

export type OperatorCommandUndoReceipt = CommandReceipt<
  ClientAppliedAction | ProvisioningAppliedAction,
  "undone"
> & {
  platformOwnerId: string | null;
};

function row(data: unknown, code: string): Record<string, unknown> {
  if (!Array.isArray(data) || data.length !== 1 || !data[0] || typeof data[0] !== "object") {
    throw new Error(code);
  }
  return data[0] as Record<string, unknown>;
}

function string(value: unknown, code: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
}

function nullableString(value: unknown, code: string) {
  if (value === null) return null;
  return string(value, code);
}

function state(value: unknown, code: string): CommandState {
  if (value === "applied" || value === "intent_recorded" || value === "recorded" || value === "undone") return value;
  throw new Error(code);
}

function isClientAppliedAction(value: string): value is ClientAppliedAction {
  return value === "client_pause" || value === "client_resume" || value === "client_archive";
}

function isClientIntentAction(value: string): value is ClientIntentAction {
  return value === "client_resend_signup" || value === "client_nudge_onboarding";
}

function isProvisioningAppliedAction(value: string): value is ProvisioningAppliedAction {
  return value === "provisioning_reassign";
}

function isProvisioningIntentAction(value: string): value is ProvisioningIntentAction {
  return value === "provisioning_nudge" || value === "provisioning_resend";
}

function auditId(value: unknown, code: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(code);
  return parsed;
}

function provisioningStep(value: unknown, code: string): ProvisioningStep | null {
  if (value === null) return null;
  if (typeof value === "string" && PROVISIONING_STEPS.includes(value as ProvisioningStep)) {
    return value as ProvisioningStep;
  }
  throw new Error(code);
}

function receiptBase(value: Record<string, unknown>, code: string) {
  return {
    commandId: string(value.command_id, code),
    tenantId: string(value.tenant_id, code),
    tenantStatus: nullableString(value.tenant_status, code),
    auditId: auditId(value.audit_id, code),
    undoAvailable: value.undo_available === true,
  };
}

function clientReceipt(value: Record<string, unknown>, code: string): ClientCommandReceipt {
  const action = string(value.action, code);
  const commandState = state(value.state, code);
  const base = receiptBase(value, code);
  if (isClientAppliedAction(action) && commandState === "applied") return { ...base, action, state: commandState };
  if (isClientIntentAction(action) && commandState === "intent_recorded") return { ...base, action, state: commandState };
  if (action === "client_note" && commandState === "recorded") return { ...base, action, state: commandState };
  throw new Error(code);
}

function provisioningReceipt(value: Record<string, unknown>, code: string): ProvisioningCommandReceipt {
  const action = string(value.action, code);
  const commandState = state(value.state, code);
  const base = receiptBase(value, code);
  const receipt = {
    ...base,
    step: provisioningStep(value.step_key, code),
    platformOwnerId: nullableString(value.platform_owner_id, code),
  };
  if (isProvisioningAppliedAction(action) && commandState === "applied") return { ...receipt, action, state: commandState };
  if (isProvisioningIntentAction(action) && commandState === "intent_recorded") return { ...receipt, action, state: commandState };
  throw new Error(code);
}

function undoReceipt(value: Record<string, unknown>, code: string): OperatorCommandUndoReceipt {
  const action = string(value.action, code);
  const commandState = state(value.state, code);
  if (commandState !== "undone" || !(isClientAppliedAction(action) || isProvisioningAppliedAction(action))) {
    throw new Error(code);
  }
  return {
    ...receiptBase(value, code),
    action,
    state: commandState,
    platformOwnerId: nullableString(value.platform_owner_id, code),
  };
}

export async function recordClientOperatorCommand(input: {
  expectedTenant: string;
  actorId: string;
  action: "pause" | "resume" | "resend_signup" | "nudge_onboarding" | "archive" | "note";
  reason?: string;
  note?: string;
}): Promise<ClientCommandReceipt> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("record_client_operator_command", {
    p_expected_tenant: input.expectedTenant,
    p_actor_id: input.actorId,
    p_action: input.action,
    p_reason: input.reason ?? null,
    p_note: input.note ?? null,
  });
  if (error) throw new Error("CLIENT_OPERATOR_COMMAND_REFUSED");
  const value = row(data, "CLIENT_OPERATOR_COMMAND_READBACK_INVALID");
  return clientReceipt(value, "CLIENT_OPERATOR_COMMAND_READBACK_INVALID");
}

export async function recordProvisioningOperatorCommand(input: {
  expectedTenant: string;
  step: ProvisioningStep;
  actorId: string;
  action: "nudge" | "resend" | "reassign";
  reason: string;
  assigneeId?: string;
}): Promise<ProvisioningCommandReceipt> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("record_provisioning_operator_command", {
    p_expected_tenant: input.expectedTenant,
    p_step_key: input.step,
    p_actor_id: input.actorId,
    p_action: input.action,
    p_reason: input.reason,
    p_assignee_id: input.assigneeId ?? null,
  });
  if (error) throw new Error("PROVISIONING_OPERATOR_COMMAND_REFUSED");
  const value = row(data, "PROVISIONING_OPERATOR_COMMAND_READBACK_INVALID");
  return provisioningReceipt(value, "PROVISIONING_OPERATOR_COMMAND_READBACK_INVALID");
}

export async function undoOperatorCommand(input: {
  expectedTenant: string;
  commandId: string;
  actorId: string;
  reason: string;
}): Promise<OperatorCommandUndoReceipt> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("undo_platform_operator_command", {
    p_expected_tenant: input.expectedTenant,
    p_command_id: input.commandId,
    p_actor_id: input.actorId,
    p_reason: input.reason,
  });
  if (error) throw new Error("OPERATOR_COMMAND_UNDO_REFUSED");
  const value = row(data, "OPERATOR_COMMAND_UNDO_READBACK_INVALID");
  return undoReceipt(value, "OPERATOR_COMMAND_UNDO_READBACK_INVALID");
}
