import { describe, expect, it, vi } from "vitest";

import {
  createContact,
  importContacts,
  parseContactIdentityInput,
} from "@/lib/contacts/service";
import type { ContactIdentityInput } from "@/lib/contacts/service";

const metaContact: ContactIdentityInput = {
  name: "Manual lead",
  provider: "meta_direct",
  channel: "instagram",
  providerIdentityId: "meta-lead-1",
  providerAccountId: null,
  normalizedPhone: "+15550000001",
  normalizedEmail: "LEAD@example.test",
};

describe("contact management service", () => {
  it("normalizes ingress-compatible identities and refuses an unbound GHL identity", () => {
    expect(parseContactIdentityInput(metaContact)).toEqual({
      ...metaContact,
      normalizedEmail: "lead@example.test",
    });
    expect(parseContactIdentityInput({ ...metaContact, provider: "ghl", providerAccountId: null })).toBeNull();
    expect(parseContactIdentityInput({ ...metaContact, providerAccountId: "unexpected" })).toBeNull();
  });

  it("passes the caller tenant to manual creation and returns the database audit receipt", async () => {
    const rpc = vi.fn(async () => ({
      contact_id: "contact-a", identity_id: "identity-a", outcome: "created", audit_id: 41,
    }));
    const result = await createContact({
      tenantId: "tenant-a", actorId: "actor-a", contact: metaContact, idempotencyKey: "manual-a",
    }, { rpc });
    expect(result).toEqual({ contactId: "contact-a", identityId: "identity-a", outcome: "created", auditId: 41 });
    expect(rpc).toHaveBeenCalledWith("create_manual_contact", expect.objectContaining({
      p_expected_tenant: "tenant-a", p_actor_id: "actor-a", p_normalized_email: "lead@example.test",
    }));
  });

  it("preserves each import row outcome instead of flattening a partial import into success", async () => {
    const rpc = vi.fn(async () => ({
      outcomes: [
        { row: 0, outcome: "created", contact_id: "contact-a", identity_id: "identity-a", audit_id: 42 },
        { row: 1, outcome: "merged_existing_identity", contact_id: "contact-a", identity_id: "identity-a", audit_id: 43 },
        { row: 2, outcome: "rejected", reason: "CONTACT_IMPORT_ROW_INVALID" },
      ],
      audit_id: 44,
    }));
    await expect(importContacts({
      tenantId: "tenant-a", actorId: "actor-a", rows: [metaContact, metaContact, {}], idempotencyKey: "import-a",
    }, { rpc })).resolves.toEqual({
      outcomes: [
        { row: 0, outcome: "created", contactId: "contact-a", identityId: "identity-a", auditId: 42 },
        { row: 1, outcome: "merged_existing_identity", contactId: "contact-a", identityId: "identity-a", auditId: 43 },
        { row: 2, outcome: "rejected", reason: "CONTACT_IMPORT_ROW_INVALID" },
      ],
      auditId: 44,
    });
  });
});
