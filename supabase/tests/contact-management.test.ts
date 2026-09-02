// Contact management behavior is database-owned: these tests exercise tenant assertions, the GHL
// install trigger, atomic import receipts, and audit rows together rather than mocking an RPC.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL = process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const TENANT_A = "93100000-0000-4000-8000-000000000010";
const TENANT_B = "93100000-0000-4000-8000-000000000020";
const COACH_A = "93200000-0000-4000-8000-000000000010";
const COACH_B = "93200000-0000-4000-8000-000000000020";
const INSTALL_A = "93300000-0000-4000-8000-000000000010";

let db: Client;

async function createMetaContact(identity = "manual-meta-1") {
  const result = await db.query<{
    contact_id: string; identity_id: string; outcome: string; audit_id: string;
  }>(`
    select * from public.create_manual_contact(
      $1, $2, 'Manual contact', 'meta_direct', 'instagram', $3, null,
      '+15550000001', 'manual@example.test', $4
    )
  `, [TENANT_A, COACH_A, identity, `manual-${identity}`]);
  return result.rows[0];
}

async function expectDatabaseError(query: () => Promise<unknown>, pattern: RegExp) {
  await db.query("savepoint contact_management_error");
  await expect(query()).rejects.toThrow(pattern);
  await db.query("rollback to savepoint contact_management_error");
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(`Contact management suite could not reach Postgres at ${DB_URL}.`, { cause });
  }
});

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await db.query("begin");
  await db.query("set local role postgres");
  await db.query(`
    insert into public.tenants (id, slug, name, billing_contact_email, is_demo) values
      ('${TENANT_A}', 'contact-management-a', 'Contact Management A', 'a@contact-management.test', false),
      ('${TENANT_B}', 'contact-management-b', 'Contact Management B', 'b@contact-management.test', false);
    insert into public.users (id, email, role, tenant_id) values
      ('${COACH_A}', 'coach-a@contact-management.test', 'coach', '${TENANT_A}'),
      ('${COACH_B}', 'coach-b@contact-management.test', 'coach', '${TENANT_B}');
    insert into public.ghl_installs (id, tenant_id, location_id, company_id, token_expires_at)
    values ('${INSTALL_A}', '${TENANT_A}', 'contact-management-location-a',
      'contact-management-company-a', now() + interval '1 hour');
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("manual contact creation", () => {
  it("creates a tenant-scoped contact and identity with its audit receipt", async () => {
    const created = await createMetaContact();
    const readback = await db.query<{
      tenant_id: string; provider: string; provider_identity_id: string; action: string; actor_id: string;
    }>(`
      select identity.tenant_id, identity.provider::text, identity.provider_identity_id,
        audit.action, audit.actor_id
      from public.contact_identities identity
      join public.audit_log audit on audit.id = $1
      where identity.id = $2
    `, [created.audit_id, created.identity_id]);
    expect(created.outcome).toBe("created");
    expect(readback.rows).toEqual([{
      tenant_id: TENANT_A,
      provider: "meta_direct",
      provider_identity_id: "manual-meta-1",
      action: "contact.created.manual",
      actor_id: COACH_A,
    }]);
  });

  it("refuses a caller from another tenant before it writes a contact", async () => {
    await expectDatabaseError(() => db.query(`
      select * from public.create_manual_contact(
        $1, $2, 'Cross tenant', 'meta_direct', 'instagram', 'cross-tenant-id', null,
        null, null, 'cross-tenant-create'
      )
    `, [TENANT_A, COACH_B]), /PHASE4_ACTOR_NOT_AUTHORIZED/);
    const count = await db.query<{ count: string }>(
      "select count(*)::text from public.contacts where tenant_id = $1", [TENANT_A],
    );
    expect(count.rows[0].count).toBe("0");
  });

  it("requires a GHL identity to bind to the matching install for the tenant", async () => {
    await expectDatabaseError(() => db.query(`
      select * from public.create_manual_contact(
        $1, $2, 'Unbound GHL', 'ghl', 'sms', 'ghl-unbound', 'wrong-location',
        '+15550000002', null, 'ghl-unbound'
      )
    `, [TENANT_A, COACH_A]), /GHL_IDENTITY_ACCOUNT_BINDING_REQUIRED/);

    const bound = await db.query<{ identity_id: string }>(`
      select * from public.create_manual_contact(
        $1, $2, 'Bound GHL', 'ghl', 'sms', 'ghl-bound', 'contact-management-location-a',
        '+15550000002', null, 'ghl-bound'
      )
    `, [TENANT_A, COACH_A]);
    const identity = await db.query<{ provider_account_id: string; ghl_install_id: string }>(
      "select provider_account_id, ghl_install_id from public.contact_identities where id = $1",
      [bound.rows[0].identity_id],
    );
    expect(identity.rows).toEqual([{
      provider_account_id: "contact-management-location-a",
      ghl_install_id: INSTALL_A,
    }]);
  });
});

describe("contact notes and tags", () => {
  it("round-trips actor-attributed notes and tenant-scoped tag assignment/removal", async () => {
    const created = await createMetaContact("notes-tags");
    const note = await db.query<{ note_id: string; audit_id: string }>(
      "select * from public.add_contact_note($1, $2, $3, $4)",
      [TENANT_A, created.contact_id, COACH_A, "Called and left a voicemail"],
    );
    const listedNotes = await db.query<{ body: string; created_by: string }>(
      "select body, created_by from public.list_contact_notes($1, $2)", [TENANT_A, created.contact_id],
    );
    expect(listedNotes.rows).toEqual([{ body: "Called and left a voicemail", created_by: COACH_A }]);

    const tag = await db.query<{ tag_id: string; added: boolean; audit_id: string }>(
      "select * from public.add_contact_tag($1, $2, $3, $4)",
      [TENANT_A, created.contact_id, COACH_A, "Warm lead"],
    );
    const listedTags = await db.query<{ id: string; label: string }>(
      "select id, label from public.list_contact_tags($1, $2)", [TENANT_A, created.contact_id],
    );
    expect(listedTags.rows).toEqual([{ id: tag.rows[0].tag_id, label: "Warm lead" }]);
    const removed = await db.query<{ removed: boolean }>(
      "select * from public.remove_contact_tag($1, $2, $3, $4)",
      [TENANT_A, created.contact_id, COACH_A, tag.rows[0].tag_id],
    );
    expect(removed.rows[0].removed).toBe(true);
    expect(note.rows[0].audit_id).toMatch(/^\d+$/);
    expect(tag.rows[0].audit_id).toMatch(/^\d+$/);
  });
});

describe("bulk contact import", () => {
  it("returns created, merged, and rejected rows, then replays the exact receipt without a second write", async () => {
    const rows = [
      { name: "Imported", provider: "meta_direct", channel: "instagram", providerIdentityId: "import-a", providerAccountId: null, normalizedPhone: null, normalizedEmail: null },
      { name: "Imported replay", provider: "meta_direct", channel: "instagram", providerIdentityId: "import-a", providerAccountId: null, normalizedPhone: null, normalizedEmail: null },
      { name: "Invalid row", provider: "ghl", channel: "sms", providerIdentityId: "", providerAccountId: null, normalizedPhone: null, normalizedEmail: null },
    ];
    const first = await db.query<{ outcomes: unknown[]; audit_id: string }>(
      "select * from public.import_contacts($1, $2, $3::jsonb, $4)",
      [TENANT_A, COACH_A, JSON.stringify(rows), "import-replay-key"],
    );
    const replay = await db.query<{ outcomes: unknown[]; audit_id: string }>(
      "select * from public.import_contacts($1, $2, $3::jsonb, $4)",
      [TENANT_A, COACH_A, JSON.stringify(rows), "import-replay-key"],
    );
    const contacts = await db.query<{ count: string }>(
      "select count(*)::text from public.contacts where tenant_id = $1", [TENANT_A],
    );
    expect(first.rows[0].outcomes).toEqual([
      expect.objectContaining({ row: 0, outcome: "created" }),
      expect.objectContaining({ row: 1, outcome: "merged_existing_identity" }),
      { row: 2, outcome: "rejected", reason: "CONTACT_IMPORT_ROW_INVALID" },
    ]);
    expect(replay.rows[0]).toEqual(first.rows[0]);
    expect(contacts.rows[0].count).toBe("1");
  });
});
