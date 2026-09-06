import { describe, expect, it, vi } from "vitest";

import type { PromptInspection } from "@/lib/repositories/brain-prompt-inspection";
import { BrainRuntimeReadinessError } from "@/lib/repositories/brain-runtime";

import { createBrainPromptHandler, parsePromptQuery } from "./handler";

const admin = { userId: "platform-admin", role: "owner" as const };
const inspection: PromptInspection = {
  blocks: [{ label: "[A0]", title: "PLATFORM INVARIANTS", source: "system", text: "[A0] PLATFORM INVARIANTS\nrules" }],
  promptHash: "a".repeat(64),
  tokens: 12,
  tokenMethod: "chars_div_4",
  chars: 45,
  revision: { kind: "live", snapshotId: "s", brainVersion: 7, contentHash: "b".repeat(64), offerVersion: 2, draftId: null },
};
const url = (query: string) => new Request(`http://localhost/api/admin/brain/prompt${query}`);

function handler(overrides: Partial<Parameters<typeof createBrainPromptHandler>[0]> = {}) {
  return createBrainPromptHandler({
    enabled: () => true,
    session: async () => admin,
    inspect: async () => inspection,
    ...overrides,
  });
}

describe("GET /api/admin/brain/prompt", () => {
  it("gates on Phase 2 and admin role", async () => {
    const inspect = vi.fn(async () => inspection);
    expect((await handler({ enabled: () => false, inspect })(url("?coachTenantId=t&revision=live"))).status).toBe(404);
    expect((await handler({ session: async () => ({ userId: "s", role: "success" }), inspect })(url("?coachTenantId=t&revision=live"))).status).toBe(403);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("requires exactly coachTenantId and a known revision", async () => {
    for (const query of ["", "?coachTenantId=t", "?coachTenantId=t&revision=published", "?coachTenantId=%20&revision=live", "?coachTenantId=t&revision=live&extra=1"]) {
      const response = await handler()(url(query));
      expect(response.status, query).toBe(400);
      expect(await response.json()).toEqual({ state: "refused", code: "BRAIN_PROMPT_QUERY_INVALID" });
    }
  });

  it("returns the inspection for the named coach and revision", async () => {
    const inspect = vi.fn(async () => inspection);
    const response = await handler({ inspect })(url("?coachTenantId=tenant-1&revision=draft"));
    expect(response.status).toBe(200);
    expect(inspect).toHaveBeenCalledWith({ tenantId: "tenant-1", revision: "draft" });
    expect(await response.json()).toEqual({ state: "assembled", ...inspection });
  });

  it("maps readiness failures to 409 and anything else to a generic 400", async () => {
    const notReady = await handler({ inspect: async () => { throw new BrainRuntimeReadinessError("RUNTIME_TENANT_NOT_READY"); } })(url("?coachTenantId=t&revision=live"));
    expect(notReady.status).toBe(409);
    expect(await notReady.json()).toEqual({ state: "not_ready", code: "RUNTIME_TENANT_NOT_READY" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const other = await handler({ inspect: async () => { throw new Error("PROMPT_BLOCKS_DRIFT"); } })(url("?coachTenantId=t&revision=live"));
    expect(other.status).toBe(400);
    expect(await other.json()).toEqual({ state: "refused", code: "BRAIN_PROMPT_REFUSED" });
    error.mockRestore();
  });
});

describe("parsePromptQuery", () => {
  it("trims the tenant id and accepts both revisions", () => {
    expect(parsePromptQuery(new URL("http://x/?coachTenantId=%20t%20&revision=draft"))).toEqual({ tenantId: "t", revision: "draft" });
    expect(parsePromptQuery(new URL("http://x/?revision=live&coachTenantId=t"))).toEqual({ tenantId: "t", revision: "live" });
  });
});
