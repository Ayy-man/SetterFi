/**
 * Showcase lead book — the eighth seeder, and the one that runs after every other.
 *
 * WHY IT EXISTS. Coach Home defaults to the `1m` window and reads one aggregate RPC,
 * `public.read_coach_measurement_for_actor`. The six earlier seeders together leave the two demo
 * tenants with 8 and 17 contacts, almost none of them created inside a trailing month, so
 * Booked, Active, Leads, Not a fit, Conversion and Avg time to book would all print zero or the
 * absent phrase. (Until `65537157` they printed "Not yet" whatever the data held, because every
 * preset window is `still_filling` and `availableMetric` refused that state -- a code defect, not a
 * data one, fixed in `src/lib/analytics/metric-definitions.ts`.) This seeder writes a lead book
 * with enough shape that every one of those carries a real number in the 1m window and a
 * plausible one at 1w, 3m and all.
 *
 * WHERE IT SITS IN THE ORDER. Last:
 *   demo:reset -> demo:seed -> demo:seed-phase2 -> demo:seed-phase5 -> demo:seed-phase6
 *   -> demo:seed-phase7 -> demo:seed-phase8 -> demo:seed-complete -> demo:seed-showcase
 * `demo:reset` deletes the Phase 1 fixture by id and `demo:seed` re-upserts it, so anything this
 * script writes has to come after both. It is additive on top of them and never edits a row they
 * own: every id is in the `8d000000-` namespace and every write is `on conflict (id) do update`,
 * so a second run is a no-op in effect.
 *
 * WHAT MAKES EACH HOME CARD COUNT SOMETHING. Derived from the RPC body in
 * `supabase/migrations/20260823000001_phase7_measurement.sql:1171` (the `_pre_phase13`
 * implementation the current public seam calls) and the views in
 * `20260830000001_coach_demo_self_visibility.sql`. `cohort` throughout means
 * `analytics_contacts` rows with `tenant_id = <tenant>`, `merged_into_contact_id is null` and
 * `created_at` inside the window.
 *
 *   Leads (coach.new_leads)      count(cohort). Needs contacts CREATED inside the window --
 *                                `updated_at` and `stage_set_at` are not consulted for it.
 *   Active (coach.active_leads)  cohort rows whose `contacts.pipeline_stage` is NOT one of
 *                                booked / qualified_no_buy / disqualified. So new_lead,
 *                                qualifying, long_term_followup and no_show all read as active.
 *   Booked (coach.booked_contacts)
 *                                cohort rows with at least one `appointments` row whose `status`
 *                                is anything but `canceled`. The pipeline stage is irrelevant --
 *                                a no_show contact with a no_show appointment counts as booked.
 *   Not a fit (coach.disqualified_leads)
 *                                cohort rows with `pipeline_stage = 'disqualified'`. The
 *                                `contacts.outcome` column (BOOK / SOFT_DQ / HARD_DQ) does NOT
 *                                feed it, which is why the "worth keeping warm" vs "ended
 *                                politely" split the artboard drew is still not renderable.
 *   Conversion (coach.conversion_rate)
 *                                booked / count(cohort); `requiresPositiveDenominator`, so the
 *                                window needs at least one contact created inside it.
 *   Avg time to book (coach.average_time_to_book)
 *                                avg(appointments.created_at - contacts.created_at) over cohort
 *                                rows whose first non-canceled appointment exists. Its state is
 *                                `unavailable` when that average is null, so `appointments.created_at`
 *                                has to be written explicitly and has to be LATER than the
 *                                contact's `created_at` or the reading goes negative.
 *   Pipeline / agent win rate    booked / count(cohort rows in booked, qualified_no_buy or
 *                                disqualified). Needs at least one terminal-stage contact in the
 *                                window. `agent_win_rate` additionally needs
 *                                `appointments.attributed_to_agent = true`.
 *   Show rate (coach.show_rate)  NOT window-scoped and NOT cohort-scoped: every appointment on the
 *                                tenant with `end_at < asOf` and `status <> 'canceled'`, counted
 *                                completed / (completed + no_show). Needs past appointments in
 *                                both of those two statuses.
 *   Response rate (coach.step.response_rate)
 *                                distinct contacts with an `answered` conversation_step_event over
 *                                distinct contacts with an `asked` one, joined to cohort contacts.
 *                                `analytics_conversation_step_events` only surfaces an `answered`
 *                                row when an `asked` row on the same conversation precedes it by
 *                                under seven days, so both are written as a pair.
 *   Keyword panel (coach.keyword.*)
 *                                NOT reachable on a demo tenant, and no seed can change that.
 *                                `app.phase13_keyword_measurement`
 *                                (`20261007000001_keyword_goals_capi.sql:929`) is a separate
 *                                security-definer function with `not conversation.is_test and not
 *                                tenant.is_demo` written into its WHERE clause and no demo
 *                                widening, so it returns zero rows for both demo tenants no matter
 *                                what `conversations.first_touch_keyword` holds. The seeder still
 *                                writes keywords with distinctly different booking rates -- they
 *                                are the honest shape of the data and the panel fills the moment
 *                                that exclusion is revisited -- but the panel reads "no
 *                                conversations" today. Reported rather than worked around: fixing
 *                                it is a migration.
 *   Allowance                    `analytics_billing_subscriptions` joined to `tiers.call_allowance`,
 *                                with `used` summed from `billable_events`. This seeder is
 *                                forbidden from writing `billable_events`, so allowance `used`
 *                                stays whatever the Phase 6 seed left it at.
 *   "What needs you today"       not from the RPC. `loadCoachAttention`
 *                                (`src/app/(workspace)/coach/home/page.tsx:129`) counts
 *                                `conversations.status = 'needs_human'` with `needs_human_at` set,
 *                                plus `contacts.pipeline_stage in ('long_term_followup','no_show')`
 *                                with `merged_into_contact_id is null`. All three are seeded; the
 *                                blocked-setup row reads `provisioning_steps`, which this seeder
 *                                must not touch.
 *
 * SEGREGATION. Nothing here changes it. `app.inherit_is_test` sets `is_test := tenants.is_demo` on
 * insert for contacts and by parent for conversations, messages, appointments and step events, so
 * every row lands `is_test = true` and the read-back proves it. The analytics views exclude
 * `is_test`/`is_demo` rows for every reader except the demo tenant's own coach, who is widened by
 * `app.phase7_widen_to_own_demo_tenant` for that one transaction. Platform aggregates never see
 * these rows.
 *
 * TABLES DELIBERATELY NOT WRITTEN: `billable_events`, `notifications`, `provisioning_steps`,
 * `audit_log`. `reset-phase1-demo.mjs:118` refuses to reset while a single `billable_events` row
 * exists, and `demo:run` resets first, so one billing row would brick both commands permanently.
 * The counts are read before and after and asserted unchanged.
 */

