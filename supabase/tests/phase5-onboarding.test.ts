// Phase 5 onboarding schema contract. Every case runs against migrated Postgres in a rollback-only
// transaction so lease, RLS, immutable evidence, and audit atomicity are proved without persistent rows.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TENANT_A = "51000000-0000-4000-8000-000000000010";
const TENANT_B = "51000000-0000-4000-8000-000000000020";
const TIER = "52000000-0000-4000-8000-000000000010";
const ADMIN = "53000000-0000-4000-8000-000000000010";
const COACH_A = "53000000-0000-4000-8000-000000000020";
const COACH_B = "53000000-0000-4000-8000-000000000030";
const AFFILIATE = "53000000-0000-4000-8000-000000000040";
const AUTH_NEW = "53000000-0000-4000-8000-000000000050";

const PROVISIONING_STEPS = [
  "account", "billing", "ghl_location", "ghl_snapshot", "phone_number",
  "sms_eligibility_screen", "business_profile", "optin_artifact", "a2p_brand",
  "a2p_campaign", "sms_live", "meta_connect", "whatsapp_connect",
  "calendar_connect", "offer_layer", "test_pass", "go_live",
] as const;

const PHASE5_TABLES = [
  "a2p_probe_receipts",
  "business_profiles",
  "onboarding_content_screens",
  "onboarding_optin_artifacts",
] as const;

const PHASE5_SERVICE_FUNCTIONS = [
  "acknowledge_onboarding_content_screen",
  "claim_provisioning_step",
  "complete_onboarding_signup",
  "complete_provisioning_step",
  "confirm_onboarding_artifact",
  "confirm_onboarding_content_screen",
  "fail_provisioning_step",
  "go_live_onboarding",
  "record_a2p_probe_receipt",
  "record_web_form_consent",
  "retry_provisioning_step",
  "transition_provisioning_step",
  "unblock_provisioning_step",
  "read_coach_a2p_registration",
] as const;

const PHASE5_READ_FUNCTIONS = [
  "list_signup_tier_catalog",
  "read_hosted_onboarding_artifact",
  "read_self_signup_intent",
] as const;

let db: Client;

async function actAs(
  pgRole: "authenticated" | "anon" | "service_role",
  claims: Record<string, string> = {},
) {
  await db.query(`set local role ${pgRole}`);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: claims.sub, app_metadata: claims }),
  ]);
}

async function resetRole() {
  await db.query("reset role");
  await db.query(`select set_config('request.jwt.claims', '{}', true)`);
}

async function createGhlInstallBinding(tenantId: string) {
  const locationId = `synthetic-phase5-location-${tenantId}`;
  const install = await db.query<{ id: string; location_id: string }>(
    `insert into public.ghl_installs (tenant_id, location_id, company_id, token_expires_at)
     values ($1, $2, $3, now() + interval '1 day')
     returning id, location_id`,
    [tenantId, locationId, `synthetic-phase5-company-${tenantId}`],
  );
  return install.rows[0];
}

async function insertStep(
  stepKey: (typeof PROVISIONING_STEPS)[number],
  state = "pending",
  options: { tenantId?: string; awaitingParty?: string; blockedReason?: string } = {},
) {
  const tenantId = options.tenantId ?? TENANT_A;
  const completedAt = state === "done" ? "now()" : "null";
  const result = await db.query<{ id: string }>(
    `insert into public.provisioning_steps (
       tenant_id, step_key, state, awaiting_party, blocked_reason, completed_at,
       next_attempt_at, last_transition_at, idempotency_key
     ) values ($1::uuid, $2::public.provisioning_step, $3, $4, $5, ${completedAt},
       now(), now(), $1::uuid::text || ':' || $2::public.provisioning_step::text)
     returning id`,
    [tenantId, stepKey, state, options.awaitingParty ?? null, options.blockedReason ?? null],
  );
  return result.rows[0].id;
}

async function insertArtifact(placeholder = false, tenantId = TENANT_A) {
  const hash = "a".repeat(64);
  const termsBody = "Synthetic terms including the no-sharing clause.";
  const privacyBody = "Synthetic privacy posture.";
  const result = await db.query<{ id: string }>(
    `insert into public.onboarding_optin_artifacts (
       tenant_id, version, template_version, marketing_language, marketing_language_hash,
       non_marketing_language, non_marketing_language_hash, terms_url, privacy_url,
       terms_body, terms_body_hash, privacy_body, privacy_body_hash,
       campaign_description, campaign_description_hash, artifact_hash, placeholder
     ) values ($1, 1, 'template-v1', 'Marketing disclosure', $2,
       'Non-marketing disclosure', $2, 'https://example.test/terms',
       'https://example.test/privacy', $3, $4, $5, $6,
       'Campaign description', $2, $2, $7)
     returning id`,
    [
      tenantId,
      hash,
      termsBody,
      createHash("sha256").update(termsBody).digest("hex"),
      privacyBody,
      createHash("sha256").update(privacyBody).digest("hex"),
      placeholder,
    ],
  );
  return result.rows[0].id;
}

async function insertScreen(result: "clean" | "flagged") {
  const matches = result === "clean" ? [] : [{ phrase: "synthetic match", page: "/offer" }];
  const row = await db.query<{ id: string }>(
    `insert into public.onboarding_content_screens (tenant_id, input_hash, result, matches)
     values ($1, $2, $3, $4) returning id`,
    [TENANT_A, result === "clean" ? "b".repeat(64) : "c".repeat(64), result, JSON.stringify(matches)],
  );
  return row.rows[0].id;
}

function signupEmail(authUserId: string) {
  return `${authUserId.replaceAll("-", "").slice(-12)}@signup.test`;
}

async function insertSignupIntent(authUserId: string, code: string | null = null) {
  await db.query(
    `insert into public.signup_intents (auth_user_id, email, tier_id, timezone, referral_code)
     values ($1, $2, $3, 'Asia/Kolkata', $4)`,
    [authUserId, signupEmail(authUserId), TIER, code],
  );
}

