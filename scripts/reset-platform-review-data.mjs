/** Remove only the exact review-preview rows; upstream demo fixtures remain intact. */

import { pathToFileURL } from "node:url";

import pg from "pg";

import { resolveDemoTarget } from "./seed-phase1-demo.mjs";
import { referredBusinessFixtures } from "./seed-demo-gaps.mjs";
import { PLATFORM_REVIEW_DATA_IDS } from "./seed-platform-review-data.mjs";

const REFERRED_SLUGS = Object.freeze(referredBusinessFixtures().map((fixture) => fixture.slug));

export async function resetPlatformReviewData({ argumentsList = process.argv.slice(2), quiet = false } = {}) {
  const target = resolveDemoTarget(argumentsList);
  if (!target.databaseUrl) throw new Error("SUPABASE_DB_PASSWORD_REQUIRED_FOR_PLATFORM_REVIEW_RESET");
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    await database.query("begin");
    await database.query("delete from public.support_messages where id=any($1::uuid[])", [PLATFORM_REVIEW_DATA_IDS.messages]);
    await database.query("delete from public.support_threads where id=any($1::uuid[])", [PLATFORM_REVIEW_DATA_IDS.threads]);
    await database.query("delete from public.platform_measurement_preview_snapshots where key='staging-demo' and is_demo=true");
    // The second coach's correction chain, deleted from the leaf inwards: the request holds an
    // `on delete restrict` reference to its billable event, so the billable cannot go first, and
    // the appointment cannot go until the billable that points at it is gone. Leaving these
    // behind would also block `reset-phase6` from removing the affiliate tenant they hang off.
    const secondCoach = PLATFORM_REVIEW_DATA_IDS.secondCoach;
    await database.query("delete from public.billing_correction_requests where id=$1", [secondCoach.correctionRequest]);
    const billable = await database.query(
      "delete from public.billable_events where id=$1 returning appointment_id",
      [secondCoach.billable],
    );
    const appointmentId = billable.rows[0]?.appointment_id ?? null;
    if (appointmentId) await database.query("delete from public.appointments where id=$1", [appointmentId]);
    await database.query("delete from public.contacts where id=$1", [secondCoach.contact]);
    await database.query("delete from public.calendar_connections where id=$1", [secondCoach.calendar]);
    // The cost rollups this seed writes on the three referred demo tenants. `reset-phase6` only
    // clears the two Phase 6 tenants, so nothing else would ever remove these.
    await database.query(
      `delete from public.tenant_cost_rollups
       where window_start = '2026-08-01T00:00:00Z'::timestamptz
         and tenant_id in (select id from public.tenants where slug = any($1::text[]))`,
      [REFERRED_SLUGS],
    );
    const counts = (await database.query(
      `select
        (select count(*)::int from public.platform_measurement_preview_snapshots where key='staging-demo') previews,
        (select count(*)::int from public.support_threads where id=any($1::uuid[])) threads,
        (select count(*)::int from public.support_messages where id=any($2::uuid[])) messages,
        (select count(*)::int from public.billing_correction_requests where id=$3) second_coach_corrections,
        (select count(*)::int from public.billable_events where id=$4) second_coach_billables`,
      [PLATFORM_REVIEW_DATA_IDS.threads, PLATFORM_REVIEW_DATA_IDS.messages,
        PLATFORM_REVIEW_DATA_IDS.secondCoach.correctionRequest,
        PLATFORM_REVIEW_DATA_IDS.secondCoach.billable],
    )).rows[0];
    if (Object.values(counts).some((value) => value !== 0)) {
      throw new Error(`PLATFORM_REVIEW_RESET_INCOMPLETE:${JSON.stringify(counts)}`);
    }
    await database.query("commit");
    if (!quiet) console.log(`Platform review reset read-back: ${JSON.stringify(counts)} upstream_demo_rows=preserved`);
    return counts;
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  resetPlatformReviewData().catch((error) => {
    console.error(error instanceof Error ? error.message : "PLATFORM_REVIEW_RESET_FAILED");
    process.exitCode = 1;
  });
}
