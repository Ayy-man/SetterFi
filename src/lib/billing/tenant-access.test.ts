import { describe, expect, it } from "vitest";
import { decideTenantAccess } from "@/lib/billing/tenant-access";

describe("tenant billing access", () => {
  it("keeps overdue operational", () => {
    expect(decideTenantAccess({ status: "overdue", operation: "new_conversation" })).toEqual({ allowed: true, existingConversation: false });
    expect(decideTenantAccess({ status: "overdue", operation: "new_followup" })).toEqual({ allowed: true, existingConversation: false });
  });

  it("refuses only new suspended work", () => {
    expect(decideTenantAccess({ status: "suspended", operation: "new_conversation" })).toEqual({
      allowed: false, existingConversation: false, reason: "TENANT_BILLING_SUSPENDED",
    });
    expect(decideTenantAccess({ status: "suspended", operation: "new_followup" }).allowed).toBe(false);
    expect(decideTenantAccess({ status: "suspended", operation: "existing_conversation" })).toEqual({ allowed: true, existingConversation: true });
  });
});
