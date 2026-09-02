import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLiveAgentHandler, POST as agentRoute } from "@/app/api/agent/handler";
import { createConsumerHandler, POST as consumerRoute } from "@/app/api/consumer-agent/handler";
import { createClaimHandler, type RouteActor } from "@/app/api/conversations/[id]/claim/handler";
import { createHumanMessageHandler } from "@/app/api/conversations/[id]/messages/handler";
import { createReleaseHandler } from "@/app/api/conversations/[id]/release/handler";
import { GET as livenessRoute } from "@/app/api/health/live/route";
import { createReadinessHandler } from "@/app/api/health/ready/handler";
import { createAppointmentReconcileHandler } from "@/app/api/jobs/appointment-reconcile/handler";
import { createDeletionPreviewHandler } from "@/app/api/contacts/[id]/deletion-preview/handler";
import { createContactDeleteHandler } from "@/app/api/contacts/[id]/handler";
import { createGhlInstallReconcileHandler } from "@/app/api/jobs/ghl-install-reconcile/handler";
import { createFollowupJobHandler } from "@/app/api/jobs/followups/handler";
import { createComplianceReconcileHandler } from "@/app/api/jobs/compliance-reconcile/handler";
import { createImpersonationEndHandler } from "@/app/api/platform/impersonation/end/handler";
import { createImpersonationStartHandler } from "@/app/api/platform/impersonation/start/handler";
import {
  createGhlWebhookHandler,
  markGhlUninstalled,
  POST as liveGhlWebhookIngress,
} from "@/app/api/webhooks/ghl/handler";
import { createMetaWebhookHandler } from "@/app/api/webhooks/meta/handler";
import { NO_CLAIMS } from "@/lib/auth/claims";
import type { NormalizedInboundEvent } from "@/lib/integrations/types";
import { resetRateLimits } from "@/lib/rate-limit";
import type { ConversationRead } from "@/lib/repositories/conversations";
import { processGhlUninstallReceipt } from "@/lib/webhooks/process-inbound";
import { createProxy } from "@/proxy";

let caller = 0;

