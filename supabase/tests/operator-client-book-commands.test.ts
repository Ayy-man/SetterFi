import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL = process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const TENANT_A = "9a000000-0000-4000-8000-000000000001";
const TENANT_B = "9a000000-0000-4000-8000-000000000002";
const ADMIN = "9a000000-0000-4000-8000-000000000011";
const SUCCESS_A = "9a000000-0000-4000-8000-000000000012";
const SUCCESS_B = "9a000000-0000-4000-8000-000000000013";
const COACH = "9a000000-0000-4000-8000-000000000014";
let db: Client;

async function actAs(role: "authenticated" | "service_role", claims: Record<string, string> = {}) {
  await db.query(`set local role ${role}`);
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: claims.sub, app_metadata: claims })]);
}

beforeAll(async () => { db = new Client({ connectionString: DB_URL }); await db.connect(); });
afterAll(async () => { await db?.end(); });
beforeEach(async () => {
  await db.query("begin");
  await db.query(`
    insert into public.tenants (id,slug,name,billing_contact_email,status) values
      ('${TENANT_A}','operator-command-a','Operator Command A','a@commands.test','active'),
      ('${TENANT_B}','operator-command-b','Operator Command B','b@commands.test','active');
    insert into public.users (id,email,role,tenant_id) values
      ('${ADMIN}','admin@commands.test','admin',null),
      ('${SUCCESS_A}','success-a@commands.test','success',null),
      ('${SUCCESS_B}','success-b@commands.test','success',null),
      ('${COACH}','coach@commands.test','coach','${TENANT_A}');
    update public.tenants set success_owner = '${SUCCESS_A}' where id = '${TENANT_A}';
    insert into public.provisioning_steps (tenant_id,step_key,state,idempotency_key)
      values ('${TENANT_A}','a2p_brand','awaiting_platform','${TENANT_A}:a2p_brand');
    insert into public.support_threads (tenant_id,subject,created_by,assigned_to) values ('${TENANT_A}','Separate owner proof','${COACH}','${SUCCESS_A}');
  `);
});
afterEach(async () => { await db.query("rollback"); });