async function completeSignup(authUserId: string, slug: string, code: string | null = null) {
  return db.query<{
    tenant_id: string;
    referral_result: string;
    audit_id: string;
    replayed: boolean;
  }>(
    `select * from public.complete_onboarding_signup(
       $1, $1, $2, 'Synthetic Coach', 'Synthetic Business', $3,
       $4, 'Asia/Kolkata', $5, false
     )`,
    [authUserId, signupEmail(authUserId), slug, TIER, code],
  );
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Phase 5 onboarding suite could not reach Postgres at ${DB_URL}. ` +
        "Start the local stack with `supabase start`; this suite fails rather than skips.",
      { cause },
    );
  }
});

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await db.query("begin");
  await db.query(`
    insert into public.tiers (id, name, price_cents, call_allowance)
    values ('${TIER}', 'Phase 5 synthetic tier', 10000, 10);
    insert into public.tenants (id, slug, name, tier_id, billing_contact_email) values
      ('${TENANT_A}', 'phase5-a', 'Phase 5 A', '${TIER}', 'billing-a@phase5.test'),
      ('${TENANT_B}', 'phase5-b', 'Phase 5 B', '${TIER}', 'billing-b@phase5.test');
    insert into public.tenant_settings (tenant_id, timezone) values
      ('${TENANT_A}', 'America/Chicago'), ('${TENANT_B}', 'America/Denver');
    insert into public.users (id, email, role, tenant_id) values
      ('${ADMIN}', 'admin@phase5.test', 'admin', null),
      ('${COACH_A}', 'coach-a@phase5.test', 'coach', '${TENANT_A}'),
      ('${COACH_B}', 'coach-b@phase5.test', 'coach', '${TENANT_B}'),
      ('${AFFILIATE}', 'affiliate@phase5.test', 'affiliate', null);
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("Phase 5 catalog and custody", () => {
  it("keeps the exact seventeen Phase 1 steps instead of creating a second vocabulary", async () => {
    const result = await db.query<{ enumlabel: string }>(`
      select e.enumlabel
      from pg_enum e
      join pg_type t on t.oid = e.enumtypid
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' and t.typname = 'provisioning_step'
      order by e.enumsortorder
    `);
    expect(result.rows.map((row) => row.enumlabel)).toEqual(PROVISIONING_STEPS);
  });

  it("creates only the four Phase 5 evidence tables with forced RLS and explicit read policies", async () => {
    const result = await db.query<{
      relname: string;
      relforcerowsecurity: boolean;
      policies: string;
    }>(`
      select c.relname, c.relforcerowsecurity, count(p.policyname)::text as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_policies p on p.schemaname = n.nspname and p.tablename = c.relname
      where n.nspname = 'public' and c.relname = any($1::text[])
      group by c.relname, c.relforcerowsecurity order by c.relname
    `, [[...PHASE5_TABLES]]);
    expect(result.rows.map((row) => row.relname)).toEqual([...PHASE5_TABLES]);
    expect(result.rows.every((row) => row.relforcerowsecurity && Number(row.policies) === 2)).toBe(true);
  });

  it("adds no is_test trigger and never creates a plaintext sensitive companion", async () => {
    const triggers = await db.query<{ table_name: string }>(`
      select event_object_table as table_name from information_schema.triggers
      where trigger_schema = 'public' and trigger_name = 'inherit_is_test'
        and event_object_table = any($1::text[])
    `, [[...PHASE5_TABLES]]);
    expect(triggers.rows).toEqual([]);
    const companions = await db.query<{ name: string | null }>(`
      select to_regclass('public.business_profile_sensitive')::text as name
    `);
    expect(companions.rows[0].name).toBeNull();
  });

  it("pins lease columns, constraint names, and the runnable index", async () => {
    const columns = await db.query<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'provisioning_steps'
        and column_name in (
          'attempt_id', 'idempotency_key', 'last_transition_at',
          'lease_expires_at', 'next_attempt_at'
        ) order by column_name
    `);
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "attempt_id", "idempotency_key", "last_transition_at", "lease_expires_at", "next_attempt_at",
    ]);
    const objects = await db.query<{ names: string[] }>(`
      select array_agg(name order by name)::text[] as names from (
        select conname as name from pg_constraint
        where conrelid = 'public.provisioning_steps'::regclass
          and conname like 'provisioning_steps_%'
        union all
        select indexname from pg_indexes
        where schemaname = 'public' and tablename = 'provisioning_steps'
          and indexname = 'provisioning_steps_runnable_idx'
      ) catalog
    `);
    expect(objects.rows[0].names).toEqual(expect.arrayContaining([
      "provisioning_steps_completion_shape_chk",
      "provisioning_steps_idempotency_shape_chk",
      "provisioning_steps_idempotency_key_key",
      "provisioning_steps_lease_shape_chk",
      "provisioning_steps_runnable_idx",
    ]));
  });

  it("exposes every service RPC only to service_role", async () => {
    const result = await db.query<{
      proname: string;
      auth_exec: boolean;
      service_exec: boolean;
    }>(`
      select p.proname,
        has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
        has_function_privilege('service_role', p.oid, 'execute') as service_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[])
      order by p.proname
    `, [[...PHASE5_SERVICE_FUNCTIONS]]);
    expect(result.rows.map((row) => row.proname)).toEqual([...PHASE5_SERVICE_FUNCTIONS].sort());
    expect(result.rows.every((row) => !row.auth_exec && row.service_exec)).toBe(true);
  });

  it("keeps the three public read functions security-definer with explicit grants", async () => {
    const result = await db.query<{
      proname: string;
      security_definer: boolean;
      config: string[];
      anon_exec: boolean;
      auth_exec: boolean;
    }>(`
      select p.proname, p.prosecdef as security_definer, p.proconfig::text[] as config,
        has_function_privilege('anon', p.oid, 'execute') as anon_exec,
        has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[])
      order by p.proname
    `, [[...PHASE5_READ_FUNCTIONS]]);
    expect(result.rows.map((row) => row.proname)).toEqual([...PHASE5_READ_FUNCTIONS].sort());
    expect(result.rows.every((row) => row.security_definer && row.config.includes("search_path=\"\"")))
      .toBe(true);
    expect(result.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ proname: "list_signup_tier_catalog", anon_exec: true, auth_exec: true }),
      expect.objectContaining({ proname: "read_hosted_onboarding_artifact", anon_exec: true, auth_exec: true }),
      expect.objectContaining({ proname: "read_self_signup_intent", anon_exec: false, auth_exec: true }),
    ]));
  });

  /**
   * The allowance joins the catalogue; the economics still do not.
   *
   * `call_allowance` is what the plans differ on and what the public marketing page already sells
   * them on, so a signup catalogue that returns a price and not this describes the product by the
   * number that varies least. What this test guards has not moved: `price_cents`, `fair_use_cap`
   * and `stripe_price_id` stay behind the projection, and the check is now written as a denylist of
   * those names as well as an exact key set -- so a column added to `tiers` and passed straight
   * through fails here rather than reaching an unauthenticated reader.
   */
  it("returns active tier ids, labels and allowances without exposing an economic column", async () => {
    await db.query(`
      insert into public.tiers (name, price_cents, call_allowance, active)
      values ('Hidden inactive tier', 99999, 999, false)
    `);
    await actAs("anon");
    const result = await db.query<Record<string, unknown>>(
      "select * from public.list_signup_tier_catalog() order by label",
    );
    expect(result.rows).toContainEqual({
      id: TIER,
      label: "Phase 5 synthetic tier",
      call_allowance: expect.any(Number),
    });
    expect(result.rows.every((row) =>
      Object.keys(row).sort().join(",") === "call_allowance,id,label")).toBe(true);
    for (const economic of ["price_cents", "fair_use_cap", "stripe_price_id", "active"]) {
      expect(result.rows.every((row) => !(economic in row))).toBe(true);
    }
    // The inactive tier stays out, allowance or not.
    expect(JSON.stringify(result.rows)).not.toContain("Hidden inactive tier");
  });

  it("returns only the verified subject's own signup intent", async () => {
    await insertSignupIntent(AUTH_NEW);
    const otherAuth = "53000000-0000-4000-8000-000000000060";
    await insertSignupIntent(otherAuth);
    await actAs("authenticated", { sub: AUTH_NEW });
    const result = await db.query<{
      intent_id: string;
      state: string;
      tenant_id: string | null;
      error_code: string | null;
    }>("select * from public.read_self_signup_intent()");
    expect(result.rows).toEqual([{
      intent_id: expect.any(String),
      state: "started",
      tenant_id: null,
      error_code: null,
    }]);
    expect(JSON.stringify(result.rows)).not.toContain(otherAuth);
  });

  it("contains no Phase 3 or Phase 4 table recreation in the migration", () => {
    const migration = readFileSync(resolve(
      process.cwd(),
      "supabase/migrations/20260821000001_phase5_self_serve_onboarding.sql",
    ), "utf8");
    expect(migration).not.toMatch(/create table public\.(contact_identities|channel_connections)/);
    expect(migration).not.toMatch(/SETTERFI_DEMO_PLACEHOLDER_[^'"\s]*/);
  });
});

describe("RLS and tracker isolation", () => {
  it("lets a coach read only their own export-ready evidence and grants no direct writes", async () => {
    await db.query(`
      insert into public.business_profiles (
        tenant_id, legal_name, entity_type, has_ein, website_url,
        address_line1, city, region, postal_code, country_code
      ) values
        ('${TENANT_A}', 'Synthetic A', 'llc', true, 'https://a.test', '1 Test St', 'Austin', 'TX', '78701', 'US'),
        ('${TENANT_B}', 'Synthetic B', 'llc', true, 'https://b.test', '2 Test St', 'Denver', 'CO', '80202', 'US');
    `);
    await actAs("authenticated", { role: "coach", tenant_id: TENANT_A, sub: COACH_A });
    const rows = await db.query<{ tenant_id: string }>(
      "select tenant_id::text from public.business_profiles order by tenant_id",
    );
    expect(rows.rows).toEqual([{ tenant_id: TENANT_A }]);
    await db.query("savepoint coach_forge");
    await expect(db.query(`
      insert into public.business_profiles (
        tenant_id, legal_name, entity_type, has_ein, website_url,
        address_line1, city, region, postal_code, country_code
      ) values ('${TENANT_A}', 'Forged', 'llc', true, 'https://forged.test',
        '3 Test St', 'Austin', 'TX', '78701', 'US')
    `)).rejects.toThrow(/permission denied/);
  });

  it("denies direct service-role evidence writes so every mutation uses an RPC", async () => {
    await actAs("service_role");
    await expect(db.query(`
      insert into public.a2p_probe_receipts (
        tenant_id, probe_key, target_identifier_hash, result, observed_at
      ) values ('${TENANT_A}', 'forged', '${"d".repeat(64)}', 'inconclusive', now())
    `)).rejects.toThrow(/permission denied/);
  });

  it("includes a tenantless failed intent in the service tracker and denies coach enumeration", async () => {
    await db.query(`
      insert into public.signup_intents (auth_user_id, email, state, error)
      values ('${AUTH_NEW}', 'failed@phase5.test', 'failed', 'SIGNUP_SYNTHETIC_FAILURE')
    `);
    await actAs("service_role");
    const tracker = await db.query<{
      tenant_id: string | null;
      state: string;
      blocking_party: string;
      error_code: string;
    }>(`
      select tenant_id::text, state, blocking_party, error_code
      from public.provisioning_tracker_rows where signup_intent_id = (
        select id from public.signup_intents where auth_user_id = '${AUTH_NEW}'
      )
    `);
    expect(tracker.rows[0]).toEqual({
      tenant_id: null,
      state: "failed",
      blocking_party: "system",
      error_code: "SIGNUP_SYNTHETIC_FAILURE",
    });
    await resetRole();
    await actAs("authenticated", { role: "coach", tenant_id: TENANT_A, sub: COACH_A });
    await expect(db.query("select * from public.provisioning_tracker_rows"))
      .rejects.toThrow(/permission denied/);
  });

  it("appends demo classification and current content-screen evidence without widening grants", async () => {
    await db.query(`
      update public.tenants set is_demo = true where id = '${TENANT_A}';
      insert into public.signup_intents (auth_user_id, email, tenant_id, state)
      values ('${AUTH_NEW}', 'tracker@phase5.test', '${TENANT_A}', 'completed');
    `);
    const screenId = await insertScreen("flagged");
    await db.query(
      "select public.acknowledge_onboarding_content_screen($1, $2, $3)",
      [TENANT_A, screenId, COACH_A],
    );
    await actAs("service_role");
    const tracker = await db.query<{
      is_demo: boolean;
      content_screen_id: string;
      content_screen_state: string;
    }>(`
      select is_demo, content_screen_id::text, content_screen_state
      from public.provisioning_tracker_rows where tenant_id = $1
    `, [TENANT_A]);
    expect(tracker.rows[0]).toEqual({
      is_demo: true,
      content_screen_id: screenId,
      content_screen_state: "awaiting_admin",
    });
    const grants = await db.query<{ grantee: string; privilege_type: string }>(`
      select grantee, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'provisioning_tracker_rows'
      order by grantee, privilege_type
    `);
    expect([...new Set(grants.rows.map((row) => row.grantee))]).toEqual(["service_role"]);
    expect(grants.rows).toContainEqual({ grantee: "service_role", privilege_type: "SELECT" });
  });
});

describe("public artifact and coach registration projections", () => {
  it("returns only confirmed current bodies for an active slug and labels demo placeholders", async () => {
    await db.query(`update public.tenants set status = 'active' where id = '${TENANT_A}'`);
    const artifactId = await insertArtifact(false);
    await db.query(
      "select public.confirm_onboarding_artifact($1, $2, $3)",
      [TENANT_A, artifactId, COACH_A],
    );
    await actAs("anon");
    const terms = await db.query<{
      artifact_id: string;
      business_name: string;
      terms_body: string;
      terms_body_hash: string;
      placeholder: boolean;
    }>("select artifact_id::text, business_name, terms_body, terms_body_hash, placeholder from public.read_hosted_onboarding_artifact('phase5-a', 'terms')");
    expect(terms.rows[0]).toMatchObject({
      artifact_id: artifactId,
      business_name: "Phase 5 A",
      terms_body: "Synthetic terms including the no-sharing clause.",
      terms_body_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      placeholder: false,
    });

    await resetRole();
    await db.query(`update public.tenants set status = 'active', is_demo = true where id = '${TENANT_B}'`);
    const demoArtifact = await insertArtifact(true, TENANT_B);
    await db.query(`
      update public.onboarding_optin_artifacts
      set confirmed_at = now(), confirmed_by = '${COACH_B}'
      where id = '${demoArtifact}'
    `);
    await actAs("anon");
    const demo = await db.query<{ is_demo: boolean; placeholder: boolean }>(
      "select is_demo, placeholder from public.read_hosted_onboarding_artifact('phase5-b', 'consent')",
    );
    expect(demo.rows).toEqual([{ is_demo: true, placeholder: true }]);
  });

  it("returns zero public rows for unknown, non-live, unconfirmed, and production placeholder artifacts", async () => {
    await insertArtifact(false);
    await actAs("anon");
    const nonLive = await db.query("select * from public.read_hosted_onboarding_artifact('phase5-a', 'consent')");
    const unknown = await db.query("select * from public.read_hosted_onboarding_artifact('missing', 'consent')");
    expect(nonLive.rows).toEqual([]);
    expect(unknown.rows).toEqual([]);

    await resetRole();
    await db.query(`update public.tenants set status = 'active' where id = '${TENANT_A}'`);
    const artifactId = await db.query<{ id: string }>(
      "select id::text from public.onboarding_optin_artifacts where tenant_id = $1",
      [TENANT_A],
    );
    await db.query(`
      update public.onboarding_optin_artifacts
      set placeholder = true, confirmed_at = now(), confirmed_by = '${COACH_A}'
      where id = '${artifactId.rows[0].id}'
    `);
    await actAs("anon");
    const placeholder = await db.query("select * from public.read_hosted_onboarding_artifact('phase5-a', 'consent')");
    expect(placeholder.rows).toEqual([]);
  });

  it("projects submitted-at, current state, and normalized terminal evidence for one tenant", async () => {
    await insertStep("a2p_campaign", "done");
    await db.query(`
      update public.provisioning_steps
      set external_ref = '{"submittedAt":"2026-08-17T12:00:00.000Z"}'::jsonb
      where tenant_id = '${TENANT_A}' and step_key = 'a2p_campaign'
    `);
    await insertStep("sms_live", "awaiting_provider", { awaitingParty: "carrier" });
    const active = await db.query<{
      submitted_at: string;
      registration_state: string;
      terminal_rejection: boolean;
      terminal_code: string | null;
    }>("select submitted_at::text, registration_state, terminal_rejection, terminal_code from public.read_coach_a2p_registration($1)", [TENANT_A]);
    expect(active.rows[0]).toEqual({
      submitted_at: "2026-08-17 12:00:00+00",
      registration_state: "awaiting_provider",
      terminal_rejection: false,
      terminal_code: null,
    });

    await db.query(`
      update public.provisioning_steps
      set state = 'blocked', awaiting_party = null, blocked_reason = 'Synthetic terminal refusal',
        error_code = 'CARRIER_TERMINAL'
      where tenant_id = '${TENANT_A}' and step_key = 'sms_live'
    `);
    const terminal = await db.query<{
      registration_state: string;
      terminal_rejection: boolean;
      terminal_code: string;
    }>("select registration_state, terminal_rejection, terminal_code from public.read_coach_a2p_registration($1)", [TENANT_A]);
    expect(terminal.rows[0]).toEqual({
      registration_state: "blocked",
      terminal_rejection: true,
      terminal_code: "CARRIER_TERMINAL",
    });
  });
});

describe("provisioning transitions and evidence gates", () => {
  it("claims once, increments attempts, and rejects a stale completion", async () => {
    await insertStep("ghl_location");
    const attempt = "54000000-0000-4000-8000-000000000010";
    const claimed = await db.query<{
      attempt_id: string;
      attempts: number;
      idempotency_key: string;
    }>(`select attempt_id, attempts, idempotency_key from public.claim_provisioning_step(
      $1, 'ghl_location', $2, 300
    )`, [TENANT_A, attempt]);
    expect(claimed.rows[0]).toEqual({
      attempt_id: attempt,
      attempts: 1,
      idempotency_key: `${TENANT_A}:ghl_location`,
    });
    await expect(db.query(
      `select public.complete_provisioning_step($1, 'ghl_location', $2, '{}'::jsonb)`,
      [TENANT_A, "54000000-0000-4000-8000-000000000099"],
    )).rejects.toThrow(/PROVISIONING_ATTEMPT_STALE/);
  });

  it("clears awaiting_party on provider completion and records bounded failure", async () => {
    await insertStep("sms_live", "awaiting_provider", { awaitingParty: "carrier" });
    await db.query(`select public.transition_provisioning_step(
      $1, 'sms_live', null, 'done', null, null, null, '{}'::jsonb, null, null
    )`, [TENANT_A]);
    let row = await db.query<{ state: string; awaiting_party: string | null; completed: boolean }>(`
      select state::text, awaiting_party::text, completed_at is not null as completed
      from public.provisioning_steps where tenant_id = $1 and step_key = 'sms_live'
    `, [TENANT_A]);
    expect(row.rows[0]).toEqual({ state: "done", awaiting_party: null, completed: true });

    await insertStep("ghl_snapshot");
    const attempt = "54000000-0000-4000-8000-000000000020";
    await db.query(`select * from public.claim_provisioning_step($1, 'ghl_snapshot', $2, 300)`, [TENANT_A, attempt]);
    const audit = await db.query<{ id: string }>(`
      select public.fail_provisioning_step(
        $1, 'ghl_snapshot', $2, 'PROVIDER_TIMEOUT', 'Synthetic timeout', now() + interval '5 minutes'
      )::text as id
    `, [TENANT_A, attempt]);
    expect(audit.rows[0].id).toBeTruthy();
    row = await db.query(`
      select state::text, awaiting_party::text, completed_at is not null as completed
      from public.provisioning_steps where tenant_id = $1 and step_key = 'ghl_snapshot'
    `, [TENANT_A]);
    expect(row.rows[0]).toEqual({ state: "failed", awaiting_party: null, completed: false });
  });

  it("blocks with a reason, refuses general retry, and clears the reason only through audited correction", async () => {
    await insertStep("sms_live");
    await db.query(`select public.transition_provisioning_step(
      $1, 'sms_live', null, 'blocked', null, 'CARRIER_TERMINAL', 'Synthetic refusal',
      null, 'Carrier returned a terminal classification', null
    )`, [TENANT_A]);
    await db.query("savepoint blocked_retry");
    await expect(db.query(
      `select public.retry_provisioning_step($1, 'sms_live', $2, 'blocked')`,
      [TENANT_A, ADMIN],
    )).rejects.toThrow(/PROVISIONING_RETRY_FORBIDDEN/);
    await db.query("rollback to savepoint blocked_retry");
    const audit = await db.query<{ id: string }>(`
      select public.unblock_provisioning_step(
        $1, 'sms_live', $2, 'Provider corrected the classification'
      )::text as id
    `, [TENANT_A, ADMIN]);
    expect(audit.rows[0].id).toBeTruthy();
    const row = await db.query<{ state: string; blocked_reason: string | null }>(`
      select state::text, blocked_reason from public.provisioning_steps
      where tenant_id = $1 and step_key = 'sms_live'
    `, [TENANT_A]);
    expect(row.rows[0]).toEqual({ state: "pending", blocked_reason: null });
  });

  it("requires a confirmed non-placeholder artifact and current approved screen before filing", async () => {
    await insertStep("a2p_campaign");
    const attempt = "54000000-0000-4000-8000-000000000030";
    await db.query("savepoint artifact_missing");
    await expect(db.query(
      `select * from public.claim_provisioning_step($1, 'a2p_campaign', $2, 300)`,
      [TENANT_A, attempt],
    )).rejects.toThrow(/A2P_ARTIFACT_NOT_APPROVED/);
    await db.query("rollback to savepoint artifact_missing");
    const artifactId = await insertArtifact(true);
    await db.query(`select public.confirm_onboarding_artifact($1, $2, $3)`, [TENANT_A, artifactId, COACH_A]);
    await insertScreen("clean");
    await db.query("savepoint artifact_placeholder");
    await expect(db.query(
      `select * from public.claim_provisioning_step($1, 'a2p_campaign', $2, 300)`,
      [TENANT_A, attempt],
    )).rejects.toThrow(/A2P_ARTIFACT_NOT_APPROVED/);
    await db.query("rollback to savepoint artifact_placeholder");
    await db.query(
      "update public.onboarding_optin_artifacts set placeholder = false where id = $1",
      [artifactId],
    );
    await db.query(`select * from public.approve_onboarding_campaign_content($1, $2, $3::jsonb)`, [
      TENANT_A, COACH_A, JSON.stringify(["Synthetic A2P approval sample"]),
    ]);
    const claimed = await db.query<{ step_key: string }>(
      `select step_key::text from public.claim_provisioning_step($1, 'a2p_campaign', $2, 300)`,
      [TENANT_A, attempt],
    );
    expect(claimed.rows[0].step_key).toBe("a2p_campaign");
  });

  it("requires coach acknowledgement before audited platform confirmation on a flagged screen", async () => {
    const screenId = await insertScreen("flagged");
    await db.query("savepoint early_admin_confirmation");
    await expect(db.query(
      `select public.confirm_onboarding_content_screen($1, $2, $3)`,
      [TENANT_A, screenId, ADMIN],
    )).rejects.toThrow(/ONBOARDING_CONTENT_ADMIN_CONFIRMATION_FORBIDDEN/);
    await db.query("rollback to savepoint early_admin_confirmation");
    const acknowledgement = await db.query<{ id: string }>(`
      select public.acknowledge_onboarding_content_screen($1, $2, $3)::text as id
    `, [TENANT_A, screenId, COACH_A]);
    const confirmation = await db.query<{ id: string }>(`
      select public.confirm_onboarding_content_screen($1, $2, $3)::text as id
    `, [TENANT_A, screenId, ADMIN]);
    expect(acknowledgement.rows[0].id).toBeTruthy();
    expect(confirmation.rows[0].id).toBeTruthy();
    const actions = await db.query<{ action: string }>(`
      select action from public.audit_log where target_id = $1 order by id
    `, [screenId]);
    expect(actions.rows.map((row) => row.action)).toEqual([
      "onboarding.content_acknowledged",
      "onboarding.content_admin_confirmed",
      "onboarding.a2p_filing_confirmed",
    ]);
  });

  it("stamps the A2P registration start date on confirmation and never resets it", async () => {
    await insertStep("sms_live", "awaiting_provider", { awaitingParty: "carrier" });
    await insertStep("a2p_campaign");
    const screenId = await insertScreen("flagged");
    await db.query(
      `select public.acknowledge_onboarding_content_screen($1, $2, $3)`,
      [TENANT_A, screenId, COACH_A],
    );

    const before = await db.query<{ submitted_at: string | null }>(`
      select external_ref ->> 'submittedAt' as submitted_at from public.provisioning_steps
      where tenant_id = $1 and step_key = 'a2p_campaign'
    `, [TENANT_A]);
    expect(before.rows[0].submitted_at).toBeNull();

    await db.query(
      `select public.confirm_onboarding_content_screen($1, $2, $3)`,
      [TENANT_A, screenId, ADMIN],
    );
    const stamped = await db.query<{ submitted_at: string | null }>(`
      select external_ref ->> 'submittedAt' as submitted_at from public.provisioning_steps
      where tenant_id = $1 and step_key = 'a2p_campaign'
    `, [TENANT_A]);
    expect(stamped.rows[0].submitted_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );

    // The coach-facing day counter reads through this projection; it now has a real source.
    const projected = await db.query<{ submitted_at: string | null }>(
      `select submitted_at from public.read_coach_a2p_registration($1)`,
      [TENANT_A],
    );
    expect(projected.rows[0].submitted_at).not.toBeNull();
    expect(new Date(projected.rows[0].submitted_at!).toISOString())
      .toBe(stamped.rows[0].submitted_at);

    // A repeat confirmation must not move the start date, or the counter would restart at day 0.
    await db.query(
      `select public.confirm_onboarding_content_screen($1, $2, $3)`,
      [TENANT_A, screenId, ADMIN],
    );
    const replayed = await db.query<{ submitted_at: string | null }>(`
      select external_ref ->> 'submittedAt' as submitted_at from public.provisioning_steps
      where tenant_id = $1 and step_key = 'a2p_campaign'
    `, [TENANT_A]);
    expect(replayed.rows[0].submitted_at).toBe(stamped.rows[0].submitted_at);
  });

  it("keeps probe receipts append-only, replay-safe, and hashed", async () => {
    const targetHash = "e".repeat(64);
    const observedAt = "2026-08-17T12:00:00.000Z";
    const first = await db.query<{ id: string }>(`
      select public.record_a2p_probe_receipt(
        $1, 'probe-1', $2, 'delivered', 'synthetic-provider-reference', 'DELIVERED', $3
      )::text as id
    `, [TENANT_A, targetHash, observedAt]);
    const replay = await db.query<{ id: string }>(`
      select public.record_a2p_probe_receipt(
        $1, 'probe-1', $2, 'delivered', 'synthetic-provider-reference', 'DELIVERED', $3
      )::text as id
    `, [TENANT_A, targetHash, observedAt]);
    expect(replay.rows[0].id).toBe(first.rows[0].id);
    await db.query("savepoint probe_mismatch");
    await expect(db.query(
      `select public.record_a2p_probe_receipt(
        $1, 'probe-1', $2, 'terminal_rejection', 'different', 'BLOCKED', $3
      )`,
      [TENANT_A, targetHash, observedAt],
    )).rejects.toThrow(/A2P_PROBE_REPLAY_MISMATCH/);
    await db.query("rollback to savepoint probe_mismatch");
    await db.query("savepoint probe_mutation");
    await expect(db.query(
      "update public.a2p_probe_receipts set provider_code = 'changed' where id = $1",
      [first.rows[0].id],
    )).rejects.toThrow(/A2P_PROBE_RECEIPTS_APPEND_ONLY/);
  });
});

describe("signup and immutable attribution", () => {
  it("creates tenant, settings, coach, run, and seventeen rows atomically and replays without overwriting timezone", async () => {
    await insertSignupIntent(AUTH_NEW);
    const first = await completeSignup(AUTH_NEW, "phase5-new");
    expect(first.rows[0].replayed).toBe(false);
    expect(first.rows[0].referral_result).toBe("none");
    const created = await db.query<{ timezone: string; steps: string; audits: string }>(`
      select
        (select timezone from public.tenant_settings where tenant_id = $1) as timezone,
        (select count(*)::text from public.provisioning_steps where tenant_id = $1) as steps,
        (select count(*)::text from public.audit_log
          where tenant_id = $1 and action = 'onboarding.signup_completed') as audits
    `, [first.rows[0].tenant_id]);
    expect(created.rows[0]).toEqual({ timezone: "Asia/Kolkata", steps: "17", audits: "1" });
    const replay = await completeSignup(AUTH_NEW, "phase5-new");
    expect(replay.rows[0]).toMatchObject({ tenant_id: first.rows[0].tenant_id, replayed: true });
    const timezone = await db.query<{ timezone: string }>(
      "select timezone from public.tenant_settings where tenant_id = $1",
      [first.rows[0].tenant_id],
    );
    expect(timezone.rows[0].timezone).toBe("Asia/Kolkata");
  });

  it("rolls tenant birth back while leaving the earlier tenantless intent visible", async () => {
    await insertSignupIntent(AUTH_NEW);
    await db.query("savepoint duplicate_slug");
    await expect(completeSignup(AUTH_NEW, "phase5-a")).rejects.toThrow(/duplicate key/);
    await db.query("rollback to savepoint duplicate_slug");
    const result = await db.query<{ state: string; tenant_id: string | null; tenants: string }>(`
      select state::text, tenant_id::text,
        (select count(*)::text from public.tenants where billing_contact_email like '53000000%') as tenants
      from public.signup_intents where auth_user_id = $1
    `, [AUTH_NEW]);
    expect(result.rows[0]).toEqual({ state: "started", tenant_id: null, tenants: "0" });
  });

  it("silently drops unknown and revoked referral codes but records their reasons", async () => {
    const revoked = await db.query<{ id: string }>(`
      insert into public.affiliates (user_id, referral_code, link_active)
      values ('${AFFILIATE}', 'REVOKED-P5', false) returning id
    `);
    expect(revoked.rows[0].id).toBeTruthy();
    await insertSignupIntent(AUTH_NEW, "UNKNOWN-P5");
    const unknown = await completeSignup(AUTH_NEW, "phase5-unknown", "UNKNOWN-P5");
    expect(unknown.rows[0].referral_result).toBe("invalid_silent");

    const secondAuth = "53000000-0000-4000-8000-000000000060";
    await insertSignupIntent(secondAuth, "REVOKED-P5");
    const revokedResult = await completeSignup(secondAuth, "phase5-revoked", "REVOKED-P5");
    expect(revokedResult.rows[0].referral_result).toBe("invalid_silent");
    const reasons = await db.query<{ reason: string }>(`
      select payload ->> 'reason' as reason from public.audit_log
      where action = 'referral.code_rejected' order by id
    `);
    expect(reasons.rows.map((row) => row.reason)).toEqual(["unknown", "revoked"]);
  });

  it("returns self_referral visibly and permits valid attribution only inside signup", async () => {
    const selfAuth = "53000000-0000-4000-8000-000000000070";
    await db.query(
      `insert into public.users (id, email, role) values ($1, 'self@phase5.test', 'affiliate')`,
      [selfAuth],
    );
    await db.query(
      `insert into public.affiliates (user_id, referral_code) values ($1, 'SELF-P5')`,
      [selfAuth],
    );
    await insertSignupIntent(selfAuth, "SELF-P5");
    const self = await completeSignup(selfAuth, "phase5-self", "SELF-P5");
    expect(self.rows[0].referral_result).toBe("self_referral");

    await db.query(
      `insert into public.affiliates (user_id, referral_code) values ('${AFFILIATE}', 'VALID-P5')
       on conflict (user_id) do update set referral_code = excluded.referral_code`,
    );
    const validAuth = "53000000-0000-4000-8000-000000000080";
    await insertSignupIntent(validAuth, "VALID-P5");
    const valid = await completeSignup(validAuth, "phase5-valid", "VALID-P5");
    expect(valid.rows[0].referral_result).toBe("attributed");
    await db.query("savepoint referral_update");
    await expect(db.query(
      `update public.referrals set affiliate_id = affiliate_id where tenant_id = $1`,
      [valid.rows[0].tenant_id],
    )).rejects.toThrow(/REFERRAL_ATTRIBUTION_IMMUTABLE/);
    await db.query("rollback to savepoint referral_update");
    await db.query("savepoint referral_insert");
    await expect(db.query(
      `insert into public.referrals (affiliate_id, tenant_id)
       select id, '${TENANT_A}' from public.affiliates where referral_code = 'VALID-P5'`,
    )).rejects.toThrow(/REFERRAL_SIGNUP_ONLY/);
  });
});

describe("hosted consent and go-live authority", () => {
  it("records validator-shaped consent and an audit even when no purpose is selected", async () => {
    const install = await createGhlInstallBinding(TENANT_A);
    const contact = await db.query<{ id: string }>(`
      insert into public.contacts (tenant_id, last_channel, name)
      values ('${TENANT_A}', 'sms', 'Synthetic lead') returning id
    `);
    const identity = await db.query<{ id: string }>(`
      insert into public.contact_identities (
        tenant_id, contact_id, provider, channel, provider_identity_id, provider_account_id, ghl_install_id
      ) values ('${TENANT_A}', $1, 'ghl', 'sms', 'synthetic-consent-id', $2, $3) returning id
    `, [contact.rows[0].id, install.location_id, install.id]);
    const rendered = "Synthetic disclosure language";
    const submittedAt = "2026-08-17T12:00:00.000Z";
    const evidence = {
      schemaVersion: 1,
      formSubmissionId: "synthetic-submission",
      formUrl: "https://phase5.test/opt-in",
      disclosureVersion: "v1",
      disclosureTextHash: createHash("sha256").update(rendered).digest("hex"),
      submittedAt,
      purposes: [],
      channels: ["sms"],
    };
    const audit = await db.query<{ id: string }>(`
      select public.record_web_form_consent(
        $1, $2, $3, $4, $5, '{}'::text[], $6::jsonb, $1
      )::text as id
    `, [TENANT_A, identity.rows[0].id, rendered, evidence.formUrl, submittedAt, JSON.stringify(evidence)]);
    expect(audit.rows[0].id).toBeTruthy();
    const row = await db.query<{ consent_state: string; consent_source: string; selected: boolean }>(`
      select i.consent_state, i.consent_source,
        (l.payload ->> 'selected')::boolean as selected
      from public.contact_identities i
      join public.audit_log l on l.id = $2
      where i.id = $1
    `, [identity.rows[0].id, audit.rows[0].id]);
    expect(row.rows[0]).toEqual({ consent_state: "none", consent_source: "web_form", selected: false });
  });

  it("rejects consent identity mismatch and extra raw evidence fields", async () => {
    const install = await createGhlInstallBinding(TENANT_B);
    const contact = await db.query<{ id: string }>(`
      insert into public.contacts (tenant_id, last_channel, name)
      values ('${TENANT_B}', 'sms', 'Other lead') returning id
    `);
    const identity = await db.query<{ id: string }>(`
      insert into public.contact_identities (
        tenant_id, contact_id, provider, channel, provider_identity_id, provider_account_id, ghl_install_id
      ) values ('${TENANT_B}', $1, 'ghl', 'sms', 'other-consent-id', $2, $3) returning id
    `, [contact.rows[0].id, install.location_id, install.id]);
    await expect(db.query(`select public.record_web_form_consent(
      $1, $2, 'Synthetic', 'https://phase5.test/opt-in', now(), '{}'::text[],
      '{"rawIp":true}'::jsonb, $1
    )`, [TENANT_A, identity.rows[0].id])).rejects.toThrow(/EXPECTED_TENANT_MISMATCH:contact_identity/);
  });

  it("counts a live SMS connection as messaging readiness and rolls activation back on a later refusal", async () => {
    await db.query(`
      insert into public.onboarding_runs (tenant_id) values ('${TENANT_A}');
      insert into public.channel_connections (tenant_id, channel, provider, state)
      values ('${TENANT_A}', 'sms', 'ghl', 'live');
      insert into public.calendar_connections (
        tenant_id, provider, external_calendar_id, timezone, state, is_primary,
        last_slot_fetch_at, last_slot_fetch_ok
      ) values ('${TENANT_A}', 'ghl', 'phase5-calendar', 'America/Chicago', 'ready', true, now(), true);
      insert into public.offer_layers (
        tenant_id, status, version, program_name, booking_mode, content_hash
      ) values ('${TENANT_A}', 'published', 1, 'Synthetic program', 'direct', '${"f".repeat(64)}');
      insert into public.brain_snapshots (
        version, content_hash, source_hash, payload, compiled_platform,
        platform_tokens, knowledge_mode, published_by, reason
      ) values (5001, '${"1".repeat(64)}', '${"2".repeat(64)}', '{}'::jsonb,
        'Synthetic Brain snapshot', 3, 'inline', '${ADMIN}', 'Phase 5 test');
    `);
    await insertStep("test_pass", "done");
    await insertStep("go_live");
    await db.query(`select * from public.record_offer_review(
      $1, $2, (select id from public.offer_layers where tenant_id = $1 and status = 'published'),
      1, $3, 'clear', 'Synthetic clearance'
    )`, [TENANT_A, ADMIN, "f".repeat(64)]);
    const review = await db.query<{ created_at: string }>(`
      select created_at::text from public.offer_reviews where tenant_id = $1 order by created_at desc limit 1
    `, [TENANT_A]);
    await db.query("savepoint subscription_refusal");
    await expect(db.query(`select * from public.go_live_onboarding(
      $1, $2, true, $3, 'incomplete', now()
    )`, [TENANT_A, COACH_A, review.rows[0].created_at])).rejects.toThrow(/subscription_contract_unavailable/);
    await db.query("rollback to savepoint subscription_refusal");
    let tenant = await db.query<{ status: string }>(
      "select status::text from public.tenants where id = $1",
      [TENANT_A],
    );
    expect(tenant.rows[0].status).toBe("onboarding");

    const live = await db.query<{ tenant_id: string; audit_id: string }>(`
      select tenant_id::text, audit_id::text from public.go_live_onboarding(
        $1, $2, true, $3, 'active', now()
      )
    `, [TENANT_A, COACH_A, review.rows[0].created_at]);
    expect(live.rows[0]).toMatchObject({ tenant_id: TENANT_A });
    expect(live.rows[0].audit_id).toBeTruthy();
    tenant = await db.query("select status::text from public.tenants where id = $1", [TENANT_A]);
    expect(tenant.rows[0].status).toBe("active");
  });

  it("names every database-owned go-live refusal instead of collapsing readiness", async () => {
    await db.query(`
      insert into public.onboarding_runs (tenant_id) values ('${TENANT_A}');
      insert into public.channel_connections (tenant_id, channel, provider, state)
      values ('${TENANT_A}', 'sms', 'ghl', 'live');
      insert into public.calendar_connections (
        tenant_id, provider, external_calendar_id, timezone, state, is_primary,
        last_slot_fetch_at, last_slot_fetch_ok
      ) values ('${TENANT_A}', 'ghl', 'phase5-refusal-calendar', 'America/Chicago',
        'ready', true, now(), true);
    `);
    await insertStep("test_pass", "done");
    await insertStep("go_live");

    const prerequisiteCases = [
      {
        name: "missing_channel",
        mutate: "delete from public.channel_connections where tenant_id = $1",
        error: /READINESS_MESSAGING_CHANNEL_LIVE_REQUIRED/,
      },
      {
        name: "unhealthy_calendar",
        mutate: "update public.calendar_connections set last_slot_fetch_ok = false, last_error = 'Synthetic failure' where tenant_id = $1",
        error: /READINESS_PRIMARY_CALENDAR_HEALTHY_REQUIRED/,
      },
    ] as const;

    for (const testCase of prerequisiteCases) {
      await db.query(`savepoint ${testCase.name}`);
      await db.query(testCase.mutate, [TENANT_A]);
      await expect(db.query(`select * from public.go_live_onboarding(
        $1, $2, true, now(), 'active', now()
      )`, [TENANT_A, COACH_A])).rejects.toThrow(testCase.error);
      await db.query(`rollback to savepoint ${testCase.name}`);
    }

    await db.query("savepoint missing_offer");
    await expect(db.query(`select * from public.go_live_onboarding(
      $1, $2, true, now(), 'active', now()
    )`, [TENANT_A, COACH_A])).rejects.toThrow(/READINESS_PUBLISHED_OFFER_REQUIRED/);
    await db.query("rollback to savepoint missing_offer");
    await db.query(`
      insert into public.offer_layers (
        tenant_id, status, version, program_name, booking_mode, content_hash
      ) values ('${TENANT_A}', 'published', 1, 'Synthetic program', 'direct', '${"3".repeat(64)}')
    `);
    await db.query(`select * from public.record_offer_review(
      $1, $2, (select id from public.offer_layers where tenant_id = $1 and status = 'published'),
      1, $3, 'clear', 'Synthetic clearance'
    )`, [TENANT_A, ADMIN, "3".repeat(64)]);
    const review = await db.query<{ created_at: string }>(`
      select created_at::text from public.offer_reviews where tenant_id = $1 order by created_at desc limit 1
    `, [TENANT_A]);

    await db.query("savepoint missing_brain");
    await expect(db.query(`select * from public.go_live_onboarding(
      $1, $2, true, $3, 'active', now()
    )`, [TENANT_A, COACH_A, review.rows[0].created_at])).rejects.toThrow(/READINESS_PLATFORM_BRAIN_PUBLISHED_REQUIRED/);
    await db.query("rollback to savepoint missing_brain");
    await db.query(`
      insert into public.brain_snapshots (
        version, content_hash, source_hash, payload, compiled_platform,
        platform_tokens, knowledge_mode, published_by, reason
      ) values (5002, '${"4".repeat(64)}', '${"5".repeat(64)}', '{}'::jsonb,
        'Synthetic Brain snapshot', 3, 'inline', '${ADMIN}', 'Phase 5 refusal test')
    `);

    const finalCases = [
      {
        name: "missing_test_pass",
        mutate: "update public.provisioning_steps set state = 'pending', completed_at = null where tenant_id = $1 and step_key = 'test_pass'",
        error: /READINESS_TEST_PASS_REQUIRED/,
      },
    ] as const;

    for (const testCase of finalCases) {
      await db.query(`savepoint ${testCase.name}`);
      await db.query(testCase.mutate, testCase.mutate.includes("$1") ? [TENANT_A] : []);
      await expect(db.query(`select * from public.go_live_onboarding(
        $1, $2, true, $3, 'active', now()
      )`, [TENANT_A, COACH_A, review.rows[0].created_at])).rejects.toThrow(testCase.error);
      await db.query(`rollback to savepoint ${testCase.name}`);
    }
  });

  it("refuses privileged writes while an active impersonation session exists", async () => {
    const session = await db.query<{ id: string }>(`
      insert into public.impersonation_sessions (
        actor_id, tenant_id, reason, started_at, expires_at
      ) values ('${ADMIN}', '${TENANT_A}', 'Phase 5 write refusal', now(), now() + interval '30 minutes')
      returning id
    `);
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({
      sub: ADMIN,
      app_metadata: { role: "admin", impersonation_session_id: session.rows[0].id },
    })]);
    await expect(db.query(`select public.record_a2p_probe_receipt(
      $1, 'impersonated-probe', $2, 'inconclusive', null, null, now()
    )`, [TENANT_A, "6".repeat(64)])).rejects.toThrow(/IMPERSONATION_WRITE_FORBIDDEN/);
  });

  it("rolls artifact confirmation back when its registry audit cannot be written", async () => {
    const artifactId = await insertArtifact(false);
    await db.query("update public.audit_actions set actor_kind = 'system' where key = 'onboarding.artifact_confirmed'");
    await db.query("savepoint forced_artifact_audit_failure");
    await expect(db.query(
      `select public.confirm_onboarding_artifact($1, $2, $3)`,
      [TENANT_A, artifactId, COACH_A],
    )).rejects.toThrow(/AUDIT/);
    await db.query("rollback to savepoint forced_artifact_audit_failure");
    const row = await db.query<{ confirmed_at: string | null }>(
      "select confirmed_at::text from public.onboarding_optin_artifacts where id = $1",
      [artifactId],
    );
    expect(row.rows[0].confirmed_at).toBeNull();
  });
});
