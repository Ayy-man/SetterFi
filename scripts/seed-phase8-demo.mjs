/** Deterministic, receipt-backed Phase 8 demo extension. No provider is contacted. */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import pg from "pg";

import { DEMO_IDS, DEMO_VALUES, resolveDemoTarget, seedPhase1Demo } from "./seed-phase1-demo.mjs";
import { seedPhase2Demo } from "./seed-phase2-demo.mjs";
import { DEMO_ALERT_COPY, DEMO_PERSON_NAMES, DEMO_SUPPORT_COPY } from "./fixtures/names.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REQUIRED_SEEDS = Object.freeze([
  ["seed-phase5-demo.mjs", "PHASE5_DEMO_SEED_MISSING", "seedPhase5Demo"],
  ["seed-phase6-demo.mjs", "PHASE6_DEMO_SEED_MISSING", "seedPhase6Demo"],
  ["seed-phase7-demo.mjs", "PHASE7_DEMO_SEED_MISSING", "seedPhase7Demo"],
]);

export const PHASE8_DEMO_IDS = Object.freeze({
  tenant: DEMO_IDS.tenant,
  coach: DEMO_IDS.coach,
  admin: "82000000-0000-4000-8000-000000000001",
  success: "88000000-0000-4000-8000-000000000001",
  thread: "88000000-0000-4000-8000-000000000002",
  coachMessage: "88000000-0000-4000-8000-000000000003",
  platformReply: "88000000-0000-4000-8000-000000000004",
  internalNote: "88000000-0000-4000-8000-000000000005",
  billingPreference: "88000000-0000-4000-8000-000000000006",
  bellNotification: "88000000-0000-4000-8000-000000000007",
  emailNotification: "88000000-0000-4000-8000-000000000008",
  slackNotification: "88000000-0000-4000-8000-000000000009",
  bellDelivery: "88000000-0000-4000-8000-000000000010",
  emailDelivery: "88000000-0000-4000-8000-000000000011",
  slackDelivery: "88000000-0000-4000-8000-000000000012",
  emailAttempt: "88000000-0000-4000-8000-000000000013",
  slackAttemptOne: "88000000-0000-4000-8000-000000000014",
  slackAttemptTwo: "88000000-0000-4000-8000-000000000015",
  emailWorker: "88000000-0000-4000-8000-000000000016",
  slackWorker: "88000000-0000-4000-8000-000000000017",
  slackRule: "88000000-0000-4000-8000-000000000018",
});

export const PHASE8_DEMO_VALUES = Object.freeze({
  billingEmail: "phase8-billing-contact@example.invalid",
  successOwnerName: DEMO_PERSON_NAMES.successOwner,
  successReason: DEMO_SUPPORT_COPY.successOwnerReason,
  namedExportReason: DEMO_SUPPORT_COPY.namedExportReason,
  resourceExportReason: DEMO_SUPPORT_COPY.resourceExportReason,
  abortedExportReason: DEMO_SUPPORT_COPY.abortedExportReason,
  supportSubject: DEMO_SUPPORT_COPY.subject,
  coachBody: DEMO_SUPPORT_COPY.coachMessage,
  replyBody: DEMO_SUPPORT_COPY.platformReply,
  internalBody: DEMO_SUPPORT_COPY.internalNote,
});

export const PHASE8_MOCK_DRIVER_NAMES = Object.freeze([
  "SETTERFI_EMAIL_DRIVER",
  "SETTERFI_SLACK_DRIVER",
  "SETTERFI_GHL_DRIVER",
  "SETTERFI_STRIPE_DRIVER",
  "SETTERFI_META_DRIVER",
  "SETTERFI_NOTION_DRIVER",
  "SETTERFI_EMBEDDINGS_DRIVER",
  "SETTERFI_OPENROUTER_DRIVER",
]);

function assert(condition, code, detail) {
  if (!condition) throw new Error(detail ? `${code}:${JSON.stringify(detail)}` : code);
}

