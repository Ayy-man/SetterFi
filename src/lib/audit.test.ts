import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS, type AuditActionKey } from "@/lib/audit/actions";
import {
  claim,
  clearGuardrail,
  release,
  setPipelineStage,
  type AuditDependencies,
  type ConversationMutationRead,
} from "@/lib/audit";

function harness(initial: Partial<ConversationMutationRead> = {}) {
  let conversation: ConversationMutationRead = {
    id: "conversation-1",
    tenantId: "tenant-a",
    status: "agent",
    statusReason: null,
    takenOverBy: null,
    disclosurePending: false,
    currentStepAsks: 2,
    ...initial,
  };
  let auditSequence = 0;
  const auditActions = new Map<string, AuditActionKey>();
  const dependencies: AuditDependencies = {
    rpc: async (name, args) => {
      if (name === "claim_conversation") {
        if (
          conversation.status !== args.p_expected_status ||
          conversation.takenOverBy !== args.p_expected_holder_id
        ) {
          throw new Error("CONVERSATION_CLAIM_STALE");
        }
        if (
          conversation.takenOverBy &&
          conversation.takenOverBy !== args.p_actor_id &&
          !args.p_confirm_displace
        ) {
          throw new Error("CONVERSATION_DISPLACE_CONFIRMATION_REQUIRED");
        }
        conversation = {
          ...conversation,
          status: "human",
          statusReason: "lead_requested_human",
          takenOverBy: String(args.p_actor_id),
        };
        auditActions.set(String((auditSequence += 1)), "conversation.takeover.claimed");
        return auditSequence;
      }
      if (name === "release_conversation") {
        if (
          conversation.status !== "human" ||
          conversation.takenOverBy !== args.p_expected_holder_id
        ) {
          throw new Error("CONVERSATION_RELEASE_STALE");
        }
        conversation = {
          ...conversation,
          status: "agent",
          statusReason: null,
          takenOverBy: null,
          disclosurePending: true,
        };
        auditActions.set(String((auditSequence += 1)), "conversation.takeover.released");
        return auditSequence;
      }
      if (name === "clear_conversation_guardrail") {
        conversation = {
          ...conversation,
          status: "agent",
          statusReason: null,
          disclosurePending: true,
        };
        auditActions.set(String((auditSequence += 1)), "conversation.guardrail.cleared");
        return auditSequence;
      }
      if (name === "set_contact_pipeline_stage") {
        auditActions.set(String((auditSequence += 1)), "contact.pipeline_stage.set");
        return auditSequence;
      }
      return null;
    },
    loadConversation: async () => conversation,
    loadContactStage: async (contactId) => ({
      id: contactId,
      tenantId: "tenant-a",
      pipelineStage: "booked",
      stageSetBy: "system",
      stageSetAt: "2026-08-17T12:00:00.000Z",
    }),
    loadAuditReceipt: async (auditId, tenantId, actionKey) => {
      if (tenantId !== "tenant-a" || auditActions.get(auditId) !== actionKey) return null;
      return {
        auditId,
        actionKey,
        label: AUDIT_ACTIONS[actionKey].microcopy,
        ariaLabel: AUDIT_ACTIONS[actionKey].ariaLabel,
      };
    },
  };
  return { dependencies, conversation: () => conversation };
}

