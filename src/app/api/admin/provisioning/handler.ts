import {
  loadPlatformActor,
  type PlatformActor,
} from "@/lib/auth/actors";
import { hasImpersonationMarker, PLATFORM_ROLES, type UserRole } from "@/lib/auth/claims";
import { phase5Live } from "@/lib/env-contract";
import { PROVISIONING_STEPS, type ProvisioningStep, type ProvisioningTrackerRow } from "@/lib/onboarding/contracts";
import { createOnboardingEvidenceRepository } from "@/lib/repositories/onboarding-evidence";
import { listProvisioningTrackerRows } from "@/lib/repositories/onboarding-steps";
import {
  recordProvisioningOperatorCommand,
  undoOperatorCommand,
  type ProvisioningCommandReceipt,
} from "@/lib/platform/operator-commands";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };
const MUTATING_ROLES: readonly UserRole[] = ["owner", "admin", "success"];

type AdminActor = PlatformActor & {
  impersonatingTenant?: string | null;
  impersonationSessionId?: string | null;
};

type AdminProvisioningDependencies = {
  enabled(): boolean;
  session(): Promise<AdminActor | null>;
  list(expectedRole: UserRole): Promise<ProvisioningTrackerRow[]>;
  retry(input: {
    tenantId: string;
    step: ProvisioningStep;
    actorId: string;
    expectedState: "failed";
  }): Promise<string>;
  unblock(input: {
    tenantId: string;
    step: ProvisioningStep;
    actorId: string;
    reason: string;
  }): Promise<string>;
  confirm(input: { tenantId: string; screenId: string; actorId: string }): Promise<{
    auditId: string;
    actionKey: "onboarding.a2p_filing_confirmed";
  }>;
  command?(input: {
    expectedTenant: string;
    step: ProvisioningStep;
    actorId: string;
    action: "nudge" | "resend" | "reassign";
    reason: string;
    assigneeId?: string;
  }): Promise<ProvisioningCommandReceipt>;
  undo?(input: {
    expectedTenant: string;
    commandId: string;
    actorId: string;
    reason: string;
  }): Promise<{ tenantId: string; action: string; state: "undone"; platformOwnerId: string | null; auditId: number }>;
};

type AdminAction =
  | { action: "retry"; tenantId: string; step: ProvisioningStep; expectedState: "failed" }
  | { action: "unblock"; tenantId: string; step: ProvisioningStep; reason: string }
  | { action: "confirm_content"; tenantId: string; screenId: string }
  | { action: "nudge" | "resend"; tenantId: string; step: ProvisioningStep; reason: string }
  | { action: "reassign"; tenantId: string; step: ProvisioningStep; reason: string; assigneeId: string }
  | { action: "undo"; tenantId: string; commandId: string; reason: string };

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function step(value: unknown): ProvisioningStep | null {
  return typeof value === "string" && PROVISIONING_STEPS.includes(value as ProvisioningStep)
    ? value as ProvisioningStep
    : null;
}

function parseAction(value: unknown): AdminAction | "blocked_retry" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const tenantId = text(body.tenantId);
  if (!tenantId) return null;
  if (body.action === "retry") {
    if (body.expectedState === "blocked") return "blocked_retry";
    if (
      Object.keys(body).some((key) => !["action", "tenantId", "step", "expectedState"].includes(key))
      || body.expectedState !== "failed"
      || !step(body.step)
    ) return null;
    return { action: "retry", tenantId, step: step(body.step)!, expectedState: "failed" };
  }
  if (body.action === "unblock") {
    const reason = text(body.reason);
    if (
      Object.keys(body).some((key) => !["action", "tenantId", "step", "reason"].includes(key))
      || !step(body.step)
      || !reason
      || reason.length > 500
    ) return null;
    return { action: "unblock", tenantId, step: step(body.step)!, reason };
  }
  if (body.action === "confirm_content") {
    if (
      Object.keys(body).some((key) => !["action", "tenantId", "screenId"].includes(key))
      || !text(body.screenId)
    ) return null;
    return { action: "confirm_content", tenantId, screenId: text(body.screenId)! };
  }
  if (body.action === "nudge" || body.action === "resend") {
    const reason = text(body.reason);
    if (
      Object.keys(body).some((key) => !["action", "tenantId", "step", "reason"].includes(key))
      || !step(body.step) || !reason || reason.length > 500
    ) return null;
    return { action: body.action, tenantId, step: step(body.step)!, reason };
  }
  if (body.action === "reassign") {
    const reason = text(body.reason);
    const assigneeId = text(body.assigneeId);
    if (
      Object.keys(body).some((key) => !["action", "tenantId", "step", "reason", "assigneeId"].includes(key))
      || !step(body.step) || !reason || reason.length > 500 || !assigneeId
    ) return null;
    return { action: "reassign", tenantId, step: step(body.step)!, reason, assigneeId };
  }
  if (body.action === "undo") {
    const commandId = text(body.commandId);
    const reason = text(body.reason);
    if (
      Object.keys(body).some((key) => !["action", "tenantId", "commandId", "reason"].includes(key))
      || !commandId || !reason || reason.length > 500
    ) return null;
    return { action: "undo", tenantId, commandId, reason };
  }
  return null;
}

