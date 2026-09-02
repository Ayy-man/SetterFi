import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  BASE_TENANT_EXPORT_RESOURCES,
  COACH_COMPOSITION_EXPORT_RESOURCES,
  COACH_OBJECTION_EXPORT_RESOURCES,
  createExportHandler,
  EXPORT_RESOURCES,
  exportResourceEnabled,
  PHASE2_EXPORT_RESOURCES,
  PHASE3_EXPORT_RESOURCES,
  PHASE4_EXPORT_RESOURCES,
  PHASE5_EXPORT_RESOURCES,
  PHASE6_EXPORT_RESOURCES,
  PHASE7_TENANT_EXPORT_RESOURCES,
  PHASE7_ECONOMICS_EXPORT_RESOURCES,
  PHASE7_OPERATIONAL_EXPORT_RESOURCES,
  PHASE7_PLATFORM_EXPORT_RESOURCES,
  PHASE7_EXPORT_EXCLUSION_VIEWS,
  PHASE7_REQUIRED_PLATFORM_EXPORT_ARMS,
  PHASE8_EXPORT_RESOURCES,
  PHASE8_PLATFORM_EXPORT_RESOURCES,
  PHASE8_TENANT_EXPORT_RESOURCES,
  OWNER_ADMIN_EXPORT_RESOURCES,
  PLATFORM_EXPORT_RESOURCES,
  RESOURCE_COLUMNS,
  phase4ExportRow,
  phase5ExportRow,
  phase6ExportRow,
  phase7MeasurementExportRows,
  phase7PlatformExportRows,
  phase8ExportRow,
  EXPORT_ACTOR_JOINS,
  exportAuditActorLabel,
  exportOwnerLabel,
  exportSupportAuthorLabel,
  type ExportCursor,
} from "@/app/api/exports/[resource]/handler";
import type { UserRole } from "@/lib/auth/claims";
import type { CoachMeasurement } from "@/lib/repositories/analytics";
import type { PlatformMeasurement } from "@/lib/repositories/platform-analytics";

const actor = {
  userId: "actor-1",
  tenantId: "tenant-1",
  role: "coach" as const,
};

const OBJECTION_ID = "8a000000-0000-4000-8000-000000000102";

const PHASE6_OWNER_ADMIN_RESOURCES = PHASE6_EXPORT_RESOURCES.filter(
  (resource): resource is Exclude<(typeof PHASE6_EXPORT_RESOURCES)[number], "affiliate-referrals"> => resource !== "affiliate-referrals",
);

function request(
  resource: string,
  query = "",
  signal?: AbortSignal,
) {
  return new Request(`https://setterfi.test/api/exports/${resource}${query}`, { signal });
}

function context(resource: "conversations" | "contacts" | string) {
  return { params: Promise.resolve({ resource }) };
}

function cursorFromPages(pages: Array<Array<Record<string, string | number | boolean | null>>>) {
  let index = 0;
  const close = vi.fn(async () => undefined);
  const cursor: ExportCursor = {
    nextPage: vi.fn(async () => pages[index++] ?? []),
    close,
  };
  return { cursor, close };
}

function dependencies(cursor: ExportCursor, overrides: {
  role?: UserRole;
  tenantId?: string | null;
  affiliateAccess?: boolean;
} = {}) {
  const start = vi.fn(async () => "audit-start-1");
  const finish = vi.fn(async () => undefined);
  const openCursor = vi.fn(async () => cursor);
  return {
    values: {
      enabled: () => true,
      session: async () => ({
        ...actor,
        role: overrides.role ?? actor.role,
        tenantId: overrides.tenantId === undefined ? actor.tenantId : overrides.tenantId,
        affiliateAccess: overrides.affiliateAccess
          ?? (overrides.role ?? actor.role) === "affiliate",
      }),
      start,
      finish,
      openCursor,
    },
    start,
    finish,
    openCursor,
  };
}

describe("tenant export route", () => {
  it("stays unavailable while the Phase 1 live flag is off", async () => {
    const { cursor } = cursorFromPages([]);
    const deps = dependencies(cursor);
    const response = await createExportHandler({ ...deps.values, enabled: () => false })(
      request("contacts"),
      context("contacts"),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.openCursor).not.toHaveBeenCalled();
  });

  it("flushes the CSV header before the first tenant query resolves", async () => {
    let resolvePage: ((rows: []) => void) | undefined;
    const firstPage = new Promise<[]>((resolve) => { resolvePage = resolve; });
    const cursor: ExportCursor = {
      nextPage: vi.fn(() => firstPage),
      close: vi.fn(async () => undefined),
    };
    const deps = dependencies(cursor);
    const handler = createExportHandler(deps.values);
    const response = await handler(
      request("contacts", "?format=csv&columns=name,lastActivity"),
      context("contacts"),
    );
    const reader = response.body!.getReader();
    const header = await reader.read();

    expect(Array.from(header.value!.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(header.value!.slice(3))).toBe("\"name\",\"lastActivity\"\r\n");
    expect(cursor.nextPage).toHaveBeenCalledTimes(1);
    resolvePage?.([]);
    await reader.read();
    expect(deps.finish).toHaveBeenCalledWith(expect.objectContaining({ rowCount: 0 }));
  });

  it("streams stable CSV pages, escapes formulas, and records exact row and byte counts", async () => {
    const { cursor } = cursorFromPages([
      [{ lead: "=2+2", channel: "SMS", status: "Agent active", lastMessage: "First", lastActivity: "2026-08-17T02:00:00Z", demoData: true, testData: true }],
      [{ lead: "Second", channel: "SMS", status: "Closed", lastMessage: "Done", lastActivity: "2026-08-17T01:00:00Z", demoData: true, testData: true }],
      [],
    ]);
    const deps = dependencies(cursor);
    const handler = createExportHandler(deps.values);
    const response = await handler(
      request("conversations", "?format=csv&columns=lead,status&channel=sms&outcome=all&stage=all"),
      context("conversations"),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="setterfi-conversations.csv"');
    expect(body).toBe("\"lead\",\"status\"\r\n\"'=2+2\",\"Agent active\"\r\n\"Second\",\"Closed\"\r\n");
    expect(deps.openCursor).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      pageSize: 500,
      filter: expect.objectContaining({ channel: "sms", order: "last_activity_desc" }),
    }));
    expect(deps.finish).toHaveBeenCalledWith(expect.objectContaining({
      startedAuditId: "audit-start-1",
      rowCount: 2,
      byteCount: new TextEncoder().encode(body).byteLength + 3,
    }));
  });

  it("streams more than 4.5MB incrementally without assembling a response payload", async () => {
    let page = 0;
    const fullPage = Array.from({ length: 500 }, (_, index) => ({
      name: `${page}-${index}-${"x".repeat(1_000)}`,
    }));
    const cursor: ExportCursor = {
      nextPage: vi.fn(async () => (page++ < 10 ? fullPage : [])),
      close: vi.fn(async () => undefined),
    };
    const deps = dependencies(cursor);
    const response = await createExportHandler(deps.values)(
      request("contacts", "?format=json&columns=name"),
      context("contacts"),
    );
    const reader = response.body!.getReader();
    let chunks = 0;
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks += 1;
      bytes += next.value.byteLength;
    }

    expect(bytes).toBeGreaterThan(4.5 * 1024 * 1024);
    expect(chunks).toBeGreaterThan(10);
    expect(cursor.nextPage).toHaveBeenCalledTimes(11);
    expect(deps.finish).toHaveBeenCalledWith(expect.objectContaining({ rowCount: 5_000, byteCount: bytes }));
  });

  it("streams JSON with exact allowlisted projection keys and no telemetry fields", async () => {
    const { cursor } = cursorFromPages([[
      {
        name: "Ada",
        channels: "SMS: +15550000000",
        creditRange: "700+",
        fundingGoal: "$50K",
        timeline: "Now",
        decision: "BOOK",
        pipelineStage: "booked",
        lastActivity: "2026-08-17T00:00:00Z",
        demoData: true,
        testData: true,
        model: "must-not-leak",
        cost: 99,
        latency: 10,
        tokenCount: 20,
        margin: 0.8,
        message_traces: "must-not-leak",
      },
    ], []]);
    const deps = dependencies(cursor);
    const handler = createExportHandler(deps.values);
    const response = await handler(request("contacts", "?format=json"), context("contacts"));
    const body = await response.text();
    const rows = JSON.parse(body) as Array<Record<string, unknown>>;

    expect(response.headers.get("content-type")).toContain("application/json");
    expect(Object.keys(rows[0])).toEqual([
      "name",
      "channels",
      "creditRange",
      "fundingGoal",
      "timeline",
      "decision",
      "pipelineStage",
      "lastActivity",
      "demoData",
      "testData",
    ]);
    expect(body).not.toMatch(/model|cost|latency|token|margin|message_traces/);
    expect(deps.finish).toHaveBeenCalledWith(expect.objectContaining({
      rowCount: 1,
      byteCount: new TextEncoder().encode(body).byteLength,
    }));
  });

  it("leaves only export.started when the browser cancels mid-flight", async () => {
    const close = vi.fn(async () => undefined);
    const cursor: ExportCursor = {
      nextPage: vi.fn(() => new Promise<Array<Record<string, string | number | boolean | null>>>(() => undefined)),
      close,
    };
    const deps = dependencies(cursor);
    const handler = createExportHandler(deps.values);
    const response = await handler(
      request("contacts", "?format=json&columns=name"),
      context("contacts"),
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await Promise.resolve();

    expect(deps.start).toHaveBeenCalledTimes(1);
    expect(deps.finish).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("refuses a 100,001st row without writing export.finished", async () => {
    let pages = 0;
    const fullPage = Array.from({ length: 500 }, () => ({ name: "x" }));
    const cursor: ExportCursor = {
      nextPage: vi.fn(async () => (pages++ < 201 ? fullPage : [])),
      close: vi.fn(async () => undefined),
    };
    const deps = dependencies(cursor);
    const handler = createExportHandler(deps.values);
    const response = await handler(
      request("contacts", "?format=json&columns=name"),
      context("contacts"),
    );

    await expect(response.text()).rejects.toThrow(/EXPORT_ROW_LIMIT_EXCEEDED/);
    expect(deps.start).toHaveBeenCalledTimes(1);
    expect(deps.finish).not.toHaveBeenCalled();
  });

  it("refuses anonymous, build, affiliate, and cross-tenant exports before opening a cursor", async () => {
    const { cursor } = cursorFromPages([]);
    const anonymous = dependencies(cursor);
    expect((await createExportHandler({ ...anonymous.values, session: async () => null })(request("contacts"), context("contacts"))).status).toBe(401);

    for (const role of ["build", "affiliate"] as const) {
      const denied = dependencies(cursor, { role });
      expect((await createExportHandler(denied.values)(request("contacts"), context("contacts"))).status).toBe(403);
      expect(denied.openCursor).not.toHaveBeenCalled();
    }

    const confused = dependencies(cursor);
    const response = await createExportHandler(confused.values)(
      request("contacts", "?tenantId=tenant-2"),
      context("contacts"),
    );
    expect(response.status).toBe(403);
    expect(confused.start).not.toHaveBeenCalled();
    expect(confused.openCursor).not.toHaveBeenCalled();
  });

  it.each([
    "contacts", "conversations", "coach-support-messages", "support-messages",
    "support-threads", "success-client-book",
  ])("refuses build access to lead-data resource %s before parse, audit, or cursor", async (resource) => {
    const { cursor } = cursorFromPages([]);
    const deps = dependencies(cursor, { role: "build", tenantId: null });
    const response = await createExportHandler(deps.values)(
      request(resource, "?where=malformed"), context(resource),
    );
    expect(response.status).toBe(403);
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.openCursor).not.toHaveBeenCalled();
  });

  it("refuses unknown resources, filters, order, columns, and formats instead of widening scope", async () => {
    const { cursor } = cursorFromPages([]);
    const cases = [
      ["messages", ""],
      ["contacts", "?format=xml"],
      ["contacts", "?order=name_asc"],
      ["contacts", "?columns=name,cost"],
      ["contacts", "?where=tenant_id.eq.tenant-2"],
      ["conversations", "?channel=other"],
    ] as const;

    for (const [resource, query] of cases) {
      const deps = dependencies(cursor);
      const response = await createExportHandler(deps.values)(
        new Request(`https://setterfi.test/api/exports/${resource}${query}`),
        context(resource),
      );
      expect(response.status).toBe(400);
      expect(deps.start).not.toHaveBeenCalled();
      expect(deps.openCursor).not.toHaveBeenCalled();
    }
  });

  it("carries the objection filter into the conversations export and nowhere else", async () => {
    const { cursor } = cursorFromPages([[]]);
    const deps = dependencies(cursor);
    const response = await createExportHandler(deps.values)(
      request("conversations", `?format=json&objection=${OBJECTION_ID}`),
      context("conversations"),
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(deps.openCursor).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      filter: expect.objectContaining({ objection: OBJECTION_ID }),
    }));

    // Absent leaves the export byte-identical to its current output: no `objection` key at all.
    const plain = cursorFromPages([[]]);
    const plainDeps = dependencies(plain.cursor);
    await (await createExportHandler(plainDeps.values)(
      request("conversations", "?format=json"), context("conversations"),
    )).text();
    const [call] = plainDeps.openCursor.mock.calls as unknown as Array<[{ filter: object }]>;
    expect(Object.keys(call[0].filter)).not.toContain("objection");
  });

  it("closes the objection grammar: not a uuid, and not on any other resource", async () => {
    const refused = [
      ["conversations", "?objection=not-a-uuid"],
      ["conversations", "?objection=8a000000-0000-4000-8000-00000000010"],
      ["contacts", `?objection=${OBJECTION_ID}`],
      ["coach-lead-composition", `?objection=${OBJECTION_ID}`],
      ["coach-measurement-keywords", `?objection=${OBJECTION_ID}`],
      ["brain-objections", `?reason=audit&objection=${OBJECTION_ID}`],
    ] as const;

    for (const [resource, query] of refused) {
      const { cursor } = cursorFromPages([]);
      const deps = dependencies(cursor, { role: "admin", tenantId: null });
      const response = await createExportHandler(deps.values)(
        request(resource, query), context(resource),
      );
      expect(response.status, `${resource}${query}`).toBe(400);
      expect(deps.openCursor).not.toHaveBeenCalled();
    }
  });
});

