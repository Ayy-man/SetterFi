import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  createSupportRepository,
  type CoachSupportMessageRead,
  type SupportRepositoryDependencies,
} from "./support";

type CoachTypeHasInternal = "internal" extends keyof CoachSupportMessageRead ? true : false;
const coachTypeHasInternal: CoachTypeHasInternal = false;

const publicMessage = {
  id: "message-public",
  author_id: "coach-user",
  author_name: "Synthetic Coach",
  body: "Synthetic support question",
  is_test: true,
  created_at: "2026-08-18T00:01:00.000Z",
};

const coachThread = {
  id: "thread-1",
  tenant_id: "tenant-1",
  subject: "Synthetic support subject",
  status: "open" as const,
  assigned_to: null,
  is_test: true,
  created_at: "2026-08-18T00:00:00.000Z",
  updated_at: "2026-08-18T00:01:00.000Z",
  messages: [publicMessage],
};

const platformThread = {
  ...coachThread,
  tenant_name: "Synthetic Demo Tenant",
  tenant_is_demo: true,
  assigned_to_name: null,
  success_owner_id: null,
  success_owner_name: null,
  messages: [
    { ...publicMessage, internal: false },
    {
      ...publicMessage,
      id: "message-internal",
      author_id: "admin-user",
      author_name: "Synthetic Admin",
      body: "Synthetic internal note",
      internal: true,
    },
  ],
};

const clientBookRow = {
  client: { id: "tenant-1", name: "Synthetic Demo Tenant", is_demo: true },
  status: "active",
  success_owner: null,
  support_status: "open" as const,
  plan_id: "tier-growth",
  plan_label: "Growth",
  updated_at: "2026-08-18T00:01:00.000Z",
};

function dependencies(
  overrides: Partial<SupportRepositoryDependencies> = {},
): SupportRepositoryDependencies {
  return {
    projectCoachThreads: async () => [coachThread],
    projectPlatformThreads: async () => [platformThread],
    projectClientBook: async () => [clientBookRow],
    callCreateThread: async () => [{
      thread_id: "thread-1",
      message_id: "message-public",
    }],
    callAppendMessage: async () => [{
      message_id: "message-public",
      created_at: "2026-08-18T00:01:00.000Z",
    }],
    callReassign: async () => [{
      tenant_id: "tenant-1",
      success_owner: "success-user",
      audit_id: 41,
    }],
    readReassignment: async () => ({
      tenant_id: "tenant-1",
      success_owner: "success-user",
      audit_id: 41,
      audit_actor_id: "admin-user",
      audit_assignee_id: "success-user",
      audit_action: "tenant.success_owner.reassigned",
      audit_target_type: "tenant",
      audit_target_id: "tenant-1",
      audit_reason: "Synthetic coverage update",
      expected_assignee: "success-user",
    }),
    ...overrides,
  };
}