function authorize(actor: AdminActor | null, mutating = false) {
  if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
  if (hasImpersonationMarker(actor)) return Response.json({ error: "Impersonated sessions are read-only." }, { status: 403, headers: NO_STORE });
  const roles = mutating ? MUTATING_ROLES : PLATFORM_ROLES;
  if (!roles.includes(actor.role)) return Response.json({ error: "Forbidden." }, { status: 403, headers: NO_STORE });
  return null;
}

export function createAdminProvisioningHandlers(dependencies: AdminProvisioningDependencies) {
  return {
    GET: async () => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
      const actor = await dependencies.session();
      const refused = authorize(actor);
      if (refused || !actor) return refused!;
      try {
        return Response.json({ rows: await dependencies.list(actor.role) }, { headers: NO_STORE });
      } catch (cause) {
        console.error(
          "/api/admin/provisioning failed.",
          cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
        );
        return Response.json({ error: "Provisioning tracker is unavailable." }, { status: 503, headers: NO_STORE });
      }
    },
    POST: async (request: Request) => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
      const actor = await dependencies.session();
      const refused = authorize(actor, true);
      if (refused || !actor) return refused!;
      try {
        const action = parseAction(await request.json());
        if (action === "blocked_retry") {
          return Response.json({ error: "Blocked steps cannot be retried." }, { status: 409, headers: NO_STORE });
        }
        if (!action) return Response.json({ error: "Provisioning action is invalid." }, { status: 400, headers: NO_STORE });
        if (action.action === "retry") {
          const auditId = await dependencies.retry({
            tenantId: action.tenantId,
            step: action.step,
            expectedState: action.expectedState,
            actorId: actor.userId,
          });
          if (!auditId.trim()) throw new Error("PROVISIONING_RETRY_AUDIT_REQUIRED");
          return Response.json({ step: action.step, state: "pending", receipt: { auditId, actionKey: "onboarding.step_retried" } }, { headers: NO_STORE });
        }
        if (action.action === "unblock") {
          const auditId = await dependencies.unblock({
            tenantId: action.tenantId,
            step: action.step,
            reason: action.reason,
            actorId: actor.userId,
          });
          if (!auditId.trim()) throw new Error("PROVISIONING_UNBLOCK_AUDIT_REQUIRED");
          return Response.json({ step: action.step, state: "pending", receipt: { auditId, actionKey: "onboarding.step_unblocked" } }, { headers: NO_STORE });
        }
        if (action.action === "nudge" || action.action === "resend" || action.action === "reassign") {
          if (!dependencies.command) throw new Error("PROVISIONING_COMMAND_NOT_CONFIGURED");
          const receipt = await dependencies.command({
            expectedTenant: action.tenantId,
            step: action.step,
            actorId: actor.userId,
            action: action.action,
            reason: action.reason,
            ...(action.action === "reassign" ? { assigneeId: action.assigneeId } : {}),
          });
          if (receipt.tenantId !== action.tenantId || receipt.step !== action.step
            || !Number.isSafeInteger(receipt.auditId) || receipt.auditId <= 0) {
            throw new Error("PROVISIONING_COMMAND_READBACK_INVALID");
          }
          return Response.json({
            command: { id: receipt.commandId, action: receipt.action, state: receipt.state },
            step: receipt.step,
            platformOwnerId: receipt.platformOwnerId,
            effect: receipt.state === "intent_recorded"
              ? { status: "intent_recorded", providerDispatch: "not_wired" }
              : { status: receipt.state, platformOwnerId: receipt.platformOwnerId },
            undo: { available: receipt.undoAvailable, commandId: receipt.undoAvailable ? receipt.commandId : null },
            audit: { id: receipt.auditId },
          }, { headers: NO_STORE });
        }
        if (action.action === "undo") {
          if (!dependencies.undo) throw new Error("PROVISIONING_UNDO_NOT_CONFIGURED");
          const receipt = await dependencies.undo({
            expectedTenant: action.tenantId,
            commandId: action.commandId,
            actorId: actor.userId,
            reason: action.reason,
          });
          if (receipt.tenantId !== action.tenantId || receipt.state !== "undone"
            || !Number.isSafeInteger(receipt.auditId) || receipt.auditId <= 0) {
            throw new Error("PROVISIONING_UNDO_READBACK_INVALID");
          }
          return Response.json({
            command: { id: action.commandId, action: receipt.action, state: receipt.state },
            platformOwnerId: receipt.platformOwnerId,
            effect: { status: "undone", platformOwnerId: receipt.platformOwnerId },
            undo: { available: false, commandId: null },
            audit: { id: receipt.auditId },
          }, { headers: NO_STORE });
        }
        if (action.action === "confirm_content") {
          const receipt = await dependencies.confirm({
            tenantId: action.tenantId,
            screenId: action.screenId,
            actorId: actor.userId,
          });
          if (!receipt.auditId.trim()) throw new Error("CONFIRM_ONBOARDING_CONTENT_SCREEN_EMPTY");
          return Response.json({ screenId: action.screenId, receipt }, { headers: NO_STORE });
        }
        throw new Error("PROVISIONING_ACTION_NOT_HANDLED");
      } catch {
        return Response.json({ error: "Provisioning action was refused." }, { status: 409, headers: NO_STORE });
      }
    },
  };
}