function post(body: unknown, path = "/api/agent", ip = `10.0.0.${(caller += 1) % 250}`) {
  return new Request(`https://setterfi.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

const actor: RouteActor = {
  ...NO_CLAIMS,
  userId: "actor-1",
  role: "coach",
  tenantId: "tenant-1",
};

const conversation: ConversationRead = {
  id: "conversation-1",
  contactId: "contact-1",
  contactName: "Test Lead",
  channel: "sms",
  status: "human",
  statusReason: "lead_requested_human",
  takenOverBy: "actor-1",
  unreadByCoach: false,
  disclosurePending: false,
  currentStepAsks: 0,
  isDemo: true,
  isTest: true,
  lastActivityAt: "2026-08-17T00:00:00.000Z",
  qualification: { credit: null, goal: null, timeline: null, outcome: null },
  appointment: null,
  messages: [],
};

const audit = {
  auditId: "audit-1",
  actionKey: "conversation.takeover.claimed" as const,
  label: "Takeover logged",
  ariaLabel: "Conversation takeover recorded in the audit log",
};

function context(id = "conversation-1") {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  resetRateLimits();
  vi.stubEnv("SETTERFI_PHASE1_LIVE", "");
  vi.stubEnv("SETTERFI_PHASE3_LIVE", "true");
});

afterEach(() => vi.unstubAllEnvs());

describe("off-flag fixture routes", () => {
  it("removes the legacy agent simulator while preserving an inert no-store response", async () => {
    const response = await agentRoute(post({ message: "what's this cost?" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found." });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects the retired client-carried consumer transcript shape", async () => {
    for (const message of ["STOP", "can I talk to a human", "my credit score is 540", "hello"]) {
      const response = await consumerRoute(post({ message }, "/api/consumer-agent"));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: "CONSUMER_BODY_INVALID" });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("rejects malformed and oversized messages", async () => {
    expect((await agentRoute(post({ message: "x".repeat(801) }))).status).toBe(404);
    expect((await consumerRoute(post({ message: " " }, "/api/consumer-agent"))).status).toBe(400);
  });
});

describe("shared paid-call limiter", () => {
  beforeEach(() => vi.stubEnv("SETTERFI_PHASE1_LIVE", "true"));

  it("refuses agent limiter denial without invoking a provider", async () => {
    const execute = vi.fn();
    const response = await createLiveAgentHandler({
      enabled: () => true,
      session: async () => ({ ...actor, role: "admin" }),
      resolveTenant: async () => actor.tenantId,
      createSession: async () => "session-synthetic",
      consume: async () => ({ allowed: false, retryAfter: 12 }),
      execute,
    })(post({ message: "test", sessionId: "session-synthetic" }));
    expect(response.status).toBe(429);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses agent limiter-store failure without invoking a provider", async () => {
    const execute = vi.fn();
    const consume = vi.fn(async () => ({ allowed: false, retryAfter: 60 }));
    await createLiveAgentHandler({
      enabled: () => true,
      session: async () => ({ ...actor, role: "admin" }),
      resolveTenant: async () => actor.tenantId,
      createSession: async () => "session-synthetic",
      consume,
      execute,
    })(post({ message: "test", sessionId: "session-synthetic" }));
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns only the consumer turn envelope after a server-bound session is accepted", async () => {
    const response = await createConsumerHandler({
      start: vi.fn(),
      turn: vi.fn().mockResolvedValue({
        reply: "Approved test reply", state: "active", booking: null, author: { role: "assistant" },
      }),
      confirm: vi.fn(),
    })(post({ action: "turn", sessionReference: "server-issued", message: "test" }, "/api/consumer-agent"));
    expect(Object.keys(await response.json()).sort()).toEqual(["author", "booking", "reply", "state"]);
  });
});

describe("signed webhook receipts", () => {
  beforeEach(() => vi.stubEnv("SETTERFI_PHASE1_LIVE", "true"));

  function ghlDependencies(
    inserted = true,
    events?: readonly NormalizedInboundEvent[],
    behavior: {
      status?: "received" | "processed" | "failed" | "skipped";
      lookupFailure?: boolean;
      persistFailure?: boolean;
      scheduleFailure?: boolean;
      unresolvedLocation?: string;
    } = {},
  ) {
    const order: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const persistReceipt = vi.fn(async (input) => {
      order.push("receipt");
      if (behavior.persistFailure) throw new Error("DB_UNAVAILABLE");
      return { id: "receipt-1", ...input, status: behavior.status ?? "received", inserted };
    });
    const processReceipt = vi.fn(async () => { order.push("process"); });
    const processUninstall = vi.fn(async () => { order.push("uninstall"); });
    return {
      order,
      scheduled,
      persistReceipt,
      processReceipt,
      processUninstall,
      handler: createGhlWebhookHandler({
        driver: {
          provider: "ghl",
          verifyWebhook: async (_bytes, signature) => signature === "valid",
          normalizeInbound: async () => ({
            events: events ?? [{
              kind: "message",
              eventId: "event-1",
              providerMessageId: "message-1",
              body: "Hello",
              externalAccountId: "location-1",
              identity: {
                provider: "ghl",
                channel: "sms",
                externalId: "lead-1",
                normalizedPhone: null,
                normalizedEmail: null,
              },
              providerWindow: null,
            }],
          }),
          capabilities: () => ({ windowed: false, postWindow: "none", templates: false }),
          send: async () => ({ providerMessageId: "outbound-1" }),
          reconcileInstall: async () => ({
            companyId: "company-1",
            accessToken: crypto.randomUUID(),
            refreshToken: crypto.randomUUID(),
            tokenExpiresAt: "2030-01-01T00:00:00.000Z",
          }),
        },
        resolveTenant: async (locationId) => {
          if (behavior.lookupFailure) throw new Error("DB_UNAVAILABLE");
          return behavior.unresolvedLocation === locationId ? null : "tenant-1";
        },
        persistReceipt,
        processReceipt,
        processUninstall,
        schedule: (callback) => {
          if (behavior.scheduleFailure) throw new Error("SCHEDULER_UNAVAILABLE");
          order.push("schedule");
          scheduled.push(callback);
        },
      }),
    };
  }

  function ghlRequest(signature: string | null) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (signature) headers["x-ghl-signature"] = signature;
    return new Request("https://setterfi.test/api/webhooks/ghl", {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "InboundMessage" }),
    });
  }

  it("performs zero writes when the provider signature is missing or invalid", async () => {
    const missing = ghlDependencies();
    expect((await missing.handler(ghlRequest(null))).status).toBe(401);
    expect(missing.persistReceipt).not.toHaveBeenCalled();
    const invalid = ghlDependencies();
    expect((await invalid.handler(ghlRequest("invalid"))).status).toBe(401);
    expect(invalid.persistReceipt).not.toHaveBeenCalled();
  });

  it("persists before ack scheduling and absorbs a receipt replay", async () => {
    const first = ghlDependencies();
    expect((await first.handler(ghlRequest("valid"))).status).toBe(200);
    expect(first.order).toEqual(["receipt", "schedule"]);
    await first.scheduled[0]();
    expect(first.order).toEqual(["receipt", "schedule", "process"]);

    const replay = ghlDependencies(false);
    expect((await replay.handler(ghlRequest("valid"))).status).toBe(200);
    expect(replay.processReceipt).not.toHaveBeenCalled();
  });

  it("routes INSTALL to install recovery and never reads UNINSTALL as one", async () => {
    function lifecycleRequest(type: string) {
      return new Request("https://setterfi.test/api/webhooks/ghl", {
        method: "POST",
        headers: { "content-type": "application/json", "x-ghl-signature": "valid" },
        body: JSON.stringify({ type, webhookId: `hook-${type}`, locationId: "location-1" }),
      });
    }

    const install = ghlDependencies();
    expect((await install.handler(lifecycleRequest("INSTALL"))).status).toBe(200);
    expect(install.persistReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "INSTALL" }),
    );
    expect(install.processUninstall).not.toHaveBeenCalled();
    for (const scheduled of install.scheduled) await scheduled();
    expect(install.processReceipt).toHaveBeenCalledTimes(1);

    const uninstall = ghlDependencies();
    expect((await uninstall.handler(lifecycleRequest("UNINSTALL"))).status).toBe(200);
    const [[persisted]] = uninstall.persistReceipt.mock.calls;
    expect(persisted.eventType).toBe("UNINSTALL");
    expect(persisted.eventType).not.toBe("INSTALL");
    for (const scheduled of uninstall.scheduled) await scheduled();
    // The revoked grant is retired and no install recovery is ever scheduled for it.
    expect(uninstall.processUninstall).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "UNINSTALL", status: "received" }),
    );
    expect(uninstall.processReceipt).not.toHaveBeenCalled();

    // A lowercase provider spelling still discriminates, and an unrelated type stays inbound.
    const lowercase = ghlDependencies();
    expect((await lowercase.handler(lifecycleRequest("uninstall"))).status).toBe(200);
    expect(lowercase.persistReceipt.mock.calls[0][0].eventType).toBe("UNINSTALL");
  });

  it("rejects an UNINSTALL without a location before writing a receipt", async () => {
    const uninstall = ghlDependencies();
    const response = await uninstall.handler(new Request(
      "https://setterfi.test/api/webhooks/ghl",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-ghl-signature": "valid" },
        body: JSON.stringify({
          type: "UNINSTALL",
          webhookId: "hook-uninstall",
          companyId: "company-1",
        }),
      },
    ));
    expect(response.status).toBe(400);
    expect(uninstall.persistReceipt).not.toHaveBeenCalled();
  });

  it("persists and schedules every message, ignored, and status event in a normalized batch", async () => {
    const batch = ghlDependencies(true, [
      {
        kind: "message",
        eventId: "event-1",
        providerMessageId: "message-1",
        body: "Hello",
        externalAccountId: "location-1",
        identity: {
          provider: "ghl",
          channel: "sms",
          externalId: "lead-1",
          normalizedPhone: null,
          normalizedEmail: null,
        },
        providerWindow: null,
      },
      { kind: "ignored", eventId: "echo-1", externalAccountId: "location-1", reason: "echo" },
      { kind: "status", eventId: "status-1", externalAccountId: "location-1", status: "delivered" },
    ]);

    expect((await batch.handler(ghlRequest("valid"))).status).toBe(200);
    expect(batch.persistReceipt).toHaveBeenCalledTimes(3);
    expect(batch.persistReceipt.mock.calls.map(([input]) => input.eventType)).toEqual([
      "InboundMessage",
      "Ignored",
      "Status",
    ]);
    expect(batch.scheduled).toHaveLength(3);
    for (const scheduled of batch.scheduled) await scheduled();
    expect(batch.processReceipt).toHaveBeenCalledTimes(3);
  });

  it("resolves the complete normalized batch before its first durable write", async () => {
    const batch = ghlDependencies(true, [
      {
        kind: "ignored",
        eventId: "event-1",
        externalAccountId: "location-1",
        reason: "echo",
      },
      {
        kind: "status",
        eventId: "event-2",
        externalAccountId: "location-unresolved",
        status: "delivered",
      },
    ], { unresolvedLocation: "location-unresolved" });

    const response = await batch.handler(ghlRequest("valid"));
    expect(response.status).toBe(404);
    expect(batch.persistReceipt).not.toHaveBeenCalled();
    expect(batch.scheduled).toHaveLength(0);
  });

  it.each([
    ["lookup", { lookupFailure: true }],
    ["persist", { persistFailure: true }],
    ["schedule", { scheduleFailure: true }],
  ] as const)("returns 503 when %s infrastructure is unavailable", async (_name, behavior) => {
    const ingress = ghlDependencies(true, undefined, behavior);
    const response = await ingress.handler(ghlRequest("valid"));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reschedules durable received and failed rows but leaves completed rows alone", async () => {
    for (const status of ["received", "failed"] as const) {
      const retry = ghlDependencies(false, undefined, { status });
      expect((await retry.handler(ghlRequest("valid"))).status).toBe(200);
      expect(retry.scheduled).toHaveLength(1);
    }
    const complete = ghlDependencies(false, undefined, { status: "processed" });
    expect((await complete.handler(ghlRequest("valid"))).status).toBe(200);
    expect(complete.scheduled).toHaveLength(0);
  });

  it("refuses an explicit mock or missing live GHL selector without accepting the webhook", async () => {
    for (const selector of ["mock", undefined] as const) {
      if (selector) vi.stubEnv("SETTERFI_GHL_DRIVER", selector);
      else vi.stubEnv("SETTERFI_GHL_DRIVER", "");
      const response = await liveGhlWebhookIngress(ghlRequest("valid"));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "Webhook verification unavailable.",
      });
    }
  });

  it("rejects a Meta payload whose stored connection cannot resolve one tenant", async () => {
    const persistReceipt = vi.fn();
    const handler = createMetaWebhookHandler({
      driver: {
        verifyWebhook: async () => true,
        normalizeInbound: async () => ({ events: [{
          kind: "message",
          eventId: "event-1",
          providerMessageId: "message-1",
          externalAccountId: "page-1",
          body: "Hello",
          identity: {
            provider: "meta_direct",
            channel: "messenger",
            externalId: "lead-1",
            normalizedPhone: null,
            normalizedEmail: null,
          },
          providerWindow: {
            observedAt: "2026-08-17T00:00:00.000Z",
            expiresAt: "2026-08-18T00:00:00.000Z",
            source: "derived_24h",
          },
        }] }),
      },
      resolveTenant: async () => null,
      persistReceipt,
      processReceipt: async () => undefined,
      schedule: () => undefined,
    });
    const response = await handler(new Request("https://setterfi.test/api/webhooks/meta", {
      method: "POST",
      headers: { "x-hub-signature-256": "present" },
      body: JSON.stringify({ object: "page" }),
    }));
    expect(response.status).toBe(404);
    expect(persistReceipt).not.toHaveBeenCalled();
  });
});

describe("an uninstall destroys the credential it invalidates", () => {
  type Recorded = {
    table: string;
    op: string;
    payload?: Record<string, unknown>;
    filters: [string, unknown][];
  };
  type Result = { data?: unknown; error?: unknown };
  type Node = Record<string, (...args: never[]) => unknown>;

  /** Records both table writes and the atomic uninstall RPC used by the lifecycle handler. */
  function fakeSupabase(handler: (call: Recorded) => Result) {
    const calls: Recorded[] = [];
    const node = (call: Recorded): Node => {
      const result = () => handler(call);
      const self: Node = {
        insert: (payload: never) => { call.op = "insert"; call.payload = payload; return self; },
        update: (payload: never) => { call.op = "update"; call.payload = payload; return self; },
        delete: () => { call.op = "delete"; return self; },
        select: () => { call.op ||= "select"; return self; },
        eq: (column: never, value: never) => { call.filters.push([column, value]); return self; },
        maybeSingle: async () => result(),
        single: async () => result(),
        then: (resolve: never, reject: never) =>
          Promise.resolve(result()).then(resolve as never, reject as never),
      };
      return self;
    };
    const client = {
      rpc: async (operation: string, payload: Record<string, unknown>) => {
        const call: Recorded = { table: "$rpc", op: operation, payload, filters: [] };
        calls.push(call);
        return handler(call);
      },
      from: (table: string) => {
        const call: Recorded = { table, op: "", filters: [] };
        calls.push(call);
        return node(call);
      },
    };
    return { client: client as never, calls };
  }

  function supabase(overrides: (call: Recorded) => Result = () => ({})) {
    return fakeSupabase((call) => {
      const override = overrides(call);
      if (override.error !== undefined || override.data !== undefined) return override;
      return {};
    });
  }

  it("delegates credential destruction and install retirement to one atomic RPC", async () => {
    const { client, calls } = supabase();
    await markGhlUninstalled("location-1", client);
    expect(calls).toEqual([{
      table: "$rpc",
      op: "mark_ghl_uninstalled_atomic",
      payload: { p_location_id: "location-1" },
      filters: [],
    }]);
  });

  it("surfaces an atomic uninstall failure without attempting fallback writes", async () => {
    const { client, calls } = supabase((call) =>
      call.table === "$rpc" ? { error: { message: "boom" } } : {});
    await expect(markGhlUninstalled("location-1", client))
      .rejects.toThrow(/GHL_UNINSTALL_ATOMIC_WRITE_FAILED:boom/);
    expect(calls).toHaveLength(1);
  });

  it("stays a silent no-op when the atomic RPC finds no matching install", async () => {
    const { client, calls } = supabase((call) => call.table === "$rpc" ? { data: null } : {});
    await expect(markGhlUninstalled("location-unknown", client)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("marks an UNINSTALL receipt processed only after the atomic retirement succeeds", async () => {
    const { client, calls } = supabase();
    await processGhlUninstallReceipt({
      id: "receipt-uninstall-1",
      provider: "ghl",
      providerEventId: "uninstall-1",
      tenantId: "tenant-1",
      eventType: "UNINSTALL",
      payload: { normalized: { locationId: "location-1" } },
      status: "received",
      inserted: true,
    }, client);

    const retire = calls.findIndex((call) => call.table === "$rpc");
    const receipt = calls.findIndex((call) => call.table === "webhook_events" && call.op === "update");
    expect(retire).toBeLessThan(receipt);
    expect(calls[receipt].payload).toMatchObject({ status: "processed", error: null });
  });

  it("keeps a failed UNINSTALL receipt retryable when credential retirement fails", async () => {
    const { client, calls } = supabase((call) =>
      call.table === "$rpc" ? { error: { message: "boom" } } : {});
    await expect(processGhlUninstallReceipt({
      id: "receipt-uninstall-1",
      provider: "ghl",
      providerEventId: "uninstall-1",
      tenantId: "tenant-1",
      eventType: "UNINSTALL",
      payload: { normalized: { locationId: "location-1" } },
      status: "received",
      inserted: true,
    }, client)).rejects.toThrow("GHL_UNINSTALL_ATOMIC_WRITE_FAILED:boom");
    expect(calls.find((call) => call.table === "webhook_events")?.payload).toMatchObject({
      status: "failed",
      error: "UNINSTALL_RECONCILE_FAILED",
    });
  });
});

describe("secreted reconcile jobs", () => {
  beforeEach(() => vi.stubEnv("SETTERFI_PHASE1_LIVE", "true"));

  it("refuses missing and incorrect cron authorization", async () => {
    const secret = crypto.randomUUID();
    const reconcile = vi.fn();
    const handler = createAppointmentReconcileHandler({ secret, reconcile });
    expect((await handler(new Request("https://setterfi.test/api/jobs/appointment-reconcile"))).status).toBe(401);
    expect((await handler(new Request("https://setterfi.test/api/jobs/appointment-reconcile", {
      headers: { authorization: `Bearer ${crypto.randomUUID()}` },
    }))).status).toBe(401);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("runs the appointment reconciliation job with the bounded claim size", async () => {
    const secret = crypto.randomUUID();
    const reconcile = vi.fn(async () => ({
      connections: 25,
      checked: 40,
      canceled: 2,
      failed: 1,
      outboxDispatched: 2,
      outboxFailed: 0,
    }));
    const handler = createAppointmentReconcileHandler({ secret, reconcile });
    const response = await handler(new Request("https://setterfi.test/api/jobs/appointment-reconcile", {
      headers: { authorization: `Bearer ${secret}` },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connections: 25,
      checked: 40,
      canceled: 2,
      failed: 1,
      outboxDispatched: 2,
      outboxFailed: 0,
    });
    expect(reconcile).toHaveBeenCalledWith(25);
  });

  it("provides a bounded manual fallback for a killed after callback", async () => {
    const secret = crypto.randomUUID();
    const reconcile = vi.fn(async (limit: number) => ({ checked: 1, processed: 1, failed: 0, limit }));
    const handler = createGhlInstallReconcileHandler({ secret, reconcile });
    const response = await handler(new Request("https://setterfi.test/api/jobs/ghl-install-reconcile", {
      headers: { authorization: `Bearer ${secret}` },
    }));
    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith(25);
  });

  it("refuses follow-up cron authorization before tenant leases", async () => {
    const secret = crypto.randomUUID();
    const listTenants = vi.fn(async () => ["tenant-1"]);
    const run = vi.fn();
    const handler = createFollowupJobHandler({ secret, listTenants, run });
    expect((await handler(new Request("https://setterfi.test/api/jobs/followups"))).status).toBe(401);
    expect(listTenants).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("runs bounded tenant-scoped follow-up leases with one secreted request", async () => {
    const secret = crypto.randomUUID();
    const run = vi.fn(async () => [
      { outcome: "sent" }, { outcome: "deferred" }, { outcome: "canceled" },
    ]);
    const handler = createFollowupJobHandler({
      secret,
      listTenants: async (limit) => {
        expect(limit).toBe(25);
        return ["tenant-1"];
      },
      run,
    });
    const response = await handler(new Request("https://setterfi.test/api/jobs/followups", {
      headers: { authorization: `Bearer ${secret}` },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ tenants: 1, claimed: 3, sent: 1, deferred: 1, canceled: 1 });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-1", limit: 50 }));
  });

  it("runs the stale sweep while suppression provider sync is off", async () => {
    const secret = crypto.randomUUID();
    const sweep = vi.fn(async () => ({ closedCount: 2 }));
    const reconcileProvider = vi.fn();
    const handler = createComplianceReconcileHandler({
      secret,
      syncEnabled: () => false,
      listTenants: async () => ["tenant-1", "tenant-2"],
      sweep,
      reconcileProvider,
    });
    const response = await handler(new Request("https://setterfi.test/api/jobs/compliance-reconcile", {
      headers: { authorization: `Bearer ${secret}` },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      tenants: 2,
      staleClosed: 4,
      provider: { checked: 0, skipped: "SETTERFI_SUPPRESSION_SYNC_LIVE is off" },
    });
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(reconcileProvider).not.toHaveBeenCalled();
  });

  it("404s both Phase 3 jobs before claims when either parent flag is off", async () => {
    const secret = crypto.randomUUID();
    const listTenants = vi.fn();
    vi.stubEnv("SETTERFI_PHASE3_LIVE", "false");
    const followups = createFollowupJobHandler({ secret, listTenants, run: vi.fn() });
    expect((await followups(new Request("https://setterfi.test/api/jobs/followups", {
      headers: { authorization: `Bearer ${secret}` },
    }))).status).toBe(404);
    expect(listTenants).not.toHaveBeenCalled();
  });
});

describe("handoff and human-message contracts", () => {
  beforeEach(() => vi.stubEnv("SETTERFI_PHASE1_LIVE", "true"));

  it("returns the exact claim contract and refuses a stale claim race", async () => {
    const handler = createClaimHandler({
      session: async () => actor,
      claim: async () => ({ conversation: {} as never, audit }),
      loadConversation: async () => conversation,
    });
    const response = await handler(post({ expectedState: "needs_human", expectedHolderId: null, confirmDisplace: false }), context());
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json()).sort()).toEqual(["audit", "conversation"]);

    const stale = createClaimHandler({
      session: async () => actor,
      claim: async () => { throw new Error("CONVERSATION_CLAIM_STALE"); },
      loadConversation: async () => conversation,
    });
    expect((await stale(post({ expectedState: "needs_human", expectedHolderId: null, confirmDisplace: false }), context())).status).toBe(409);
  });

  it("returns release read-back only when disclosure is pending", async () => {
    const handler = createReleaseHandler({
      session: async () => actor,
      release: async () => ({ conversation: {} as never, audit: { ...audit, actionKey: "conversation.takeover.released" as const } }),
      loadConversation: async () => ({ ...conversation, status: "agent", statusReason: null, takenOverBy: null, disclosurePending: true }),
    });
    const payload = await (await handler(post({ expectedHolderId: "actor-1" }), context())).json();
    expect(payload.conversation.disclosurePending).toBe(true);
  });

  it("keeps an internal note as an undelivered system row and never calls an adapter", async () => {
    const adapter = vi.fn();
    const handler = createHumanMessageHandler({
      session: async () => actor,
      write: async (input) => ({
        message: {
          id: "message-1", direction: "system", author: `human:${input.actorId}`,
          body: input.body, createdAt: "2026-08-17T00:00:00.000Z", delivered: false,
        },
        audit: {
          ...audit,
          actionKey: "conversation.internal_note.added" as const,
          label: "Internal note added",
          ariaLabel: "Internal conversation note recorded in the audit log",
        },
      }),
      loadConversation: async () => conversation,
    });
    const response = await handler(post({ kind: "internal_note", body: "Test note", expectedState: "human" }), context());
    expect(await response.json()).toMatchObject({
      message: { direction: "system", delivered: false },
      audit: { actionKey: "conversation.internal_note.added" },
    });
    expect(adapter).not.toHaveBeenCalled();
  });

  it("returns the audited human-reply contract from the transactional writer", async () => {
    const sendReply = vi.fn(async (input) => ({
      message: {
        id: "message-2", direction: "out" as const, author: `human:${input.actorId}`,
        body: input.body, createdAt: "2026-08-17T00:00:00.000Z", delivered: false,
      },
      audit: {
        ...audit,
        actionKey: "conversation.message.sent.human" as const,
        label: "Message sent",
        ariaLabel: "Human-authored message recorded in the audit log",
      },
    }));
    const handler = createHumanMessageHandler({
      session: async () => actor,
      write: vi.fn(),
      sendReply,
      loadConversation: async () => ({ ...conversation, status: "human", takenOverBy: actor.userId }),
    });
    const response = await handler(post({ kind: "reply", body: " Human reply ", expectedState: "human" }), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      message: { direction: "out", author: "human:actor-1", body: "Human reply" },
      audit: { actionKey: "conversation.message.sent.human" },
    });
    expect(sendReply).toHaveBeenCalledWith(expect.objectContaining({ body: "Human reply" }));
  });

  it("requires a second explicit request before a human quiet-hours override", async () => {
    const sendReply = vi.fn(async (input: { actorId: string; body: string; quietHoursOverride: boolean }) =>
      input.quietHoursOverride
        ? {
            kind: "sent" as const,
            message: {
              id: "message-quiet", direction: "out" as const, author: `human:${input.actorId}`,
              body: input.body, createdAt: "2026-08-17T00:00:00.000Z", delivered: true,
            },
            audit,
          }
        : {
            kind: "confirmation_required" as const,
            scheduledAt: "2026-08-17T12:00:00.000Z",
            timezoneSource: "contact" as const,
            leadLocalTimes: ["America/New_York: 7:00 AM"],
            allowedWindow: "8:00 AM–8:00 PM",
          });
    const handler = createHumanMessageHandler({
      session: async () => actor,
      write: vi.fn(),
      sendReply,
      loadConversation: async () => ({ ...conversation, status: "human", takenOverBy: actor.userId }),
    });

    const warning = await handler(
      post({ kind: "reply", body: "Human reply", expectedState: "human" }),
      context(),
    );
    expect(warning.status).toBe(409);
    await expect(warning.json()).resolves.toMatchObject({
      code: "HUMAN_REPLY_QUIET_HOURS_CONFIRMATION_REQUIRED",
      leadLocalTimes: ["America/New_York: 7:00 AM"],
      allowedWindow: "8:00 AM–8:00 PM",
    });

    const sent = await handler(post({
      kind: "reply",
      body: "Human reply",
      expectedState: "human",
      quietHoursOverride: true,
    }), context());
    expect(sent.status).toBe(200);
    expect(sendReply).toHaveBeenLastCalledWith(expect.objectContaining({ quietHoursOverride: true }));
  });

  it("refuses extra body keys, oversized messages, and cross-tenant service failures", async () => {
    const write = vi.fn(async () => { throw new Error("CONVERSATION_TENANT_MISMATCH"); });
    const handler = createHumanMessageHandler({ session: async () => actor, write, sendReply: write, loadConversation: async () => conversation });
    expect((await handler(post({ kind: "reply", body: "ok", expectedState: "human", tenantId: "tenant-2" }), context())).status).toBe(409);
    expect((await handler(post({ kind: "reply", body: "x".repeat(801), expectedState: "human" }), context())).status).toBe(409);
    expect((await handler(post({ kind: "reply", body: "ok", expectedState: "human" }), context("other"))).status).toBe(409);
  });
});

describe("impersonation lifecycle routes", () => {
  beforeEach(() => vi.stubEnv("SETTERFI_PHASE1_LIVE", "true"));

  const platformActor = { ...actor, role: "success" as const };
  const session = {
    id: "session-1", actorId: "actor-1", tenantId: "tenant-2", reason: "Support review",
    startedAt: "2026-08-17T00:00:00.000Z", endedAt: null,
    expiresAt: "2026-08-17T00:30:00.000Z",
  };
  const activeLifecycleActor = {
    ...platformActor,
    claims: {
      userId: "actor-1", role: "success" as const, tenantId: null,
      impersonatingTenant: "tenant-2", impersonationSessionId: "session-1",
    },
    activeSession: { id: "session-1", tenantId: "tenant-2" },
  };

  it("requires a reason, refuses build, and verifies exact thirty-minute expiry", async () => {
    const start = vi.fn(async () => session);
    const end = vi.fn(async () => undefined);
    const refresh = async () => activeLifecycleActor.claims;
    const handler = createImpersonationStartHandler({ session: async () => platformActor, start, refresh, end });
    expect((await handler(post({ tenantId: "tenant-2", reason: " " }))).status).toBe(409);
    const build = createImpersonationStartHandler({
      session: async () => ({ ...actor, role: "build" }), start, refresh, end,
    });
    expect((await build(post({ tenantId: "tenant-2", reason: "Support review" }))).status).toBe(403);
    expect((await handler(post({ tenantId: "tenant-2", reason: "Support review" }))).status).toBe(200);

    const badDuration = createImpersonationStartHandler({
      session: async () => platformActor,
      start: async () => ({ ...session, expiresAt: "2026-08-17T00:31:00.000Z" }),
      refresh,
      end,
    });
    expect((await badDuration(post({ tenantId: "tenant-2", reason: "Support review" }))).status).toBe(409);

    const staleRefresh = createImpersonationStartHandler({
      session: async () => platformActor,
      start,
      refresh: async () => ({ ...activeLifecycleActor.claims, impersonatingTenant: null }),
      end,
    });
    expect((await staleRefresh(post({ tenantId: "tenant-2", reason: "Support review" }))).status)
      .toBe(409);
    expect(end).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenLastCalledWith("actor-1", "session-1");
  });

  it("returns a bounded recovery handle if start compensation itself fails", async () => {
    const handler = createImpersonationStartHandler({
      session: async () => platformActor,
      start: async () => session,
      refresh: async () => ({ ...activeLifecycleActor.claims, impersonationSessionId: null }),
      end: async () => { throw new Error("IMPERSONATION_END_FAILED"); },
    });

    const response = await handler(post({ tenantId: "tenant-2", reason: "Support review" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Impersonation start requires cleanup.",
      recovery: { sessionId: "session-1", expiresAt: "2026-08-17T00:30:00.000Z" },
    });
  });

  it("ends the named session and refuses cross-actor or post-end failures", async () => {
    const end = vi.fn(async () => ({ session: { ...session, endedAt: "2026-08-17T00:10:00.000Z" }, auditId: "audit-2" }));
    const clearedClaims = { ...activeLifecycleActor.claims, impersonatingTenant: null, impersonationSessionId: null };
    const handler = createImpersonationEndHandler({
      session: async () => activeLifecycleActor, end, refresh: async () => clearedClaims,
    });
    expect((await handler(post({ sessionId: "session-1" }))).status).toBe(200);
    expect(end).toHaveBeenCalledWith("actor-1", "session-1");
    const refused = createImpersonationEndHandler({
      session: async () => activeLifecycleActor,
      end: async () => { throw new Error("IMPERSONATION_SESSION_NOT_FOUND"); },
      refresh: async () => clearedClaims,
    });
    expect((await refused(post({ sessionId: "session-1" }))).status).toBe(409);

    const mismatched = createImpersonationEndHandler({
      session: async () => activeLifecycleActor,
      end,
      refresh: async () => clearedClaims,
    });
    expect((await mismatched(post({ sessionId: "session-other" }))).status).toBe(409);
  });
});

describe("proxy ingress boundaries", () => {
  const publicPaths = ["/api/webhooks/ghl", "/api/jobs/appointment-reconcile", "/api/health/live", "/api/health/ready"];

  it("admits exact ingress prefixes through the password arm but protects lookalikes", async () => {
    const proxy = createProxy({
      mode: () => "password",
      loadSession: async (request) => ({ response: NextResponse.next({ request }), claims: null }),
      password: () => crypto.randomUUID(),
      passwordAuthorized: async () => false,
    });
    for (const path of publicPaths) {
      expect((await proxy(new NextRequest(`https://setterfi.test${path}`))).headers.get("x-middleware-next")).toBe("1");
    }
    for (const path of ["/api/webhooksx/ghl", "/api/jobsx/run", "/api/private"]) {
      expect((await proxy(new NextRequest(`https://setterfi.test${path}`))).status).toBe(401);
    }
  });

  it("admits exact ingress prefixes through the Supabase arm and preserves handler gates", async () => {
    const proxy = createProxy({
      mode: () => "supabase",
      loadSession: async (request) => ({ response: NextResponse.next({ request }), claims: null }),
      password: () => null,
      passwordAuthorized: async () => false,
    });
    for (const path of publicPaths) {
      expect((await proxy(new NextRequest(`https://setterfi.test${path}`))).headers.get("x-middleware-next")).toBe("1");
    }
    expect((await proxy(new NextRequest("https://setterfi.test/api/webhooksx/ghl"))).status).toBe(401);

    vi.stubEnv("SETTERFI_PHASE1_LIVE", "true");
    const ingress = createGhlWebhookHandler({
      driver: {
        provider: "ghl",
        verifyWebhook: async () => false,
        normalizeInbound: async () => { throw new Error("unused"); },
        capabilities: () => ({ windowed: false, postWindow: "none", templates: false }),
        send: async () => ({ providerMessageId: "unused" }),
        reconcileInstall: async () => { throw new Error("unused"); },
      },
      resolveTenant: async () => null,
      persistReceipt: async () => { throw new Error("unused"); },
      processReceipt: async () => undefined,
      processUninstall: async () => { throw new Error("unused"); },
      schedule: () => undefined,
    });
    expect((await ingress(new Request("https://setterfi.test/api/webhooks/ghl", { method: "POST", body: "{}" }))).status).toBe(401);
  });

  it("keeps liveness dependency-free and readiness low-information after proxy admission", async () => {
    const live = await livenessRoute();
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toEqual({ status: "alive" });

    const ready = await createReadinessHandler(async () => ({
      status: "unready", configuration: true, database: true,
      automation: false, requiredProviders: true,
    }))();
    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toEqual({
      status: "unready", configuration: true, database: true,
      automation: false, requiredProviders: true,
    });
  });
});