describe("support repository", () => {
  it("keeps the coach type and row set incapable of carrying an internal note", async () => {
    const repository = createSupportRepository(dependencies());
    const coach = await repository.getCoachSupportThread("tenant-1", "coach-user", "thread-1");
    const platform = await repository.getPlatformSupportThread("admin-user", "thread-1");

    expect(coachTypeHasInternal).toBe(false);
    expect(coach.messages).toHaveLength(1);
    expect(coach.messages[0]).toEqual({
      id: "message-public",
      authorId: "coach-user",
      authorName: "Synthetic Coach",
      body: "Synthetic support question",
      isTest: true,
      createdAt: "2026-08-18T00:01:00.000Z",
    });
    expect(Object.hasOwn(coach.messages[0], "internal")).toBe(false);
    expect(platform.messages.map((message) => message.internal)).toEqual([false, true]);
  });

  it("rejects a widened coach projection instead of filtering internal after selection", async () => {
    const repository = createSupportRepository(dependencies({
      projectCoachThreads: async () => [{
        ...coachThread,
        messages: [{ ...publicMessage, internal: true }],
      }],
    }));

    await expect(repository.listCoachSupportThreads("tenant-1", "coach-user"))
      .rejects.toThrow("COACH_SUPPORT_PROJECTION_INVALID");
  });

  it("keeps support independent from lead-message repositories and paths", async () => {
    const source = await readFile(new URL("./support.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/repositories\/conversations/);
    expect(source).not.toMatch(/\.from\(["']conversations["']\)/);
    expect(source).not.toMatch(/sendToLead|cadence|messages\/route/);
  });

  it("applies mine and all as matching query filters for support and the client book", async () => {
    const projectPlatformThreads = vi.fn(dependencies().projectPlatformThreads);
    const projectClientBook = vi.fn(dependencies().projectClientBook);
    const repository = createSupportRepository(dependencies({
      projectPlatformThreads,
      projectClientBook,
    }));

    await repository.listPlatformSupportThreads({
      actorId: "success-user",
      book: "mine",
      status: "open",
    });
    await repository.listPlatformSupportThreads({ actorId: "success-user", book: "all" });
    await repository.listSuccessClientBook({ actorId: "success-user", book: "mine" });
    await repository.listSuccessClientBook({ actorId: "success-user", book: "all" });

    expect(projectPlatformThreads).toHaveBeenNthCalledWith(1, {
      actorId: "success-user",
      book: "mine",
      status: "open",
    });
    expect(projectPlatformThreads).toHaveBeenNthCalledWith(2, {
      actorId: "success-user",
      book: "all",
    });
    expect(projectClientBook.mock.calls).toEqual([
      [{ actorId: "success-user", book: "mine" }],
      [{ actorId: "success-user", book: "all" }],
    ]);
  });

  it("refuses a cross-tenant coach thread even if a privileged source returns it", async () => {
    const repository = createSupportRepository(dependencies({
      projectCoachThreads: async () => [{ ...coachThread, tenant_id: "tenant-2" }],
    }));

    await expect(repository.getCoachSupportThread("tenant-1", "coach-user", "thread-1"))
      .rejects.toThrow("COACH_SUPPORT_THREAD_NOT_FOUND");
  });

  it("preserves an unassigned platform thread and the exact five-part client book shape", async () => {
    const repository = createSupportRepository(dependencies());

    await expect(repository.getPlatformSupportThread("admin-user", "thread-1"))
      .resolves.toMatchObject({ assignedTo: null, successOwner: null });
    const book = await repository.listSuccessClientBook({ actorId: "admin-user", book: "all" });
    expect(book).toEqual([{
      client: { id: "tenant-1", name: "Synthetic Demo Tenant", isDemo: true },
      status: "active",
      successOwner: null,
      supportStatus: "open",
      planId: "tier-growth",
      planLabel: "Growth",
      updatedAt: "2026-08-18T00:01:00.000Z",
    }]);
    expect(Object.keys(book[0]).sort()).toEqual([
      "client", "planId", "planLabel", "status", "successOwner", "supportStatus", "updatedAt",
    ]);
  });

  it("carries a null plan for a tenant with no tier assigned", async () => {
    const repository = createSupportRepository(dependencies({
      projectClientBook: async () => [{
        ...clientBookRow,
        plan_id: null,
        plan_label: null,
      }],
    }));

    const book = await repository.listSuccessClientBook({ actorId: "admin-user", book: "all" });
    expect(book[0]).toMatchObject({ planId: null, planLabel: null });
  });

  it("passes only expected-tenant RPC arguments and returns the persisted created thread", async () => {
    const callCreateThread = vi.fn(dependencies().callCreateThread);
    const repository = createSupportRepository(dependencies({ callCreateThread }));

    const result = await repository.createCoachSupportThread({
      expectedTenant: "tenant-1",
      userId: "coach-user",
      subject: "  Request body subject  ",
      body: "Request body message",
    });

    expect(callCreateThread).toHaveBeenCalledWith({
      p_expected_tenant: "tenant-1",
      p_actor_id: "coach-user",
      p_subject: "  Request body subject  ",
      p_body: "Request body message",
    });
    expect(result.subject).toBe("Synthetic support subject");
    expect(result.messages[0].body).toBe("Synthetic support question");
  });

  it("hard-codes coach append as public and rejects a missing persisted message read-back", async () => {
    const callAppendMessage = vi.fn(dependencies().callAppendMessage);
    const repository = createSupportRepository(dependencies({ callAppendMessage }));

    await repository.appendCoachSupportMessage({
      expectedTenant: "tenant-1",
      userId: "coach-user",
      threadId: "thread-1",
      body: "Synthetic follow-up",
    });
    expect(callAppendMessage).toHaveBeenCalledWith({
      p_expected_tenant: "tenant-1",
      p_thread_id: "thread-1",
      p_actor_id: "coach-user",
      p_body: "Synthetic follow-up",
      p_internal: false,
    });

    const mismatch = createSupportRepository(dependencies({
      callAppendMessage: async () => [{
        message_id: "message-not-persisted",
        created_at: "2026-08-18T00:01:00.000Z",
      }],
    }));
    await expect(mismatch.appendCoachSupportMessage({
      expectedTenant: "tenant-1",
      userId: "coach-user",
      threadId: "thread-1",
      body: "Synthetic follow-up",
    })).rejects.toThrow("SUPPORT_MESSAGE_APPEND_READBACK_MISMATCH");
  });

  it("returns Reassigned only after exact owner and audit read-back", async () => {
    const repository = createSupportRepository(dependencies());
    await expect(repository.reassignSuccessOwner({
      expectedTenant: "tenant-1",
      actorId: "admin-user",
      assigneeId: "success-user",
      reason: "Synthetic coverage update",
    })).resolves.toEqual({
      tenantId: "tenant-1",
      successOwner: "success-user",
      auditId: 41,
      state: "Reassigned",
    });

    const mismatched = createSupportRepository(dependencies({
      readReassignment: async () => ({
        ...(await dependencies().readReassignment({
          expectedTenant: "tenant-1",
          assigneeId: "success-user",
          auditId: 41,
        }) as Record<string, unknown>),
        audit_assignee_id: "different-success-user",
      }),
    }));
    await expect(mismatched.reassignSuccessOwner({
      expectedTenant: "tenant-1",
      actorId: "admin-user",
      assigneeId: "success-user",
      reason: "Synthetic coverage update",
    })).rejects.toThrow("SUCCESS_OWNER_REASSIGN_READBACK_MISMATCH");
  });
});
