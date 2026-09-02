import { describe, expect, it, vi } from "vitest";

import { createSupportThreadLifecycle } from "./thread-lifecycle";

describe("support thread lifecycle", () => {
  it("forwards only thread lifecycle inputs and validates the persisted status receipt", async () => {
    const setStatus = vi.fn(async () => [{
      thread_id: "thread-1", tenant_id: "tenant-1", status: "resolved", audit_id: 44,
    }]);
    const lifecycle = createSupportThreadLifecycle({
      setStatus, setAssignee: async () => { throw new Error("not used"); },
    });

    await expect(lifecycle.setStatus({
      threadId: "thread-1", actorId: "admin-1", status: "resolved", reason: "Synthetic completion",
    })).resolves.toMatchObject({
      threadId: "thread-1", tenantId: "tenant-1", status: "resolved", auditId: 44,
      actionKey: "support.thread.status.changed", microcopy: "Thread status change logged",
    });
    expect(setStatus).toHaveBeenCalledWith({
      p_thread_id: "thread-1", p_actor_id: "admin-1", p_status: "resolved", p_reason: "Synthetic completion",
    });
  });

  it("rejects an assignment receipt that does not persist the requested assignee", async () => {
    const lifecycle = createSupportThreadLifecycle({
      setStatus: async () => { throw new Error("not used"); },
      setAssignee: async () => [{
        thread_id: "thread-1", tenant_id: "tenant-1", assigned_to: "different-user", audit_id: 45,
      }],
    });

    await expect(lifecycle.setAssignee({
      threadId: "thread-1", actorId: "admin-1", assigneeId: "success-1", reason: "Synthetic routing",
    })).rejects.toThrow("SUPPORT_THREAD_ASSIGNMENT_RECEIPT_INVALID");
  });
});
