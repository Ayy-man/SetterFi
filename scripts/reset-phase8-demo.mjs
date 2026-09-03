/** Exact-ID Phase 8 reset. Lower-phase demo rows remain intact. */

import { pathToFileURL } from "node:url";

import pg from "pg";

import { DEMO_VALUES, resolveDemoTarget } from "./seed-phase1-demo.mjs";
import { PHASE8_DEMO_IDS, PHASE8_DEMO_VALUES } from "./seed-phase8-demo.mjs";

export async function resetPhase8Demo({ argumentsList = process.argv.slice(2), quiet = false } = {}) {
  const target = resolveDemoTarget(argumentsList);
  if (!target.databaseUrl) throw new Error("SUPABASE_DB_PASSWORD_REQUIRED_FOR_HOSTED_PHASE8_RESET");
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    await database.query("begin");
    const tenant = (await database.query(
      "select id,is_demo from public.tenants where id=$1",
      [PHASE8_DEMO_IDS.tenant],
    )).rows[0];
    if (!tenant || tenant.is_demo !== true) throw new Error("PHASE8_DEMO_RESET_ANCESTRY_REFUSED");
    await database.query("set local session_replication_role=replica");
    await database.query(
      "delete from public.notification_delivery_attempts where id=any($1::uuid[])",
      [[PHASE8_DEMO_IDS.emailAttempt]],
    );
    await database.query(
      "delete from public.notification_deliveries where id=any($1::uuid[])",
      [[PHASE8_DEMO_IDS.bellDelivery, PHASE8_DEMO_IDS.emailDelivery]],
    );
    await database.query(
      "delete from public.notifications where id=any($1::uuid[])",
      [[PHASE8_DEMO_IDS.bellNotification, PHASE8_DEMO_IDS.emailNotification]],
    );
    await database.query("delete from public.notification_preferences where id=$1", [PHASE8_DEMO_IDS.billingPreference]);
    await database.query("delete from public.support_messages where thread_id=$1", [PHASE8_DEMO_IDS.thread]);
    await database.query("delete from public.support_threads where id=$1", [PHASE8_DEMO_IDS.thread]);
    await database.query(
      "delete from public.audit_log where reason=any($1::text[])",
      [[PHASE8_DEMO_VALUES.successReason, PHASE8_DEMO_VALUES.namedExportReason,
        PHASE8_DEMO_VALUES.resourceExportReason, PHASE8_DEMO_VALUES.abortedExportReason]],
    );
    await database.query(
      `update public.tenants set success_owner=null,billing_contact_email=$2
       where id=$1 and is_demo and success_owner=$3`,
      [PHASE8_DEMO_IDS.tenant, DEMO_VALUES.billingEmail, PHASE8_DEMO_IDS.success],
    );
    await database.query("delete from public.users where id=$1", [PHASE8_DEMO_IDS.success]);
    await database.query("set local session_replication_role=origin");
    const remaining = (await database.query(
      `select
        (select count(*)::int from public.support_threads where id=$1) threads,
        (select count(*)::int from public.support_messages where thread_id=$1) messages,
        (select count(*)::int from public.notification_preferences where id=$2) preferences,
        (select count(*)::int from public.alert_rules where id=$8) demo_rules,
        (select count(*)::int from public.notifications where id=any($3::uuid[])) notifications,
        (select count(*)::int from public.notification_deliveries where id=any($4::uuid[])) deliveries,
        (select count(*)::int from public.notification_delivery_attempts where id=any($5::uuid[])) attempts,
        (select count(*)::int from public.audit_log where reason=any($6::text[])) audits,
        (select count(*)::int from public.users where id=$7) users`,
      [PHASE8_DEMO_IDS.thread, PHASE8_DEMO_IDS.billingPreference,
        [PHASE8_DEMO_IDS.bellNotification, PHASE8_DEMO_IDS.emailNotification],
        [PHASE8_DEMO_IDS.bellDelivery, PHASE8_DEMO_IDS.emailDelivery],
        [PHASE8_DEMO_IDS.emailAttempt],
        [PHASE8_DEMO_VALUES.successReason, PHASE8_DEMO_VALUES.namedExportReason,
          PHASE8_DEMO_VALUES.resourceExportReason, PHASE8_DEMO_VALUES.abortedExportReason],
        PHASE8_DEMO_IDS.success],
    )).rows[0];
    if (!Object.values(remaining).every((count) => count === 0)) {
      throw new Error(`PHASE8_DEMO_RESET_INCOMPLETE:${JSON.stringify(remaining)}`);
    }
    await database.query("commit");
    if (!quiet) console.log(`Phase 8 reset read-back: ${JSON.stringify(remaining)} lower_phase_rows=preserved`);
    return remaining;
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  resetPhase8Demo().catch((error) => {
    console.error(error instanceof Error ? error.message : "PHASE8_DEMO_RESET_FAILED");
    process.exitCode = 1;
  });
}
