// Phase 4 schema contract. Catalog, grant, migration-order, and constraint assertions run against
// live Postgres because service-only custody and populated-table backfills cannot be proved by a
// mocked client or by inspecting the final TypeScript types alone.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

// The other eleven suites resolve the stack this way. Shelling out to `npx supabase status`
// made this file's connection depend on the npm registry being reachable at test time, and a
// transient npx failure turned the security gate red while the database itself was healthy.
const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TENANT_A = "50000000-0000-4000-8000-000000000010";
const TENANT_B = "50000000-0000-4000-8000-000000000020";
const ADMIN = "51000000-0000-4000-8000-000000000010";
const COACH = "51000000-0000-4000-8000-000000000020";
const CONTACT_A = "52000000-0000-4000-8000-000000000010";
const CONTACT_B = "52000000-0000-4000-8000-000000000020";
const CONTACT_OTHER = "52000000-0000-4000-8000-000000000030";
const CONVERSATION = "53000000-0000-4000-8000-000000000010";
const MESSAGE = "53000000-0000-4000-8000-000000000020";
const GHL_CONNECTION = "54000000-0000-4000-8000-000000000010";
const META_CONNECTION = "54000000-0000-4000-8000-000000000020";
const GHL_INSTALL = "55000000-0000-4000-8000-000000000010";
const TEMPLATE = "56000000-0000-4000-8000-000000000010";

const PHASE4_TABLE_POLICIES: Record<string, string[]> = {
  channel_connection_secrets: ["ALL"],
  channel_connections: ["SELECT", "SELECT"],
  channel_oauth_states: ["ALL"],
  channel_operation_receipts: ["ALL"],
  contact_duplicate_candidates: ["SELECT", "SELECT"],
  contact_identities: ["SELECT", "SELECT"],
  ghl_install_secrets: ["ALL"],
  ghl_installs: ["SELECT"],
  message_templates: ["SELECT", "SELECT"],
};

let db: Client;