async function retryStep(input: {
  tenantId: string;
  step: ProvisioningStep;
  actorId: string;
  expectedState: "failed";
}) {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("retry_provisioning_step", {
    p_expected_tenant: input.tenantId,
    p_step_key: input.step,
    p_actor_id: input.actorId,
    p_expected_state: input.expectedState,
  });
  if (error || (typeof data !== "string" && typeof data !== "number")) throw new Error("PROVISIONING_RETRY_REFUSED");
  return String(data);
}

async function unblockStep(input: {
  tenantId: string;
  step: ProvisioningStep;
  actorId: string;
  reason: string;
}) {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("unblock_provisioning_step", {
    p_expected_tenant: input.tenantId,
    p_step_key: input.step,
    p_actor_id: input.actorId,
    p_reason: input.reason,
  });
  if (error || (typeof data !== "string" && typeof data !== "number")) throw new Error("PROVISIONING_UNBLOCK_REFUSED");
  return String(data);
}

const handlers = createAdminProvisioningHandlers({
  enabled: phase5Live,
  session: loadPlatformActor,
  list: listProvisioningTrackerRows,
  retry: retryStep,
  unblock: unblockStep,
  confirm: (input) => createOnboardingEvidenceRepository().confirmContentScreen(input),
  command: recordProvisioningOperatorCommand,
  undo: async (input) => {
    const receipt = await undoOperatorCommand(input);
    if (receipt.state !== "undone") throw new Error("OPERATOR_COMMAND_UNDO_READBACK_INVALID");
    return {
      tenantId: receipt.tenantId,
      action: receipt.action,
      state: receipt.state,
      platformOwnerId: receipt.platformOwnerId,
      auditId: receipt.auditId,
    };
  },
});

export const GET = handlers.GET;
export const POST = handlers.POST;
