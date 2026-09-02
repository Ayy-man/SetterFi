import { describe, expect, it, vi } from "vitest";

import type { RouteActor } from "@/app/api/conversations/[id]/claim/handler";
import { READINESS_KEYS, type ReadinessResult } from "@/lib/onboarding/contracts";

import { createGoLiveHandler } from "./handler";

const actor: RouteActor = { userId: "coach-1", tenantId: "tenant-1", role: "coach", impersonatingTenant: null, impersonationSessionId: null };
function refused(code: string) {
  const readiness: ReadinessResult = { ready: false, checks: READINESS_KEYS.map((key, index) => ({ key, ready: index !== 0, code: index === 0 ? code : "ready", evidenceAt: null, blamingParty: "platform" })) };
  return { kind: "refused" as const, readiness, code };
}

describe("POST /api/onboarding/go-live", () => {
  it.each(["messaging_channel_required", "primary_calendar_stale", "offer_review_contract_unavailable", "subscription_contract_unavailable"])("preserves readiness refusal %s", async (code) => {
    const response = await createGoLiveHandler({ enabled: () => true, session: vi.fn().mockResolvedValue(actor), commit: vi.fn().mockResolvedValue(refused(code)) })();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ kind: "refused", code });
  });

  it("returns live only with the transactional audit receipt", async () => {
    const commit = vi.fn().mockResolvedValue({ kind: "live", readiness: { ready: true, checks: [] }, receipt: { tenantId: "tenant-1", auditId: "61", wentLiveAt: "2030-01-01T00:00:00.000Z" } });
    const response = await createGoLiveHandler({ enabled: () => true, session: vi.fn().mockResolvedValue(actor), commit })();
    expect(response.status).toBe(200);
    expect(commit).toHaveBeenCalledWith({ tenantId: "tenant-1", actorId: "coach-1" });
  });

  it.each([[null, 401], [{ ...actor, impersonatingTenant: "tenant-2" }, 403], [{ ...actor, role: "coach_member" as const }, 403]])("refuses an unauthorized actor", async (candidate, status) => {
    const commit = vi.fn();
    const response = await createGoLiveHandler({ enabled: () => true, session: vi.fn().mockResolvedValue(candidate), commit })();
    expect(response.status).toBe(status);
    expect(commit).not.toHaveBeenCalled();
  });

  it("refuses a missing audit receipt without exposing the cause", async () => {
    const response = await createGoLiveHandler({ enabled: () => true, session: vi.fn().mockResolvedValue(actor), commit: vi.fn().mockResolvedValue({ kind: "live", readiness: { ready: true, checks: [] }, receipt: { tenantId: "tenant-1", auditId: "", wentLiveAt: "now" } }) })();
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toMatch(/audit|required|sql/i);
  });
});