async function expectDbError(sql: string, params: readonly unknown[], expected: RegExp) {
  await db.query("savepoint expected_phase4_failure");
  let error: unknown;
  try {
    await db.query(sql, params as unknown[]);
  } catch (cause) {
    error = cause;
  }
  await db.query("rollback to savepoint expected_phase4_failure");
  expect(String(error)).toMatch(expected);
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Phase 4 schema suite could not reach Postgres at ${DB_URL}. ` +
        "Start the local Supabase stack; this suite fails rather than skips.",
      { cause },
    );
  }
});

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await db.query("begin");
  // Every existing table touched by the migration carries a row before catalog/constraint tests.
  // This keeps the suite representative of hosted application rather than empty-schema success.
  await db.query(`
    insert into public.tenants (id, slug, name, billing_contact_email) values
      ('${TENANT_A}', 'phase4-a', 'Phase 4 A', 'billing-a@phase4.test'),
      ('${TENANT_B}', 'phase4-b', 'Phase 4 B', 'billing-b@phase4.test');
    insert into public.users (id, email, role, tenant_id) values
      ('${ADMIN}', 'schema-admin@phase4.test', 'admin', null),
      ('${COACH}', 'schema-coach@phase4.test', 'coach', '${TENANT_A}');
    insert into public.contacts (id, tenant_id, last_channel, name) values
      ('${CONTACT_A}', '${TENANT_A}', 'instagram', 'Synthetic lead A'),
      ('${CONTACT_B}', '${TENANT_A}', 'instagram', 'Synthetic lead B'),
      ('${CONTACT_OTHER}', '${TENANT_B}', 'instagram', 'Synthetic lead other');
    insert into public.conversations
      (id, tenant_id, contact_id, channel, provider_window_expires_at)
      values ('${CONVERSATION}', '${TENANT_A}', '${CONTACT_A}', 'instagram', now() + interval '1 hour');
    insert into public.messages
      (id, tenant_id, conversation_id, direction, author, body, provider, provider_message_id)
      values ('${MESSAGE}', '${TENANT_A}', '${CONVERSATION}', 'out', 'agent',
        'Synthetic reply', 'meta_direct', 'phase4-message');
    insert into public.ghl_installs
      (id, tenant_id, location_id, company_id, token_expires_at)
      values ('${GHL_INSTALL}', '${TENANT_A}', 'phase4-schema-location',
        'phase4-schema-company', now() + interval '1 hour');
    insert into public.contact_identities
      (tenant_id, contact_id, provider, channel, provider_identity_id, provider_account_id, ghl_install_id)
      values ('${TENANT_A}', '${CONTACT_A}', 'ghl', 'instagram', 'phase4-identity',
        'phase4-schema-location', '${GHL_INSTALL}');
    insert into public.channel_connections
      (id, tenant_id, channel, provider, state, external_account_id)
      values
        ('${GHL_CONNECTION}', '${TENANT_A}', 'instagram', 'ghl', 'ready', 'phase4-schema-location'),
        ('${META_CONNECTION}', '${TENANT_A}', 'instagram', 'meta_direct', 'ready', 'phase4-meta-account');
    insert into public.message_templates
      (id, tenant_id, channel, provider, provider_template_id, name, provider_template_name,
       status, locale, body, body_hash, variables, status_updated_at)
      values ('${TEMPLATE}', '${TENANT_A}', 'whatsapp', 'meta_direct', null,
        'Synthetic draft', 'synthetic_draft', 'draft', 'en_US', 'Synthetic body',
        repeat('a', 64), '[]', now());
    insert into public.contact_duplicate_candidates
      (tenant_id, contact_a_id, contact_b_id, source, evidence_key, evidence)
      values ('${TENANT_A}', '${CONTACT_A}', '${CONTACT_B}', 'field_match',
        'normalized-phone-match', '{"synthetic":true}');
    insert into public.channel_connection_secrets (channel_connection_id, credential_envelope)
      values ('${GHL_CONNECTION}',
        '{"version":1,"keyVersion":1,"algorithm":"A256GCM","iv":"AAAAAAAAAAAAAAAA","ciphertext":"AA","tag":"AAAAAAAAAAAAAAAAAAAAAA"}');
    insert into public.ghl_install_secrets
      (ghl_install_id, access_credential_envelope, refresh_credential_envelope)
      values ('${GHL_INSTALL}',
        '{"version":1,"keyVersion":1,"algorithm":"A256GCM","iv":"AAAAAAAAAAAAAAAA","ciphertext":"AA","tag":"AAAAAAAAAAAAAAAAAAAAAA"}',
        '{"version":1,"keyVersion":1,"algorithm":"A256GCM","iv":"AAAAAAAAAAAAAAAA","ciphertext":"AA","tag":"AAAAAAAAAAAAAAAAAAAAAA"}');
    insert into public.channel_oauth_states
      (tenant_id, actor_id, channel, state_hash, return_path, expires_at)
      values ('${TENANT_A}', '${COACH}', 'instagram', repeat('b', 64),
        '/coach/settings', now() + interval '5 minutes');
    insert into public.channel_operation_receipts
      (tenant_id, operation, idempotency_key, payload_hash, result)
      values ('${TENANT_A}', 'submit_template', 'phase4-replay', repeat('c', 64), '{"synthetic":true}');
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("Phase 4 migration and catalog contract", () => {
  it("extends Phase 1 identity and template objects instead of recreating them", () => {
    const migration = readFileSync(
      resolve("supabase/migrations/20260820000001_phase4_channels.sql"),
      "utf8",
    );
    expect(migration).not.toMatch(/create table public\.contact_identities/i);
    expect(migration).not.toMatch(/create table public\.message_templates/i);
    expect(migration).toMatch(/alter table public\.message_templates/i);
    expect(migration).toMatch(/alter table public\.conversations/i);
  });

  it("moves both legacy credential sources before dropping browser-readable columns", () => {
    const migration = readFileSync(
      resolve("supabase/migrations/20260820000001_phase4_channels.sql"),
      "utf8",
    );
    const channelMove = migration.indexOf("insert into public.channel_connection_secrets");
    const ghlMove = migration.indexOf("insert into public.ghl_install_secrets");
    const channelDrop = migration.indexOf("alter table public.channel_connections drop column access_token");
    const ghlDrop = migration.indexOf("alter table public.ghl_installs drop column access_token");
    expect(channelMove).toBeGreaterThan(0);
    expect(ghlMove).toBeGreaterThan(channelMove);
    expect(channelDrop).toBeGreaterThan(ghlMove);
    expect(ghlDrop).toBeGreaterThan(channelDrop);
    expect(migration).toContain("PHASE4_CHANNEL_SECRET_MIGRATION_INCOMPLETE");
    expect(migration).toContain("PHASE4_GHL_SECRET_MIGRATION_INCOMPLETE");
  });

  it("contains every required extension column and no copied candidate test flag", async () => {
    const result = await db.query<{ signature: string }>(`
      select table_name || '.' || column_name as signature
      from information_schema.columns
      where table_schema = 'public' and (
        (table_name = 'contacts' and column_name = 'merged_into_contact_id') or
        (table_name = 'conversations' and column_name = 'provider_window_expires_at') or
        (table_name = 'message_templates' and column_name in
          ('provider_template_name','category','locale','body_hash','variables','rejection_detail','is_demo'))
      ) order by 1
    `);
    expect(result.rows.map((row) => row.signature)).toEqual([
      "contacts.merged_into_contact_id",
      "conversations.provider_window_expires_at",
      "message_templates.body_hash",
      "message_templates.category",
      "message_templates.is_demo",
      "message_templates.locale",
      "message_templates.provider_template_name",
      "message_templates.rejection_detail",
      "message_templates.variables",
    ]);
    const candidateColumns = await db.query<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema='public' and table_name='contact_duplicate_candidates'
      order by column_name
    `);
    expect(candidateColumns.rows.map((row) => row.column_name)).not.toContain("is_test");
  });

  it("keeps the exact policy-command map for every Phase 4 custody table", async () => {
    const result = await db.query<{ tablename: string; commands: string[] }>(`
      select tablename, array_agg(cmd order by cmd)::text[] as commands
      from pg_policies
      where schemaname='public' and tablename = any($1::text[])
      group by tablename order by tablename
    `, [Object.keys(PHASE4_TABLE_POLICIES)]);
    expect(Object.fromEntries(result.rows.map((row) => [row.tablename, row.commands])))
      .toEqual(PHASE4_TABLE_POLICIES);
  });

  it("gives each secrets table one service-role policy and no browser grant", async () => {
    const policies = await db.query<{ tablename: string; policyname: string; cmd: string; roles: string[] }>(`
      select tablename, policyname, cmd, roles::text[]
      from pg_policies
      where schemaname='public'
        and tablename in ('channel_connection_secrets','ghl_install_secrets')
      order by tablename, policyname
    `);
    expect(policies.rows).toEqual([
      {
        tablename: "channel_connection_secrets",
        policyname: "channel_connection_secrets_service_all",
        cmd: "ALL",
        roles: ["service_role"],
      },
      {
        tablename: "ghl_install_secrets",
        policyname: "ghl_install_secrets_service_all",
        cmd: "ALL",
        roles: ["service_role"],
      },
    ]);
    const grants = await db.query<{ count: string }>(`
      select count(*)::text from information_schema.role_table_grants
      where table_schema='public'
        and table_name in ('channel_connection_secrets','ghl_install_secrets')
        and grantee in ('anon','authenticated')
    `);
    expect(grants.rows[0].count).toBe("0");
  });

  it("retains non-token GHL metadata while removing every plaintext token column", async () => {
    const columns = await db.query<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema='public'
        and table_name in ('channel_connections','ghl_installs')
        and column_name in ('access_token','refresh_token')
      order by column_name
    `);
    expect(columns.rows).toEqual([]);
    const metadata = await db.query<{ location_id: string; company_id: string }>(`
      select location_id, company_id from public.ghl_installs where id='${GHL_INSTALL}'
    `);
    expect(metadata.rows[0]).toEqual({
      location_id: "phase4-schema-location",
      company_id: "phase4-schema-company",
    });
  });
});