describe("Phase 2 export route", () => {
  it.each(PHASE2_EXPORT_RESOURCES)("404s %s before auth, audit, or data access when Phase 2 is off", async (resource) => {
    const { cursor } = cursorFromPages([]);
    const deps = dependencies(cursor);
    const session = vi.fn(deps.values.session);
    const response = await createExportHandler({ ...deps.values, enabled: () => false, session })(
      request(resource),
      context(resource),
    );

    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.openCursor).not.toHaveBeenCalled();
  });

  it.each(PLATFORM_EXPORT_RESOURCES)("requires a nonblank reason for platform resource %s", async (resource) => {
    const { cursor } = cursorFromPages([]);
    const deps = dependencies(cursor, { role: "admin", tenantId: null });
    for (const query of ["", "?reason=%20%20%20"]) {
      const response = await createExportHandler(deps.values)(request(resource, query), context(resource));
      expect(response.status).toBe(400);
    }
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.openCursor).not.toHaveBeenCalled();
  });

  it("streams a platform export through a reason-bound start and exact finish receipt", async () => {
    const { cursor } = cursorFromPages([[
      {
        version: 4,
        contentHash: "a".repeat(64),
        sourceHash: "b".repeat(64),
        knowledgeMode: "retrieved",
        publishedAt: "2026-08-17T00:00:00Z",
        rollbackOfSnapshotId: null,
        embedding: "must-not-leak",
        payload: "must-not-leak",
        providerCredential: "must-not-leak",
      },
    ], []]);
    const deps = dependencies(cursor, { role: "admin", tenantId: null });
    const response = await createExportHandler(deps.values)(
      request("brain-snapshot-diffs", "?format=json&reason=incident-review"),
      context("brain-snapshot-diffs"),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual([{
      version: 4,
      contentHash: "a".repeat(64),
      sourceHash: "b".repeat(64),
      knowledgeMode: "retrieved",
      publishedAt: "2026-08-17T00:00:00Z",
      rollbackOfSnapshotId: null,
    }]);
    expect(body).not.toMatch(/embedding|payload|credential/i);
    expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: null,
      actorId: actor.userId,
      resource: "brain-snapshot-diffs",
      reason: "incident-review",
    }));
    expect(deps.finish).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: null,
      resource: "brain-snapshot-diffs",
      reason: "incident-review",
      rowCount: 1,
      byteCount: new TextEncoder().encode(body).byteLength,
    }));
  });

  it("leaves platform export.started without a finish when its stream is canceled", async () => {
    const close = vi.fn(async () => undefined);
    const cursor: ExportCursor = {
      nextPage: vi.fn(() => new Promise<Array<Record<string, string | number | boolean | null>>>(() => undefined)),
      close,
    };
    const deps = dependencies(cursor, { role: "success", tenantId: null });
    const response = await createExportHandler(deps.values)(
      request("brain-import-batches", "?format=json&reason=review"),
      context("brain-import-batches"),
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await Promise.resolve();

    expect(deps.start).toHaveBeenCalledTimes(1);
    expect(deps.finish).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("refuses tenant ids on platform exports and cross-tenant ids on tenant configuration exports", async () => {
    const { cursor } = cursorFromPages([]);
    const platform = dependencies(cursor, { role: "admin", tenantId: null });
    const platformResponse = await createExportHandler(platform.values)(
      request("brain-import-items", "?reason=review&tenantId=tenant-request"),
      context("brain-import-items"),
    );
    expect(platformResponse.status).toBe(400);
    expect(platform.start).not.toHaveBeenCalled();

    const tenant = dependencies(cursor);
    const tenantResponse = await createExportHandler(tenant.values)(
      request("offer-prices", "?tenantId=tenant-other"),
      context("offer-prices"),
    );
    expect(tenantResponse.status).toBe(403);
    expect(tenant.start).not.toHaveBeenCalled();

    const keywordResponse = await createExportHandler(tenant.values)(
      request("keyword-goals", "?tenantId=tenant-other"),
      context("keyword-goals"),
    );
    expect(keywordResponse.status).toBe(403);
    expect(tenant.openCursor).not.toHaveBeenCalled();
  });

  it("refuses tenant roles on platform data before audit or cursor work", async () => {
    const { cursor } = cursorFromPages([]);
    const deps = dependencies(cursor, { role: "coach" });
    const response = await createExportHandler(deps.values)(
      request("eval-gate-results", "?reason=review"),
      context("eval-gate-results"),
    );
    expect(response.status).toBe(403);
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.openCursor).not.toHaveBeenCalled();
  });

  it.each([
    ["brain-import-batches", "?reason=review&columns=id,collectionRef"],
    ["brain-import-items", "?reason=review&columns=id,afterPayload"],
    ["brain-knowledge-entries", "?reason=review&columns=id,embedding"],
    ["brain-objections", "?reason=review&columns=id,pattern"],
    ["brain-snapshots", "?reason=review&columns=id,payload"],
    ["eval-gate-results", "?reason=review&columns=id,costCents"],
    ["offer-assets", "?columns=id,tenantId"],
    ["keyword-goals", "?columns=id,providerReceipt"],
  ])("refuses non-visible or sensitive columns for %s", async (resource, query) => {
    const { cursor } = cursorFromPages([]);
    const platform = PLATFORM_EXPORT_RESOURCES.includes(resource as never);
    const deps = dependencies(cursor, platform ? { role: "admin", tenantId: null } : {});
    const response = await createExportHandler(deps.values)(request(resource, query), context(resource));
    expect(response.status).toBe(400);
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.openCursor).not.toHaveBeenCalled();
  });
});

