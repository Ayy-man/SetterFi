import { describe, expect, it } from "vitest";

import {
  listMessageTemplates,
  MESSAGE_TEMPLATE_STATUSES,
  submitMessageTemplate,
  type MessageTemplateDependencies,
} from "@/lib/repositories/message-templates";

function template(overrides: Record<string, unknown> = {}) {
  return {
    id: "template-a",
    tenant_id: "tenant-a",
    channel: "whatsapp" as const,
    provider_template_name: "follow_up_en_us",
    category: "utility" as const,
    locale: "en_US",
    body: "Synthetic follow-up body",
    body_hash: "a".repeat(64),
    variables: ["first_name"],
    status: "submitted" as const,
    submitted_at: "2026-08-17T12:00:00.000Z",
    approved_at: null,
    rejected_at: null,
    paused_at: null,
    disabled_at: null,
    status_updated_at: "2026-08-17T12:00:00.000Z",
    rejection_detail: null,
    is_demo: false,
    credential_envelope: "canary-secret-value",
    ...overrides,
  };
}

function dependencies(row = template()) {
  const calls: Array<Record<string, unknown>> = [];
  const deps: MessageTemplateDependencies = {
    submit: async (args) => {
      calls.push(args);
      return { template_id: String(row.id), status: "submitted", audit_id: 91 };
    },
    loadById: async () => row,
    list: async () => [row],
  };
  return { deps, calls };
}

const input = {
  expectedTenantId: "tenant-a",
  channel: "whatsapp" as const,
  provider: "meta_direct" as const,
  providerTemplateId: "provider-template-a",
  providerTemplateName: "follow_up_en_us",
  category: "utility" as const,
  locale: "en_US",
  body: "Synthetic follow-up body",
  variables: ["first_name"],
  actorUserId: "actor-a",
  idempotencyKey: "template-submit-a",
};

describe("message template repository", () => {
  it("submits without a caller-controlled approval state and returns tenant readback", async () => {
    const state = dependencies();
    const result = await submitMessageTemplate(input, state.deps);
    expect(state.calls).toEqual([
      {
        p_expected_tenant: "tenant-a",
        p_channel: "whatsapp",
        p_provider: "meta_direct",
        p_provider_template_id: "provider-template-a",
        p_provider_template_name: "follow_up_en_us",
        p_category: "utility",
        p_locale: "en_US",
        p_body: "Synthetic follow-up body",
        p_variables: ["first_name"],
        p_actor_id: "actor-a",
        p_idempotency_key: "template-submit-a",
      },
    ]);
    expect(result).toMatchObject({ id: "template-a", status: "submitted", isDemo: false });
    expect(JSON.stringify(result)).not.toContain("canary");
  });

  it("refuses a forged approved submission receipt instead of treating it as provider evidence", async () => {
    const state = dependencies();
    state.deps.submit = async () => ({
      template_id: "template-a",
      status: "approved",
      audit_id: 91,
    });
    await expect(submitMessageTemplate(input, state.deps)).rejects.toThrow(
      "MESSAGE_TEMPLATE_SUBMIT_STATUS_INVALID",
    );
  });

  it("lists provider-approved real readback and labels synthetic demo lifecycle rows", async () => {
    const approved = template({
      status: "approved" as const,
      approved_at: "2026-08-17T12:10:00.000Z",
    });
    const demo = template({
      id: "template-demo",
      provider_template_name: "SETTERFI_DEMO_PLACEHOLDER_FOLLOW_UP",
      body: "SETTERFI_DEMO_PLACEHOLDER_FOLLOW_UP_BODY",
      status: "approved" as const,
      approved_at: "2026-08-17T12:10:00.000Z",
      is_demo: true,
    });
    const state = dependencies(approved);
    state.deps.list = async () => [approved, demo];
    const result = await listMessageTemplates("tenant-a", state.deps);
    expect(result.map((item) => ({ id: item.id, status: item.status, dataLabel: item.dataLabel })))
      .toEqual([
        { id: "template-a", status: "approved", dataLabel: null },
        { id: "template-demo", status: "approved", dataLabel: "Demo" },
      ]);
  });

  it("rejects cross-tenant template rows returned through the service client", async () => {
    const state = dependencies(template({ tenant_id: "tenant-b" }));
    await expect(listMessageTemplates("tenant-a", state.deps)).rejects.toThrow(
      "MESSAGE_TEMPLATE_TENANT_MISMATCH",
    );
  });

  it("pins the complete provider lifecycle for schema drift", () => {
    expect(MESSAGE_TEMPLATE_STATUSES).toEqual([
      "draft",
      "submitted",
      "approved",
      "rejected",
      "paused",
      "disabled",
    ]);
  });
});