describe("Phase 4 populated-table constraints", () => {
  it("enforces one live provider per tenant and channel", async () => {
    const receipt = await db.query<{ id: string }>(`
      insert into public.webhook_events
        (provider,provider_event_id,tenant_id,payload,signature_verified,status)
      values ('meta','phase4-signed-receipt','${TENANT_A}','{}',true,'processed') returning id
    `);
    await db.query(`
      update public.channel_connections
      set state='live', asset_verified_at=now(), webhook_subscribed_at=now(), signed_round_trip_at=now(),
          last_signed_inbound_receipt_id=$1, last_signed_outbound_message_id='${MESSAGE}'
      where id='${META_CONNECTION}'
    `, [receipt.rows[0].id]);
    await expectDbError(
      `update public.channel_connections set state='live' where id=$1`,
      [GHL_CONNECTION],
      /channel_connections_one_live_provider_idx/,
    );
  });

  it("refuses a live direct-Meta state without persisted round-trip receipts", async () => {
    await expectDbError(
      `update public.channel_connections set state='live' where id=$1`,
      [META_CONNECTION],
      /channel_connections_meta_live_receipt_chk/,
    );
  });

  it("rejects cross-tenant duplicate evidence and ordered-pair drift", async () => {
    await expectDbError(
      `insert into public.contact_duplicate_candidates
        (tenant_id,contact_a_id,contact_b_id,source,evidence_key)
       values ($1,$2,$3,'field_match','cross-tenant')`,
      [TENANT_A, CONTACT_A, CONTACT_OTHER],
      /DUPLICATE_CANDIDATE_TENANT_MISMATCH/,
    );
    await expectDbError(
      `insert into public.contact_duplicate_candidates
        (tenant_id,contact_a_id,contact_b_id,source,evidence_key)
       values ($1,$2,$3,'field_match','reverse')`,
      [TENANT_A, CONTACT_B, CONTACT_A],
      /contact_duplicate_candidates_order_chk/,
    );
  });

  it("rejects cross-tenant and cyclic contact merge state", async () => {
    const auditA = await db.query<{ id: string }>(`
      insert into public.audit_log (actor_id,tenant_id,action,target_type,target_id,reason,payload)
      values ('${ADMIN}','${TENANT_A}','contact.merged','contact','${CONTACT_B}','Synthetic merge',
        '{"prior":{"winner":{"id":"${CONTACT_B}"},"loser":{"id":"${CONTACT_A}"},"identities":[],"conversations":[],"candidates":[]},"new":{}}'::jsonb)
      returning id::text
    `);
    await expectDbError(
      `update public.contacts set merged_into_contact_id=$2,merged_at=now(),merge_audit_id=$3 where id=$1`,
      [CONTACT_A, CONTACT_OTHER, auditA.rows[0].id],
      /MERGE_TARGET_TENANT_MISMATCH/,
    );
    await db.query(
      `update public.contacts set merged_into_contact_id=$2,merged_at=now(),merge_audit_id=$3 where id=$1`,
      [CONTACT_A, CONTACT_B, auditA.rows[0].id],
    );
    const auditB = await db.query<{ id: string }>(`
      insert into public.audit_log (actor_id,tenant_id,action,target_type,target_id,reason,payload)
      values ('${ADMIN}','${TENANT_A}','contact.merged','contact','${CONTACT_A}','Synthetic cycle',
        '{"prior":{"winner":{"id":"${CONTACT_A}"},"loser":{"id":"${CONTACT_B}"},"identities":[],"conversations":[],"candidates":[]},"new":{}}'::jsonb)
      returning id::text
    `);
    await expectDbError(
      `update public.contacts set merged_into_contact_id=$2,merged_at=now(),merge_audit_id=$3 where id=$1`,
      [CONTACT_B, CONTACT_A, auditB.rows[0].id],
      /MERGE_CYCLE_FORBIDDEN/,
    );
  });

  it("keeps OAuth state short-lived and operation replay tenant-scoped", async () => {
    await expectDbError(
      `insert into public.channel_oauth_states
        (tenant_id,actor_id,channel,state_hash,return_path,expires_at)
       values ($1,$2,'instagram',$3,'/coach/settings',now()+interval '11 minutes')`,
      [TENANT_A, COACH, "d".repeat(64)],
      /channel_oauth_states_expiry_chk/,
    );
    const sameKeyOtherTenant = await db.query<{ id: string }>(`
      insert into public.channel_operation_receipts
        (tenant_id,operation,idempotency_key,payload_hash,result)
      values ($1,'submit_template','phase4-replay',$2,'{}') returning id
    `, [TENANT_B, "e".repeat(64)]);
    expect(sameKeyOtherTenant.rows[0].id).toBeTruthy();
  });
});