describe("Phase 4 export route", () => {
  it.each(PHASE4_EXPORT_RESOURCES)(
    "404s %s before auth, audit, or data access when Phase 4 is off",
    async (resource) => {
      const { cursor } = cursorFromPages([]);
      const deps = dependencies(cursor);
      const session = vi.fn(deps.values.session);
      const response = await createExportHandler({ ...deps.values, enabled: () => false, session })(
        request(resource),
        context(resource),
      );

      expect(response.status).toBe(404);
      expect(session).not.toHaveBeenCalled();
      expect(deps.start).not.toHaveBeenCalled();
      expect(deps.openCursor).not.toHaveBeenCalled();
    },
  );

  it("keeps existing resources on their original gates while Phase 4 resources stay off", () => {
    const environment = {
      SETTERFI_PHASE1_LIVE: "true",
      SETTERFI_PHASE2_LIVE: "true",
      SETTERFI_PHASE4_LIVE: "false",
    };

    expect(exportResourceEnabled("contacts", environment)).toBe(true);
    expect(exportResourceEnabled("offer-prices", environment)).toBe(true);
    for (const resource of PHASE4_EXPORT_RESOURCES) {
      expect(exportResourceEnabled(resource, environment)).toBe(false);
    }
  });

  it("streams every Phase 4 resource as a tenant export with exact projection and byte receipts", async () => {
    const { cursor } = cursorFromPages([[
      {
        id: "identity-1",
        contactId: "contact-1",
        channel: "sms",
        address: "+15550000000",
        consentState: "opted_in",
        windowExpiresAt: null,
        createdAt: "2026-08-17T00:00:00Z",
        dataLabel: "Demo",
        testData: true,
        tenantId: "tenant-other",
        ciphertext: "must-not-leak",
        accessToken: "must-not-leak",
      },
    ], []]);
    const deps = dependencies(cursor);
    const response = await createExportHandler(deps.values)(
      request("contact-identities", "?format=json&columns=id,contactId,dataLabel,testData"),
      context("contact-identities"),
    );
    const body = await response.text();

    expect(JSON.parse(body)).toEqual([{
      id: "identity-1",
      contactId: "contact-1",
      dataLabel: "Demo",
      testData: true,
    }]);
    expect(body).not.toMatch(/tenant-other|ciphertext|accessToken|must-not-leak/);
    expect(deps.openCursor).toHaveBeenCalledWith(expect.objectContaining({
      resource: "contact-identities",
      tenantId: "tenant-1",
      filter: { search: "", channel: "all", status: "all", order: "created_desc" },
    }));
    expect(deps.finish).toHaveBeenCalledWith(expect.objectContaining({
      resource: "contact-identities",
      rowCount: 1,
      byteCount: new TextEncoder().encode(body).byteLength,
    }));
  });

  it("derives candidate Demo and test-boundary labels from both joined contacts", () => {
    expect(phase4ExportRow("suspected-duplicates", {
      id: "candidate-1",
      contact_a_id: "contact-a",
      contact_b_id: "contact-b",
      source: "field_match",
      evidence_key: "synthetic-match",
      state: "open",
      created_at: "2026-08-17T00:00:00Z",
      tenant: { is_demo: true },
      contact_a: { id: "contact-a", name: "Synthetic A", is_test: false },
      contact_b: { id: "contact-b", name: "Synthetic B", is_test: true },
      evidence: { ciphertext: "must-not-leak" },
    })).toEqual({
      id: "candidate-1",
      contactAId: "contact-a",
      contactAName: "Synthetic A",
      contactBId: "contact-b",
      contactBName: "Synthetic B",
      source: "field_match",
      evidenceKey: "synthetic-match",
      state: "open",
      createdAt: "2026-08-17T00:00:00Z",
      testBoundary: "mixed",
      dataLabel: "Demo",
    });
  });

  it("uses resource-specific filters instead of parsing every Phase 4 resource as contacts", async () => {
    const { cursor } = cursorFromPages([[]]);
    const accepted = [
      ["contact-identities", "?status=opted_in&channel=sms"],
      ["suspected-duplicates", "?status=open"],
      ["message-templates", "?status=approved&channel=whatsapp"],
      ["channel-connections", "?status=live&channel=instagram"],
      ["merge-history", ""],
    ] as const;
    for (const [resource, query] of accepted) {
      const deps = dependencies(cursor);
      const response = await createExportHandler(deps.values)(
        request(resource, `${query}${query ? "&" : "?"}format=json`),
        context(resource),
      );
      await response.text();
      expect(response.status).toBe(200);
      expect(deps.start).toHaveBeenCalledTimes(1);
    }

    const refused = [
      ["contact-identities", "?status=approved"],
      ["suspected-duplicates", "?channel=sms"],
      ["message-templates", "?status=total"],
      ["channel-connections", "?status=booked"],
      ["merge-history", "?status=open"],
    ] as const;
    for (const [resource, query] of refused) {
      const deps = dependencies(cursor);
      const response = await createExportHandler(deps.values)(
        request(resource, query),
        context(resource),
      );
      expect(response.status).toBe(400);
      expect(deps.start).not.toHaveBeenCalled();
    }
  });

  it.each([
    "channel-oauth-states",
    "channel-connection-secrets",
    "ghl-install-secrets",
    "channel-operation-receipts",
  ])("rejects secret or internal resource %s before audit and data access", async (resource) => {
    const { cursor } = cursorFromPages([]);
    const deps = dependencies(cursor);
    const response = await createExportHandler(deps.values)(request(resource), context(resource));

    expect(response.status).toBe(400);
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.openCursor).not.toHaveBeenCalled();
  });

  it.each([
    ["contact-identities", "?columns=id,provider"],
    ["suspected-duplicates", "?columns=id,evidence"],
    ["message-templates", "?columns=id,providerTemplateId"],
    ["channel-connections", "?columns=id,externalAccountId"],
    ["merge-history", "?columns=auditId,payload"],
  ])("refuses hidden Phase 4 columns for %s", async (resource, query) => {
    const { cursor } = cursorFromPages([]);
    const deps = dependencies(cursor);
    const response = await createExportHandler(deps.values)(request(resource, query), context(resource));

    expect(response.status).toBe(400);
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.openCursor).not.toHaveBeenCalled();
  });
});

describe("Phase 3 export route", () => {
  it.each(PHASE3_EXPORT_RESOURCES)("404s %s before auth or cursor work when Phase 3 is off", async (resource) => {
    const { cursor } = cursorFromPages([]);
    const deps = dependencies(cursor);
    const session = vi.fn(deps.values.session);
    const response = await createExportHandler({ ...deps.values, enabled: () => false, session })(
      request(resource), context(resource),
    );
    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(deps.openCursor).not.toHaveBeenCalled();
  });

  it("streams tenant follow-ups with scheduler state and no hidden payload", async () => {
    const { cursor } = cursorFromPages([[
      {
        id: "followup-1", conversationId: "conversation-1", contactId: "contact-1",
        channel: "sms", purpose: "lead_magnet", touchNo: 1, status: "scheduled",
        scheduledAt: "2026-08-18T10:00:00.000Z", sentAt: null, canceledReason: null,
        pausedAt: null, deferredCount: 0, attemptCount: 1, testData: true,
        identifier_hash: "must-not-leak", body: "must-not-leak",
      },
    ], []]);
    const deps = dependencies(cursor);
    const response = await createExportHandler(deps.values)(
      request("followups", "?format=json&status=scheduled"), context("followups"),
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(body)[0]).toMatchObject({ id: "followup-1", status: "scheduled", testData: true });
    expect(body).not.toMatch(/identifier_hash|must-not-leak|body/);
    expect(deps.openCursor).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-1" }));
  });

  it("keeps suppression tombstones platform-wide, reason-bound, and free of raw identifiers", async () => {
    const { cursor } = cursorFromPages([[
      {
        id: "tombstone-1", tenantId: "tenant-1", channel: "sms", identifierLast4: "4567",
        deletionAuditId: 51, createdAt: "2026-08-17T00:00:00.000Z",
        identifierHash: "must-not-leak", identifier: "+15551234567",
      },
    ], []]);
    const coach = dependencies(cursor);
    expect((await createExportHandler(coach.values)(
      request("suppression-tombstones", "?reason=review"), context("suppression-tombstones"),
    )).status).toBe(403);

    const platform = dependencies(cursor, { role: "admin", tenantId: null });
    const response = await createExportHandler(platform.values)(
      request("suppression-tombstones", "?format=json&reason=privacy-review"),
      context("suppression-tombstones"),
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(body)[0]).toEqual({
      id: "tombstone-1", tenantId: "tenant-1", channel: "sms", identifierLast4: "4567",
      deletionAuditId: 51, createdAt: "2026-08-17T00:00:00.000Z",
    });
    expect(body).not.toMatch(/must-not-leak|identifierHash|\+1555/);
    expect(platform.start).toHaveBeenCalledWith(expect.objectContaining({ tenantId: null, reason: "privacy-review" }));
    expect(platform.openCursor).toHaveBeenCalledWith(expect.objectContaining({ tenantId: null }));
  });

  it("keeps prior resources on their own gates while Phase 3 resources require both Phase 1 and 3", () => {
    const environment = {
      SETTERFI_PHASE1_LIVE: "true",
      SETTERFI_PHASE2_LIVE: "true",
      SETTERFI_PHASE3_LIVE: "false",
      SETTERFI_PHASE4_LIVE: "true",
    };
    expect(exportResourceEnabled("contacts", environment)).toBe(true);
    expect(exportResourceEnabled("contact-identities", environment)).toBe(true);
    expect(exportResourceEnabled("followups", environment)).toBe(false);
    expect(exportResourceEnabled("suppression-tombstones", environment)).toBe(false);
  });
});