import { pathToFileURL } from "node:url";

import pg from "pg";

import { SHOWCASE_LEADS_NAMESPACE } from "./fixtures/showcase-leads-namespace.mjs";
import { COACH_NAMES, LEAD_NAMES, assertUniqueDisplayNames } from "./fixtures/names.mjs";
import { demoChannelFor } from "./fixtures/demo-channels.mjs";
import { resolveDemoTarget } from "./seed-phase1-demo.mjs";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * The two demo tenants, and only these two. `--tenant=` selects one; the default is both.
 * `is_demo` is re-checked against the database before a single row is written, so a slug or id
 * that stops being a demo tenant stops this script rather than filling it with test data.
 */
export const SHOWCASE_TENANTS = Object.freeze([
  Object.freeze({
    slot: 1,
    key: "phase1",
    tenantId: "81000000-0000-4000-8000-000000000001",
    slug: "setterfi-phase1-demo",
  }),
  Object.freeze({
    slot: 2,
    key: "measurement",
    tenantId: "87000000-0000-4000-8000-000000000001",
    slug: "setterfi-demo-placeholder-measurement",
    /*
     * Every message body on the measurement tenant has to say `(demo)`. That is not this script's
     * rule -- `run-phase7-demo.mjs:104` counts messages on this tenant whose body lacks the marker
     * and fails the verifier if the count is anything but zero, because a hosted demo without it
     * read as a database dump. The Phase 1 tenant carries no such rule and `seed-demo-complete.mjs`
     * writes unmarked bodies there, so the marker is per tenant rather than global.
     */
    messageMarker: " (demo)",
  }),
]);

const KIND = Object.freeze({
  contact: 1,
  conversation: 2,
  message: 3,
  appointment: 4,
  stepEvent: 5,
  identity: 6,
});

