import { describe, expect, it, vi } from "vitest";

import { authorizeHumanActor, type MessagingDriver } from "@/lib/integrations/types";

import {
  isProviderWindowExpired,
  sendWithOutboundPolicy,
  type MessageTemplateStatus,
  type OutboundPolicyDependencies,
} from "./outbound-policy";

const now = new Date("2026-08-17T12:00:00.000Z");

function harness(input: {
  provider?: MessagingDriver["provider"];
  windowed: boolean;
  postWindow?: "none" | "human_tag" | "template";
  templates?: boolean;
  expiresAt: string | null;
  templateStatus?: MessageTemplateStatus;
}) {
  const send = vi.fn(async () => ({ providerMessageId: "provider-message-1" }));
  const driver: MessagingDriver = {
    provider: input.provider ?? "ghl",
    verifyWebhook: vi.fn(async () => true),
    normalizeInbound: vi.fn(async () => ({ events: [] })),
    capabilities: () => ({
      windowed: input.windowed,
      postWindow: input.postWindow ?? "none",
      templates: input.templates ?? false,
    }),
    send,
  };
  const recordWindowRefusal = vi.fn(async () => undefined);
  const emitWindowExpired = vi.fn(async () => undefined);
  const emitContinuationUnavailable = vi.fn(async () => undefined);
  const overrides: Partial<Omit<OutboundPolicyDependencies, "driver">> = {
    authorizeExisting: vi.fn(async () => ({ allowed: true as const })),
    resolveCapabilityWindow: vi.fn(async () => ({
      provider: driver.provider,
      capabilities: driver.capabilities("whatsapp"),
      providerWindowExpiresAt: input.expiresAt,
    })),
    loadTemplate: vi.fn(async ({ tenantId, templateId }) => ({
      id: templateId,
      tenantId,
      channel: "whatsapp" as const,
      provider: driver.provider,
      providerTemplateName: "appointment_follow_up",
      locale: "en_US",
      bodyHash: "a".repeat(64),
      status: input.templateStatus ?? "approved",
    })),
    recordWindowRefusal,
    emitWindowExpired,
    emitContinuationUnavailable,
    now: () => now,
  };
  return {
    driver,
    send,
    overrides,
    recordWindowRefusal,
    emitWindowExpired,
    emitContinuationUnavailable,
  };
}

const base = {
  tenantId: "tenant-1",
  conversationId: "conversation-1",
  channel: "whatsapp" as const,
  recipientExternalId: "lead-1",
  body: "Synthetic reply",
  isTest: false,
};

