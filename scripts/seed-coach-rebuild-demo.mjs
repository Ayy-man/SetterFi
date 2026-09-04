/**
 * Round 3 backend gap seeder. `seed-phase7-demo.mjs` stands up the login demo coach's tenant
 * (`87000000-0000-4000-8000-000000000001`, "Avery Morgan (demo)") for measurement fixtures, but
 * none of the coach-rehaul lanes had anywhere to seed the rows their own screens need: a
 * published offer, a keyword table with real rows, a business profile, an A2P registration a
 * coach can actually see mid-review, an expired channel connection, and a support thread with a
 * named responder. This script adds exactly those, onto the tenant `seed-phase7-demo.mjs` already
 * owns, and touches nothing that script wrote.
 *
 * Run order: after `node scripts/seed-phase7-demo.mjs --acknowledge-stale-rollups` (this script
 * refuses to run against a tenant that does not already exist with the right ancestry). Every
 * fixture id lives in its own `92000000-0000-4000-8000-` namespace --
 * `grep -rn "92000000" scripts/ src/ supabase/` was empty before this file existed -- so a second
 * run only updates the same rows.
 *
 * Every billable or analytics-visible row this script writes carries `is_test = true`, matching
 * every other seeder's convention: this tenant is `is_demo = true` too, so nothing here can reach
 * a real invoice or a real measurement total.
 *
 *     node scripts/seed-coach-rebuild-demo.mjs [--target <url>] [--confirm-hosted]
 *
 * This file is written, not run, as part of the round 3 backend gap round -- see
 * `docs/plans/2026-09-04-coach-backend-gaps.md`, "## Round 3".
 */

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import pg from "pg";

import { resolveDemoTarget } from "./seed-phase1-demo.mjs";
import { PHASE7_DEMO_IDS, PHASE7_DEMO_VALUES } from "./seed-phase7-demo.mjs";
import { DEMO_PERSON_NAMES } from "./fixtures/names.mjs";

const NAMESPACE = "92000000-0000-4000-8000-";

function id(sequence) {
  return `${NAMESPACE}${String(sequence).padStart(12, "0")}`;
}

const REBUILD_DEMO_IDS = Object.freeze({
  businessProfile: id(1),
  responder: id(2),
  supportResponderReply: id(5),
  contacts: Object.freeze([id(10), id(11), id(12), id(13)]),
  conversations: Object.freeze([id(20), id(21), id(22), id(23)]),
  messages: Object.freeze([id(30), id(31), id(32), id(33)]),
  instagramConnection: id(40),
  qualificationQuestions: Object.freeze([id(50), id(51), id(52), id(53)]),
});

const REBUILD_DEMO_VALUES = Object.freeze({
  responderName: DEMO_PERSON_NAMES.successOwner,
  responderEmail: "coach-rebuild-responder@example.invalid",
  supportSubject: "Question about the pricing page copy (demo)",
  supportCoachBody: "Can you confirm the funding minimum on my public offer page is correct?",
  supportResponderBody: "Confirmed -- the number on your live offer matches what you published.",
  supportAssignReason: "Routine coach question, routed to the assigned success owner (demo)",
  supportResolveReason: "Answered the coach's question; nothing further pending (demo)",
  offerProgramName: "Funding accelerator",
  offerProgramDescription:
    "We help service businesses secure working capital and structure smart growth financing in under 30 days.",
  // `offer_layers_content_hash_chk` requires 64 lowercase hex characters. Re-derived from the
  // current program name each run so a name change (like this one) forces a fresh draft version
  // rather than reusing stale content under an old hash.
  offerContentHash: createHash("sha256")
    .update("SETTERFI_DEMO_REBUILD_OFFER_V2:Funding accelerator")
    .digest("hex"),
  priceOne: { label: "Funding accelerator", amountCents: 199900, billingPeriod: "one_time" },
  priceTwo: { label: "Monthly coaching", amountCents: 49900, billingPeriod: "monthly" },
  businessLegalName: "Reid Capital Coaching LLC",
  businessWebsiteUrl: "https://reidcapitalcoaching.com",
  businessAddressLine1: "482 Harbor View Drive",
  businessCity: "Charleston",
  businessRegion: "SC",
  businessPostalCode: "29401",
  contactNames: Object.freeze([
    "Rowan Ashford (demo)",
    "Priya Kutty (demo)",
    "Devon Larkspur (demo)",
    "Marisol Quan (demo)",
  ]),
  // `app.coach_question_defaults` (`read_coach_questions`'s source) cross-joins every
  // `status = 'published', disposition = 'shared'` `brain_knowledge_entries` row against every
  // eligible tenant with no per-tenant or per-keyword-goal scoping in the schema today -- there
  // were zero such rows on the hosted database before this seeder, so this list is empty for
  // every tenant on the platform, not only this one. These four match the qualification fields
  // the Inbox lead card already reads (credit range, funding goal, timeline, monthly revenue),
  // inserted in this order so their `default_position` (row_number over created_at, id) matches.
  qualificationQuestions: Object.freeze([
    {
      category: "credit_range",
      question: "What's your current credit range?",
      answer: "Used to route the lead to the right funding products before a call is booked.",
    },
    {
      category: "funding_goal",
      question: "How much funding are you looking to secure?",
      answer: "Used to route the lead to the right funding products before a call is booked.",
    },
    {
      category: "timeline",
      question: "What's your timeline to get funded?",
      answer: "Used to route the lead to the right funding products before a call is booked.",
    },
    {
      category: "monthly_revenue",
      question: "What's your business's average monthly revenue?",
      answer: "Used to route the lead to the right funding products before a call is booked.",
    },
  ]),
});

