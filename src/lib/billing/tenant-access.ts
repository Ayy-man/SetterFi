import type { NormalizedInboundMessage } from "@/lib/integrations/types";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type TenantAccessState = "active" | "overdue" | "suspended";
export type TenantAccessDecision =
  | { allowed: true; existingConversation: boolean }
  | { allowed: false; existingConversation: false; reason: "TENANT_BILLING_SUSPENDED" };

export function decideTenantAccess(input: {
  status: TenantAccessState;
  operation: "new_conversation" | "existing_conversation" | "new_followup";
}): TenantAccessDecision {
  const existingConversation = input.operation === "existing_conversation";
  if (input.status !== "suspended" || existingConversation) return { allowed: true, existingConversation };
  return { allowed: false, existingConversation: false, reason: "TENANT_BILLING_SUSPENDED" };
}

export type TenantAccessPort = {
  assertInboundAllowed(input: {
    tenantId: string;
    identity: NormalizedInboundMessage["identity"];
  }): Promise<TenantAccessDecision>;
};

export function createLiveTenantAccessPort(): TenantAccessPort {
  const client = createSupabaseServiceClient();
  return {
    assertInboundAllowed: async ({ tenantId, identity }) => {
      const { data: tenant, error: tenantError } = await client.from("tenants")
        .select("status").eq("id", tenantId).single();
      if (tenantError || !tenant || !["active", "overdue", "suspended"].includes(tenant.status)) {
        throw new Error("TENANT_ACCESS_STATE_UNAVAILABLE");
      }
      const { data: contactIdentity, error: identityError } = await client.from("contact_identities")
        .select("contact_id").eq("tenant_id", tenantId).eq("provider", identity.provider)
        .eq("provider_identity_id", identity.externalId).maybeSingle();
      if (identityError) throw new Error("TENANT_ACCESS_IDENTITY_READ_FAILED");
      let existingConversation = false;
      if (contactIdentity) {
        const { data, error } = await client.from("conversations").select("id")
          .eq("tenant_id", tenantId).eq("contact_id", contactIdentity.contact_id).limit(1);
        if (error) throw new Error("TENANT_ACCESS_CONVERSATION_READ_FAILED");
        existingConversation = (data ?? []).length > 0;
      }
      const decision = decideTenantAccess({
        status: tenant.status as TenantAccessState,
        operation: existingConversation ? "existing_conversation" : "new_conversation",
      });
      if (!decision.allowed) throw new Error(decision.reason);
      return decision;
    },
  };
}