// Phase 3 — Plan 03-07
describe("compliance route gates and deletion", () => {
  beforeEach(() => {
    vi.stubEnv("SETTERFI_PHASE1_LIVE", "true");
    vi.stubEnv("SETTERFI_PHASE3_LIVE", "true");
    vi.stubEnv("SETTERFI_CONTACT_DELETE_LIVE", "true");
  });

  it.each([
    "SETTERFI_PHASE1_LIVE",
    "SETTERFI_PHASE3_LIVE",
    "SETTERFI_CONTACT_DELETE_LIVE",
  ])("404s deletion before auth when %s is off", async (flag) => {
    vi.stubEnv(flag, "false");
    const session = vi.fn(async () => actor);
    const preview = vi.fn();
    const handler = createDeletionPreviewHandler({ session, preview });
    const response = await handler(post({}), context("contact-1"));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(session).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it("returns a tenant-bound preview envelope and refuses an impersonated session", async () => {
    const preview = vi.fn(async () => ({
      tenantId: "tenant-1",
      contactId: "contact-1",
      actorId: "actor-1",
      token: "synthetic-preview-token",
      expiresAt: "2026-08-17T00:15:00.000Z",
      reasonRequired: true as const,
      counts: {
        mergedContacts: 0, contactNotes: 0, unmatchedObjections: 0, mergeAuditsRedacted: 0,
        identities: 1, conversations: 1, messages: 2, messageTraces: 1,
        followups: 1, appointments: 0, billableEventsDetached: 0, evalCasesSevered: 0,
      },
      providerEffects: [],
      receipt: { actionKey: "contact.delete.preview" as const, auditId: 1, previewedAt: "2026-08-17T00:00:00.000Z" },
    }));
    const response = await createDeletionPreviewHandler({ session: async () => actor, preview })(
      post({}), context("contact-1"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ preview: { tenantId: "tenant-1", contactId: "contact-1" } });
    expect(preview).toHaveBeenCalledWith({ tenantId: "tenant-1", contactId: "contact-1", actorId: "actor-1" });

    const blocked = createDeletionPreviewHandler({ session: async () => null, preview });
    expect((await blocked(post({}), context("contact-1"))).status).toBe(401);
  });

  it("returns conflict for stale preview without widening the exact delete body", async () => {
    const remove = vi.fn(async () => ({ kind: "refused" as const, stage: "preview" as const, reason: "preview_stale" as const }));
    const handler = createContactDeleteHandler({ session: async () => actor, remove });
    const response = await handler(new Request("https://setterfi.test/api/contacts/contact-1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Approved synthetic request", previewToken: "token", idempotencyKey: "delete-1" }),
    }), context("contact-1"));
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-1", contactId: "contact-1" }));
  });

  it("returns the persisted replay receipt only when deletion reports deleted", async () => {
    const remove = vi.fn(async () => ({
      kind: "deleted" as const,
      auditId: 51,
      providerEvidence: { kind: "not_applicable" as const },
      tombstoneCount: 1,
      replayed: true,
    }));
    const response = await createContactDeleteHandler({ session: async () => actor, remove })(
      new Request("https://setterfi.test/api/contacts/contact-1", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Approved synthetic request", previewToken: "token", idempotencyKey: "delete-1" }),
      }),
      context("contact-1"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: {
      kind: "deleted", auditId: 51, providerEvidence: { kind: "not_applicable" },
      tombstoneCount: 1, replayed: true,
    } });
  });
});