describe("audited conversation services", () => {
  it("allows one concurrent claim and rejects the stale competitor", async () => {
    const { dependencies } = harness();
    const first = await claim(
      "tenant-a",
      {
        conversationId: "conversation-1",
        actorId: "actor-a",
        expectedStatus: "agent",
        expectedHolderId: null,
        confirmDisplace: false,
      },
      dependencies,
    );
    expect(first.audit).toMatchObject({
      actionKey: "conversation.takeover.claimed",
      label: "Takeover logged",
    });
    await expect(
      claim(
        "tenant-a",
        {
          conversationId: "conversation-1",
          actorId: "actor-b",
          expectedStatus: "agent",
          expectedHolderId: null,
          confirmDisplace: false,
        },
        dependencies,
      ),
    ).rejects.toThrow("CONVERSATION_CLAIM_STALE");
  });

  it("requires explicit displacement before replacing a human holder", async () => {
    const { dependencies } = harness({
      status: "human",
      statusReason: "lead_requested_human",
      takenOverBy: "actor-a",
    });
    const input = {
      conversationId: "conversation-1",
      actorId: "actor-b",
      expectedStatus: "human" as const,
      expectedHolderId: "actor-a",
      confirmDisplace: false,
    };
    await expect(claim("tenant-a", input, dependencies)).rejects.toThrow(
      "CONVERSATION_DISPLACE_CONFIRMATION_REQUIRED",
    );
    const result = await claim(
      "tenant-a",
      { ...input, confirmDisplace: true },
      dependencies,
    );
    expect(result.conversation.takenOverBy).toBe("actor-b");
  });

  it("returns disclosure pending from release and leaves consumption to the agent-turn RPC", async () => {
    const { dependencies } = harness({
      status: "human",
      statusReason: "lead_requested_human",
      takenOverBy: "actor-a",
      currentStepAsks: 3,
    });
    const result = await release(
      "tenant-a",
      {
        conversationId: "conversation-1",
        actorId: "actor-a",
        expectedHolderId: "actor-a",
      },
      dependencies,
    );
    expect(result.conversation).toMatchObject({
      status: "agent",
      disclosurePending: true,
      currentStepAsks: 3,
    });
    expect(result.audit.actionKey).toBe("conversation.takeover.released");
    await expect(
      release(
        "tenant-a",
        {
          conversationId: "conversation-1",
          actorId: "actor-a",
          expectedHolderId: "actor-a",
        },
        dependencies,
      ),
    ).rejects.toThrow("CONVERSATION_RELEASE_STALE");
  });

  it("requires a reason to clear a guardrail and returns registry-backed copy", async () => {
    const { dependencies } = harness({ status: "scope_blocked", statusReason: "scope_exit_cap" });
    await expect(
      clearGuardrail(
        "tenant-a",
        { conversationId: "conversation-1", actorId: "actor-a", reason: "  " },
        dependencies,
      ),
    ).rejects.toThrow("GUARDRAIL_CLEAR_REASON_REQUIRED");
    const result = await clearGuardrail(
      "tenant-a",
      { conversationId: "conversation-1", actorId: "actor-a", reason: "Reviewed" },
      dependencies,
    );
    expect(result.audit).toMatchObject({
      actionKey: "conversation.guardrail.cleared",
      label: "Guardrail clear logged",
    });
  });

  it("returns no Logged copy when the persisted registry receipt is unavailable", async () => {
    const { dependencies } = harness();
    await expect(
      claim(
        "tenant-a",
        {
          conversationId: "conversation-1",
          actorId: "actor-a",
          expectedStatus: "agent",
          expectedHolderId: null,
          confirmDisplace: false,
        },
        { ...dependencies, loadAuditReceipt: async () => null },
      ),
    ).rejects.toThrow("AUDIT_RECEIPT_MISSING:conversation.takeover.claimed");
  });

  it("requires an actor for a human stage move before calling the RPC", async () => {
    const { dependencies } = harness();
    await expect(
      setPipelineStage(
        "tenant-a",
        {
          contactId: "contact-1",
          expectedStage: "new_lead",
          stage: "booked",
          setBy: "user",
          actorId: null,
          reason: null,
          appointmentId: "appointment-1",
          idempotencyKey: "pipeline-contact-1-booked",
        },
        dependencies,
      ),
    ).rejects.toThrow("PIPELINE_ACTOR_REQUIRED");
  });

  it("passes pipeline audit context to the RPC and returns its verified receipt", async () => {
    const { dependencies } = harness();
    let rpcArgs: Record<string, unknown> | null = null;
    const result = await setPipelineStage(
      "tenant-a",
      {
        contactId: "contact-1",
        expectedStage: "new_lead",
        stage: "booked",
        setBy: "user",
        actorId: "actor-a",
        reason: "Appointment confirmed",
        appointmentId: "appointment-1",
        idempotencyKey: "pipeline-contact-1-booked",
      },
      {
        ...dependencies,
        rpc: async (name, args) => {
          expect(name).toBe("set_contact_pipeline_stage");
          rpcArgs = args;
          await dependencies.rpc(name, args);
          return 1;
        },
      },
    );

    expect(rpcArgs).toEqual({
      p_expected_tenant: "tenant-a",
      p_contact_id: "contact-1",
      p_expected_stage: "new_lead",
      p_stage: "booked",
      p_set_by: "user",
      p_actor_id: "actor-a",
      p_reason: "Appointment confirmed",
      p_appointment_id: "appointment-1",
      p_idempotency_key: "pipeline-contact-1-booked",
    });
    expect(result).toMatchObject({
      contact: { id: "contact-1", pipelineStage: "booked" },
      audit: { id: 1, actionKey: "contact.pipeline_stage.set" },
    });
  });
});