describe("Phase 5 export route", () => {
  it.each(PHASE5_EXPORT_RESOURCES)("404s %s before auth, audit, or data access when Phase 5 is off", async (resource) => {
    const { cursor } = cursorFromPages([]);
    const deps = dependencies(cursor, { role: "admin", tenantId: null });
    const session = vi.fn(deps.values.session);
    const response = await createExportHandler({ ...deps.values, enabled: () => false, session })(
      request(resource, "?reason=review"), context(resource),
    );
    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.openCursor).not.toHaveBeenCalled();
  });

  it("keeps prior tenant/platform gates unchanged while Phase 5 uses only its own flag", () => {
    const environment = {
      SETTERFI_PHASE1_LIVE: "true",
      SETTERFI_PHASE2_LIVE: "true",
      SETTERFI_PHASE3_LIVE: "true",
      SETTERFI_PHASE4_LIVE: "true",
      SETTERFI_PHASE5_LIVE: "false",
    };
    expect(exportResourceEnabled("contacts", environment)).toBe(true);
    expect(exportResourceEnabled("brain-snapshots", environment)).toBe(true);
    for (const resource of PHASE5_EXPORT_RESOURCES) expect(exportResourceEnabled(resource, environment)).toBe(false);
    expect(exportResourceEnabled("provisioning-steps", { ...environment, SETTERFI_PHASE5_LIVE: "true" })).toBe(true);
  });

  it.each(PHASE5_EXPORT_RESOURCES)("streams an empty JSON array for authorized %s reads", async (resource) => {
    const { cursor } = cursorFromPages([[]]);
    const deps = dependencies(cursor, { role: "admin", tenantId: null });
    const response = await createExportHandler(deps.values)(
      request(resource, "?format=json&reason=onboarding-review"), context(resource),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("[]");
    expect(deps.openCursor).toHaveBeenCalledWith(expect.objectContaining({ resource, tenantId: null }));
    expect(deps.finish).toHaveBeenCalledWith(expect.objectContaining({ resource, rowCount: 0, reason: "onboarding-review" }));
  });

  it("refuses coach access, tenant selection, missing reasons, and hidden columns before data access", async () => {
    const { cursor } = cursorFromPages([]);
    const cases = [
      [dependencies(cursor, { role: "coach" }), "?reason=review", 403],
      [dependencies(cursor, { role: "admin", tenantId: null }), "?reason=review&tenantId=tenant-1", 400],
      [dependencies(cursor, { role: "admin", tenantId: null }), "", 400],
      [dependencies(cursor, { role: "admin", tenantId: null }), "?reason=review&columns=id,externalRef", 400],
    ] as const;
    for (const [deps, query, status] of cases) {
      const response = await createExportHandler(deps.values)(
        request("provisioning-steps", query), context("provisioning-steps"),
      );
      expect(response.status).toBe(status);
      expect(deps.start).not.toHaveBeenCalled();
      expect(deps.openCursor).not.toHaveBeenCalled();
    }
  });

  it("redacts raw disclosure, actor, probe-target, auth, and provider fields from Phase 5 projections", () => {
    const secretFields = {
      marketing_language: "raw disclosure must not export",
      non_marketing_language: "raw non-marketing copy must not export",
      campaign_description: "raw campaign description must not export",
      confirmed_by: "actor-private",
      acknowledged_by: "actor-private",
      admin_confirmed_by: "actor-private",
      target_identifier_hash: "target-private",
      probe_key: "probe-private",
      provider_reference: "provider-private",
      auth_user_id: "auth-private",
      referral_code: "referral-private",
      external_ref: { payload: "provider-private" },
      idempotency_key: "internal-private",
    };
    const artifact = phase5ExportRow("onboarding-optin-artifacts", {
      id: "artifact-1", tenant_id: "tenant-1", version: 1, template_version: "synthetic-v1",
      marketing_language_hash: "a".repeat(64), non_marketing_language_hash: "b".repeat(64),
      terms_url: "https://example.test/terms", privacy_url: "https://example.test/privacy",
      campaign_description_hash: "c".repeat(64), artifact_hash: "d".repeat(64),
      placeholder: true, is_current: true, confirmed_at: null, created_at: "created", updated_at: "updated",
      tenant: { is_demo: true },
      ...secretFields,
    });
    const screen = phase5ExportRow("onboarding-content-screens", {
      id: "screen-1", tenant_id: "tenant-1", input_hash: "e".repeat(64), result: "flagged",
      matches: [{ phrase: "raw phrase", page: "/synthetic" }], is_current: true,
      acknowledged_at: "ack", admin_confirmed_at: null, created_at: "created", updated_at: "updated",
      ...secretFields,
    });
    const probe = phase5ExportRow("a2p-probe-receipts", {
      id: "probe-1", tenant_id: "tenant-1", result: "inconclusive", provider_code: "review",
      observed_at: "observed", created_at: "created", ...secretFields,
    });
    const signup = phase5ExportRow("signup-intents", {
      id: "intent-1", email: "synthetic@example.test", tenant_id: null, tier_id: null,
      timezone: "UTC", state: "started", error: null, created_at: "created", updated_at: "updated",
      ...secretFields,
    });
    const serialized = JSON.stringify([artifact, screen, probe, signup]);
    expect(artifact.dataLabel).toBe("Demo");
    expect(screen).toMatchObject({ matchCount: 1, matchedPages: "/synthetic" });
    expect(serialized).not.toMatch(/raw disclosure|raw non-marketing|raw campaign|raw phrase|actor-private|target-private|probe-private|provider-private|auth-private|referral-private|external_ref|idempotency/i);
  });

  /**
   * The A2P filing export is evidence of what was filed, so the placeholder URL that has been
   * sitting in the hosted database (`https://example.invalid/phase5-demo/privacy`) has to come out
   * of it exactly as stored. Nobody spotted it for weeks because nothing anywhere said the value
   * was unusable, and recognising an RFC 2606 name by eye is not a thing an admin should have to
   * do. `privacyUrlReachable` is the thing that says so -- beside the value, never instead of it.
   */
  it("reports a placeholder privacy URL as unreachable while exporting it unchanged", () => {
    const placeholderRow = phase5ExportRow("onboarding-optin-artifacts", {
      id: "artifact-2", tenant_id: "tenant-1", version: 1, template_version: "synthetic-v1",
      marketing_language_hash: "a".repeat(64), non_marketing_language_hash: "b".repeat(64),
      terms_url: "https://example.invalid/terms",
      privacy_url: "https://example.invalid/phase5-demo/privacy",
      campaign_description_hash: "c".repeat(64), artifact_hash: "d".repeat(64),
      placeholder: true, is_current: true, confirmed_at: null,
      created_at: "created", updated_at: "updated", tenant: { is_demo: false },
    });
    // The record stays faithful. Blanking the field would falsify the filing evidence, and the
    // export is how someone finds the bad value in the first place.
    expect(placeholderRow.privacyUrl).toBe("https://example.invalid/phase5-demo/privacy");
    expect(placeholderRow.privacyUrlReachable).toBe(false);

    const liveRow = phase5ExportRow("onboarding-optin-artifacts", {
      id: "artifact-3", tenant_id: "tenant-1", version: 2, template_version: "synthetic-v1",
      marketing_language_hash: "a".repeat(64), non_marketing_language_hash: "b".repeat(64),
      terms_url: "https://legacystrong.com/terms", privacy_url: "https://legacystrong.com/privacy",
      campaign_description_hash: "c".repeat(64), artifact_hash: "d".repeat(64),
      placeholder: false, is_current: true, confirmed_at: "confirmed",
      created_at: "created", updated_at: "updated", tenant: { is_demo: false },
    });
    expect(liveRow.privacyUrlReachable).toBe(true);

    // The flag is independent of the demo label and of `placeholder`. A demo tenant can hold a
    // real URL and a live tenant can hold a placeholder -- which is exactly how this one survived.
    expect(placeholderRow.dataLabel).toBeNull();
  });

  it("serves the reachability flag by default, so a download carries it without being asked", () => {
    // The column is only useful if it arrives unrequested: no screen names explicit columns for
    // this resource, and `parseExportQuery` falls back to the full contract when none are given.
    expect(RESOURCE_COLUMNS["onboarding-optin-artifacts"]).toContain("privacyUrlReachable");
  });

  it("keeps every Phase 5 source on the service-client database cursor and out of fixture modules", () => {
    const source = readFileSync(new URL("./[resource]/handler.ts", import.meta.url), "utf8");
    for (const table of [
      "provisioning_steps", "signup_intents", "onboarding_runs", "business_profiles",
      "onboarding_optin_artifacts", "onboarding_content_screens", "a2p_probe_receipts",
    ]) expect(source).toContain(`table: "${table}"`);
    expect(source).toContain("client.from(spec.table).select(spec.select)");
    expect(source).not.toMatch(/workspace-fixtures|fixture-workspace/);
    expect(EXPORT_RESOURCES).not.toContain("business-profile-sensitive");
  });
});