// Phase 4 — Plan 04-06
describe("Meta and GHL Contract A route dependencies", () => {
  beforeEach(() => {
    vi.stubEnv("SETTERFI_PHASE1_LIVE", "true");
    vi.stubEnv("SETTERFI_PHASE4_LIVE", "true");
  });

  it("keeps both webhook routes on normalized batches rather than provider projections", async () => {
    const metaPersist = vi.fn(async (input) => ({
      id: "meta-receipt",
      ...input,
      status: "received" as const,
      inserted: true,
    }));
    const meta = createMetaWebhookHandler({
      driver: {
        verifyWebhook: async () => true,
        normalizeInbound: async () => ({ events: [{
          kind: "status",
          eventId: "meta-status-1",
          externalAccountId: "page-1",
          status: "delivered",
        }] }),
      },
      resolveTenant: async () => "tenant-1",
      persistReceipt: metaPersist,
      processReceipt: async () => undefined,
      schedule: () => undefined,
    });
    const metaResponse = await meta(new Request("https://setterfi.test/api/webhooks/meta", {
      method: "POST",
      headers: { "x-hub-signature-256": "synthetic" },
      body: JSON.stringify({ object: "page" }),
    }));
    expect(metaResponse.status).toBe(200);
    expect(metaPersist).toHaveBeenCalledWith(expect.objectContaining({ eventType: "Status" }));

    const ghlPersist = vi.fn(async (input) => ({
      id: "ghl-receipt",
      ...input,
      status: "received" as const,
      inserted: true,
    }));
    const ghl = createGhlWebhookHandler({
      driver: {
        provider: "ghl",
        verifyWebhook: async () => true,
        normalizeInbound: async () => ({ events: [{
          kind: "ignored",
          eventId: "ghl-ignored-1",
          externalAccountId: "location-1",
          reason: "echo",
        }] }),
        capabilities: () => ({ windowed: false, postWindow: "none", templates: false }),
        send: async () => ({ providerMessageId: "unused" }),
        reconcileInstall: async () => { throw new Error("unused"); },
      },
      resolveTenant: async () => "tenant-1",
      persistReceipt: ghlPersist,
      processReceipt: async () => undefined,
      processUninstall: async () => { throw new Error("unused"); },
      schedule: () => undefined,
    });
    const ghlResponse = await ghl(new Request("https://setterfi.test/api/webhooks/ghl", {
      method: "POST",
      headers: { "x-ghl-signature": "synthetic" },
      body: JSON.stringify({ type: "status" }),
    }));
    expect(ghlResponse.status).toBe(200);
    expect(ghlPersist).toHaveBeenCalledWith(expect.objectContaining({ eventType: "Ignored" }));
  });
});
