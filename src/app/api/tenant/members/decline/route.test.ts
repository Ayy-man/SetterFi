import { describe, expect, it, vi } from "vitest";

import { createDeclineTenantMemberHandler } from "./handler";

const actor = { userId: "user-2", role: "affiliate" as const, tenantId: null, impersonatingTenant: null, impersonationSessionId: null };

describe("tenant member invitation decline", () => {
  it("records a recipient-bound decline without exposing the raw token to persistence", async () => {
    const dependencies = { enabled: () => true, session: vi.fn().mockResolvedValue(actor), decline: vi.fn().mockResolvedValue({ invitationId: "invite-1", tenantId: "tenant-1", auditId: "11" }) };
    const response = await createDeclineTenantMemberHandler(dependencies)(new Request("https://setterfi.test", { method: "POST", body: JSON.stringify({ token: "opaque-token" }) }));
    expect(response.status).toBe(200);
    expect(dependencies.decline).toHaveBeenCalledWith({ actorId: "user-2", tokenHash: "84d3f23da9b5f51b3269566eff05d3fb23607eeef89567f9cd280b90ca0dbc5c" });
  });
});
