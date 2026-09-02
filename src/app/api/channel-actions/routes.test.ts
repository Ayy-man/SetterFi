import { describe, expect, it, vi } from "vitest";

import { createProviderSwitchHandler } from "@/app/api/channels/[channel]/switch/handler";
import { createContactIdentityHandler } from "@/app/api/contacts/[id]/identities/handler";
import { createContactMergeHandler } from "@/app/api/contacts/[id]/merge/handler";
import { createContactUnmergeHandler } from "@/app/api/contacts/[id]/unmerge/handler";
import { createMessageTemplateHandlers } from "@/app/api/message-templates/handler";
import type { RouteActor } from "@/app/api/conversations/[id]/claim/handler";
import type { ContactIdentityDetail } from "@/lib/repositories/contacts";
import type { MessageTemplateView } from "@/lib/repositories/message-templates";
import { ContactMergeError } from "@/lib/services/contact-merge";
import { ProviderSwitchError } from "@/lib/services/provider-switch";

const actor: RouteActor = {
  userId: "actor-1",
  tenantId: "tenant-1",
  role: "coach",
  impersonatingTenant: null,
  impersonationSessionId: null,
};

function post(path: string, body: unknown) {
  return new Request(`https://setterfi.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const identityDetail: ContactIdentityDetail = {
  contactId: "contact-1",
  name: "Synthetic Lead",
  isDemo: true,
  isTest: true,
  identities: [{
    id: "identity-1",
    channel: "instagram",
    channelLabel: "Instagram",
    address: "synthetic-external-1",
    normalizedPhone: null,
    normalizedEmail: null,
    consentState: "inbound_only",
  }],
  candidates: [{
    id: "candidate-1",
    otherContact: { id: "contact-2", name: "Synthetic Candidate", isTest: true },
    source: "field_match",
    evidenceKey: "synthetic-evidence",
    evidence: { match: "synthetic" },
    state: "open",
    createdAt: "2026-08-17T00:00:00Z",
    testBoundary: "test",
    dataLabel: "Demo",
  }],
  mergeState: {
    status: "merged",
    mergedIntoContactId: "contact-winner",
    mergedAt: "2026-08-17T01:00:00Z",
  },
  undo: { auditRowId: 41 },
};

const submittedTemplate: MessageTemplateView = {
  id: "template-1",
  channel: "whatsapp",
  providerTemplateName: "synthetic_template",
  category: "utility",
  locale: "en_US",
  body: "Synthetic template body",
  bodyHash: "a".repeat(64),
  variables: [],
  status: "submitted",
  submittedAt: "2026-08-17T00:00:00Z",
  approvedAt: null,
  rejectedAt: null,
  pausedAt: null,
  disabledAt: null,
  statusUpdatedAt: "2026-08-17T00:00:00Z",
  rejectionDetail: null,
  isDemo: false,
  dataLabel: null,
};

const switchBody = {
  outgoingConnectionId: "connection-out",
  incomingConnectionId: "connection-in",
  backfill: [{
    outgoingExternalId: "synthetic-out",
    incomingExternalId: "synthetic-in",
    contactId: "contact-1",
  }],
  reason: "Synthetic provider cutover",
  idempotencyKey: "switch-1",
};

const mergeBody = {
  loserId: "contact-2",
  source: "human_asserted" as const,
  evidenceId: null,
  reason: "Synthetic duplicate review",
  idempotencyKey: "merge-1",
};

describe("Phase 4 channel and identity routes", () => {
  it("returns 404 before auth or Contract B calls while Phase 4 is off", async () => {
    const session = vi.fn(async () => actor);
    const load = vi.fn(async () => identityDetail);
    const identityResponse = await createContactIdentityHandler({
      enabled: () => false,
      session,
      load,
    })(new Request("https://setterfi.test/api/contacts/contact-1/identities"), {
      params: Promise.resolve({ id: "contact-1" }),
    });
    expect(identityResponse.status).toBe(404);

    const submit = vi.fn(async () => submittedTemplate);
    const templates = createMessageTemplateHandlers({
      enabled: () => false,
      session,
      list: async () => [],
      submit,
    });
    const templateResponse = await templates.POST(post("/api/message-templates", {}));

    expect(templateResponse.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("derives the identity-detail tenant and projects candidates, merge state, and undo without secrets", async () => {
    const load = vi.fn(async () => ({
      ...identityDetail,
      ciphertext: "must-not-leak",
      accessToken: "must-not-leak",
      providerCost: 99,
    }));
    const response = await createContactIdentityHandler({
      enabled: () => true,
      session: async () => actor,
      load,
    })(new Request("https://setterfi.test/api/contacts/contact-1/identities"), {
      params: Promise.resolve({ id: "contact-1" }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(load).toHaveBeenCalledWith("tenant-1", "contact-1");
    expect(JSON.parse(body)).toMatchObject({
      contactId: "contact-1",
      candidates: [{ id: "candidate-1", dataLabel: "Demo" }],
      mergeState: { status: "merged", mergedIntoContactId: "contact-winner" },
      undo: { auditRowId: 41 },
    });
    expect(body).not.toMatch(/ciphertext|accessToken|providerCost|must-not-leak/);
  });

  it("returns no identity data for anonymous or cross-tenant contact lookups", async () => {
    const load = vi.fn(async () => { throw new Error("CONTACT_NOT_FOUND"); });
    const anonymous = await createContactIdentityHandler({
      enabled: () => true,
      session: async () => null,
      load,
    })(new Request("https://setterfi.test/api/contacts/contact-1/identities"), {
      params: Promise.resolve({ id: "contact-1" }),
    });
    const scoped = await createContactIdentityHandler({
      enabled: () => true,
      session: async () => actor,
      load,
    })(new Request("https://setterfi.test/api/contacts/contact-other/identities"), {
      params: Promise.resolve({ id: "contact-other" }),
    });

    expect(anonymous.status).toBe(401);
    expect(scoped.status).toBe(404);
    expect(await scoped.json()).toEqual({ error: "Contact not found." });
    expect(load).toHaveBeenCalledWith("tenant-1", "contact-other");
  });

  it("names the refusal in the server log while the body stays generic", async () => {
    /*
     * Every failure inside this route answers 404 "Contact not found.", which is right for the
     * client -- a coach must not learn from the answer whether another tenant's contact exists --
     * and left production undiagnosable: three real 404s on this route logged nothing beyond the
     * status, so a Postgres read error and a genuinely absent contact were the same line. The
     * body is asserted unchanged here so the log cannot be traded for a leak.
     */
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await createContactIdentityHandler({
        enabled: () => true,
        session: async () => actor,
        load: async () => { throw new Error("CONTACT_DETAIL_READ_FAILED"); },
      })(new Request("https://setterfi.test/api/contacts/contact-1/identities"), {
        params: Promise.resolve({ id: "contact-1" }),
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Contact not found." });
      expect(logged).toHaveBeenCalledWith(
        "Contact identity detail refused.",
        "CONTACT_DETAIL_READ_FAILED",
      );
    } finally {
      logged.mockRestore();
    }
  });

  it("returns a provider-switch audit receipt after Contract B preserves the open-contact mapping", async () => {
    const switchProvider = vi.fn(async () => ({
      state: "live" as const,
      appliedIdentityCount: 1,
      auditId: 51,
      outgoingConnectionId: "connection-out",
      incomingConnectionId: "connection-in",
    }));
    const response = await createProviderSwitchHandler({
      enabled: () => true,
      session: async () => actor,
      switchProvider,
    })(post("/api/channels/instagram/switch", switchBody), {
      params: Promise.resolve({ channel: "instagram" }),
    });

    expect(response.status).toBe(200);
    expect(switchProvider).toHaveBeenCalledWith({
      expectedTenantId: "tenant-1",
      channel: "instagram",
      outgoingConnectionId: "connection-out",
      incomingConnectionId: "connection-in",
      backfill: switchBody.backfill,
      actorUserId: "actor-1",
      reason: switchBody.reason,
      idempotencyKey: switchBody.idempotencyKey,
    });
    expect(await response.json()).toEqual({
      state: "live",
      appliedIdentityCount: 1,
      outgoingConnectionId: "connection-out",
      incomingConnectionId: "connection-in",
      audit: { id: 51, action: "channel.provider.switched" },
    });
  });

  it("returns the named backfill refusal and never treats meta as a messaging channel", async () => {
    const switchProvider = vi.fn(async () => {
      throw new ProviderSwitchError("IDENTITY_BACKFILL_REQUIRED");
    });
    const handler = createProviderSwitchHandler({
      enabled: () => true,
      session: async () => actor,
      switchProvider,
    });
    const incomplete = await handler(post("/api/channels/instagram/switch", {
      ...switchBody,
      backfill: [],
    }), { params: Promise.resolve({ channel: "instagram" }) });
    const namespaceConfusion = await handler(post("/api/channels/meta/switch", switchBody), {
      params: Promise.resolve({ channel: "meta" }),
    });

    expect(incomplete.status).toBe(409);
    expect(await incomplete.json()).toMatchObject({ code: "IDENTITY_BACKFILL_REQUIRED" });
    expect(namespaceConfusion.status).toBe(409);
    expect(switchProvider).toHaveBeenCalledTimes(1);
  });

  it("refuses impersonated provider writes before Contract B can mutate", async () => {
    const switchProvider = vi.fn(async () => {
      throw new Error("must not run");
    });
    const response = await createProviderSwitchHandler({
      enabled: () => true,
      session: async () => ({
        ...actor,
        impersonatingTenant: "tenant-1",
        impersonationSessionId: "session-1",
      }),
      switchProvider,
    })(post("/api/channels/instagram/switch", switchBody), {
      params: Promise.resolve({ channel: "instagram" }),
    });

    expect(response.status).toBe(403);
    expect(switchProvider).not.toHaveBeenCalled();
  });
});

describe("Phase 4 merge routes", () => {
  it("returns registry-backed merge and unmerge receipts with server actor context", async () => {
    const merge = vi.fn(async () => ({
      winnerId: "contact-1",
      loserId: "contact-2",
      mergeAuditId: 61,
      movedIdentityCount: 2,
      movedConversationCount: 1,
    }));
    const mergeResponse = await createContactMergeHandler({
      enabled: () => true,
      session: async () => actor,
      merge,
    })(post("/api/contacts/contact-1/merge", mergeBody), {
      params: Promise.resolve({ id: "contact-1" }),
    });
    expect(merge).toHaveBeenCalledWith({
      expectedTenantId: "tenant-1",
      winnerId: "contact-1",
      loserId: "contact-2",
      source: "human_asserted",
      evidenceId: null,
      actorUserId: "actor-1",
      reason: mergeBody.reason,
      idempotencyKey: mergeBody.idempotencyKey,
    });
    expect(await mergeResponse.json()).toMatchObject({
      audit: { id: 61, action: "contact.merged" },
    });

    const unmerge = vi.fn(async () => ({
      winnerId: "contact-1",
      loserId: "contact-2",
      unmergeAuditId: 62,
      restoredIdentityCount: 2,
      restoredConversationCount: 1,
    }));
    const unmergeResponse = await createContactUnmergeHandler({
      enabled: () => true,
      session: async () => actor,
      unmerge,
    })(post("/api/contacts/contact-2/unmerge", {
      mergeAuditId: 61,
      reason: "Synthetic undo",
      idempotencyKey: "unmerge-1",
    }), { params: Promise.resolve({ id: "contact-2" }) });

    expect(unmergeResponse.status).toBe(200);
    expect(unmerge).toHaveBeenCalledWith({
      expectedTenantId: "tenant-1",
      mergeAuditId: 61,
      actorUserId: "actor-1",
      reason: "Synthetic undo",
      idempotencyKey: "unmerge-1",
    });
    expect(await unmergeResponse.json()).toMatchObject({
      audit: { id: 62, action: "contact.unmerged" },
    });
  });

  it("returns TEST_BOUNDARY_MISMATCH without claiming a merge receipt", async () => {
    const merge = vi.fn(async () => {
      throw new ContactMergeError("TEST_BOUNDARY_MISMATCH");
    });
    const response = await createContactMergeHandler({
      enabled: () => true,
      session: async () => actor,
      merge,
    })(post("/api/contacts/contact-1/merge", mergeBody), {
      params: Promise.resolve({ id: "contact-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({ error: "Contact merge was refused.", code: "TEST_BOUNDARY_MISMATCH" });
    expect(body).not.toHaveProperty("audit");
  });

  it("refuses an unmerge receipt whose restored loser does not match the route contact", async () => {
    const unmerge = vi.fn(async () => ({
      winnerId: "contact-1",
      loserId: "contact-other",
      unmergeAuditId: 71,
      restoredIdentityCount: 1,
      restoredConversationCount: 1,
    }));
    const response = await createContactUnmergeHandler({
      enabled: () => true,
      session: async () => actor,
      unmerge,
    })(post("/api/contacts/contact-2/unmerge", {
      mergeAuditId: 61,
      reason: "Synthetic undo",
      idempotencyKey: "unmerge-2",
    }), { params: Promise.resolve({ id: "contact-2" }) });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "UNMERGE_CONFLICT" });
  });
});

describe("Phase 4 message-template routes", () => {
  it("lists only the persisted tenant lifecycle projection without credential fields", async () => {
    const list = vi.fn(async () => [{
      ...submittedTemplate,
      ciphertext: "must-not-leak",
      providerToken: "must-not-leak",
    }]);
    const handlers = createMessageTemplateHandlers({
      enabled: () => true,
      session: async () => actor,
      list,
      submit: async () => submittedTemplate,
    });
    const response = await handlers.GET();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(list).toHaveBeenCalledWith("tenant-1");
    expect(JSON.parse(body)).toMatchObject({ items: [{ id: "template-1", status: "submitted" }] });
    expect(body).not.toMatch(/ciphertext|providerToken|must-not-leak/);
  });

  it("submits without a client status and returns the registered action only after persisted readback", async () => {
    const submit = vi.fn(async () => submittedTemplate);
    const handlers = createMessageTemplateHandlers({
      enabled: () => true,
      session: async () => actor,
      list: async () => [],
      submit,
    });
    const body = {
      channel: "whatsapp",
      provider: "meta_direct",
      providerTemplateId: "synthetic-provider-id",
      providerTemplateName: "synthetic_template",
      category: "utility",
      locale: "en_US",
      body: "Synthetic template body",
      variables: [],
      idempotencyKey: "template-submit-1",
    };
    const response = await handlers.POST(post("/api/message-templates", body));

    expect(response.status).toBe(201);
    expect(submit).toHaveBeenCalledWith({
      expectedTenantId: "tenant-1",
      ...body,
      actorUserId: "actor-1",
    });
    expect(await response.json()).toMatchObject({
      template: { id: "template-1", status: "submitted" },
      audit: { action: "message_template.submitted" },
    });
  });

  it("refuses client-forged approval and impersonated submission before Contract B", async () => {
    const submit = vi.fn(async () => submittedTemplate);
    const handlers = createMessageTemplateHandlers({
      enabled: () => true,
      session: async () => actor,
      list: async () => [],
      submit,
    });
    const forged = await handlers.POST(post("/api/message-templates", {
      channel: "whatsapp",
      provider: "meta_direct",
      providerTemplateId: "synthetic-provider-id",
      providerTemplateName: "synthetic_template",
      category: "utility",
      locale: "en_US",
      body: "Synthetic template body",
      variables: [],
      idempotencyKey: "template-submit-2",
      status: "approved",
    }));
    expect(forged.status).toBe(400);
    expect(submit).not.toHaveBeenCalled();

    const impersonated = createMessageTemplateHandlers({
      enabled: () => true,
      session: async () => ({
        ...actor,
        impersonatingTenant: "tenant-1",
        impersonationSessionId: "session-1",
      }),
      list: async () => [],
      submit,
    });
    const blocked = await impersonated.POST(post("/api/message-templates", {}));
    expect(blocked.status).toBe(403);
    expect(submit).not.toHaveBeenCalled();
  });
});
