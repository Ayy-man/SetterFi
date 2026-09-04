import { describe, expect, it, vi } from "vitest";

import { createSupportRepository, type SupportRepositoryDependencies } from "@/lib/repositories/support";

import { createSupportService, type SupportSession } from "./service";

const coach: SupportSession = {
  userId: "coach-user",
  role: "coach",
  tenantId: "tenant-1",
  impersonatingTenant: null,
};
const success: SupportSession = {
  userId: "success-user",
  role: "success",
  tenantId: null,
  impersonatingTenant: null,
};
const admin: SupportSession = {
  userId: "admin-user",
  role: "admin",
  tenantId: null,
  impersonatingTenant: null,
};

const coachThread = {
  id: "thread-1",
  tenant_id: "tenant-1",
  subject: "Synthetic support subject",
  status: "open" as const,
  assigned_to: null,
  related_contact_id: null,
  is_test: true,
  created_at: "2026-08-18T00:00:00.000Z",
  updated_at: "2026-08-18T00:01:00.000Z",
  messages: [{
    id: "message-public",
    author_id: "coach-user",
    author_name: "Synthetic Coach",
    body: "Synthetic support question",
    is_test: true,
    created_at: "2026-08-18T00:01:00.000Z",
  }],
};

function repositoryDependencies(
  overrides: Partial<SupportRepositoryDependencies> = {},
): SupportRepositoryDependencies {
  return {
    projectCoachThreads: async () => [coachThread],
    projectPlatformThreads: async () => [{
      ...coachThread,
      tenant_name: "Synthetic Demo Tenant",
      tenant_is_demo: true,
      assigned_to_name: null,
      success_owner_id: null,
      success_owner_name: null,
      messages: coachThread.messages.map((message) => ({ ...message, internal: false })),
    }],
    projectClientBook: async () => [],
    callCreateThread: async () => [{ thread_id: "thread-1", message_id: "message-public" }],
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

describe("support service", () => {
  it("derives coach tenant and actor from the session instead of operation input", async () => {
    const projectCoachThreads = vi.fn(repositoryDependencies().projectCoachThreads);
    const service = createSupportService(createSupportRepository(repositoryDependencies({
      projectCoachThreads,
    })));

    await service.listCoachThreads(coach);

    expect(projectCoachThreads).toHaveBeenCalledWith({
      expectedTenant: "tenant-1",
      userId: "coach-user",
    });
  });

  it("refuses cross-role coach reads and every impersonated write", async () => {
    const service = createSupportService(createSupportRepository(repositoryDependencies()));

    await expect(service.listCoachThreads(admin)).rejects.toThrow("COACH_SUPPORT_FORBIDDEN");
    await expect(service.createCoachThread({
      ...coach,
      impersonatingTenant: "tenant-1",
    }, {
      subject: "Synthetic support subject",
      body: "Synthetic support message",
    })).rejects.toThrow("SUPPORT_IMPERSONATION_READ_ONLY");
    await expect(service.appendPlatformMessage({
      ...admin,
      impersonatingTenant: "tenant-1",
    }, {
      threadId: "thread-1",
      body: "Synthetic reply",
      internal: false,
    })).rejects.toThrow("SUPPORT_IMPERSONATION_READ_ONLY");
    await expect(service.createCoachThread({
      ...coach,
      impersonationSessionId: "stale-session-marker",
    }, {
      subject: "Synthetic support subject",
      body: "Synthetic support message",
    })).rejects.toThrow("SUPPORT_IMPERSONATION_READ_ONLY");
  });

  it("lets every platform operator read mine or all without turning book into a permission", async () => {
    const projectPlatformThreads = vi.fn(repositoryDependencies().projectPlatformThreads);
    const service = createSupportService(createSupportRepository(repositoryDependencies({
      projectPlatformThreads,
    })));

    await service.listPlatformThreads(success, { book: "all", status: "open" });
    await service.listPlatformThreads(admin, { book: "mine" });

    expect(projectPlatformThreads.mock.calls).toEqual([
      [{ actorId: "success-user", book: "all", status: "open" }],
      [{ actorId: "admin-user", book: "mine" }],
    ]);
  });

  it("limits success reassignment to self-take while owner and admin may assign eligible users", async () => {
    const callReassign = vi.fn(repositoryDependencies().callReassign);
    const service = createSupportService(createSupportRepository(repositoryDependencies({
      callReassign,
    })));

    await expect(service.reassignSuccessOwner(success, {
      expectedTenant: "tenant-1",
      assigneeId: "different-success-user",
      reason: "Synthetic coverage update",
    })).rejects.toThrow("SUCCESS_OWNER_SELF_TAKE_ONLY");
    expect(callReassign).not.toHaveBeenCalled();

    await service.reassignSuccessOwner(admin, {
      expectedTenant: "tenant-1",
      assigneeId: "success-user",
      reason: "Synthetic coverage update",
    });
    expect(callReassign).toHaveBeenCalledWith({
      p_expected_tenant: "tenant-1",
      p_actor_id: "admin-user",
      p_assignee_id: "success-user",
      p_reason: "Synthetic coverage update",
    });
  });

  it("never forwards an internal option on the coach append path", async () => {
    const callAppendMessage = vi.fn(repositoryDependencies().callAppendMessage);
    const service = createSupportService(createSupportRepository(repositoryDependencies({
      callAppendMessage,
    })));

    await service.appendCoachMessage(coach, {
      threadId: "thread-1",
      body: "Synthetic coach follow-up",
    });

    expect(callAppendMessage).toHaveBeenCalledWith(expect.objectContaining({
      p_expected_tenant: "tenant-1",
      p_actor_id: "coach-user",
      p_internal: false,
    }));
  });
});