// `vector(1536)`; content is irrelevant to `read_coach_questions` (no semantic search runs
// against it there), so a fixed unit vector is enough to satisfy
// `brain_knowledge_entries_publishable_chk`. Same placeholder `seed-phase2-demo.mjs` uses.
const UNIT_EMBEDDING = `[1,${Array.from({ length: 1535 }, () => "0").join(",")}]`;

function daysAgoIso(days, hours = 0) {
  const at = new Date();
  at.setUTCDate(at.getUTCDate() - days);
  at.setUTCHours(at.getUTCHours() - hours, 0, 0, 0);
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function requireRebuildAncestry(database) {
  const existing = await database.query(
    "select id, slug, is_demo from public.tenants where id = $1",
    [PHASE7_DEMO_IDS.tenant],
  );
  if (
    existing.rowCount !== 1
    || existing.rows[0].slug !== PHASE7_DEMO_VALUES.slug
    || existing.rows[0].is_demo !== true
  ) {
    throw new Error(
      "COACH_REBUILD_DEMO_TENANT_MISSING: run `node scripts/seed-phase7-demo.mjs "
        + "--acknowledge-stale-rollups` first",
    );
  }
  const coach = await database.query("select id from public.users where id = $1 and tenant_id = $2", [
    PHASE7_DEMO_IDS.coach,
    PHASE7_DEMO_IDS.tenant,
  ]);
  if (coach.rowCount !== 1) {
    throw new Error("COACH_REBUILD_DEMO_COACH_MISSING");
  }
}

async function seedBusinessProfile(database) {
  await database.query(
    `insert into public.business_profiles
       (id, tenant_id, legal_name, entity_type, has_ein, website_url, address_line1,
        address_line2, city, region, postal_code, country_code)
     values ($1::uuid, $2::uuid, $3, 'llc', true, $4, $5, null, $6, $7, $8, 'US')
     on conflict (id) do update set legal_name = excluded.legal_name,
       website_url = excluded.website_url, address_line1 = excluded.address_line1,
       city = excluded.city, region = excluded.region, postal_code = excluded.postal_code`,
    [
      REBUILD_DEMO_IDS.businessProfile,
      PHASE7_DEMO_IDS.tenant,
      REBUILD_DEMO_VALUES.businessLegalName,
      REBUILD_DEMO_VALUES.businessWebsiteUrl,
      REBUILD_DEMO_VALUES.businessAddressLine1,
      REBUILD_DEMO_VALUES.businessCity,
      REBUILD_DEMO_VALUES.businessRegion,
      REBUILD_DEMO_VALUES.businessPostalCode,
    ],
  );
}

async function seedA2pMidReview(database) {
  const submittedAt = daysAgoIso(14);
  await database.query(
    `insert into public.provisioning_steps
       (tenant_id, step_key, state, awaiting_party, attempts, started_at, last_attempt_at,
        external_ref, next_attempt_at, last_transition_at, idempotency_key)
     values ($1::uuid, 'a2p_campaign', 'awaiting_provider', 'carrier', 1, $2::timestamptz,
       $2::timestamptz, $3::jsonb, $2::timestamptz, $2::timestamptz, $1::text || ':a2p_campaign')
     on conflict (tenant_id, step_key) do update set state = excluded.state,
       awaiting_party = excluded.awaiting_party, external_ref = excluded.external_ref,
       last_transition_at = excluded.last_transition_at`,
    [PHASE7_DEMO_IDS.tenant, submittedAt, JSON.stringify({ submittedAt })],
  );
  await database.query(
    `insert into public.provisioning_steps
       (tenant_id, step_key, state, awaiting_party, attempts, started_at, last_attempt_at,
        next_attempt_at, last_transition_at, idempotency_key)
     values ($1::uuid, 'sms_live', 'awaiting_provider', 'carrier', 1, $2::timestamptz,
       $2::timestamptz, $2::timestamptz, $2::timestamptz, $1::text || ':sms_live')
     on conflict (tenant_id, step_key) do update set state = excluded.state,
       awaiting_party = excluded.awaiting_party, last_transition_at = excluded.last_transition_at`,
    [PHASE7_DEMO_IDS.tenant, submittedAt],
  );
}

async function seedExpiredInstagramConnection(database) {
  await database.query(
    `insert into public.channel_connections
       (id, tenant_id, channel, provider, state, external_ref, token_expires_at)
     values ($1::uuid, $2::uuid, 'instagram', 'meta_direct', 'expired',
       jsonb_build_object('pageId', 'SETTERFI_DEMO_PLACEHOLDER_REBUILD_IG_PAGE'), $3::timestamptz)
     -- The plain unique(tenant_id, channel) constraint this table had in init.sql was dropped by
     -- 20260817000001_phase1_demo_path.sql in favor of unique(tenant_id, channel, provider), so
     -- that triple is the idempotency key here.
     on conflict (tenant_id, channel, provider) do update set state = 'expired',
       token_expires_at = excluded.token_expires_at, external_ref = excluded.external_ref`,
    [REBUILD_DEMO_IDS.instagramConnection, PHASE7_DEMO_IDS.tenant, daysAgoIso(5)],
  );
}

async function findGoalId(database, keyword) {
  const result = await database.query(
    `select id from public.keyword_goals
     where tenant_id = $1 and normalized_keyword = app.normalize_keyword($2)`,
    [PHASE7_DEMO_IDS.tenant, keyword],
  );
  return result.rows[0]?.id ?? null;
}

async function saveKeywordGoal(database, keyword, goalId) {
  const result = await database.query(
    `select * from public.save_keyword_goal($1, $2, $3, $4, 'book', null, null, null, null)`,
    [PHASE7_DEMO_IDS.tenant, PHASE7_DEMO_IDS.coach, goalId, keyword],
  );
  return result.rows[0].keyword_goal_id;
}

async function seedKeywordGoalsAndConversations(database) {
  const fundingExisting = await findGoalId(database, "funding");
  const fundingGoalId = await saveKeywordGoal(database, "funding", fundingExisting);
  const creditExisting = await findGoalId(database, "credit");
  const creditGoalId = await saveKeywordGoal(database, "credit", creditExisting);

  const fixtures = [
    { keyword: "funding", goalId: fundingGoalId, index: 0, daysAgo: 6 },
    { keyword: "funding", goalId: fundingGoalId, index: 1, daysAgo: 8 },
    { keyword: "credit", goalId: creditGoalId, index: 2, daysAgo: 7 },
    { keyword: "credit", goalId: creditGoalId, index: 3, daysAgo: 9 },
  ];

  for (const fixture of fixtures) {
    const createdAt = daysAgoIso(fixture.daysAgo);
    await database.query(
      `insert into public.contacts
         (id, tenant_id, last_channel, name, business_context, is_test, created_at)
       values ($1::uuid, $2::uuid, 'sms', $3, 'Plausible demo lead for the keyword table.', true,
         $4::timestamptz)
       on conflict (id) do update set name = excluded.name, is_test = true`,
      [
        REBUILD_DEMO_IDS.contacts[fixture.index],
        PHASE7_DEMO_IDS.tenant,
        REBUILD_DEMO_VALUES.contactNames[fixture.index],
        createdAt,
      ],
    );
    await database.query(
      `insert into public.conversations
         (id, tenant_id, contact_id, channel, status, first_touch_keyword, keyword_goal_id,
          is_test, created_at)
       values ($1, $2, $3, 'sms', 'agent', $4, $5, true, $6)
       on conflict (id) do nothing`,
      [
        REBUILD_DEMO_IDS.conversations[fixture.index],
        PHASE7_DEMO_IDS.tenant,
        REBUILD_DEMO_IDS.contacts[fixture.index],
        fixture.keyword,
        fixture.goalId,
        createdAt,
      ],
    );
    await database.query(
      `insert into public.messages
         (id, tenant_id, conversation_id, direction, author, body, provider, is_test, created_at)
       values ($1, $2, $3, 'in', 'lead', $4, 'ghl', true, $5)
       on conflict (id) do update set body = excluded.body`,
      [
        REBUILD_DEMO_IDS.messages[fixture.index],
        PHASE7_DEMO_IDS.tenant,
        REBUILD_DEMO_IDS.conversations[fixture.index],
        `Hi, I texted in about ${fixture.keyword} (demo).`,
        createdAt,
      ],
    );
  }
}

async function seedSupportThread(database) {
  await database.query(
    `insert into public.users (id, email, full_name, role, tenant_id)
     values ($1, $2, $3, 'success', null)
     on conflict (id) do update set role = 'success', tenant_id = null,
       full_name = excluded.full_name`,
    [REBUILD_DEMO_IDS.responder, REBUILD_DEMO_VALUES.responderEmail, REBUILD_DEMO_VALUES.responderName],
  );

  // `create_support_thread` mints its own ids and there is no natural key besides
  // (tenant_id, subject) to recognize an earlier run's row by, so that pair is the idempotency
  // check: a fixed id would need an `on update cascade` this table's foreign keys do not carry.
  let threadId = (await database.query(
    "select id from public.support_threads where tenant_id = $1 and subject = $2",
    [PHASE7_DEMO_IDS.tenant, REBUILD_DEMO_VALUES.supportSubject],
  )).rows[0]?.id;
  if (!threadId) {
    const created = await database.query(
      `select * from public.create_support_thread($1, $2, $3, $4, null)`,
      [
        PHASE7_DEMO_IDS.tenant,
        PHASE7_DEMO_IDS.coach,
        REBUILD_DEMO_VALUES.supportSubject,
        REBUILD_DEMO_VALUES.supportCoachBody,
      ],
    );
    threadId = created.rows[0].thread_id;
  }

  await database.query(
    `insert into public.support_messages (id, tenant_id, thread_id, author_id, body, internal, is_test)
     values ($1, $2, $3, $4, $5, false, true)
     on conflict (id) do update set body = excluded.body`,
    [
      REBUILD_DEMO_IDS.supportResponderReply,
      PHASE7_DEMO_IDS.tenant,
      threadId,
      REBUILD_DEMO_IDS.responder,
      REBUILD_DEMO_VALUES.supportResponderBody,
    ],
  );

  const currentAssignee = (await database.query(
    "select assigned_to from public.support_threads where id = $1",
    [threadId],
  )).rows[0]?.assigned_to;
  if (currentAssignee !== REBUILD_DEMO_IDS.responder) {
    await database.query(
      "select * from public.set_support_thread_assignee($1, $2, $3, $4)",
      [threadId, REBUILD_DEMO_IDS.responder, REBUILD_DEMO_IDS.responder, REBUILD_DEMO_VALUES.supportAssignReason],
    );
  }
  const currentStatus = (await database.query(
    "select status from public.support_threads where id = $1",
    [threadId],
  )).rows[0]?.status;
  if (currentStatus !== "waiting_on_coach") {
    await database.query(
      "select * from public.set_support_thread_status($1, $2, $3, $4)",
      [threadId, REBUILD_DEMO_IDS.responder, "waiting_on_coach", REBUILD_DEMO_VALUES.supportResolveReason],
    );
  }
  await database.query(
    "update public.support_threads set is_test = true where id = $1",
    [threadId],
  );
  return threadId;
}

async function seedPublishedOffer(database) {
  const published = await database.query(
    "select id, program_name from public.offer_layers where tenant_id = $1 and status = 'published'",
    [PHASE7_DEMO_IDS.tenant],
  );
  // Idempotent on content rather than existence: a re-run with a changed program name (as this
  // round's fix was) has to publish a new version rather than leaving the old one in place.
  if (published.rowCount > 0 && published.rows[0].program_name === REBUILD_DEMO_VALUES.offerProgramName) {
    return;
  }

  const draft = await database.query(
    "select id, content_hash from public.offer_layers where tenant_id = $1 and status = 'draft'",
    [PHASE7_DEMO_IDS.tenant],
  );
  const draftId = draft.rows[0]?.id ?? null;
  const draftContentHash = draft.rows[0]?.content_hash ?? null;

  const offerPayload = {
    programName: REBUILD_DEMO_VALUES.offerProgramName,
    programDescription: REBUILD_DEMO_VALUES.offerProgramDescription,
    creditMin: 640,
    fundingGoalMinCents: 2500000,
    fundingGoalMaxCents: 10000000,
    monthlyRevenueMinCents: 500000,
    products: ["biz term loans", "biz line of credit"],
    creditRepair: "no_good_credit_only",
    bookingHorizonDays: 21,
    bookingMode: "direct",
    prices: [REBUILD_DEMO_VALUES.priceOne, REBUILD_DEMO_VALUES.priceTwo],
    contentHash: REBUILD_DEMO_VALUES.offerContentHash,
  };

  const saved = await database.query(
    `select public.save_offer_draft($1, $2, $3, $4, $5::jsonb) offer_id`,
    [
      PHASE7_DEMO_IDS.tenant,
      PHASE7_DEMO_IDS.coach,
      draftId,
      draftId === null ? null : draftContentHash,
      JSON.stringify(offerPayload),
    ],
  );
  const offerId = saved.rows[0].offer_id;
  await database.query(
    `select * from public.publish_offer_draft($1, $2, $3, $4)`,
    [PHASE7_DEMO_IDS.tenant, PHASE7_DEMO_IDS.coach, offerId, REBUILD_DEMO_VALUES.offerContentHash],
  );
}

async function seedQualificationQuestions(database) {
  const rows = REBUILD_DEMO_VALUES.qualificationQuestions;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const sourceRef = `coach-rebuild:question:${row.category}`;
    // `created_at` spaced a second apart, in list order: `app.coach_question_defaults` orders by
    // `row_number() over (order by created_at, id)`, and that becomes each row's `default_position`.
    const createdAt = daysAgoIso(0, -index);
    await database.query(
      `insert into public.brain_knowledge_entries
         (id, question, answer, category, match_keywords, status, source, source_ref, disposition,
          response_template, embedding, version, published_at, created_at, updated_at)
       values ($1::uuid, $2, $3, $4, '{}', 'published', 'mock', $5, 'shared', $3, $6::vector, 1,
         $7::timestamptz, $7::timestamptz, $7::timestamptz)
       on conflict (source, source_ref) where source_ref is not null do update set
         question = excluded.question, answer = excluded.answer, category = excluded.category,
         status = 'published', disposition = 'shared', response_template = excluded.response_template,
         embedding = excluded.embedding, updated_at = excluded.updated_at`,
      [
        REBUILD_DEMO_IDS.qualificationQuestions[index],
        row.question,
        row.answer,
        row.category,
        sourceRef,
        UNIT_EMBEDDING,
        createdAt,
      ],
    );
  }
}

