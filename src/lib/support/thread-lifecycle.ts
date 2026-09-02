/** Service-only, audited mutations for a support thread's own lifecycle fields. */

import type { SupportStatus } from "@/lib/repositories/support";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type SupportThreadStatusReceipt = {
  threadId: string;
  tenantId: string;
  status: SupportStatus;
  auditId: number;
  actionKey: "support.thread.status.changed";
  microcopy: "Thread status change logged";
};

export type SupportThreadAssignmentReceipt = {
  threadId: string;
  tenantId: string;
  assigneeId: string | null;
  auditId: number;
  actionKey: "support.thread.assignment.changed";
  microcopy: "Thread assignment logged";
};

export type SupportThreadLifecycleDependencies = {
  setStatus(args: Record<string, unknown>): Promise<unknown>;
  setAssignee(args: Record<string, unknown>): Promise<unknown>;
};

export class SupportThreadLifecycleError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const statuses = ["open", "waiting_on_coach", "resolved"] as const;

function row(value: unknown, code: string) {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new SupportThreadLifecycleError(code);
  }
  return candidate as Record<string, unknown>;
}

function string(value: unknown, code: string) {
  if (typeof value !== "string" || !value.trim()) throw new SupportThreadLifecycleError(code);
  return value;
}

function auditId(value: unknown, code: string) {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
    throw new SupportThreadLifecycleError(code);
  }
  return number;
}

async function liveDependencies(): Promise<SupportThreadLifecycleDependencies> {
  const client = createSupabaseServiceClient();
  return {
    setStatus: async (args) => {
      const { data, error } = await client.rpc("set_support_thread_status", args);
      if (error) throw new SupportThreadLifecycleError("SUPPORT_THREAD_STATUS_FAILED");
      return data;
    },
    setAssignee: async (args) => {
      const { data, error } = await client.rpc("set_support_thread_assignee", args);
      if (error) throw new SupportThreadLifecycleError("SUPPORT_THREAD_ASSIGNMENT_FAILED");
      return data;
    },
  };
}

export function createSupportThreadLifecycle(provided?: SupportThreadLifecycleDependencies) {
  const dependencies = async () => provided ?? liveDependencies();

  return {
    async setStatus(input: {
      threadId: string;
      actorId: string;
      status: SupportStatus;
      reason: string;
    }): Promise<SupportThreadStatusReceipt> {
      const receipt = row(await (await dependencies()).setStatus({
        p_thread_id: input.threadId,
        p_actor_id: input.actorId,
        p_status: input.status,
        p_reason: input.reason,
      }), "SUPPORT_THREAD_STATUS_RECEIPT_INVALID");
      const threadId = string(receipt.thread_id, "SUPPORT_THREAD_STATUS_RECEIPT_INVALID");
      const tenantId = string(receipt.tenant_id, "SUPPORT_THREAD_STATUS_RECEIPT_INVALID");
      if (threadId !== input.threadId || !statuses.includes(receipt.status as SupportStatus)
        || receipt.status !== input.status) {
        throw new SupportThreadLifecycleError("SUPPORT_THREAD_STATUS_RECEIPT_INVALID");
      }
      return {
        threadId,
        tenantId,
        status: receipt.status as SupportStatus,
        auditId: auditId(receipt.audit_id, "SUPPORT_THREAD_STATUS_RECEIPT_INVALID"),
        actionKey: "support.thread.status.changed",
        microcopy: "Thread status change logged",
      };
    },
    async setAssignee(input: {
      threadId: string;
      actorId: string;
      assigneeId: string | null;
      reason: string;
    }): Promise<SupportThreadAssignmentReceipt> {
      const receipt = row(await (await dependencies()).setAssignee({
        p_thread_id: input.threadId,
        p_actor_id: input.actorId,
        p_assignee_id: input.assigneeId,
        p_reason: input.reason,
      }), "SUPPORT_THREAD_ASSIGNMENT_RECEIPT_INVALID");
      const threadId = string(receipt.thread_id, "SUPPORT_THREAD_ASSIGNMENT_RECEIPT_INVALID");
      const tenantId = string(receipt.tenant_id, "SUPPORT_THREAD_ASSIGNMENT_RECEIPT_INVALID");
      if (threadId !== input.threadId || receipt.assigned_to !== input.assigneeId
        || (receipt.assigned_to !== null && typeof receipt.assigned_to !== "string")) {
        throw new SupportThreadLifecycleError("SUPPORT_THREAD_ASSIGNMENT_RECEIPT_INVALID");
      }
      return {
        threadId,
        tenantId,
        assigneeId: receipt.assigned_to as string | null,
        auditId: auditId(receipt.audit_id, "SUPPORT_THREAD_ASSIGNMENT_RECEIPT_INVALID"),
        actionKey: "support.thread.assignment.changed",
        microcopy: "Thread assignment logged",
      };
    },
  };
}