/** `8d000000-<slot><kind>00-4000-8000-<sequence>`; see `fixtures/showcase-leads-namespace.mjs`. */
export function showcaseLeadId(slot, kind, sequence) {
  return `${SHOWCASE_LEADS_NAMESPACE}${slot}${kind}00-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function argumentValue(argumentsList, name) {
  const prefix = `${name}=`;
  return argumentsList.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

/*
 * Names. Twenty-four given names against fourteen family names. The family index advances with
 * the given index and again on every wrap, so consecutive pairs share neither column and the
 * first 336 are distinct -- a plain stride would have repeated at 168, short of the 200 needed. `assertUniqueDisplayNames` runs over the whole tenant in `seed-phase1-demo.mjs` and
 * `seed-phase7-demo.mjs`, and both refuse a name starting demo/test/synthetic/setterfi, so the
 * generated set is checked against the existing fixture names before anything is written.
 */
const GIVEN_NAMES = [
  "Alicia", "Brandon", "Camille", "Darnell", "Elena", "Franklin", "Gabriela", "Hakeem",
  "Imani", "Jerome", "Kendra", "Lorenzo", "Marisol", "Nathaniel", "Odette", "Preston",
  "Quinton", "Rosalind", "Sterling", "Tamika", "Ulises", "Vanessa", "Wendell", "Yolanda",
];
const FAMILY_NAMES = [
  "Ashford", "Benoit", "Castellano", "Dunleavy", "Eriksen", "Fontaine", "Garrigan",
  "Holloway", "Ingersoll", "Jessup", "Kimbrough", "Lattimore", "Marchetti", "Northcutt",
];

export function buildShowcaseNames(count) {
  const names = [];
  for (let index = 0; index < count; index += 1) {
    const given = GIVEN_NAMES[index % GIVEN_NAMES.length];
    const family = FAMILY_NAMES[(index + Math.floor(index / GIVEN_NAMES.length)) % FAMILY_NAMES.length];
    names.push(`${given} ${family}`);
  }
  assertUniqueDisplayNames(names, "SHOWCASE_LEAD_NAMES_NOT_UNIQUE");
  const taken = new Set([...LEAD_NAMES, ...COACH_NAMES].map((name) => name.toLocaleLowerCase("en-US")));
  if (names.some((name) => taken.has(name.toLocaleLowerCase("en-US")))) {
    throw new Error("SHOWCASE_LEAD_NAME_COLLIDES_WITH_FIXTURE");
  }
  if (names.some((name) => /^(demo|test|synthetic|setterfi)\b/i.test(name))) {
    throw new Error("SHOWCASE_LEAD_NAME_LOOKS_LIKE_STATE");
  }
  return names;
}

const BUSINESSES = [
  "Runs a two-van mobile detailing business and wants working capital for a third.",
  "Owns a hair studio with four chairs and is opening a second location.",
  "Contract landscaping crew, seasonal cash flow, looking to buy equipment outright.",
  "Sells refurbished restaurant equipment online and needs inventory float.",
  "Independent freight dispatcher moving from one truck to three.",
  "Runs a childcare centre and is applying for a larger lease.",
  "Boutique fitness studio, wants to fund a build-out rather than finance it monthly.",
  "Family-run bakery supplying two grocery chains and outgrowing its kitchen.",
  "Mobile welding outfit that turns down jobs for want of a second rig.",
  "E-commerce apparel brand carrying its own inventory for the first time.",
  "Two-person accounting practice buying out a retiring competitor's book.",
  "Auto repair shop adding a diagnostics bay.",
];

/*
 * Channels come from `fixtures/demo-channels.mjs` rather than a list here, and `webchat` is gone
 * from it. Every one of these two hundred leads used to render "no channel saved" in the coach's
 * "Where they came from" column, because that column reads `contact_identities` and this seeder
 * wrote none, and the fifth of them stamped `webchat` could never have had one: the demo tenant
 * carries no web-chat connection and `channel_provider` has no web-chat provider in it.
 */

/**
 * Six keywords with deliberately different booking rates, plus untagged leads. The rates come out
 * of which pool a stage draws from rather than from a hard-coded percentage, so the table cannot
 * disagree with the pipeline beside it. (See the header: the keyword panel is not readable on a
 * demo tenant today; this is the shape it will show when it is.)
 */
const KEYWORDS_BOOKING = ["FUNDS", "FUNDS", "100K", "FUNDS", "CREDIT", "FUNDS", "100K", "FUNDS"];
const KEYWORDS_RULED_OUT = ["GRANT", "START", "CREDIT", "GRANT", "100K", "START", "GRANT", "CREDIT"];
const KEYWORDS_OPEN = ["START", "SCALE", "CREDIT", "100K", null, "GRANT", "SCALE", null, "START", "CREDIT"];

const CREDIT_RANGES = ["600–640", "640–680", "680–700", "700+", "below 600", "unknown"];
const FUNDING_GOALS = ["<$50K", "$50K–100K", "$100K–150K", "$150K+"];
const TIMELINES = ["ASAP–30d", "1–3mo", "3–6mo", "exploring"];
const TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"];

/**
 * The stage plan. Each segment is a day-range and a stage histogram, and the ranges matter: a
 * `no_show` contact needs an appointment that has already ended, so no segment newer than twelve
 * days is allowed to produce one. Segment A of each cohort is the older half.
 */
const COHORT_PLAN = [
  {
    name: "recent-settled",
    fromDaysBack: 28,
    toDaysBack: 14,
    stages: { booked: 10, no_show: 5, qualified_no_buy: 7, disqualified: 8, long_term_followup: 6 },
  },
  {
    name: "recent-open",
    fromDaysBack: 13,
    toDaysBack: 1,
    stages: { new_lead: 12, qualifying: 12, booked: 2, disqualified: 2, long_term_followup: 2 },
  },
  {
    name: "older-settled",
    fromDaysBack: 178,
    toDaysBack: 60,
    stages: {
      booked: 20, no_show: 8, qualified_no_buy: 13, disqualified: 18,
      long_term_followup: 14, qualifying: 12, new_lead: 9,
    },
  },
  {
    name: "older-recent",
    fromDaysBack: 59,
    toDaysBack: 31,
    stages: {
      booked: 4, no_show: 2, qualified_no_buy: 3, disqualified: 4,
      long_term_followup: 6, qualifying: 10, new_lead: 11,
    },
  },
];

const TERMINAL_STAGES = new Set(["booked", "qualified_no_buy", "disqualified"]);

const DQ_REASONS = [
  "The lead is looking for a personal loan rather than business funding.",
  "The lead has an open bankruptcy and is outside the current program criteria.",
  "The lead asked to revisit funding after this year's filings are done.",
  "The lead wants a grant only and is not open to a funding review.",
];

/**
 * Threads. The agent asks one bounded question at a time, never guarantees an approval or an
 * amount, and quotes no price at all -- the two demo tenants publish different offers and a
 * number invented here would be a number the Brain does not hold. Booking language names the
 * review session and stops there.
 */
const OPENERS = [
  "Saw your post about funding for small businesses. How does it work?",
  "Hi — a friend said you help people get funded. Is that right?",
  "I commented on your reel. Can you tell me more?",
  "Do you work with people who are still building their credit?",
  "I'm trying to get capital into my business this quarter. Where do I start?",
];
const CREDIT_ANSWERS = [
  "Last time I checked it was around 660.",
  "Mid 600s, I think. I have not pulled it in a couple of months.",
  "It's just over 700 now.",
  "Honestly I am not sure. I know it is not great.",
];
const GOAL_ANSWERS = [
  "I'd want somewhere around 75k.",
  "Maybe 100k if I can get it.",
  "Enough to buy the equipment outright, so about 40k.",
  "150k or more — I'm buying out a partner.",
];
const TIMELINE_ANSWERS = [
  "As soon as possible, ideally inside 30 days.",
  "Next couple of months.",
  "I'm mostly looking around for now.",
  "Before the end of the quarter.",
];

function threadFor(stage, index) {
  const opener = OPENERS[index % OPENERS.length];
  const credit = CREDIT_ANSWERS[index % CREDIT_ANSWERS.length];
  const goal = GOAL_ANSWERS[index % GOAL_ANSWERS.length];
  const timeline = TIMELINE_ANSWERS[index % TIMELINE_ANSWERS.length];
  const core = [
    ["in", "lead", opener],
    ["out", "agent", "Happy to help. So I point you the right way — roughly where is your personal credit sitting at the moment?", "credit"],
    ["in", "lead", credit, "credit"],
    ["out", "agent", "Understood. How much are you trying to raise for the business?", "goal"],
    ["in", "lead", goal, "goal"],
    ["out", "agent", "And what sort of timing are you working to?", "timeline"],
    ["in", "lead", timeline, "timeline"],
  ];
  if (stage === "booked" || stage === "no_show") {
    return [
      ...core,
      ["out", "agent", "That's enough for the team to review properly. The next step is a review session where they go through your file with you — I can't promise an approval or an amount, that comes out of the review. Would earlier or later in the day suit you better?"],
      ["in", "lead", "Later in the day works."],
      ["out", "agent", "Booked. A confirmation with the details is on its way."],
    ];
  }
  if (stage === "disqualified") {
    return [
      ...core.slice(0, 5),
      ["out", "agent", "Thanks for being straight with me. Based on that, this programme is not the right fit for you right now, so I won't take up more of your time. If your situation changes, message here again."],
    ];
  }
  if (stage === "qualified_no_buy") {
    return [
      ...core,
      ["out", "agent", "You're in range for a review. Do you want me to look at times, or would you rather sit with it?"],
      ["in", "lead", "Let me think about it and come back to you."],
    ];
  }
  if (stage === "long_term_followup") {
    return [
      ...core.slice(0, 5),
      ["out", "agent", "That timing is further out than the review is useful for. I'll check back closer to then — anything change in the meantime, message here."],
    ];
  }
  if (stage === "qualifying") return core;
  return core.slice(0, 2);
}

function spread(count, fromDaysBack, toDaysBack, index) {
  if (count <= 1) return fromDaysBack;
  const span = fromDaysBack - toDaysBack;
  return fromDaysBack - Math.round((span * index) / (count - 1));
}

/**
 * The whole dataset for one tenant, as plain objects, with every timestamp derived from `nowMs`.
 * Nothing is written here -- keeping generation pure is what lets the unit test assert the shape
 * without a database.
 */
export function buildShowcaseDataset(slot, nowMs) {
  const marker = SHOWCASE_TENANTS.find((tenant) => tenant.slot === slot)?.messageMarker ?? "";
  const specs = [];
  for (const segment of COHORT_PLAN) {
    const entries = [];
    for (const [stage, count] of Object.entries(segment.stages)) {
      for (let n = 0; n < count; n += 1) entries.push(stage);
    }
    // Rotate rather than sort, so the segment does not read as blocks of one stage in date order.
    const ordered = entries.map((stage, index) => ({
      stage,
      sortKey: (index * 7) % entries.length,
    })).sort((left, right) => left.sortKey - right.sortKey).map((entry) => entry.stage);
    ordered.forEach((stage, index) => {
      specs.push({
        stage,
        segment: segment.name,
        daysBack: spread(ordered.length, segment.fromDaysBack, segment.toDaysBack, index),
      });
    });
  }

  const names = buildShowcaseNames(specs.length);
  let bookingCursor = 0;
  let ruledOutCursor = 0;
  let openCursor = 0;
  let needsHumanBudget = 9;

  const contacts = [];
  const identities = [];
  const conversations = [];
  const messages = [];
  const appointments = [];
  const stepEvents = [];

  specs.forEach((spec, index) => {
    const sequence = index + 1;
    const contactId = showcaseLeadId(slot, KIND.contact, sequence);
    const conversationId = showcaseLeadId(slot, KIND.conversation, sequence);
    // Minutes-of-day vary so the inbox does not read as two hundred leads arriving at midnight.
    const createdAtMs = nowMs - spec.daysBack * DAY_MS
      + ((index * 37) % 11) * HOUR_MS + ((index * 13) % 60) * MINUTE_MS;

    let keyword;
    if (spec.stage === "booked" || spec.stage === "no_show") {
      keyword = KEYWORDS_BOOKING[bookingCursor % KEYWORDS_BOOKING.length];
      bookingCursor += 1;
    } else if (spec.stage === "disqualified" || spec.stage === "qualified_no_buy") {
      keyword = KEYWORDS_RULED_OUT[ruledOutCursor % KEYWORDS_RULED_OUT.length];
      ruledOutCursor += 1;
    } else {
      keyword = KEYWORDS_OPEN[openCursor % KEYWORDS_OPEN.length];
      openCursor += 1;
    }

    let outcome = null;
    let dqReason = null;
    if (spec.stage === "booked") outcome = "BOOK";
    if (spec.stage === "disqualified") {
      outcome = index % 2 === 0 ? "HARD_DQ" : "SOFT_DQ";
      dqReason = DQ_REASONS[index % DQ_REASONS.length];
    }
    if (spec.stage === "long_term_followup") {
      outcome = "SOFT_DQ";
      dqReason = "The lead asked to revisit funding on a longer timeline.";
    }

    const thread = threadFor(spec.stage, index);
    // The stage was reached by the conversation, so it is stamped at the last turn rather than now.
    const lastTurnMs = createdAtMs + (thread.length - 1) * 9 * MINUTE_MS + 4 * HOUR_MS;

    contacts.push({
      id: contactId,
      name: names[index],
      lastChannel: demoChannelFor(index).channel,
      creditRange: spec.stage === "new_lead" ? null : CREDIT_RANGES[index % CREDIT_RANGES.length],
      fundingGoal: spec.stage === "new_lead" ? null : FUNDING_GOALS[index % FUNDING_GOALS.length],
      timeline: spec.stage === "new_lead" ? null : TIMELINES[index % TIMELINES.length],
      timezone: TIMEZONES[index % TIMEZONES.length],
      businessContext: BUSINESSES[index % BUSINESSES.length],
      outcome,
      dqReason,
      stage: spec.stage,
      createdAt: new Date(createdAtMs).toISOString(),
      stageSetAt: new Date(lastTurnMs).toISOString(),
      lastSeenAt: new Date(lastTurnMs).toISOString(),
    });

    /*
     * The identity is what makes "Where they came from" print a channel, and its provider is the
     * one the demo tenant's own connection for that channel uses, so the lead, the identity and
     * the connection tell one story. `consent_state` is `conversation` because that is what an
     * inbound lead who replied actually holds, and the evidence is marked synthetic so nothing
     * mistakes it for a captured consent record.
     */
    const arrival = demoChannelFor(index);
    identities.push({
      id: showcaseLeadId(slot, KIND.identity, sequence),
      contactId,
      provider: arrival.provider,
      channel: arrival.channel,
      providerIdentityId: `showcase-${slot}-${arrival.channel}-${String(sequence).padStart(4, "0")}`,
      normalizedPhone: arrival.channel === "sms" || arrival.channel === "whatsapp"
        ? `+1555${String(1_000_000 + Number(slot) * 100_000 + sequence).slice(-7)}`
        : null,
      consentCapturedAt: new Date(createdAtMs).toISOString(),
      createdAt: new Date(createdAtMs).toISOString(),
    });

    let status = "agent";
    let statusReason = null;
    let needsHumanAt = null;
    if (spec.stage === "booked") { status = "closed"; statusReason = "booked"; }
    else if (spec.stage === "disqualified") {
      status = "closed";
      statusReason = outcome === "HARD_DQ" ? "hard_dq" : "soft_dq";
    } else if (spec.stage === "qualified_no_buy" || spec.stage === "no_show") {
      status = "nurture"; statusReason = "stale";
    } else if (spec.stage === "long_term_followup") {
      status = "nurture"; statusReason = "cadence_exhausted";
    } else if (spec.stage === "qualifying" && spec.daysBack <= 28 && needsHumanBudget > 0) {
      status = "needs_human";
      statusReason = needsHumanBudget % 2 === 0 ? "lead_requested_human" : "tripwire_escalate";
      needsHumanAt = new Date(nowMs - (needsHumanBudget * 7 * HOUR_MS + 40 * MINUTE_MS)).toISOString();
      needsHumanBudget -= 1;
    }

    conversations.push({
      id: conversationId,
      contactId,
      channel: demoChannelFor(index).channel,
      keyword,
      status,
      statusReason,
      needsHumanAt,
      currentStep: spec.stage === "new_lead" ? "credit" : "timeline",
      createdAt: new Date(createdAtMs).toISOString(),
      statusChangedAt: new Date(lastTurnMs).toISOString(),
      lastMessageAt: new Date(lastTurnMs).toISOString(),
      unreadByCoach: status === "needs_human",
    });

    const askedByStep = new Map();
    thread.forEach((turn, turnIndex) => {
      const [direction, author, body, stepKey] = turn;
      const messageId = showcaseLeadId(slot, KIND.message, sequence * 100 + turnIndex);
      const occurredMs = createdAtMs + turnIndex * 9 * MINUTE_MS + (turnIndex >= 3 ? 4 * HOUR_MS : 0);
      messages.push({
        id: messageId,
        conversationId,
        direction,
        author,
        body: `${body}${marker}`,
        provider: direction === "in" ? null : "ghl",
        createdAt: new Date(occurredMs).toISOString(),
      });
      if (!stepKey) return;
      if (direction === "out") {
        askedByStep.set(stepKey, { messageId, occurredMs });
        stepEvents.push({
          id: showcaseLeadId(slot, KIND.stepEvent, sequence * 100 + turnIndex),
          conversationId,
          contactId,
          messageId,
          stepKey,
          eventKind: "asked",
          occurredAt: new Date(occurredMs).toISOString(),
        });
        return;
      }
      // An `answered` row only surfaces through `analytics_conversation_step_events` when an
      // `asked` row on the same conversation precedes it by under seven days, so it is only ever
      // written against the ask it replies to.
      const asked = askedByStep.get(stepKey);
      if (!asked || occurredMs - asked.occurredMs >= 6 * DAY_MS) return;
      stepEvents.push({
        id: showcaseLeadId(slot, KIND.stepEvent, sequence * 100 + turnIndex),
        conversationId,
        contactId,
        messageId,
        stepKey,
        eventKind: "answered",
        occurredAt: new Date(occurredMs).toISOString(),
      });
    });

    if (spec.stage === "booked" || spec.stage === "no_show" || spec.stage === "qualified_no_buy") {
      // Time to book: one to six days after the lead arrived, which is what the Avg time to book
      // card averages. `created_at` is written explicitly -- the column defaults to now(), and a
      // default here would make every booking look instantaneous.
      const bookedAfterDays = 1 + (index % 6);
      const bookedAtMs = createdAtMs + bookedAfterDays * DAY_MS;
      const startAtMs = bookedAtMs + (3 + (index % 6)) * DAY_MS + 15 * HOUR_MS;
      const isPast = startAtMs < nowMs - 2 * HOUR_MS;
      let status2;
      if (spec.stage === "no_show") status2 = "no_show";
      else if (spec.stage === "qualified_no_buy") status2 = "canceled";
      else if (isPast) status2 = "completed";
      else status2 = index % 3 === 0 ? "confirmed" : "scheduled";
      // A no_show or completed appointment that has not happened yet would be a lie; the plan
      // keeps those stages out of the newest segments, and this asserts it rather than trusting it.
      if (!isPast && (status2 === "completed" || status2 === "no_show")) {
        throw new Error(`SHOWCASE_APPOINTMENT_IN_FUTURE_WITH_PAST_STATUS:${contactId}`);
      }
      appointments.push({
        id: showcaseLeadId(slot, KIND.appointment, sequence),
        externalId: `showcase-leads-${slot}-${String(sequence).padStart(4, "0")}`,
        contactId,
        conversationId,
        status: status2,
        createdAt: new Date(bookedAtMs).toISOString(),
        startAt: new Date(startAtMs).toISOString(),
        endAt: new Date(startAtMs + 45 * 60_000).toISOString(),
        timezone: TIMEZONES[index % TIMEZONES.length],
        canceledAt: status2 === "canceled" ? new Date(startAtMs - 2 * DAY_MS).toISOString() : null,
        cancelSource: status2 === "canceled" ? "lead" : null,
        attendanceSource: status2 === "completed" || status2 === "no_show" ? "coach" : null,
        attendanceSetAt: status2 === "completed" || status2 === "no_show"
          ? new Date(startAtMs + 2 * HOUR_MS).toISOString()
          : null,
      });
    }
  });

  return { contacts, identities, conversations, messages, appointments, stepEvents };
}

/** What the dataset should make the RPC say, computed from the same objects the writer inserts. */
export function projectShowcaseWindow(dataset, nowMs, windowDays) {
  const start = nowMs - windowDays * DAY_MS;
  const cohort = dataset.contacts.filter((contact) => Date.parse(contact.createdAt) >= start);
  const ids = new Set(cohort.map((contact) => contact.id));
  const booked = new Set(dataset.appointments
    .filter((appointment) => appointment.status !== "canceled" && ids.has(appointment.contactId))
    .map((appointment) => appointment.contactId));
  const terminal = cohort.filter((contact) => TERMINAL_STAGES.has(contact.stage));
  return {
    leads: cohort.length,
    active: cohort.filter((contact) => !TERMINAL_STAGES.has(contact.stage)).length,
    booked: booked.size,
    notAFit: cohort.filter((contact) => contact.stage === "disqualified").length,
    terminal: terminal.length,
  };
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

async function requireDemoTenant(database, tenant) {
  const row = (await database.query(
    "select id, slug, is_demo from public.tenants where id = $1",
    [tenant.tenantId],
  )).rows[0];
  assert(row, `SHOWCASE_TENANT_ABSENT:${tenant.slug}`);
  assert(row.is_demo === true, `SHOWCASE_TARGET_IS_NOT_A_DEMO_TENANT:${tenant.slug}`);
  assert(row.slug === tenant.slug, `SHOWCASE_TENANT_SLUG_MISMATCH:${row.slug}`);
}

const GUARDED_TABLES = ["billable_events", "notifications", "provisioning_steps"];

async function readGuardedCounts(database, tenantId) {
  const entries = [];
  for (const table of GUARDED_TABLES) {
    const row = (await database.query(
      `select count(*)::int as total from public.${table} where tenant_id = $1`,
      [tenantId],
    )).rows[0];
    entries.push([table, row.total]);
  }
  const audit = (await database.query(
    "select count(*)::int as total from public.audit_log where tenant_id = $1",
    [tenantId],
  )).rows[0];
  entries.push(["audit_log", audit.total]);
  return Object.fromEntries(entries);
}

async function insertRows(database, sql, rows, columns) {
  if (rows.length === 0) return;
  const chunk = Math.max(1, Math.floor(60_000 / columns));
  for (let offset = 0; offset < rows.length; offset += chunk) {
    const slice = rows.slice(offset, offset + chunk);
    const values = slice
      .map((unusedRow, rowIndex) => `(${Array.from({ length: columns }, (unusedColumn, columnIndex) =>
        `$${rowIndex * columns + columnIndex + 1}`).join(",")})`)
      .join(",");
    await database.query(sql.replace("__VALUES__", values), slice.flat());
  }
}

/**
 * The install the tenant's SMS identities belong to.
 *
 * An existing one is reused rather than replaced: the Phase 1 demo tenant already owns
 * `DEMO_IDS.ghlInstall`, its Phase 4 and Phase 9 fixtures reference it, and minting a second
 * install for the same tenant would give that tenant two accounts it never installed. Only a
 * tenant with none gets one, under this seeder's own id namespace, so the measurement tenant's
 * showcase book can carry SMS leads too. Idempotent both ways.
 */
async function ensureShowcaseGhlInstall(database, tenant) {
  const existing = (await database.query(
    `select id, location_id from public.ghl_installs
     where tenant_id = $1 and install_state = 'installed'
     order by created_at, id limit 1`,
    [tenant.tenantId],
  )).rows[0];
  if (existing) return { installId: existing.id, locationId: existing.location_id };

  const installId = showcaseLeadId(tenant.slot, KIND.identity, 0);
  const locationId = `SETTERFI_DEMO_PLACEHOLDER_LOCATION_SHOWCASE_${tenant.slot}`;
  await database.query(
    `insert into public.ghl_installs
       (id, tenant_id, location_id, company_id, token_expires_at, install_state)
     values ($1, $2, $3, $4, '2030-01-01T00:00:00Z', 'installed')
     on conflict (id) do update set tenant_id = excluded.tenant_id,
       location_id = excluded.location_id, install_state = 'installed'`,
    [installId, tenant.tenantId, locationId, `showcase-demo-company-${tenant.slot}`],
  );
  return { installId, locationId };
}

async function writeTenant(database, tenant, nowMs) {
  await requireDemoTenant(database, tenant);
  const guardedBefore = await readGuardedCounts(database, tenant.tenantId);
  const dataset = buildShowcaseDataset(tenant.slot, nowMs);

  await insertRows(
    database,
    `insert into public.contacts
       (id, tenant_id, last_channel, name, credit_range, funding_goal, timeline, timezone,
        timezone_source, business_context, outcome, dq_reason, pipeline_stage, stage_set_by,
        stage_set_at, last_seen_at, created_at)
     values __VALUES__
     on conflict (id) do update set last_channel=excluded.last_channel, name=excluded.name,
       credit_range=excluded.credit_range, funding_goal=excluded.funding_goal,
       timeline=excluded.timeline, timezone=excluded.timezone,
       business_context=excluded.business_context, outcome=excluded.outcome,
       dq_reason=excluded.dq_reason, pipeline_stage=excluded.pipeline_stage,
       stage_set_at=excluded.stage_set_at, last_seen_at=excluded.last_seen_at,
       created_at=excluded.created_at`,
    dataset.contacts.map((contact) => [
      contact.id, tenant.tenantId, contact.lastChannel, contact.name, contact.creditRange,
      contact.fundingGoal, contact.timeline, contact.timezone, "provided", contact.businessContext,
      contact.outcome, contact.dqReason, contact.stage, "system", contact.stageSetAt,
      contact.lastSeenAt, contact.createdAt,
    ]),
    17,
  );

  /*
   * Identities are written straight after the contacts and before the conversations, because the
   * contacts table's channel column reads these rows and nothing else does. `on conflict (id)`
   * keeps the seeder idempotent; the natural key
   * (tenant, provider, channel, provider_identity_id) is derived from the slot and sequence, so a
   * re-run lands on the same row rather than minting a second identity for the same lead.
   *
   * A `ghl` identity has to name the install it belongs to. `enforce_ghl_identity_account_binding`
   * raises GHL_IDENTITY_ACCOUNT_BINDING_REQUIRED without one, which is right: an SMS lead that
   * cannot say which account it arrived on is not an SMS lead.
   */
  const ghlInstallId = await ensureShowcaseGhlInstall(database, tenant);
  await insertRows(
    database,
    `insert into public.contact_identities
       (id, tenant_id, contact_id, provider, channel, provider_identity_id, normalized_phone,
        consent_state, consent_source, consent_captured_at, consent_evidence, created_at,
        provider_account_id, ghl_install_id)
     values __VALUES__
     on conflict (id) do update set contact_id=excluded.contact_id, provider=excluded.provider,
       channel=excluded.channel, provider_identity_id=excluded.provider_identity_id,
       normalized_phone=excluded.normalized_phone, consent_state=excluded.consent_state,
       consent_source=excluded.consent_source, consent_captured_at=excluded.consent_captured_at,
       consent_evidence=excluded.consent_evidence, created_at=excluded.created_at,
       provider_account_id=excluded.provider_account_id, ghl_install_id=excluded.ghl_install_id`,
    dataset.identities.map((identity) => [
      identity.id, tenant.tenantId, identity.contactId, identity.provider, identity.channel,
      identity.providerIdentityId, identity.normalizedPhone, "conversation", "inbound_message",
      identity.consentCapturedAt, JSON.stringify({ kind: "synthetic_demo_inbound" }),
      identity.createdAt,
      identity.provider === "ghl" ? ghlInstallId.locationId : null,
      identity.provider === "ghl" ? ghlInstallId.installId : null,
    ]),
    14,
  );

  await insertRows(
    database,
    `insert into public.conversations
       (id, tenant_id, contact_id, channel, status, status_reason, first_touch_keyword,
        current_step, needs_human_at, unread_by_coach, created_at, status_changed_at,
        last_message_at)
     values __VALUES__
     on conflict (id) do update set channel=excluded.channel, status=excluded.status,
       status_reason=excluded.status_reason, first_touch_keyword=excluded.first_touch_keyword,
       current_step=excluded.current_step, needs_human_at=excluded.needs_human_at,
       unread_by_coach=excluded.unread_by_coach, created_at=excluded.created_at,
       status_changed_at=excluded.status_changed_at, last_message_at=excluded.last_message_at`,
    dataset.conversations.map((conversation) => [
      conversation.id, tenant.tenantId, conversation.contactId, conversation.channel,
      conversation.status, conversation.statusReason, conversation.keyword,
      conversation.currentStep, conversation.needsHumanAt, conversation.unreadByCoach,
      conversation.createdAt, conversation.statusChangedAt, conversation.lastMessageAt,
    ]),
    13,
  );

  await insertRows(
    database,
    `insert into public.messages
       (id, tenant_id, conversation_id, direction, author, body, provider, created_at)
     values __VALUES__
     on conflict (id) do update set conversation_id=excluded.conversation_id,
       direction=excluded.direction, author=excluded.author, body=excluded.body,
       provider=excluded.provider, created_at=excluded.created_at`,
    dataset.messages.map((message) => [
      message.id, tenant.tenantId, message.conversationId, message.direction, message.author,
      message.body, message.provider, message.createdAt,
    ]),
    8,
  );

  await insertRows(
    database,
    `insert into public.appointments
       (id, tenant_id, contact_id, conversation_id, provider, external_id, start_at, end_at,
        timezone, status, created_source, attributed_to_agent, canceled_at, cancel_source,
        attendance_source, attendance_set_at, created_at)
     values __VALUES__
     on conflict (id) do update set contact_id=excluded.contact_id,
       conversation_id=excluded.conversation_id, start_at=excluded.start_at,
       end_at=excluded.end_at, timezone=excluded.timezone, status=excluded.status,
       attributed_to_agent=excluded.attributed_to_agent, canceled_at=excluded.canceled_at,
       cancel_source=excluded.cancel_source, attendance_source=excluded.attendance_source,
       attendance_set_at=excluded.attendance_set_at, created_at=excluded.created_at`,
    dataset.appointments.map((appointment) => [
      appointment.id, tenant.tenantId, appointment.contactId, appointment.conversationId, "ghl",
      appointment.externalId, appointment.startAt, appointment.endAt, appointment.timezone,
      appointment.status, "agent", true, appointment.canceledAt, appointment.cancelSource,
      appointment.attendanceSource, appointment.attendanceSetAt, appointment.createdAt,
    ]),
    17,
  );

  /*
   * `do nothing`, not `do update`. `conversation_step_events_reject_mutation`
   * (`20260823000001_phase7_measurement.sql:644`) raises `CONVERSATION_STEP_EVENTS_APPEND_ONLY` on
   * any update AND on any delete, so these rows can be written once and never corrected. That is
   * safe here: the response-rate read filters on the CONTACT's `created_at`, not on the event's
   * `occurred_at`, so an event frozen at its first run still counts for as long as its contact is
   * in the window, and the asked/answered pair it belongs to is frozen with it.
   */
  await insertRows(
    database,
    `insert into public.conversation_step_events
       (id, tenant_id, conversation_id, contact_id, message_id, step_key, event_kind, occurred_at)
     values __VALUES__
     on conflict (id) do nothing`,
    dataset.stepEvents.map((event) => [
      event.id, tenant.tenantId, event.conversationId, event.contactId, event.messageId,
      event.stepKey, event.eventKind, event.occurredAt,
    ]),
    8,
  );

  const readBack = (await database.query(
    `select
       (select count(*)::int from public.contacts
          where tenant_id=$1 and id::text like $2) contacts,
       (select count(*)::int from public.contacts
          where tenant_id=$1 and id::text like $2 and not is_test) contacts_not_test,
       (select count(*)::int from public.contacts
          where tenant_id=$1 and id::text like $2 and created_at >= now() - interval '30 days') contacts_30d,
       (select count(*)::int from public.conversations where tenant_id=$1 and id::text like $2) conversations,
       (select count(*)::int from public.conversations
          where tenant_id=$1 and id::text like $2 and not is_test) conversations_not_test,
       (select count(*)::int from public.messages where tenant_id=$1 and id::text like $2) messages,
       (select count(*)::int from public.messages
          where tenant_id=$1 and id::text like $2 and not is_test) messages_not_test,
       (select count(*)::int from public.appointments where tenant_id=$1 and id::text like $2) appointments,
       (select count(*)::int from public.appointments
          where tenant_id=$1 and id::text like $2 and not is_test) appointments_not_test,
       (select count(*)::int from public.conversation_step_events
          where tenant_id=$1 and id::text like $2) step_events`,
    [tenant.tenantId, `${SHOWCASE_LEADS_NAMESPACE}${tenant.slot}%`],
  )).rows[0];

  assert(readBack.contacts === dataset.contacts.length, `SHOWCASE_CONTACT_COUNT_INVALID:${readBack.contacts}`);
  assert(readBack.conversations === dataset.conversations.length, "SHOWCASE_CONVERSATION_COUNT_INVALID");
  assert(readBack.messages === dataset.messages.length, "SHOWCASE_MESSAGE_COUNT_INVALID");
  assert(readBack.appointments === dataset.appointments.length, "SHOWCASE_APPOINTMENT_COUNT_INVALID");
  assert(
    readBack.contacts_not_test === 0 && readBack.conversations_not_test === 0
      && readBack.messages_not_test === 0 && readBack.appointments_not_test === 0,
    "SHOWCASE_TEST_INHERITANCE_FAILED",
  );
  assert(readBack.contacts_30d >= 60, `SHOWCASE_TRAILING_MONTH_TOO_THIN:${readBack.contacts_30d}`);

  const guardedAfter = await readGuardedCounts(database, tenant.tenantId);
  for (const table of Object.keys(guardedAfter)) {
    assert(
      guardedAfter[table] === guardedBefore[table],
      `SHOWCASE_GUARDED_TABLE_CHANGED:${table}:${guardedBefore[table]}->${guardedAfter[table]}`,
    );
  }

  return { tenant, dataset, readBack, guarded: guardedAfter };
}

export async function seedShowcaseLeads({ argumentsList = process.argv.slice(2) } = {}) {
  const target = resolveDemoTarget(argumentsList);
  if (!target.databaseUrl) {
    throw new Error("SHOWCASE_DATABASE_URL_REQUIRED: set SUPABASE_DB_PASSWORD for a hosted run");
  }
  const requested = argumentValue(argumentsList, "--tenant");
  const tenants = requested
    ? SHOWCASE_TENANTS.filter((tenant) => tenant.key === requested || tenant.tenantId === requested)
    : SHOWCASE_TENANTS;
  if (tenants.length === 0) throw new Error(`SHOWCASE_TENANT_UNKNOWN:${requested}`);

  // One clock for the whole run, so both tenants tell the same story and a re-run inside the same
  // day rewrites the same rows rather than sliding every timestamp forward by minutes.
  const nowMs = Date.now();
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  const results = [];
  try {
    console.log(`Demo database target host: ${target.host}`);
    for (const tenant of tenants) {
      await database.query("begin");
      try {
        results.push(await writeTenant(database, tenant, nowMs));
        await database.query("commit");
      } catch (error) {
        await database.query("rollback");
        throw error;
      }
    }
  } finally {
    await database.end();
  }

  for (const result of results) {
    const month = projectShowcaseWindow(result.dataset, nowMs, 30);
    console.log(
      `Showcase leads ready: tenant=${result.tenant.slug} contacts=${result.readBack.contacts} `
        + `contacts_last_30d=${result.readBack.contacts_30d} `
        + `conversations=${result.readBack.conversations} messages=${result.readBack.messages} `
        + `appointments=${result.readBack.appointments} step_events=${result.readBack.step_events} `
        + `child_is_test=true 1m_window={leads:${month.leads},active:${month.active},`
        + `booked:${month.booked},not_a_fit:${month.notAFit},terminal:${month.terminal}} `
        + `billable_events=${result.guarded.billable_events} `
        + `notifications=${result.guarded.notifications} `
        + `provisioning_steps=${result.guarded.provisioning_steps} `
        + `audit_log=${result.guarded.audit_log}`,
    );
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedShowcaseLeads().catch((error) => {
    console.error(error instanceof Error ? error.message : "SHOWCASE_LEADS_SEED_FAILED");
    process.exitCode = 1;
  });
}