async function readBack(database, threadId) {
  const counts = (await database.query(
    `select
       (select count(*)::int from public.offer_layers where tenant_id = $1 and status = 'published') offers,
       (select count(*)::int from public.keyword_goals where tenant_id = $1) keyword_goals,
       (select count(*)::int from public.conversations where tenant_id = $1
          and first_touch_keyword is not null and id = any($2::uuid[])) keyword_conversations,
       (select count(*)::int from public.business_profiles where id = $3) business_profiles,
       (select count(*)::int from public.channel_connections where id = $4 and state = 'expired') expired_connections,
       (select count(*)::int from public.support_threads where id = $5 and assigned_to is not null) support_threads,
       (select count(*)::int from public.brain_knowledge_entries
          where id = any($6::uuid[]) and status = 'published' and disposition = 'shared') qualification_questions,
       (select count(*)::int from public.brain_knowledge_entries
          where status = 'published' and disposition = 'shared') shared_questions_platform_wide`,
    [
      PHASE7_DEMO_IDS.tenant,
      REBUILD_DEMO_IDS.conversations,
      REBUILD_DEMO_IDS.businessProfile,
      REBUILD_DEMO_IDS.instagramConnection,
      threadId,
      REBUILD_DEMO_IDS.qualificationQuestions,
    ],
  )).rows[0];
  return counts;
}

export async function seedCoachRebuildDemo({ argumentsList = process.argv.slice(2) } = {}) {
  const target = resolveDemoTarget(argumentsList);
  if (!target.databaseUrl) throw new Error("SUPABASE_DB_PASSWORD_REQUIRED_FOR_HOSTED_REBUILD_SEED");
  console.log(`Demo database target host: ${target.host}`);
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    await database.query("begin");
    await requireRebuildAncestry(database);
    await seedBusinessProfile(database);
    await seedA2pMidReview(database);
    await seedExpiredInstagramConnection(database);
    await seedKeywordGoalsAndConversations(database);
    const threadId = await seedSupportThread(database);
    await seedPublishedOffer(database);
    await seedQualificationQuestions(database);
    const counts = await readBack(database, threadId);
    await database.query("commit");
    console.log(`Coach rebuild demo seed read-back: ${JSON.stringify(counts)}`);
    return counts;
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedCoachRebuildDemo().catch((error) => {
    console.error(error instanceof Error ? error.message : "COACH_REBUILD_DEMO_SEED_FAILED");
    process.exitCode = 1;
  });
}
