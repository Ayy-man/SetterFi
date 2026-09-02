/**
 * Guarded Phase 1 demo reset.
 *
 * Provider cancellation happens before local deletion. Immutable audit rows remain as operational
 * evidence; the product rows created by the runner return to the deterministic seed baseline.
 */

import { pathToFileURL } from "node:url";
import pg from "pg";

import {
  createDemoClient,
  DEMO_IDS,
  DEMO_PHASE3_IDS,
  DEMO_PHASE3_VALUES,
  DEMO_PHASE4_IDS,
  DEMO_VALUES,
  resolveDemoTarget,
  seedPhase1Demo,
} from "./seed-phase1-demo.mjs";

function namedEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

async function requireSuccess(label, promise) {
  const result = await promise;
  if (result.error) throw new Error(`${label}:${result.error.message}`);
  return result.data;
}

async function assertDemoTenant(database) {
  const result = await database.query(
    "select slug, is_demo from public.tenants where id = $1",
    [DEMO_IDS.tenant],
  );
  if (
    result.rows.length !== 1
    || result.rows[0].slug !== DEMO_VALUES.slug
    || result.rows[0].is_demo !== true
  ) {
    throw new Error("DEMO_RESET_TENANT_REFUSED_NOT_DEMO");
  }
}

async function guardedDelete(database, statement, parameters) {
  // The shared stack may carry sibling-lane rows. Reassert the deterministic demo tenant before
  // every delete so a changed target cannot turn an explicit-ID reset into a broad cleanup.
  await assertDemoTenant(database);
  await database.query(statement, parameters);
}