describe("outbound messaging policy", () => {
  it("uses the exact capability-scoped expiry predicate", () => {
    expect(isProviderWindowExpired(
      { windowed: false, postWindow: "none", templates: false }, null, now,
    )).toBe(false);
    expect(isProviderWindowExpired(
      { windowed: true, postWindow: "none", templates: false }, null, now,
    )).toBe(true);
    expect(isProviderWindowExpired(
      { windowed: true, postWindow: "none", templates: false }, now.toISOString(), now,
    )).toBe(true);
    expect(isProviderWindowExpired(
      { windowed: true, postWindow: "none", templates: false },
      "2026-08-17T12:00:00.001Z", now,
    )).toBe(false);
  });

  it("sends SMS with a null provider window when the capability is not windowed", async () => {
    const h = harness({ windowed: false, expiresAt: null });
    const result = await sendWithOutboundPolicy({ ...base, channel: "sms" }, h.driver, h.overrides);

    expect(result.kind).toBe("sent");
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ kind: "freeform", channel: "sms" }));
    expect(h.recordWindowRefusal).not.toHaveBeenCalled();
  });

  it.each([null, "2026-08-17T11:59:59.999Z"])(
    "refuses direct Meta freeform with a closed %s window before driver I/O",
    async (expiresAt) => {
      const h = harness({ provider: "meta_direct", windowed: true, expiresAt });
      const result = await sendWithOutboundPolicy(base, h.driver, h.overrides);

      expect(result).toEqual({ kind: "refused", reason: "PROVIDER_WINDOW_EXPIRED" });
      expect(h.send).not.toHaveBeenCalled();
      expect(h.recordWindowRefusal).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: "tenant-1",
        conversationId: "conversation-1",
        channel: "whatsapp",
      }));
      expect(h.emitWindowExpired).toHaveBeenCalledOnce();
      expect(h.emitContinuationUnavailable).toHaveBeenCalledOnce();
      expect(h.emitContinuationUnavailable).toHaveBeenCalledWith({
        tenantId: "tenant-1",
        conversationId: "conversation-1",
        channel: "whatsapp",
        reason: "PROVIDER_WINDOW_EXPIRED",
        isTest: false,
        occurredAt: now.toISOString(),
      });
    },
  );

  it("evaluates existing consent and suppression authorization before capability lookup", async () => {
    const h = harness({ provider: "meta_direct", windowed: true, expiresAt: null });
    h.overrides.authorizeExisting = vi.fn(async () => ({
      allowed: false as const,
      reason: "SEND_PERMISSION_REFUSED",
    }));
    const result = await sendWithOutboundPolicy(base, h.driver, h.overrides);

    expect(result).toEqual({ kind: "refused", reason: "SEND_PERMISSION_REFUSED" });
    expect(h.overrides.resolveCapabilityWindow).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("sends an approved template after the WhatsApp window closes", async () => {
    const h = harness({
      provider: "meta_direct",
      windowed: true,
      postWindow: "template",
      templates: true,
      expiresAt: null,
      templateStatus: "approved",
    });
    const result = await sendWithOutboundPolicy({
      ...base,
      template: { id: "template-1", variables: { first_name: "Taylor" } },
    }, h.driver, h.overrides);

    expect(result.kind).toBe("sent");
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({
      kind: "approved_template",
      templateId: "template-1",
      providerTemplateName: "appointment_follow_up",
    }));
    expect(h.recordWindowRefusal).not.toHaveBeenCalled();
  });

  it("refuses an approved template when the declared post-window capability is none", async () => {
    const h = harness({
      provider: "meta_direct",
      windowed: true,
      postWindow: "none",
      templates: true,
      expiresAt: null,
      templateStatus: "approved",
    });
    const result = await sendWithOutboundPolicy({
      ...base,
      template: { id: "template-1", variables: {} },
    }, h.driver, h.overrides);

    expect(result).toEqual({ kind: "refused", reason: "MESSAGE_TEMPLATES_UNSUPPORTED" });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.recordWindowRefusal).toHaveBeenCalledOnce();
  });

  it.each(["pending", "submitted", "rejected", "paused"] satisfies MessageTemplateStatus[])(
    "refuses a %s WhatsApp template before provider I/O",
    async (templateStatus) => {
      const h = harness({
        provider: "meta_direct",
        windowed: true,
        postWindow: "template",
        templates: true,
        expiresAt: null,
        templateStatus,
      });
      const result = await sendWithOutboundPolicy({
        ...base,
        template: { id: "template-1", variables: {} },
      }, h.driver, h.overrides);

      expect(result).toEqual({
        kind: "refused",
        reason: `MESSAGE_TEMPLATE_NOT_APPROVED:${templateStatus}`,
      });
      expect(h.send).not.toHaveBeenCalled();
      expect(h.recordWindowRefusal).toHaveBeenCalledOnce();
    },
  );

  it("permits the declared post-window tag only with branded human proof", async () => {
    const h = harness({
      provider: "meta_direct",
      windowed: true,
      postWindow: "human_tag",
      expiresAt: null,
    });
    const result = await sendWithOutboundPolicy({
      ...base,
      actor: { kind: "human", proof: authorizeHumanActor({ userId: "user-1", authorized: true }) },
    }, h.driver, h.overrides);

    expect(result.kind).toBe("sent");
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ kind: "human_tag" }));
  });
});