describe("operator client book and provisioning commands", () => {
  it("persists each command, its audit read-back, its honest provider intent, and reversible effects", async () => {
    await actAs("service_role", { sub: ADMIN, role: "admin" });
    const pause = await db.query<{ command_id: string; tenant_status: string; audit_id: string; undo_available: boolean }>(
      "select * from public.record_client_operator_command($1,$2,$3,$4)", [TENANT_A, ADMIN, "pause", "Synthetic pause"],
    );
    expect(pause.rows[0]).toMatchObject({ tenant_status: "paused", undo_available: true });
    const resumed = await db.query<{ tenant_status: string }>(
      "select * from public.undo_platform_operator_command($1,$2,$3,$4)", [TENANT_A, pause.rows[0].command_id, ADMIN, "Synthetic undo"],
    );
    expect(resumed.rows[0].tenant_status).toBe("active");

    const signup = await db.query<{ state: string; undo_available: boolean }>(
      "select * from public.record_client_operator_command($1,$2,$3,$4)", [TENANT_A, ADMIN, "resend_signup", "Synthetic resend"],
    );
    const nudge = await db.query<{ state: string }>(
      "select * from public.record_client_operator_command($1,$2,$3,$4)", [TENANT_A, ADMIN, "nudge_onboarding", "Synthetic nudge"],
    );
    expect(signup.rows[0]).toMatchObject({ state: "intent_recorded", undo_available: false });
    expect(nudge.rows[0].state).toBe("intent_recorded");

    const note = await db.query<{ audit_id: string }>(
      "select * from public.record_client_operator_command($1,$2,$3,$4,$5)", [TENANT_A, ADMIN, "note", null, "Synthetic internal note"],
    );
    const archive = await db.query<{ command_id: string; tenant_status: string }>(
      "select * from public.record_client_operator_command($1,$2,$3,$4)", [TENANT_A, ADMIN, "archive", "Synthetic closeout"],
    );
    expect(archive.rows[0].tenant_status).toBe("churned");
    await db.query("select * from public.undo_platform_operator_command($1,$2,$3,$4)", [TENANT_A, archive.rows[0].command_id, ADMIN, "Synthetic restore"]);

    const provisioningNudge = await db.query<{ state: string }>(
      "select * from public.record_provisioning_operator_command($1,$2,$3,$4,$5)", [TENANT_A, "a2p_brand", ADMIN, "nudge", "Synthetic provisioning nudge"],
    );
    const provisioningResend = await db.query<{ state: string }>(
      "select * from public.record_provisioning_operator_command($1,$2,$3,$4,$5)", [TENANT_A, "a2p_brand", ADMIN, "resend", "Synthetic provisioning resend"],
    );
    const reassign = await db.query<{ command_id: string; platform_owner_id: string; audit_id: string }>(
      "select * from public.record_provisioning_operator_command($1,$2,$3,$4,$5,$6)", [TENANT_A, "a2p_brand", ADMIN, "reassign", "Synthetic provisioning assignment", SUCCESS_B],
    );
    expect(provisioningNudge.rows[0].state).toBe("intent_recorded");
    expect(provisioningResend.rows[0].state).toBe("intent_recorded");
    expect(reassign.rows[0].platform_owner_id).toBe(SUCCESS_B);
    const undoneAssignment = await db.query<{ platform_owner_id: string | null }>(
      "select * from public.undo_platform_operator_command($1,$2,$3,$4)", [TENANT_A, reassign.rows[0].command_id, ADMIN, "Synthetic assignment undo"],
    );
    expect(undoneAssignment.rows[0].platform_owner_id).toBeNull();

    await db.query("reset role");
    const persisted = await db.query<{ status: string; success_owner: string; platform_owner_id: string | null; assigned_to: string; note_audit_id: string; action: string }>(`
      select tenant.status::text, tenant.success_owner::text, step.platform_owner_id::text,
        thread.assigned_to::text, note.audit_id::text as note_audit_id, audit.action
      from public.tenants tenant
      join public.provisioning_steps step on step.tenant_id = tenant.id and step.step_key = 'a2p_brand'
      join public.support_threads thread on thread.tenant_id = tenant.id
      join public.client_internal_notes note on note.tenant_id = tenant.id
      join public.audit_log audit on audit.id = note.audit_id
      where tenant.id = '${TENANT_A}'
    `);
    expect(persisted.rows[0]).toEqual({
      status: "active", success_owner: SUCCESS_A, platform_owner_id: null, assigned_to: SUCCESS_A,
      note_audit_id: note.rows[0].audit_id, action: "tenant.internal_note.added",
    });
    const auditActions = await db.query<{ action: string }>(`
      select action from public.audit_log where tenant_id = $1 and id in ($2::bigint,$3::bigint) order by id
    `, [TENANT_A, pause.rows[0].audit_id, reassign.rows[0].audit_id]);
    expect(auditActions.rows.map((row) => row.action)).toEqual(["tenant.lifecycle.paused", "provisioning.owner.reassigned"]);
  });

  it("refuses non-platform actors, cross-tenant commands, and omitted consequential reasons", async () => {
    await actAs("service_role", { sub: COACH, tenant_id: TENANT_A, role: "coach" });
    await db.query("savepoint non_platform_actor");
    await expect(db.query("select * from public.record_client_operator_command($1,$2,$3,$4)", [TENANT_A, COACH, "pause", "Forged pause"])).rejects.toThrow(/OPERATOR_COMMAND_ACTOR_FORBIDDEN/);
    await db.query("rollback to savepoint non_platform_actor");
    await db.query("reset role"); await actAs("service_role", { sub: ADMIN, role: "admin" });
    await db.query("savepoint omitted_reason");
    await expect(db.query("select * from public.record_client_operator_command($1,$2,$3,$4)", [TENANT_A, ADMIN, "pause", ""])).rejects.toThrow(/CLIENT_OPERATOR_REASON_REQUIRED/);
    await db.query("rollback to savepoint omitted_reason");
    await db.query("savepoint omitted_provisioning_reason");
    await expect(db.query("select * from public.record_provisioning_operator_command($1,$2,$3,$4,$5)", [TENANT_A, "a2p_brand", ADMIN, "nudge", ""])).rejects.toThrow(/PROVISIONING_OPERATOR_COMMAND_INVALID/);
    await db.query("rollback to savepoint omitted_provisioning_reason");
    const command = await db.query<{ command_id: string }>("select * from public.record_client_operator_command($1,$2,$3,$4)", [TENANT_A, ADMIN, "pause", "Synthetic pause"]);
    await db.query("savepoint cross_tenant_undo");
    await expect(db.query("select * from public.undo_platform_operator_command($1,$2,$3,$4)", [TENANT_B, command.rows[0].command_id, ADMIN, "Forged other tenant undo"])).rejects.toThrow(/EXPECTED_TENANT_MISMATCH/);
    await db.query("rollback to savepoint cross_tenant_undo");
    await db.query("savepoint missing_other_tenant_step");
    await expect(db.query("select * from public.record_provisioning_operator_command($1,$2,$3,$4,$5)", [TENANT_B, "a2p_brand", ADMIN, "nudge", "Forged other tenant step"])).rejects.toThrow(/PROVISIONING_STEP_NOT_FOUND/);
    await db.query("rollback to savepoint missing_other_tenant_step");
  });
});