describe("Phase 6 export route", () => {
  it.each(PHASE6_EXPORT_RESOURCES)("404s %s before session or repository access when its flag is off", async (resource) => {
    const { cursor } = cursorFromPages([]);
    const deps = dependencies(cursor, { role: "admin", tenantId: null });
    const session = vi.fn(deps.values.session);
    const response = await createExportHandler({ ...deps.values, enabled: () => false, session })(
      request(resource, "?reason=review"), context(resource),
    );
    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.openCursor).not.toHaveBeenCalled();
  });

  it("uses the root flag for all resources and the affiliate child flag only for referrals", () => {
    const rootOff = { SETTERFI_PHASE1_LIVE: "true", SETTERFI_PHASE6_LIVE: "false" };
    const rootOn = { SETTERFI_PHASE6_LIVE: "true", SETTERFI_PHASE6_AFFILIATES_LIVE: "false" };
    for (const resource of PHASE6_EXPORT_RESOURCES) expect(exportResourceEnabled(resource, rootOff)).toBe(false);
    for (const resource of PHASE6_OWNER_ADMIN_RESOURCES) expect(exportResourceEnabled(resource, rootOn)).toBe(true);
    expect(exportResourceEnabled("affiliate-referrals", rootOn)).toBe(false);
    expect(exportResourceEnabled("affiliate-referrals", {
      ...rootOn,
      SETTERFI_PHASE6_AFFILIATES_LIVE: "true",
    })).toBe(true);
  });

  it.each(PHASE6_OWNER_ADMIN_RESOURCES)("returns 403 to success for owner/admin resource %s", async (resource) => {
    const { cursor } = cursorFromPages([]);
    const deps = dependencies(cursor, { role: "success", tenantId: null });
    const response = await createExportHandler(deps.values)(
      request(resource, "?reason=review"), context(resource),
    );
    expect(response.status).toBe(403);
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.openCursor).not.toHaveBeenCalled();
  });

  it.each([...PHASE6_OWNER_ADMIN_RESOURCES, "affiliate-referrals"])("returns 403 to coach for money resource %s", async (resource) => {
    const { cursor } = cursorFromPages([]);
    const deps = dependencies(cursor, { role: "coach" });
    const response = await createExportHandler(deps.values)(
      request(resource, resource === "affiliate-referrals" ? "" : "?reason=review"), context(resource),
    );
    expect(response.status).toBe(403);
    expect(deps.openCursor).not.toHaveBeenCalled();
  });

  it("allows an affiliate only their exact three-field referral projection", async () => {
    const { cursor } = cursorFromPages([[
      {
        businessName: "Synthetic Coach",
        accountStatus: "active",
        commissionEarnedUsd: "4.50",
        affiliateId: "must-not-leak",
        tenantId: "must-not-leak",
        marginCents: 999,
      },
    ], []]);
    const deps = dependencies(cursor, { role: "affiliate", tenantId: null });
    const response = await createExportHandler(deps.values)(
      request("affiliate-referrals", "?format=json"), context("affiliate-referrals"),
    );
    const rows = JSON.parse(await response.text()) as Array<Record<string, unknown>>;
    expect(response.status).toBe(200);
    expect(rows).toEqual([{
      businessName: "Synthetic Coach",
      accountStatus: "active",
      commissionEarnedUsd: "4.50",
    }]);
    expect(Object.keys(rows[0])).toEqual(["businessName", "accountStatus", "commissionEarnedUsd"]);
    expect(deps.openCursor).toHaveBeenCalledWith(expect.objectContaining({
      resource: "affiliate-referrals",
      tenantId: null,
    }));

    for (const resource of PHASE6_OWNER_ADMIN_RESOURCES) {
      const refused = dependencies(cursor, { role: "affiliate", tenantId: null });
      expect((await createExportHandler(refused.values)(
        request(resource, "?reason=review"), context(resource),
      )).status).toBe(403);
      expect(refused.openCursor).not.toHaveBeenCalled();
    }
  });

  /**
   * The affiliate capability, on the export half. The affiliate referral export is the control
   * drawn on `/affiliate` (`affiliate-money.tsx`, `resource="affiliate-referrals"`), so a
   * dual-role coach who can open that portal and read the table must be able to export the rows
   * they are already looking at. The gate is the `affiliates` row existing, never
   * `role = 'affiliate'`; the plain coach is the control that shows the capability is doing the
   * work, not the role.
   */
  it("exports the affiliate projection for a dual-role coach and refuses a coach with no affiliates row", async () => {
    const { cursor } = cursorFromPages([[
      { businessName: "Synthetic Coach", accountStatus: "active", commissionEarnedUsd: "4.50" },
    ], []]);
    const dual = dependencies(cursor, {
      role: "coach",
      tenantId: "tenant-1",
      affiliateAccess: true,
    });
    const response = await createExportHandler(dual.values)(
      request("affiliate-referrals", "?format=json"), context("affiliate-referrals"),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toEqual([{
      businessName: "Synthetic Coach",
      accountStatus: "active",
      commissionEarnedUsd: "4.50",
    }]);
    // The coach's own tenant must not scope an affiliate export; the affiliate is selected in SQL.
    expect(dual.openCursor).toHaveBeenCalledWith(expect.objectContaining({
      resource: "affiliate-referrals",
      tenantId: null,
    }));

    const plain = dependencies(cursor, {
      role: "coach",
      tenantId: "tenant-1",
      affiliateAccess: false,
    });
    const refused = await createExportHandler(plain.values)(
      request("affiliate-referrals", "?format=json"), context("affiliate-referrals"),
    );
    expect(refused.status).toBe(403);
    expect(plain.openCursor).not.toHaveBeenCalled();
  });

  it("keeps formula-injection escaping on the affiliate CSV arm", async () => {
    const { cursor } = cursorFromPages([[
      { businessName: "=2+2", accountStatus: "active", commissionEarnedUsd: "4.50" },
    ], []]);
    const deps = dependencies(cursor, { role: "affiliate", tenantId: null });
    const response = await createExportHandler(deps.values)(
      request("affiliate-referrals", "?format=csv"), context("affiliate-referrals"),
    );
    expect(await response.text()).toContain("\"'=2+2\"");
  });

  it("keeps incomplete cost exports free of any margin field", () => {
    const row = phase6ExportRow("billing-cost-rollups", {
      id: "rollup-1", tenant_id: "tenant-1", window_start: "start", window_end: "end",
      recognized_subscription_cents: 1_000, model_cents: 100, messaging_cents: null,
      embedding_cents: 20, complete: false, missing_sources: ["messaging"], computed_at: "now",
      tenant: { name: "Synthetic Coach", is_demo: true },
    });
    expect(row).not.toHaveProperty("margin");
    expect(JSON.stringify(row)).not.toMatch(/margin/i);
  });

  /**
   * A payout row that says only "approved" cannot answer the question anybody actually asks about
   * it months later. `commission_payout_events` has held the time, the actor and the audit id all
   * along; this pins that the projection reaches them, and that a missing display name comes out
   * as an absence rather than as an id standing in for a person.
   */
  it("projects when a payout was approved and by whom", () => {
    const ledgerRow = (actor: unknown) => ({
      id: "ledger-1", referral_id: "referral-1", commission_cents: 450, entry_kind: "accrual",
      reverses_ledger_id: null, created_at: "2026-08-28T10:00:00.000Z",
      referral: {
        affiliate_id: "affiliate-1",
        tenant: { name: "Synthetic Coach", is_demo: true },
        affiliate: { id: "affiliate-1", user: { full_name: "Dana Reyes" } },
      },
      commission_payout_items: {
        payout_id: "payout-1",
        commission_payouts: {
          id: "payout-1", total_cents: 450,
          commission_payout_events: [{
            id: "event-1", kind: "approved", reference: null, paid_on: null, audit_id: 51,
            created_at: "2026-08-28T12:30:00.000Z", actor,
          }],
        },
      },
    });

    const named = phase6ExportRow("affiliate-payouts", ledgerRow({ full_name: "Alec Delpuech" }));
    expect(named).toMatchObject({
      payoutState: "approved_for_payout",
      approvedAt: "2026-08-28T12:30:00.000Z",
      approvedBy: "Alec Delpuech",
      approvedAuditId: 51,
    });

    // `users.full_name` is nullable, so the name is genuinely absent for some actors.
    expect(phase6ExportRow("affiliate-payouts", ledgerRow({ full_name: null })))
      .toMatchObject({ approvedAt: "2026-08-28T12:30:00.000Z", approvedBy: null });
  });

  it("keeps the closed ExportMenu union aligned with every Phase 6 route resource", () => {
    const source = readFileSync(new URL("../../../components/kit/export-menu.tsx", import.meta.url), "utf8");
    for (const resource of PHASE6_EXPORT_RESOURCES) expect(source).toContain(`\"${resource}\"`);
  });
});