function calendarDriver() {
  if (process.env.SETTERFI_GHL_DRIVER?.trim() !== "real") {
    return { cancelAppointment: async () => undefined };
  }
  namedEnvironment("GHL_CLIENT_ID");
  namedEnvironment("GHL_CLIENT_SECRET");
  namedEnvironment("GHL_WEBHOOK_PUBLIC_KEY");
  const accessToken = namedEnvironment("SETTERFI_GHL_TEST_ACCESS_TOKEN");
  return {
    cancelAppointment: async ({ externalId }) => {
      const response = await fetch(
        `https://services.leadconnectorhq.com/calendars/events/appointments/${encodeURIComponent(externalId)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Version: "2021-04-15",
          },
        },
      );
      if (!response.ok) throw new Error(`CALENDAR_APPOINTMENT_CANCEL_FAILED:HTTP_${response.status}`);
    },
  };
}

export async function resetPhase1Demo({ argumentsList = process.argv.slice(2) } = {}) {
  const target = resolveDemoTarget(argumentsList);
  if (!target.databaseUrl) throw new Error("SUPABASE_DB_PASSWORD_REQUIRED_FOR_HOSTED_RESET");
  const client = createDemoClient(target);
  console.log(`Demo database target host: ${target.host}`);

  const tenant = await requireSuccess(
    "DEMO_RESET_TENANT_READ_FAILED",
    client.from("tenants").select("id, slug, is_demo").eq("id", DEMO_IDS.tenant).maybeSingle(),
  );
  if (!tenant) throw new Error("DEMO_RESET_TENANT_ABSENT");
  if (tenant.slug !== DEMO_VALUES.slug || tenant.is_demo !== true) {
    throw new Error("DEMO_RESET_TENANT_REFUSED_NOT_DEMO");
  }

  const appointments = await requireSuccess(
    "DEMO_RESET_APPOINTMENT_READ_FAILED",
    client
      .from("appointments")
      .select("id, external_id, status, calendar:calendar_connections!inner(external_location_id)")
      .eq("tenant_id", DEMO_IDS.tenant)
      .eq("external_id", DEMO_VALUES.appointmentExternalId),
  );
  const driver = calendarDriver();
  for (const appointment of appointments ?? []) {
    if (!appointment.external_id) continue;
    const joined = Array.isArray(appointment.calendar) ? appointment.calendar[0] : appointment.calendar;
    const locationId = joined?.external_location_id;
    if (!locationId) throw new Error(`DEMO_RESET_PROVIDER_LOCATION_REQUIRED:${appointment.id}`);
    if (appointment.status !== "canceled") {
      await driver.cancelAppointment({ locationId, externalId: appointment.external_id });
    }
    console.log(`Provider cancellation recorded: appointment=${appointment.id} arm=${process.env.SETTERFI_GHL_DRIVER === "real" ? "Real" : "Mock"}`);
  }

  const billable = await requireSuccess(
    "DEMO_RESET_BILLABLE_READ_FAILED",
    client.from("billable_events").select("id").eq("tenant_id", DEMO_IDS.tenant),
  );
  if ((billable ?? []).length > 0) {
    throw new Error("DEMO_RESET_REFUSED_BILLABLE_EVIDENCE_PRESENT");
  }

  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    await database.query("begin");
    const conversationIds = [
      ...DEMO_PHASE3_IDS.conversations,
      ...DEMO_PHASE4_IDS.conversations,
      DEMO_IDS.runnerConversation,
    ];
    const receiptIds = [
      `${DEMO_IDS.tenant}:${DEMO_VALUES.ghlInitialEventId}:${DEMO_VALUES.ghlInitialMessageId}`,
      `${DEMO_IDS.tenant}:${DEMO_VALUES.ghlHeldEventId}:${DEMO_VALUES.ghlHeldMessageId}`,
      `${DEMO_IDS.tenant}:${DEMO_VALUES.ghlResumedEventId}:${DEMO_VALUES.ghlResumedMessageId}`,
      `${DEMO_IDS.tenant}:${DEMO_PHASE3_VALUES.stopEventId}:${DEMO_PHASE3_VALUES.stopMessageId}`,
      `${DEMO_IDS.tenant}:${DEMO_VALUES.metaMessageId}:${DEMO_VALUES.metaMessageId}`,
    ];
    await guardedDelete(
      database,
      `delete from public.appointment_reschedules
       where appointment_id in (
         select id from public.appointments
         where tenant_id = $1 and external_id = $2
       )`,
      [DEMO_IDS.tenant, DEMO_VALUES.appointmentExternalId],
    );
    await guardedDelete(
      database,
      "delete from public.appointments where tenant_id = $1 and external_id = $2",
      [DEMO_IDS.tenant, DEMO_VALUES.appointmentExternalId],
    );
    await guardedDelete(
      database,
      "delete from public.followups where tenant_id = $1 and conversation_id = any($2::uuid[])",
      [DEMO_IDS.tenant, conversationIds],
    );
    await guardedDelete(
      database,
      `delete from public.message_traces
       where tenant_id = $1 and message_id in (
         select id from public.messages
         where tenant_id = $1 and conversation_id = any($2::uuid[])
       )`,
      [DEMO_IDS.tenant, conversationIds],
    );
    await guardedDelete(
      database,
      "delete from public.messages where tenant_id = $1 and conversation_id = any($2::uuid[])",
      [DEMO_IDS.tenant, conversationIds],
    );
    await guardedDelete(
      database,
      "delete from public.conversations where tenant_id = $1 and id = any($2::uuid[])",
      [DEMO_IDS.tenant, conversationIds],
    );
    await guardedDelete(
      database,
      "delete from public.webhook_events where tenant_id = $1 and provider_event_id = any($2::text[])",
      [DEMO_IDS.tenant, receiptIds],
    );
    // Phase 3: remove only the deterministic compliance-demo rows. Immutable audit receipts stay.
    await guardedDelete(
      database,
      "delete from public.suppression_tombstones where tenant_id = $1 and id = $2",
      [DEMO_IDS.tenant, DEMO_PHASE3_IDS.tombstone],
    );
    await guardedDelete(
      database,
      "delete from public.suppression_entries where tenant_id = $1 and id = any($2::uuid[])",
      [DEMO_IDS.tenant, DEMO_PHASE3_IDS.suppressions],
    );
    await guardedDelete(
      database,
      "delete from public.tenant_test_recipients where tenant_id = $1 and id = $2",
      [DEMO_IDS.tenant, DEMO_PHASE3_IDS.testRecipient],
    );
    await guardedDelete(
      database,
      "delete from public.channel_connections where tenant_id = $1 and id = $2",
      [DEMO_IDS.tenant, DEMO_PHASE3_IDS.messengerConnection],
    );
    await guardedDelete(
      database,
      "delete from public.contacts where tenant_id = $1 and id = any($2::uuid[])",
      [DEMO_IDS.tenant, DEMO_PHASE3_IDS.contacts],
    );
    await guardedDelete(
      database,
      "delete from public.contact_duplicate_candidates where tenant_id = $1 and id = any($2::uuid[])",
      [DEMO_IDS.tenant, DEMO_PHASE4_IDS.candidates],
    );
    await guardedDelete(
      database,
      "delete from public.tenant_test_recipients where tenant_id = $1 and id = any($2::uuid[])",
      [DEMO_IDS.tenant, DEMO_PHASE4_IDS.testRecipients],
    );
    await guardedDelete(
      database,
      "delete from public.message_templates where tenant_id = $1 and id = any($2::uuid[])",
      [DEMO_IDS.tenant, DEMO_PHASE4_IDS.templates],
    );
    await guardedDelete(
      database,
      "delete from public.contact_identities where tenant_id = $1 and id = any($2::uuid[])",
      [DEMO_IDS.tenant, DEMO_PHASE4_IDS.identities],
    );
    await guardedDelete(
      database,
      "delete from public.channel_connections where tenant_id = $1 and id = any($2::uuid[])",
      [DEMO_IDS.tenant, DEMO_PHASE4_IDS.connections],
    );
    await guardedDelete(
      database,
      "delete from public.contacts where tenant_id = $1 and id = any($2::uuid[])",
      [DEMO_IDS.tenant, DEMO_PHASE4_IDS.contacts],
    );
    await database.query("commit");
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
  await requireSuccess(
    "DEMO_RESET_CONTACT_FAILED",
    client.from("contacts").update({
      credit_range: null,
      funding_goal: null,
      timeline: null,
      business_stage: null,
      annual_revenue_cents: null,
      business_context: null,
      outcome: null,
      dq_reason: null,
      opted_out: false,
      pipeline_stage: "new_lead",
      stage_set_by: "system",
    }).eq("id", DEMO_IDS.contact).eq("tenant_id", DEMO_IDS.tenant),
  );

  await seedPhase1Demo({ argumentsList, announce: false });

  const exactReads = {
    conversations: await client.from("conversations").select("id")
      .in("id", [...DEMO_PHASE4_IDS.conversations, DEMO_IDS.runnerConversation]),
    identities: await client.from("contact_identities").select("id").in("id", DEMO_PHASE4_IDS.identities),
    connections: await client.from("channel_connections").select("id").in("id", DEMO_PHASE4_IDS.connections),
    templates: await client.from("message_templates").select("id").in("id", DEMO_PHASE4_IDS.templates),
    candidates: await client.from("contact_duplicate_candidates").select("id").in("id", DEMO_PHASE4_IDS.candidates),
    testRecipients: await client.from("tenant_test_recipients").select("id")
      .in("id", DEMO_PHASE4_IDS.testRecipients),
  };
  for (const [name, result] of Object.entries(exactReads)) {
    if (result.error) throw new Error(`DEMO_RESET_READBACK_${name.toUpperCase()}_FAILED:${result.error.message}`);
  }
  const counts = Object.fromEntries(
    Object.entries(exactReads).map(([name, result]) => [name, result.data?.length ?? 0]),
  );
  const providerRows = await requireSuccess(
    "DEMO_RESET_PROVIDER_READBACK_FAILED",
    client.from("appointments").select("id").eq("tenant_id", DEMO_IDS.tenant)
      .eq("external_id", DEMO_VALUES.appointmentExternalId),
  );
  if (
    counts.conversations !== DEMO_PHASE4_IDS.conversations.length
    || counts.identities !== DEMO_PHASE4_IDS.identities.length
    || counts.connections !== DEMO_PHASE4_IDS.connections.length
    || counts.templates !== DEMO_PHASE4_IDS.templates.length
    || counts.candidates !== DEMO_PHASE4_IDS.candidates.length
    || counts.testRecipients !== 0
    || (providerRows ?? []).length !== 0
  ) {
    throw new Error(`DEMO_RESET_READBACK_NOT_CLEAN:${JSON.stringify(counts)}`);
  }
  const phase3Reads = await Promise.all([
    requireSuccess("DEMO_RESET_PHASE3_CONTACTS_FAILED", client.from("contacts").select("id,is_test").in("id", DEMO_PHASE3_IDS.contacts)),
    requireSuccess("DEMO_RESET_PHASE3_CONVERSATIONS_FAILED", client.from("conversations").select("id,is_test").in("id", DEMO_PHASE3_IDS.conversations)),
    requireSuccess("DEMO_RESET_PHASE3_FOLLOWUPS_FAILED", client.from("followups").select("id,is_test").in("id", DEMO_PHASE3_IDS.followups)),
    requireSuccess("DEMO_RESET_PHASE3_SUPPRESSIONS_FAILED", client.from("suppression_entries").select("id").in("id", DEMO_PHASE3_IDS.suppressions)),
    requireSuccess("DEMO_RESET_PHASE3_TOMBSTONE_FAILED", client.from("suppression_tombstones").select("id").eq("id", DEMO_PHASE3_IDS.tombstone)),
    requireSuccess("DEMO_RESET_PHASE3_TEST_RECIPIENT_FAILED", client.from("tenant_test_recipients").select("id").eq("id", DEMO_PHASE3_IDS.testRecipient)),
    requireSuccess("DEMO_RESET_PHASE3_CONNECTION_FAILED", client.from("channel_connections").select("id").eq("id", DEMO_PHASE3_IDS.messengerConnection)),
  ]);
  const phase3Counts = phase3Reads.map((rows) => rows.length);
  if (
    phase3Counts.join(",") !== "10,9,2,2,1,1,1"
    || phase3Reads.slice(0, 3).some((rows) => rows.some((row) => row.is_test !== true))
  ) {
    throw new Error(`DEMO_RESET_PHASE3_READBACK_INVALID:${phase3Counts.join(",")}`);
  }
  console.log(`Demo reset read-back: ${Object.entries(counts).map(([table, count]) => `${table}=${count}`).join(" ")}`);
  return { counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  resetPhase1Demo().catch((error) => {
    console.error(error instanceof Error ? error.message : "DEMO_RESET_FAILED");
    process.exitCode = 1;
  });
}