async function loadSeed(file, code, symbol) {
  const absolute = resolve(SCRIPT_DIR, file);
  if (!existsSync(absolute)) throw new Error(code);
  const imported = await import(pathToFileURL(absolute).href);
  if (typeof imported[symbol] !== "function") throw new Error(code);
  return imported[symbol];
}

export async function withPhase8MockDrivers(operation) {
  const prior = new Map(PHASE8_MOCK_DRIVER_NAMES.map((name) => [name, process.env[name]]));
  for (const name of PHASE8_MOCK_DRIVER_NAMES) process.env[name] = "mock";
  try {
    return await operation();
  } finally {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function seedUpstream(argumentsList) {
  const seeds = [];
  for (const contract of REQUIRED_SEEDS) seeds.push(await loadSeed(...contract));
  await withPhase8MockDrivers(async () => {
    await seedPhase1Demo({ argumentsList, announce: false });
    await seedPhase2Demo({ argumentsList });
    await seeds[0]({ argumentsList });
    await seeds[1]({ argumentsList });
    await seeds[2]({ argumentsList });
  });
}

async function exportAudit(database, { resource, reason, tenant = null, finish = true }) {
  const existing = (await database.query(
    `select id from public.audit_log
     where action='platform_export.started' and actor_id=$1 and reason=$2
     order by id limit 1`,
    [PHASE8_DEMO_IDS.admin, reason],
  )).rows[0];
  const startId = existing?.id ?? (await database.query(
    `select public.start_platform_export($1,$2,$3::jsonb,$4::text[],$5,$6) id`,
    [PHASE8_DEMO_IDS.admin, resource, JSON.stringify({ demo: true }), ["id"], reason, tenant],
  )).rows[0].id;
  if (finish) {
    const finished = (await database.query(
      `select id from public.audit_log where action='platform_export.finished'
       and (payload->>'started_audit_id')::bigint=$1`,
      [startId],
    )).rows[0];
    if (!finished) await database.query(
      `select public.finish_platform_export($1,$2,1,64,$3,$4)`,
      [PHASE8_DEMO_IDS.admin, startId, reason, tenant],
    );
  }
  return startId;
}

async function ensureFixture(database) {
  const tenant = (await database.query(
    "select id,is_demo from public.tenants where id=$1 or slug=$2",
    [PHASE8_DEMO_IDS.tenant, DEMO_VALUES.slug],
  )).rows;
  assert(tenant.length === 1 && tenant[0].id === PHASE8_DEMO_IDS.tenant && tenant[0].is_demo,
    "PHASE8_DEMO_TENANT_ANCESTRY_REFUSED", tenant);

  await database.query(
    `insert into public.users (id,email,full_name,role,tenant_id)
     values ($1,'phase8-success@example.invalid',$2,'success',null)
     on conflict (id) do update set role='success',tenant_id=null,full_name=excluded.full_name`,
    [PHASE8_DEMO_IDS.success, PHASE8_DEMO_VALUES.successOwnerName],
  );
  await database.query(
    "update public.tenants set billing_contact_email=$2 where id=$1 and is_demo",
    [PHASE8_DEMO_IDS.tenant, PHASE8_DEMO_VALUES.billingEmail],
  );

  await database.query(
    `insert into public.support_threads
       (id,tenant_id,subject,status,assigned_to,created_by,is_test,created_at,updated_at)
     values ($1,$2,$3,'waiting_on_coach',$4,$5,true,'2026-08-18T08:00:00Z','2026-08-18T08:03:00Z')
     on conflict (id) do update set subject=excluded.subject,status=excluded.status,
       assigned_to=excluded.assigned_to,is_test=true,updated_at=excluded.updated_at`,
    [PHASE8_DEMO_IDS.thread, PHASE8_DEMO_IDS.tenant, PHASE8_DEMO_VALUES.supportSubject,
      PHASE8_DEMO_IDS.success, PHASE8_DEMO_IDS.coach],
  );
  const messages = [
    [PHASE8_DEMO_IDS.coachMessage, PHASE8_DEMO_IDS.coach, PHASE8_DEMO_VALUES.coachBody, false, "2026-08-18T08:01:00Z"],
    [PHASE8_DEMO_IDS.platformReply, PHASE8_DEMO_IDS.success, PHASE8_DEMO_VALUES.replyBody, false, "2026-08-18T08:02:00Z"],
    [PHASE8_DEMO_IDS.internalNote, PHASE8_DEMO_IDS.success, PHASE8_DEMO_VALUES.internalBody, true, "2026-08-18T08:03:00Z"],
  ];
  for (const row of messages) await database.query(
    `insert into public.support_messages
       (id,tenant_id,thread_id,author_id,body,internal,is_test,created_at)
     values ($1,$2,$3,$4,$5,$6,true,$7)
     on conflict (id) do update set body=excluded.body,internal=excluded.internal,is_test=true`,
    [row[0], PHASE8_DEMO_IDS.tenant, PHASE8_DEMO_IDS.thread, ...row.slice(1)],
  );

  // Keyed on the state the assignment produces, never on the reason text: keying on the reason
  // made a copy change look like a missing assignment and wrote a second reassignment row every
  // run, and keying on the audit row left the tenant unassigned after a reset. The audit log is
  // append-only, so a reason filed by an earlier run stays exactly as filed.
  const assigned = (await database.query(
    "select success_owner from public.tenants where id=$1", [PHASE8_DEMO_IDS.tenant],
  )).rows[0]?.success_owner;
  if (assigned !== PHASE8_DEMO_IDS.success) await database.query(
    "select * from public.reassign_success_owner($1,$2,$3,$4)",
    [PHASE8_DEMO_IDS.tenant, PHASE8_DEMO_IDS.admin, PHASE8_DEMO_IDS.success,
      PHASE8_DEMO_VALUES.successReason],
  );

  const billingRule = (await database.query(
    `select id from public.alert_rules where event_key='billing.payment_failed'
     and scope='tenant' and suppressible=false`,
  )).rows[0];
  assert(billingRule, "PHASE6_BILLING_RULE_MISSING");
  await database.query(
    `insert into public.alert_rules
       (id,event_key,scope,name,description,category,audience_roles,include_success_owner,
        include_billing_contact,default_destinations,suppressible,default_enabled,
        email_subject,email_body,slack_text)
     values ($1,'phase8.demo.slack','tenant',$2,$3,'demo','{success}',true,false,
       '{slack}',true,true,$4,$5,$6)
     on conflict (id) do update set default_destinations='{slack}',name=excluded.name,
       description=excluded.description,email_subject=excluded.email_subject,
       email_body=excluded.email_body,slack_text=excluded.slack_text`,
    [PHASE8_DEMO_IDS.slackRule, DEMO_ALERT_COPY.ruleName, DEMO_ALERT_COPY.ruleDescription,
      DEMO_ALERT_COPY.emailSubject, DEMO_ALERT_COPY.emailBody, DEMO_ALERT_COPY.slackText],
  );
  await database.query(
    `insert into public.notification_preferences (id,user_id,rule_id,destination,enabled)
     values ($1,$2,$3,'email',true)
     on conflict (id) do update set enabled=true,updated_at=now()`,
    [PHASE8_DEMO_IDS.billingPreference, PHASE8_DEMO_IDS.coach, billingRule.id],
  );

  const notifications = [
    [PHASE8_DEMO_IDS.bellNotification, PHASE8_DEMO_IDS.coach, null, billingRule.id,
      "phase8:test-bell", "billing.payment_failed", DEMO_ALERT_COPY.testBell, true],
    [PHASE8_DEMO_IDS.emailNotification, null, PHASE8_DEMO_VALUES.billingEmail, billingRule.id,
      "phase8:billing-email", "billing.payment_failed", DEMO_ALERT_COPY.billingEmail, false],
    [PHASE8_DEMO_IDS.slackNotification, PHASE8_DEMO_IDS.success, null, PHASE8_DEMO_IDS.slackRule,
      "phase8:slack-retry", "phase8.slack.retry", DEMO_ALERT_COPY.slackRetry, false],
  ];
  for (const row of notifications) await database.query(
    `insert into public.notifications
       (id,tenant_id,user_id,recipient_email,rule_id,source_event_id,kind,severity,title,body,content,is_test,created_at)
     values ($1,$2,$3,$4,$5,$6,$7,'warning',$8,$8,jsonb_build_object('demo',true),$9,'2026-08-18T08:10:00Z')
     on conflict (id) do update set title=excluded.title,body=excluded.body,content=excluded.content,is_test=excluded.is_test`,
    [row[0], PHASE8_DEMO_IDS.tenant, ...row.slice(1)],
  );

  const deliveries = [
    [PHASE8_DEMO_IDS.bellDelivery, PHASE8_DEMO_IDS.bellNotification, "bell", "delivered", 0,
      "mock-bell:phase8", "2026-08-18T08:10:00Z", "2026-08-18T08:10:00Z"],
    [PHASE8_DEMO_IDS.emailDelivery, PHASE8_DEMO_IDS.emailNotification, "email", "accepted", 1,
      "mock-email:phase8", "2026-08-18T08:11:00Z", null],
    [PHASE8_DEMO_IDS.slackDelivery, PHASE8_DEMO_IDS.slackNotification, "slack", "delivered", 2,
      "mock-slack:phase8:2", "2026-08-18T08:13:00Z", "2026-08-18T08:13:00Z"],
  ];
  for (const row of deliveries) await database.query(
    `insert into public.notification_deliveries
       (id,notification_id,destination,status,attempts,provider_reference,last_attempt_at,
        delivered_at,next_attempt_at,terminal_at,created_at,updated_at)
     values ($1,$2,$3::public.notification_destination,$4::public.notification_delivery_status,$5,$6,
       $7::timestamptz,$8::timestamptz,null,
       case when $4='delivered' then $8::timestamptz else null end,
       '2026-08-18T08:10:00Z',$7::timestamptz)
     on conflict (id) do update set status=excluded.status,attempts=excluded.attempts,
       provider_reference=excluded.provider_reference,last_attempt_at=excluded.last_attempt_at,
       delivered_at=excluded.delivered_at,next_attempt_at=null,terminal_at=excluded.terminal_at`,
    row,
  );

  const attempts = [
    [PHASE8_DEMO_IDS.emailAttempt, PHASE8_DEMO_IDS.emailDelivery, 1, PHASE8_DEMO_IDS.emailWorker,
      "email", PHASE8_DEMO_VALUES.billingEmail, null, "2026-08-18T08:11:00Z", "accepted",
      "mock-email:phase8", null],
    [PHASE8_DEMO_IDS.slackAttemptOne, PHASE8_DEMO_IDS.slackDelivery, 1, PHASE8_DEMO_IDS.slackWorker,
      "slack", null, "mock://phase8-slack-sink", "2026-08-18T08:12:00Z", "retryable",
      null, DEMO_ALERT_COPY.retryErrorCode],
    [PHASE8_DEMO_IDS.slackAttemptTwo, PHASE8_DEMO_IDS.slackDelivery, 2, PHASE8_DEMO_IDS.slackWorker,
      "slack", null, "mock://phase8-slack-sink", "2026-08-18T08:13:00Z", "delivered",
      "mock-slack:phase8:2", null],
  ];
  for (const row of attempts) await database.query(
    `insert into public.notification_delivery_attempts
       (id,delivery_id,attempt_number,worker_id,destination,recipient_email,destination_url,
        started_at,finished_at,outcome,provider_reference,error_code,error_detail,created_at)
     values ($1,$2,$3,$4,$5::public.notification_destination,$6,$7,$8::timestamptz,
       $8::timestamptz,$9,$10,$11::text,
       case when $11::text is null then null else $12::text end,
       $8::timestamptz)
     -- Delivery attempts are immutable receipts (NOTIFICATION_DELIVERY_ATTEMPT_IMMUTABLE), so a
     -- copy change reaches an already-seeded database through npm run demo:reset-phase8.
     on conflict (id) do nothing`,
    [...row, DEMO_ALERT_COPY.retryErrorDetail],
  );

  await exportAudit(database, {
    resource: "coach-support-messages", reason: PHASE8_DEMO_VALUES.namedExportReason,
    tenant: PHASE8_DEMO_IDS.tenant,
  });
  await exportAudit(database, {
    resource: "notification-deliveries", reason: PHASE8_DEMO_VALUES.resourceExportReason,
  });
  await exportAudit(database, {
    resource: "audit-log", reason: PHASE8_DEMO_VALUES.abortedExportReason, finish: false,
  });
}

export async function readPhase8Demo(database) {
  const fixedIds = Object.values(PHASE8_DEMO_IDS).filter((value) => typeof value === "string");
  const counts = (await database.query(
    `select
      (select count(*)::int from public.support_threads where id=$1) threads,
      (select count(*)::int from public.support_messages where thread_id=$1) messages,
      (select count(*)::int from public.coach_support_messages where thread_id=$1) coach_messages,
      (select count(*)::int from public.notification_preferences where id=$2) preferences,
      (select count(*)::int from public.alert_rules where id=$6) demo_rules,
      (select count(*)::int from public.notifications where id=any($3::uuid[])) notifications,
      (select count(*)::int from public.notification_deliveries where id=any($4::uuid[])) deliveries,
      (select count(*)::int from public.notification_delivery_attempts where id=any($5::uuid[])) attempts`,
    [PHASE8_DEMO_IDS.thread, PHASE8_DEMO_IDS.billingPreference,
      [PHASE8_DEMO_IDS.bellNotification, PHASE8_DEMO_IDS.emailNotification, PHASE8_DEMO_IDS.slackNotification],
      [PHASE8_DEMO_IDS.bellDelivery, PHASE8_DEMO_IDS.emailDelivery, PHASE8_DEMO_IDS.slackDelivery],
      [PHASE8_DEMO_IDS.emailAttempt, PHASE8_DEMO_IDS.slackAttemptOne, PHASE8_DEMO_IDS.slackAttemptTwo],
      PHASE8_DEMO_IDS.slackRule],
  )).rows[0];
  const deliveries = (await database.query(
    `select id,status::text,attempts,provider_reference from public.notification_deliveries
     where id=any($1::uuid[]) order by id`,
    [[PHASE8_DEMO_IDS.bellDelivery, PHASE8_DEMO_IDS.emailDelivery, PHASE8_DEMO_IDS.slackDelivery]],
  )).rows;
  const attempts = (await database.query(
    `select id,attempt_number,outcome,recipient_email,destination_url,provider_reference,error_code
     from public.notification_delivery_attempts where id=any($1::uuid[]) order by id`,
    [[PHASE8_DEMO_IDS.emailAttempt, PHASE8_DEMO_IDS.slackAttemptOne, PHASE8_DEMO_IDS.slackAttemptTwo]],
  )).rows;
  const audit = (await database.query(
    `select action,reason,target_type,target_id,payload from public.audit_log
     where reason=any($1::text[]) order by id`,
    [[PHASE8_DEMO_VALUES.successReason, PHASE8_DEMO_VALUES.namedExportReason,
      PHASE8_DEMO_VALUES.resourceExportReason, PHASE8_DEMO_VALUES.abortedExportReason]],
  )).rows;
  const tenant = (await database.query(
    "select success_owner,billing_contact_email,is_demo from public.tenants where id=$1",
    [PHASE8_DEMO_IDS.tenant],
  )).rows[0];
  const exclusionCounts = (await database.query(
    `select
      (select count(*)::int from public.analytics_tenants where tenant_id=$1) tenants,
      (select count(*)::int from public.analytics_contacts where tenant_id=$1) contacts,
      (select count(*)::int from public.analytics_conversations where tenant_id=$1) conversations,
      (select count(*)::int from public.analytics_messages where tenant_id=$1) messages`,
    [PHASE8_DEMO_IDS.tenant],
  )).rows[0];
  return { fixedIds, counts, deliveries, attempts, audit, tenant, exclusionCounts };
}

export function assertPhase8Demo(snapshot) {
  assert(snapshot.tenant?.is_demo === true, "PHASE8_DEMO_TENANT_NOT_DEMO");
  assert(snapshot.tenant.success_owner === PHASE8_DEMO_IDS.success, "PHASE8_SUCCESS_OWNER_READBACK_FAILED");
  assert(snapshot.tenant.billing_contact_email === PHASE8_DEMO_VALUES.billingEmail,
    "PHASE8_BILLING_CONTACT_READBACK_FAILED");
  assert(JSON.stringify(snapshot.counts) === JSON.stringify({
    threads: 1, messages: 3, coach_messages: 2, preferences: 1, demo_rules: 1,
    notifications: 3, deliveries: 3, attempts: 3,
  }), "PHASE8_DEMO_COUNT_MISMATCH", snapshot.counts);
  assert(snapshot.deliveries.some((row) => row.id === PHASE8_DEMO_IDS.emailDelivery
    && row.status === "accepted" && row.attempts === 1 && row.provider_reference === "mock-email:phase8"),
  "PHASE8_EMAIL_RECEIPT_MISSING");
  assert(snapshot.deliveries.some((row) => row.id === PHASE8_DEMO_IDS.slackDelivery
    && row.status === "delivered" && row.attempts === 2 && row.provider_reference === "mock-slack:phase8:2"),
  "PHASE8_SLACK_RECEIPT_MISSING");
  assert(snapshot.attempts.some((row) => row.id === PHASE8_DEMO_IDS.emailAttempt
    && row.recipient_email === PHASE8_DEMO_VALUES.billingEmail && row.outcome === "accepted"),
  "PHASE8_BILLING_TARGET_MISSING");
  assert(snapshot.attempts.some((row) => row.id === PHASE8_DEMO_IDS.slackAttemptOne
    && row.outcome === "retryable" && row.error_code === DEMO_ALERT_COPY.retryErrorCode),
  "PHASE8_RETRY_RECEIPT_MISSING");
  assert(snapshot.attempts.some((row) => row.id === PHASE8_DEMO_IDS.slackAttemptTwo
    && row.outcome === "delivered" && row.destination_url === "mock://phase8-slack-sink"),
  "PHASE8_RETRY_SUCCESS_MISSING");
  const starts = snapshot.audit.filter((row) => row.action === "platform_export.started");
  const finishes = snapshot.audit.filter((row) => row.action === "platform_export.finished");
  assert(starts.length === 3 && finishes.length === 2, "PHASE8_EXPORT_AUDIT_SHAPE_INVALID", snapshot.audit);
  assert(starts.some((row) => row.reason === PHASE8_DEMO_VALUES.namedExportReason
    && row.target_type === "platform_export_tenant" && row.target_id === PHASE8_DEMO_IDS.tenant),
  "PHASE8_NAMED_EXPORT_AUDIT_MISSING");
  assert(starts.some((row) => row.reason === PHASE8_DEMO_VALUES.resourceExportReason
    && row.target_type === "platform_export" && row.target_id === "notification-deliveries"),
  "PHASE8_RESOURCE_EXPORT_AUDIT_MISSING");
  assert(Object.values(snapshot.exclusionCounts).every((count) => count === 0),
    "PHASE8_ANALYTICS_SEGREGATION_FAILED", snapshot.exclusionCounts);
  return snapshot;
}

export async function seedPhase8Demo({ argumentsList = process.argv.slice(2), quiet = false } = {}) {
  await seedUpstream(argumentsList);
  const target = resolveDemoTarget(argumentsList);
  if (!target.databaseUrl) throw new Error("SUPABASE_DB_PASSWORD_REQUIRED_FOR_HOSTED_PHASE8_SEED");
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    await database.query("begin");
    await ensureFixture(database);
    const snapshot = assertPhase8Demo(await readPhase8Demo(database));
    await database.query("commit");
    if (!quiet) console.log(`Phase 8 seed read-back: ${JSON.stringify(snapshot.counts)} provider_sinks=mock-only exports=2-pairs+1-aborted`);
    return snapshot;
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedPhase8Demo().catch((error) => {
    console.error(error instanceof Error ? error.message : "PHASE8_DEMO_SEED_FAILED");
    process.exitCode = 1;
  });
}