describe("Phase 7 coach measurement export route", () => {
  const measurementColumns = {
    "coach-measurement-keywords": [
      "keyword", "conversations", "qualifiedContacts", "respondedConversations", "bookedContacts",
      "optInDenominator", "qualifiedDenominator", "bookedDenominator", "dataLabel",
    ],
    "coach-measurement-steps": [
      "stepKey", "stepLabel", "enteredContacts", "completedContacts", "askedContacts",
      "answeredContacts", "responseRate", "dataLabel",
    ],
    "coach-pipeline": [
      "contactId", "displayName", "stage", "attributedToAgent", "latestAppointmentStatus",
      "changedAt", "dataLabel",
    ],
  } as const;

  it.each(PHASE7_TENANT_EXPORT_RESOURCES)(
    "404s %s before session, audit, or repository access when analytics is off",
    async (resource) => {
      const { cursor } = cursorFromPages([]);
      const deps = dependencies(cursor);
      const session = vi.fn(deps.values.session);
      const response = await createExportHandler({
        ...deps.values,
        enabled: (candidate) => exportResourceEnabled(candidate, {
          SETTERFI_PHASE1_LIVE: "true",
          SETTERFI_PHASE7_LIVE: "true",
          SETTERFI_PHASE7_ANALYTICS_LIVE: "false",
        }),
        session,
      })(request(resource), context(resource));

      expect(response.status).toBe(404);
      expect(session).not.toHaveBeenCalled();
      expect(deps.start).not.toHaveBeenCalled();
      expect(deps.openCursor).not.toHaveBeenCalled();
    },
  );

  it("uses the Phase 7 root and analytics child flags without falling through to Phase 1", () => {
    const phase1Only = { SETTERFI_PHASE1_LIVE: "true" };
    const childOnly = { SETTERFI_PHASE7_ANALYTICS_LIVE: "true" };
    const phase7Live = {
      SETTERFI_PHASE7_LIVE: "true",
      SETTERFI_PHASE7_ANALYTICS_LIVE: "true",
    };

    expect(exportResourceEnabled("contacts", phase1Only)).toBe(true);
    for (const resource of PHASE7_TENANT_EXPORT_RESOURCES) {
      expect(exportResourceEnabled(resource, phase1Only)).toBe(false);
      expect(exportResourceEnabled(resource, childOnly)).toBe(false);
      expect(exportResourceEnabled(resource, phase7Live)).toBe(true);
    }
  });

  it("keeps each rendered header tuple exact and every export resource in one ownership array", () => {
    for (const resource of PHASE7_TENANT_EXPORT_RESOURCES) {
      expect(RESOURCE_COLUMNS[resource]).toEqual(measurementColumns[resource]);
    }
    const ownership = [
      ...BASE_TENANT_EXPORT_RESOURCES,
      ...PHASE2_EXPORT_RESOURCES,
      ...PHASE3_EXPORT_RESOURCES,
      ...PHASE4_EXPORT_RESOURCES,
      ...PHASE5_EXPORT_RESOURCES,
      ...PHASE6_EXPORT_RESOURCES,
      ...PHASE7_TENANT_EXPORT_RESOURCES,
      ...COACH_COMPOSITION_EXPORT_RESOURCES,
      ...PHASE7_PLATFORM_EXPORT_RESOURCES,
      // Phase 8
      ...PHASE8_EXPORT_RESOURCES,
      // Phase 10
      ...COACH_OBJECTION_EXPORT_RESOURCES,
    ];
    expect([...ownership].sort()).toEqual([...EXPORT_RESOURCES].sort());
    expect(new Set(ownership).size).toBe(EXPORT_RESOURCES.length);
  });

  it("returns an explicit enabled decision for every registered resource", () => {
    const allLive = {
      SETTERFI_PHASE1_LIVE: "true",
      SETTERFI_PHASE2_LIVE: "true",
      SETTERFI_PHASE3_LIVE: "true",
      SETTERFI_PHASE4_LIVE: "true",
      SETTERFI_PHASE5_LIVE: "true",
      SETTERFI_PHASE6_LIVE: "true",
      SETTERFI_PHASE6_AFFILIATES_LIVE: "true",
      SETTERFI_PHASE7_LIVE: "true",
      SETTERFI_PHASE7_ANALYTICS_LIVE: "true",
      SETTERFI_PHASE7_EVALS_LIVE: "true",
      SETTERFI_PHASE8_LIVE: "true",
      SETTERFI_PHASE8_EXPORTS_LIVE: "true",
      SETTERFI_BRAIN_OBJECTIONS_LIVE: "true",
    };
    expect(EXPORT_RESOURCES.map((resource) => exportResourceEnabled(resource, allLive)))
      .toEqual(EXPORT_RESOURCES.map(() => true));
  });

  it("exports the top objections at the exact seven-column tuple in both formats", async () => {
    const row = {
      objectionId: OBJECTION_ID,
      label: "Not right now",
      state: "awaiting_definition",
      bookedRate: null,
      conversationCount: 12,
      windowStart: "2026-07-23T12:00:00.000Z",
      windowEnd: "2026-08-22T12:00:00.000Z",
    };
    expect(RESOURCE_COLUMNS["coach-top-objections"]).toEqual([
      "objectionId", "label", "state", "bookedRate", "conversationCount", "windowStart", "windowEnd",
    ]);

    const csv = cursorFromPages([[row], []]);
    const csvBody = await (await createExportHandler(dependencies(csv.cursor).values)(
      request("coach-top-objections", "?format=csv"), context("coach-top-objections"),
    )).text();
    expect(csvBody.replace("﻿", "").split("\r\n")[0]).toBe(
      "\"objectionId\",\"label\",\"state\",\"bookedRate\",\"conversationCount\",\"windowStart\",\"windowEnd\"",
    );

    const json = cursorFromPages([[row], []]);
    const jsonBody = await (await createExportHandler(dependencies(json.cursor).values)(
      request("coach-top-objections", "?format=json"), context("coach-top-objections"),
    )).text();
    expect(Object.keys(JSON.parse(jsonBody)[0])).toEqual([
      "objectionId", "label", "state", "bookedRate", "conversationCount", "windowStart", "windowEnd",
    ]);
  });

  it("gates the top objections export on both flags and requires a tenant", async () => {
    // The nesting is the point: the child flag alone must not enable it either.
    expect(exportResourceEnabled("coach-top-objections", { SETTERFI_PHASE2_LIVE: "true" })).toBe(false);
    expect(exportResourceEnabled("coach-top-objections", { SETTERFI_BRAIN_OBJECTIONS_LIVE: "true" })).toBe(false);
    expect(exportResourceEnabled("coach-top-objections", {
      SETTERFI_PHASE2_LIVE: "true", SETTERFI_BRAIN_OBJECTIONS_LIVE: "true",
    })).toBe(true);

    const { cursor } = cursorFromPages([]);
    const off = dependencies(cursor);
    const session = vi.fn(off.values.session);
    const refused = await createExportHandler({
      ...off.values,
      enabled: (candidate) => exportResourceEnabled(candidate, { SETTERFI_PHASE2_LIVE: "true" }),
      session,
    })(request("coach-top-objections"), context("coach-top-objections"));
    expect(refused.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(off.openCursor).not.toHaveBeenCalled();

    const platform = cursorFromPages([[]]);
    const platformDeps = dependencies(platform.cursor, { role: "admin", tenantId: null });
    const response = await createExportHandler(platformDeps.values)(
      request("coach-top-objections", "?format=json"), context("coach-top-objections"),
    );
    expect(response.status).toBe(400);
  });

  it("accepts only the closed window grammar and passes it unchanged to the 500-row cursor", async () => {
    const accepted = [
      ["?format=json", { window: "1m" }],
      ["?format=json&window=all", { window: "all" }],
      ["?format=json&window=custom&from=2026-07-01&to=2026-07-31", {
        window: "custom", from: "2026-07-01", to: "2026-07-31",
      }],
    ] as const;
    for (const [query, expected] of accepted) {
      const { cursor } = cursorFromPages([[]]);
      const deps = dependencies(cursor);
      const response = await createExportHandler(deps.values)(
        request("coach-measurement-keywords", query), context("coach-measurement-keywords"),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(deps.openCursor).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: "tenant-1",
        pageSize: 500,
        filter: expect.objectContaining(expected),
      }));
    }

    const refused = [
      "?window=year",
      "?window=custom",
      "?window=custom&from=2026-07-01",
      "?window=custom&from=2026-02-30&to=2026-03-01",
      "?window=custom&from=2026-08-02&to=2026-08-01",
      "?window=1m&from=2026-07-01&to=2026-07-31",
      "?window=1m&search=synthetic",
      "?window=1m&order=created_desc",
    ];
    for (const query of refused) {
      const { cursor } = cursorFromPages([]);
      const deps = dependencies(cursor);
      const response = await createExportHandler(deps.values)(
        request("coach-measurement-steps", query), context("coach-measurement-steps"),
      );
      expect(response.status).toBe(400);
      expect(deps.start).not.toHaveBeenCalled();
      expect(deps.openCursor).not.toHaveBeenCalled();
    }
  });

  it.each(["window=1m", "from=2026-07-01", "to=2026-07-31"])(
    "rejects %s on every resource without measurement-window grammar before audit and data access",
    async (query) => {
      for (const resource of EXPORT_RESOURCES.filter((candidate) => !PHASE7_TENANT_EXPORT_RESOURCES.includes(candidate as never))) {
        const { cursor } = cursorFromPages([]);
        const deps = dependencies(cursor, PLATFORM_EXPORT_RESOURCES.includes(resource as never)
          || OWNER_ADMIN_EXPORT_RESOURCES.includes(resource as never)
          ? { role: "admin", tenantId: null }
          : resource === "affiliate-referrals"
            ? { role: "affiliate", tenantId: null }
            : {});
        const reason = PLATFORM_EXPORT_RESOURCES.includes(resource as never)
          || OWNER_ADMIN_EXPORT_RESOURCES.includes(resource as never)
          ? "&reason=review"
          : "";
        const response = await createExportHandler(deps.values)(
          request(resource, `?${query}${reason}`), context(resource),
        );
        expect(response.status).toBe(400);
        expect(deps.start).not.toHaveBeenCalled();
        expect(deps.openCursor).not.toHaveBeenCalled();
      }
    },
  );

  it("projects the repository snapshot in the same step and pipeline order as the UI", () => {
    const snapshot: CoachMeasurement = {
      tenantId: "tenant-1",
      window: "1m",
      windowEnd: "2026-09-01T00:00:00.000Z",
      isDemo: false,
      metrics: [],
      funnel: [{ stepKey: "identity", stepLabel: "Identity", enteredContacts: 4, completedContacts: 3 }],
      responses: [
        { stepKey: "identity", stepLabel: "Identity", askedContacts: 4, answeredContacts: 3 },
        { stepKey: "capital", stepLabel: "Capital", askedContacts: 2, answeredContacts: 0 },
      ],
      keywords: [{
        keyword: "Synthetic",
        conversations: 3,
        qualifiedContacts: 2,
        respondedConversations: 2,
        bookedContacts: 1,
        dataLabel: "Database truth",
      }],
      pipeline: [
        { contactId: "qualifying", displayName: "Synthetic B", stage: "qualifying", attributedToAgent: false, latestAppointmentStatus: null, changedAt: "2026-08-02T00:00:00.000Z", dataLabel: "Database truth" },
        { contactId: "new", displayName: "Synthetic A", stage: "new_lead", attributedToAgent: false, latestAppointmentStatus: null, changedAt: "2026-08-01T00:00:00.000Z", dataLabel: "Database truth" },
      ],
      allowance: { used: 1, limit: 5, periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z", state: "available" },
    };

    expect(phase7MeasurementExportRows("coach-measurement-keywords", snapshot)[0])
      .toEqual({
        ...snapshot.keywords[0],
        optInDenominator: 3,
        qualifiedDenominator: 3,
        bookedDenominator: 3,
      });
    expect(phase7MeasurementExportRows("coach-measurement-steps", snapshot)).toEqual([
      { stepKey: "identity", stepLabel: "Identity", enteredContacts: 4, completedContacts: 3, askedContacts: 4, answeredContacts: 3, responseRate: 75, dataLabel: "Database truth" },
      { stepKey: "capital", stepLabel: "Capital", enteredContacts: null, completedContacts: null, askedContacts: 2, answeredContacts: 0, responseRate: 0, dataLabel: "Database truth" },
    ]);
    expect(phase7MeasurementExportRows("coach-pipeline", snapshot).map((row) => row.contactId))
      .toEqual(["new", "qualifying"]);
  });

  it("streams only the declared coach columns and keeps the cursor repository-backed", async () => {
    const { cursor } = cursorFromPages([[
      { keyword: "Synthetic", conversations: 3, qualifiedContacts: 2, respondedConversations: 2, bookedContacts: 1, dataLabel: "Database truth", cost: 99 },
    ], []]);
    const deps = dependencies(cursor);
    const response = await createExportHandler(deps.values)(
      request("coach-measurement-keywords", "?format=json&window=1w"),
      context("coach-measurement-keywords"),
    );
    const body = await response.text();
    expect(Object.keys(JSON.parse(body)[0])).toEqual([...measurementColumns["coach-measurement-keywords"]]);
    expect(body).not.toMatch(/cost|margin|token|latency/i);

    const routeSource = readFileSync(new URL("./[resource]/handler.ts", import.meta.url), "utf8");
    expect(routeSource).toContain("loadCoachMeasurement(input.actorId, input.tenantId");
    expect(routeSource).toContain("phase7MeasurementExportRows(input.resource, snapshot)");
    expect(routeSource).not.toMatch(/workspace-fixtures|fixture-workspace/);
    const exportMenuSource = readFileSync(new URL("../../../components/kit/export-menu.tsx", import.meta.url), "utf8");
    expect(exportMenuSource).toContain("export type ServerExportMenuProps");
    for (const resource of PHASE7_TENANT_EXPORT_RESOURCES) expect(exportMenuSource).toContain(`\"${resource}\"`);
  });
});

describe("Phase 7 platform export route", () => {
  const platformColumns = {
    "eval-comparisons": [
      "comparisonId", "status", "brainDraftVersionId", "contentHash", "brainVersion",
      "offerVersion", "rulesVersion", "knowledgeMode", "corpusRevision", "caseSetHash",
      "modelConfigAId", "modelConfigBId", "runAId", "runBId", "createdAt", "finishedAt",
    ],
    "eval-comparison-results": [
      "comparisonId", "arm", "suite", "passed", "total", "passRate", "falseBlocks",
      "negativeCases", "providerCostCredits", "costPerCaseCredits", "costPerThousandCredits",
      "latencyP50Ms", "latencyP95Ms", "state",
    ],
    "platform-subscriptions": [
      "dataOrigin", "tenantId", "subscriptionId", "status", "stripePriceId", "periodStart", "periodEnd",
    ],
    "platform-tenant-performance": [
      "dataOrigin", "tenantId", "bookedAppointments", "grossMrrCents", "commissionCents", "marginCents", "marginState",
    ],
    "platform-guardrail-rules": ["dataOrigin", "ruleKey", "label", "fires", "blocks", "holds"],
    "platform-followup-performance": ["dataOrigin", "touchNo", "sent", "replied", "crossChannel", "exhausted"],
    "platform-provisioning-performance": ["dataOrigin", "stepKey", "state", "attempts", "failures", "medianDaysToClear"],
  } as const;

  it("keeps the seven resources and exact columns closed", () => {
    expect(PHASE7_PLATFORM_EXPORT_RESOURCES).toEqual([
      "eval-comparisons", "eval-comparison-results", "platform-subscriptions",
      "platform-tenant-performance", "platform-guardrail-rules",
      "platform-followup-performance", "platform-provisioning-performance",
    ]);
    for (const resource of PHASE7_PLATFORM_EXPORT_RESOURCES) {
      expect(RESOURCE_COLUMNS[resource]).toEqual(platformColumns[resource]);
    }
  });

  it.each(PHASE7_ECONOMICS_EXPORT_RESOURCES)(
    "refuses success-role access to economics resource %s before audit or cursor access",
    async (resource) => {
      const { cursor } = cursorFromPages([]);
      const deps = dependencies(cursor, { role: "success", tenantId: null });
      const response = await createExportHandler(deps.values)(
        request(resource, "?format=json&reason=operations-review"), context(resource),
      );
      expect(response.status).toBe(403);
      expect(deps.start).not.toHaveBeenCalled();
      expect(deps.openCursor).not.toHaveBeenCalled();
    },
  );

  it.each(PHASE7_OPERATIONAL_EXPORT_RESOURCES)(
    "admits success to %s but serializes no economics column",
    async (resource) => {
      const allowed = Object.fromEntries(platformColumns[resource].map((column, index) => [column, index + 1]));
      const { cursor } = cursorFromPages([[{
        ...allowed,
        grossMrrCents: 10_000,
        marginCents: 4_000,
        commissionCents: 1_000,
        providerCostCredits: 2,
        costPerCaseCredits: 1,
        costPerThousandCredits: 1_000,
      }], []]);
      const deps = dependencies(cursor, { role: "success", tenantId: null });
      const response = await createExportHandler(deps.values)(
        request(resource, "?format=json&reason=operations-review"), context(resource),
      );
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(Object.keys(JSON.parse(body)[0])).toEqual([...platformColumns[resource]]);
      expect(body).not.toMatch(/grossMrr|margin|commission|providerCost|costPerCase|costPerThousand/i);
      expect(deps.openCursor).toHaveBeenCalledTimes(1);
    },
  );

  it.each(PHASE7_PLATFORM_EXPORT_RESOURCES)(
    "refuses coach access to platform resource %s",
    async (resource) => {
      const { cursor } = cursorFromPages([]);
      const deps = dependencies(cursor, { role: "coach" });
      const response = await createExportHandler(deps.values)(
        request(resource, "?reason=review"), context(resource),
      );
      expect(response.status).toBe(403);
      expect(deps.openCursor).not.toHaveBeenCalled();
    },
  );

  it("uses the eval and analytics child flags explicitly without Phase 1 fallthrough", () => {
    const evals = { SETTERFI_PHASE7_LIVE: "true", SETTERFI_PHASE7_EVALS_LIVE: "true" };
    const analytics = { SETTERFI_PHASE7_LIVE: "true", SETTERFI_PHASE7_ANALYTICS_LIVE: "true" };
    for (const resource of PHASE7_ECONOMICS_EXPORT_RESOURCES.slice(0, 2)) {
      expect(exportResourceEnabled(resource, { SETTERFI_PHASE1_LIVE: "true" })).toBe(false);
      expect(exportResourceEnabled(resource, analytics)).toBe(false);
      expect(exportResourceEnabled(resource, evals)).toBe(true);
    }
    for (const resource of PHASE7_PLATFORM_EXPORT_RESOURCES.slice(2)) {
      expect(exportResourceEnabled(resource, { SETTERFI_PHASE1_LIVE: "true" })).toBe(false);
      expect(exportResourceEnabled(resource, evals)).toBe(false);
      expect(exportResourceEnabled(resource, analytics)).toBe(true);
    }
  });

  it("projects platform database truth through exact resource rows", () => {
    const snapshot: PlatformMeasurement = {
      asOf: "2026-08-18T00:00:00.000Z",
      metrics: [],
      subscriptions: [{ tenantId: "tenant-1", subscriptionId: "subscription-1", status: "active", stripePriceId: "price-1", periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z" }],
      tenantPerformance: [{ tenantId: "tenant-1", bookedAppointments: 2, grossMrrCents: 1000, commissionCents: 100, marginCents: 700, marginState: "available" }],
      guardrailRules: [{ ruleKey: "pricing", label: "Pricing", fires: 2, blocks: 1, holds: 0 }],
      followupPerformance: [{ touchNo: 1, sent: 3, replied: 2, crossChannel: 1, exhausted: 0 }],
      provisioningPerformance: [{ stepKey: "a2p", state: "registering", attempts: 1, failures: 0, medianDaysToClear: null }],
      history: [],
    };
    expect(phase7PlatformExportRows("platform-subscriptions", snapshot)).toEqual(snapshot.subscriptions.map((row) => ({ dataOrigin: "Real analytics", ...row })));
    expect(phase7PlatformExportRows("platform-tenant-performance", snapshot)).toEqual(snapshot.tenantPerformance.map((row) => ({ dataOrigin: "Real analytics", ...row })));
    expect(phase7PlatformExportRows("platform-guardrail-rules", snapshot)).toEqual(snapshot.guardrailRules.map((row) => ({ dataOrigin: "Real analytics", ...row })));
    expect(phase7PlatformExportRows("platform-followup-performance", snapshot)).toEqual(snapshot.followupPerformance.map((row) => ({ dataOrigin: "Real analytics", ...row })));
    expect(phase7PlatformExportRows("platform-provisioning-performance", snapshot)).toEqual(snapshot.provisioningPerformance.map((row) => ({ dataOrigin: "Real analytics", ...row })));
    expect(phase7PlatformExportRows("platform-guardrail-rules", { ...snapshot, origin: "synthetic_preview" }))
      .toEqual(snapshot.guardrailRules.map((row) => ({ dataOrigin: "Synthetic review preview", ...row })));
  });

  it("keeps ExportMenu and repository sources aligned with every platform resource", () => {
    const exportMenu = readFileSync(new URL("../../../components/kit/export-menu.tsx", import.meta.url), "utf8");
    const route = readFileSync(new URL("./[resource]/handler.ts", import.meta.url), "utf8");
    for (const resource of PHASE7_PLATFORM_EXPORT_RESOURCES) expect(exportMenu).toContain(`\"${resource}\"`);
    expect(route).toContain("loadEvalComparisonExport(id)");
    expect(route).toContain("loadPlatformMeasurement(input.actorId, new Date().toISOString())");
    expect(route).not.toMatch(/workspace-fixtures|fixture-workspace/);
  });
});

describe("Phase 8 export route", () => {
  const phase8Columns = {
    "alert-rules": ["event", "scope", "name", "category", "audience", "destinations", "required", "enabled"],
    "audit-log": ["action", "actor", "target", "reason", "at", "testData"],
    "coach-support-messages": ["thread", "author", "createdAt", "testData"],
    "notification-deliveries": ["event", "destination", "state", "attempts", "lastAttemptAt", "deliveredAt", "testData"],
    "notification-rules": ["event", "scope", "bell", "email", "slack", "required"],
    "support-messages": ["thread", "author", "internal", "createdAt", "testData"],
    "support-threads": ["subject", "client", "status", "assignee", "updatedAt", "testData"],
    "success-client-book": ["client", "status", "successOwner", "supportStatus", "updatedAt"],
  } as const;

  it("keeps the eight Phase 8 resources and their rendered column tuples closed", () => {
    expect(PHASE8_EXPORT_RESOURCES).toEqual([
      "alert-rules", "audit-log", "coach-support-messages", "notification-deliveries",
      "notification-rules", "support-messages", "support-threads", "success-client-book",
    ]);
    expect(PHASE8_TENANT_EXPORT_RESOURCES).toEqual(["coach-support-messages"]);
    expect(PHASE8_PLATFORM_EXPORT_RESOURCES).toEqual([
      "alert-rules", "audit-log", "notification-deliveries", "notification-rules",
      "support-messages", "support-threads", "success-client-book",
    ]);
    for (const resource of PHASE8_EXPORT_RESOURCES) {
      expect(RESOURCE_COLUMNS[resource]).toEqual(phase8Columns[resource]);
    }
  });

  it.each(PHASE8_EXPORT_RESOURCES)(
    "404s %s before session, audit, or cursor access while Phase 8 exports are off",
    async (resource) => {
      const { cursor } = cursorFromPages([]);
      const deps = dependencies(cursor);
      const session = vi.fn(deps.values.session);
      const response = await createExportHandler({
        ...deps.values,
        enabled: (candidate) => exportResourceEnabled(candidate, {
          SETTERFI_PHASE1_LIVE: "true",
          SETTERFI_PHASE8_LIVE: "true",
          SETTERFI_PHASE8_EXPORTS_LIVE: "false",
        }),
        session,
      })(request(resource), context(resource));

      expect(response.status).toBe(404);
      expect(session).not.toHaveBeenCalled();
      expect(deps.start).not.toHaveBeenCalled();
      expect(deps.openCursor).not.toHaveBeenCalled();
    },
  );

  it("requires both the Phase 8 root and exports child flags", () => {
    for (const resource of PHASE8_EXPORT_RESOURCES) {
      expect(exportResourceEnabled(resource, { SETTERFI_PHASE1_LIVE: "true" })).toBe(false);
      expect(exportResourceEnabled(resource, { SETTERFI_PHASE8_EXPORTS_LIVE: "true" })).toBe(false);
      expect(exportResourceEnabled(resource, {
        SETTERFI_PHASE8_LIVE: "true",
        SETTERFI_PHASE8_EXPORTS_LIVE: "true",
      })).toBe(true);
    }
  });

  it.each(PHASE8_PLATFORM_EXPORT_RESOURCES)(
    "refuses coach access to Phase 8 platform resource %s before audit or cursor access",
    async (resource) => {
      const { cursor } = cursorFromPages([]);
      const deps = dependencies(cursor, { role: "coach" });
      const response = await createExportHandler(deps.values)(
        request(resource, "?format=json&reason=review"), context(resource),
      );
      expect(response.status).toBe(403);
      expect(deps.start).not.toHaveBeenCalled();
      expect(deps.openCursor).not.toHaveBeenCalled();
    },
  );

  it("records the named tenant in platform audit inputs before opening its cursor", async () => {
    const { cursor } = cursorFromPages([[]]);
    const deps = dependencies(cursor, { role: "success", tenantId: null });
    const response = await createExportHandler(deps.values)(
      request("coach-support-messages", "?format=json&tenantId=tenant-2&reason=support-review"),
      context("coach-support-messages"),
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-2",
      subjectTenantId: "tenant-2",
      auditMode: "platform_tenant",
      reason: "support-review",
    }));
    expect(deps.openCursor).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "actor-1", tenantId: "tenant-2",
    }));
    expect(deps.start.mock.invocationCallOrder[0]).toBeLessThan(deps.openCursor.mock.invocationCallOrder[0]);
    expect(deps.finish).toHaveBeenCalledWith(expect.objectContaining({
      subjectTenantId: "tenant-2", auditMode: "platform_tenant",
    }));
  });

  it("refuses incomplete named-tenant requests before audit or cursor access", async () => {
    for (const query of ["?tenantId=tenant-2", "?reason=support-review", ""]) {
      const { cursor } = cursorFromPages([]);
      const deps = dependencies(cursor, { role: "admin", tenantId: null });
      const response = await createExportHandler(deps.values)(
        request("coach-support-messages", query), context("coach-support-messages"),
      );
      expect(response.status).toBe(400);
      expect(deps.start).not.toHaveBeenCalled();
      expect(deps.openCursor).not.toHaveBeenCalled();
    }
  });

  it("never exposes the platform-only internal field through coach support rows", () => {
    const projected = phase8ExportRow("coach-support-messages", {
      thread_id: "thread-1", author_id: "coach-1", internal: true,
      created_at: "2026-08-18T00:00:00.000Z", is_test: false,
    });
    expect(projected).toEqual({
      thread: "thread-1", author: "coach-1",
      createdAt: "2026-08-18T00:00:00.000Z", testData: false,
    });
    expect(projected).not.toHaveProperty("internal");
  });

  /**
   * A spreadsheet is the one surface a reader cannot hover to resolve an id on, so the client-book
   * export resolves `tenants.success_owner` through `users` before the column is written. The
   * three cases are the three the loader can hand it, and none of them is the uuid.
   */
  it("writes a success owner's name into the client-book export, never the stored id", () => {
    const ownerId = "88000000-0000-4000-8000-000000000001";
    const names = new Map([[ownerId, "Priya Natarajan"]]);

    expect(exportOwnerLabel(ownerId, names)).toBe("Priya Natarajan");
    expect(exportOwnerLabel("99999999-0000-4000-8000-000000000009", names)).toBe("Assigned owner");
    expect(exportOwnerLabel(null, names)).toBe("Unassigned");
    expect(exportOwnerLabel("   ", names)).toBe("Unassigned");
    for (const label of [
      exportOwnerLabel(ownerId, names),
      exportOwnerLabel("99999999-0000-4000-8000-000000000009", names),
    ]) {
      expect(label, "an owner uuid reached a client-visible export column").not.toMatch(/[0-9a-f]{8}-/u);
    }
  });

  /**
   * F-11-AUDIT-ACTOR-NAMES, on the surface the screen's own join does not reach.
   *
   * The audit feed resolves `actor_id` through `users` and reads out a name; the CSV of the same
   * rows read out the uuid, so one event had two answers to "who did this" depending on whether
   * you were looking at the page or at the file attached to a compliance request. The three
   * fallbacks are the feed's three, in the feed's words.
   */
  it("names the actor in an exported audit row, in the words the feed uses", () => {
    const actorId = "88000000-0000-4000-8000-000000000001";
    const names = new Map([[actorId, "Priya Natarajan"]]);

    expect(exportAuditActorLabel(actorId, "brain.published", names)).toBe("Priya Natarajan");
    // An id no users row answers to. Neutral, never the id itself.
    expect(exportAuditActorLabel("99999999-0000-4000-8000-000000000009", "brain.published", names))
      .toBe("Operator");
    // No actor at all: the platform for something it did itself, explicit absence otherwise.
    expect(exportAuditActorLabel(null, "appointment.created", names)).toBe("SetterFi");
    expect(exportAuditActorLabel(null, "brain.published", names)).toBe("Actor unavailable");
    expect(exportSupportAuthorLabel(actorId, names)).toBe("Priya Natarajan");
    expect(exportSupportAuthorLabel("someone-else", names)).toBe("Support team");

    for (const label of [
      exportAuditActorLabel(actorId, "brain.published", names),
      exportAuditActorLabel("99999999-0000-4000-8000-000000000009", "x.y", names),
      exportAuditActorLabel(null, "brain.published", names),
      exportSupportAuthorLabel("someone-else", names),
    ]) {
      expect(label, "an actor uuid reached an export column").not.toMatch(/[0-9a-f]{8}-/u);
    }
  });

  /**
   * The "everywhere" half of the same gap: any export whose query pulls an actor, author or owner
   * id has to resolve it, or the leak simply moves to the next resource somebody adds.
   */
  it("resolves the actor on every export whose query reads one", () => {
    const source = readFileSync(new URL("./[resource]/handler.ts", import.meta.url), "utf8");
    const specs = [...source.matchAll(
      /"([a-z0-9-]+)":\s*\{\s*\n\s*table:[^\n]*\n\s*select: "([^"]*)"/gu,
    )].map((match) => ({ resource: match[1], select: match[2].split(",") }));
    // A positive control: a regex that matched nothing would make every assertion below vacuous.
    expect(specs.length).toBeGreaterThan(10);

    const carriesAnActor = specs.filter((spec) => ["actor_id", "author_id", "success_owner"]
      .some((column) => spec.select.includes(column)));
    expect(carriesAnActor.length).toBeGreaterThan(0);
    for (const spec of carriesAnActor) {
      expect(
        EXPORT_ACTOR_JOINS[spec.resource],
        `the ${spec.resource} export reads an actor id and never names it`,
      ).toBeDefined();
    }
  });

  it("pins every Phase 7 platform arm and exclusion view while Phase 8 is added", () => {
    expect(PHASE7_REQUIRED_PLATFORM_EXPORT_ARMS).toEqual([
      "eval-comparisons", "eval-comparison-results", "platform-subscriptions",
      "platform-tenant-performance", "platform-guardrail-rules",
      "platform-followup-performance", "platform-provisioning-performance",
    ]);
    expect(PHASE7_EXPORT_EXCLUSION_VIEWS).toEqual([
      "analytics_tenants", "analytics_contacts", "analytics_conversations", "analytics_messages",
      "analytics_appointments", "analytics_billable_events", "analytics_conversation_step_events",
      "analytics_billing_subscriptions", "analytics_commission_ledger",
    ]);
    const source = readFileSync(new URL("./[resource]/handler.ts", import.meta.url), "utf8");
    expect(source).not.toContain('.select("*")');
    const coachSpec = source.slice(
      source.indexOf('"coach-support-messages": {'),
      source.indexOf('"notification-deliveries": {'),
    );
    expect(coachSpec).not.toMatch(/internal/);
  });
});
