/**
 * Coach tenant names for the demo stack. Every one carries the `(demo)` marker because these land
 * in the admin client book beside real rows, and an unmarked demo tenant reads as a real client
 * (GAPS F-11-REVIEW-TENANT-NAMES-UNLABELLED).
 */
export const COACH_NAMES = Object.freeze([
  "Reid Funding Group (demo)",
  "Northstar Capital Coaching (demo)",
  "Elevate Funding Co. (demo)",
  "Boyd and Sons Advisory (demo)",
  "Legacy Lane Financial (demo)",
]);

/**
 * The demo plan ladder, which is the client's contracted price list and not an invention.
 *
 * `docs/INTAKE.md:53-57` is Alec's own answer to the pricing questions -- "297/mo upto 25 calls/m",
 * "597/m upto 75 calls/m", "997 beyond that" -- and `docs/CONTEXT.md:230` restates the same three.
 * These rungs are those three, and nothing else may be added to this array: a fourth priced row on
 * the Plans and pricing screen is the product quoting a price the client never agreed to sell.
 *
 * It used to be five rungs at $197 / $497 / $997 / $1,497 / $2,497, chosen so that three seeders
 * could take one rung each and never render duplicate names. Distinctness was the only thing
 * choosing those numbers, and two of them landed at the same allowance as a contracted tier for a
 * different price -- $497 for the 25 calls the client sells at $297. Five ids across three seeders
 * cannot carry three tiers without either duplicating a name or inventing two prices, so the rows
 * collapse instead: every seeder now upserts the ladder's own ids, and the two ids that used to
 * mint their own rungs are deactivated by the seeder that owned them.
 *
 * The ids are phase 6's existing tier uuids, deliberately. They are referenced by seeded
 * subscriptions and allowance notices, so reusing them makes this a value change rather than an FK
 * churn, and `tiers.stripe_price_id` is globally unique -- `seed-phase6-demo.mjs:105` already
 * releases a price id from whichever row is holding it stale, which is what carries the two rungs
 * whose price id moves to a different row in this change.
 *
 * `isUncapped` is the top rung's whole point. `call_allowance` is `int not null` and there is no
 * number that honestly means "beyond that", so the column keeps holding the threshold the tier
 * begins at -- 75 -- and `tiers.is_uncapped` carries the separate fact that nothing happens when
 * the count passes it. That flag is read by `src/lib/billing/allowances.ts`, which would otherwise
 * warn this tenant at 68 booked calls and schedule them a Stripe tier change at 75.
 *
 * Ordering is the ladder order and seeds index into it, so never reorder these in place.
 */
export const DEMO_TIER_LADDER = Object.freeze([
  Object.freeze({
    id: "86000000-0000-4000-8000-000000000001",
    name: "Starter (demo)",
    priceCents: 29_700,
    callAllowance: 25,
    fairUseCap: 30,
    isUncapped: false,
  }),
  Object.freeze({
    id: "86000000-0000-4000-8000-000000000002",
    name: "Growth (demo)",
    priceCents: 59_700,
    callAllowance: 75,
    fairUseCap: 90,
    isUncapped: false,
  }),
  Object.freeze({
    id: "86000000-0000-4000-8000-000000000003",
    name: "Scale (demo)",
    priceCents: 99_700,
    // The threshold the tier begins at, never a cap -- see `isUncapped` above. `fairUseCap` is null
    // for the same reason: a plan sold with no ceiling may not carry one under another name.
    callAllowance: 75,
    fairUseCap: null,
    isUncapped: true,
  }),
]);

/**
 * The ladder ids the seeders converged on, and the two that used to mint their own rung. A database
 * seeded before the collapse still holds those two rows with their old names and old prices, and a
 * stale priced row on the Plans and pricing screen is the defect this whole change is about -- so
 * the seeder that owned each one deactivates it rather than leaving it to be noticed.
 */
export const RETIRED_DEMO_TIER_IDS = Object.freeze({
  phase5: "85000000-0000-4000-8000-000000000011",
  gaps: "8b000000-0000-4000-8000-000000000001",
});

export const APPROVED_TIER_NAMES = Object.freeze(DEMO_TIER_LADDER.map((rung) => rung.name));

export const LEAD_NAMES = Object.freeze([
  "Priya Raghunathan",
  "Terrence Boyd",
  "Danielle Ortiz",
  "Aisha Coleman",
  "Jamal Whitaker",
  "Elena Vasquez",
  "Noah Bennett",
  "Camila Brooks",
  "Darius Montgomery",
  "Mei Chen",
  "Andre Holloway",
  "Sofia Patel",
  "Caleb Foster",
  "Nia Richardson",
  "Mateo Alvarez",
  "Imani Price",
  "Ethan Kim",
  "Layla Hassan",
  "Marcus Green",
  "Jocelyn Reed",
  "Omar Daniels",
  "Vanessa Nguyen",
  "Jordan Ellis",
  "Tiana Wallace",
  "Luis Mendoza",
  "Brianna Carter",
  "Desmond Clarke",
  "Anika Shah",
  "Trevor Lawson",
  "Selena Morris",
  "Malik Thompson",
  "Grace Park",
  "Xavier Robinson",
  "Natalie Flores",
  "Devin Cooper",
  "Keisha Grant",
  "Isaiah Turner",
  "Monica Reyes",
  "Rafael Santiago",
  "Whitney James",
]);

function assertFixtureNames(names, expectedCount, code) {
  const normalized = names.map((name) => name.trim().toLocaleLowerCase("en-US"));
  if (names.length !== expectedCount || normalized.some((name) => name.length === 0)
    || new Set(normalized).size !== names.length) {
    throw new Error(code);
  }
}

assertFixtureNames(COACH_NAMES, 5, "DEMO_COACH_NAME_FIXTURES_INVALID");
assertFixtureNames(APPROVED_TIER_NAMES, DEMO_TIER_LADDER.length, "DEMO_TIER_NAME_FIXTURES_INVALID");
// A rung with no price is what produced the "$0.00" cards, and two rungs at the same price would
// stop reading as a ladder, so both are fixture errors rather than something a screen discovers.
if (DEMO_TIER_LADDER.some((rung) => rung.priceCents <= 0 || rung.callAllowance <= 0
  || (rung.fairUseCap !== null && rung.fairUseCap < rung.callAllowance))
  || new Set(DEMO_TIER_LADDER.map((rung) => rung.priceCents)).size !== DEMO_TIER_LADDER.length
  || new Set(DEMO_TIER_LADDER.map((rung) => rung.id)).size !== DEMO_TIER_LADDER.length) {
  throw new Error("DEMO_TIER_LADDER_INVALID");
}
// A capped rung with no fair-use ceiling would silently sell an unlimited plan at a capped price,
// and an uncapped rung carrying one would be a cap under another name. Both are the same mistake
// in opposite directions, so the pairing is a fixture error rather than something billing finds.
if (DEMO_TIER_LADDER.some((rung) => rung.isUncapped !== (rung.fairUseCap === null))) {
  throw new Error("DEMO_TIER_LADDER_UNCAPPED_MISMATCH");
}
assertFixtureNames(LEAD_NAMES, 40, "DEMO_LEAD_NAME_FIXTURES_INVALID");

/**
 * Readable demo copy.
 *
 * Seed rows used to carry raw `SETTERFI_DEMO_PLACEHOLDER_*` tokens in display columns so nothing
 * could mistake a demo row for a real one. That held on a local stack nobody looked at, but the
 * hosted demo tenant renders those columns, and a coach reading
 * "Currently SETTERFI_DEMO_PLACEHOLDER_SUCCESS_OWNER" learns nothing except that the product looks
 * broken.
 *
 * These values read like the credit and business-funding coaching industry and every one carries
 * the `(demo)` marker, so the test-data segregation rule still holds on screen while the screen
 * stops reading like a database dump. Tokens that code *guards* on (provider template names,
 * template bodies, Stripe ids, consent and campaign versions, anything matched by prefix or
 * `startsWith`) are deliberately absent here and stay exactly as they were.
 */
export const DEMO_TAG = "(demo)";

export const DEMO_BUSINESS_NAMES = Object.freeze({
  affiliatePortfolio: "Cedar Ridge Credit Coaching (demo)",
  moneyStory: "Summit Funding Group (demo)",
  referralNorth: "Northgate Credit Partners (demo)",
  referralHarbor: "Harbor Credit Coaching (demo)",
  referralSummit: "Sunrise Business Capital (demo)",
});

export const DEMO_PERSON_NAMES = Object.freeze({
  affiliateOwner: "Marcus Vaughn (demo)",
  moneyCoach: "Renee Alcott (demo)",
  successOwner: "Dana Whitfield (demo)",
  referralNorth: "Priya Raman (demo)",
  referralHarbor: "Terrence Boyd (demo)",
  referralSummit: "Alicia Fontaine (demo)",
});

/**
 * The four demo login accounts, as people.
 *
 * `seed-staging-users.mjs` named them "Staging Owner", "Staging Admin", "Staging Coach" and
 * "Staging Affiliate", and the workspace header prints the first whitespace token of a user's
 * name, so the demo coach was greeted "Welcome back, Staging" and the account chip beside it read
 * "SC Staging". That is the product introducing itself with a deployment environment's name.
 *
 * Each carries the `(demo)` marker like every other demo display value, and the greeting is
 * unaffected because it takes the first token. The coach shares a surname with the tenant they own,
 * "Reid Funding Group (demo)", which is what a real one-owner coaching business looks like.
 */
export const DEMO_STAFF_NAMES = Object.freeze({
  owner: "Delia Hartman (demo)",
  admin: "Theo Brightwell (demo)",
  coach: "Reid Calloway (demo)",
  affiliate: "Janelle Okonkwo (demo)",
});

/**
 * The two demo tenants that are not coach workspaces. Both used to render without the `(demo)`
 * marker in the admin clients table, beside real rows (GAPS F-11-REVIEW-TENANT-NAMES-UNLABELLED).
 */
export const DEMO_SUPPORT_TENANT_NAMES = Object.freeze({
  affiliatePartner: "Affiliate Partner Workspace (demo)",
  measurement: "Measurement Review Workspace (demo)",
});

export const DEMO_LEAD_NAMES = Object.freeze({
  moneyStory: "Rochelle Vance (demo)",
});

/** Short enough for a table cell, and it says what the cap actually does. */
export const DEMO_FAIR_USE_NOTE = "Soft cap. Overage is reviewed, never auto-charged. (demo)";

export const DEMO_BILLING_COPY = Object.freeze({
  correctionRequest: "Lead booked twice, asking for one call back (demo)",
  /**
   * The second filed correction. Both seeded rows used to carry `correctionRequest` and the same
   * `-1` delta on the same coach, so the Corrections table read as a duplicate-row bug and its
   * Direction facet had only one value to offer. This one runs the other way.
   */
  correctionRequestIncrease: "Two calls were held but only one was counted (demo)",
  /** Filed by a second coach, so the Coach column on Corrections actually varies. */
  correctionRequestSecondCoach: "A call the lead moved was still billed this month (demo)",
  correctionApproved: "Approved, duplicate booking confirmed (demo)",
  correctionRejected: "Declined, both calls were held (demo)",
  allowanceNoticeTitle: "You are close to your call allowance (demo)",
  allowanceNoticeBody: "Most of this month's included calls are used. (demo)",
  payoutApproval: "Approved for the monthly payout run (demo)",
  payoutReference: "Demo payout batch 1042",
  suspensionReason: "Card declined twice, account paused (demo)",
  costEvidenceComplete: "Demo cost evidence, complete month",
  costEvidenceIncomplete: "Demo cost evidence, partial month",
});

export const DEMO_SUPPORT_COPY = Object.freeze({
  subject: "Booking link is not reaching leads (demo)",
  coachMessage: "Two leads told me the booking link never arrived. Can you check the calendar connection? (demo)",
  platformReply: "Found it. The calendar token expired overnight, and it is reconnected now. (demo)",
  internalNote: "Internal: the token refresh failed silently, so watch this tenant for a week. (demo)",
  successOwnerReason: "Rebalancing the demo book of clients (demo)",
  namedExportReason: "Coach asked for their support history (demo)",
  resourceExportReason: "Weekly delivery review (demo)",
  abortedExportReason: "Export cancelled before it finished (demo)",
});

/**
 * The four review support threads, as a coach would actually write them.
 *
 * The subject used to repeat the row's own state ("Open \u00b7 calendar confirmation"), so the
 * Attention queue printed its State column twice and the Issue column carried no information.
 * `ageDays` is how far back the thread's last update is stamped, so the Age column ranks the queue
 * instead of reading "4 days" on every row.
 */
export const DEMO_REVIEW_THREADS = Object.freeze([
  Object.freeze({
    subject: "Booking link never reached two leads (demo)",
    status: "open",
    ageDays: 9,
    coachMessage: "Two leads told me the booking link never arrived. Can you check the calendar connection? (demo)",
    staffMessage: "Found it, the calendar token expired overnight. It is reconnected now. (demo)",
    staffInternal: false,
  }),
  Object.freeze({
    subject: "Charged for a call that was rescheduled (demo)",
    status: "waiting_on_coach",
    ageDays: 4,
    coachMessage: "This month counted a call the lead moved to next week. Can that come off the allowance? (demo)",
    staffMessage: "Internal: waiting on the coach to confirm which booking to credit. (demo)",
    staffInternal: true,
  }),
  Object.freeze({
    subject: "Referral did not show up against my code (demo)",
    status: "resolved",
    ageDays: 21,
    coachMessage: "I sent a coach through my link last week and I do not see them on my referrals. (demo)",
    staffMessage: "The attribution receipt is stored, the referral is on your list now. (demo)",
    staffInternal: false,
  }),
  Object.freeze({
    subject: "How long does text message registration take? (demo)",
    status: "open",
    ageDays: 1,
    coachMessage: "My Instagram agent is live but texts still are not sending. What is left? (demo)",
    staffMessage: "The carrier still has your registration. It switches on by itself once they clear it. (demo)",
    staffInternal: false,
  }),
]);

export const DEMO_ALERT_COPY = Object.freeze({
  ruleName: "Lead needs a human (demo)",
  ruleDescription: "Posts to the demo channel when the agent hands a conversation back. (demo)",
  emailSubject: "A demo lead needs a human",
  emailBody: "The agent handed a conversation back to you. Open the inbox to take it. (demo)",
  testBell: "Demo alert: a payment failed",
  billingEmail: "Demo alert: a payment failed, emailed to the billing contact",
  retryErrorCode: "429",
  retryErrorDetail: "The provider asked us to slow down, so the send retried. (demo)",
});

export const DEMO_MEASUREMENT_COPY = Object.freeze({
  stepDiscovery: "discovery",
  stepQualification: "qualification",
  firstTouchKeywords: Object.freeze(["funding", "credit", "tradelines", "payroll", "startup", "revenue"]),
  leadAnswer: "I run a two-year-old trucking company and I want to fix my business credit. (demo)",
  agentQuestion: "Got it. Roughly what does the company bring in each month? (demo)",
  replyAfterNextTouch: "Sorry, I missed this. Still interested. (demo)",
  replyAtSevenDayBoundary: "Are those funding slots still open? (demo)",
  heldRuleOutcome: "Let me get one of the team to answer that properly. (demo)",
  heldRule: "hand back to a human",
  heldCheckResult: "allowed",
  mockModel: "setterfi/demo-mock",
  demoLabel: "demo",
  consentLabel: "demo consent evidence",
  provisioningLabel: "demo provisioning evidence",
  evalResponse: "Grounded demo answer, no invented numbers. (demo)",
  promotionNotes: "Promoted from a demo test session (demo)",
  expectedQualification: "qualified",
  testLeadTurn: "Can you guarantee my score goes up 100 points? (demo)",
  testAgentResponse: "I cannot promise a number. Here is what the program actually does. (demo)",
  testAnsweredStep: "qualification",
  testAskedStep: "objection handling",
  redactedLeadTurn: "Redacted demo lead turn (demo)",
  redactedAgentTurn: "Redacted demo agent turn (demo)",
  provisioningFailureCode: "provider timeout",
  provisioningFailureMessage: "The provider did not answer in time, so this retries. (demo)",
  provisioningBlockedReason: "Waiting on the carrier before this step can run. (demo)",
  objectionsPublishReason: "Seed synthetic Phase 7 objections for the coach Top objections panel (demo)",
  objectionPricingLabel: "Wants pricing before qualifying",
  objectionPricingResponse: "We can walk through pricing once we know if this is a fit. (demo)",
  objectionClarityReply: "We can explain the process and collect only the details needed to assess fit. (demo)",
  objectionPricingReply: "Happy to cover pricing -- first let's confirm this is a fit. (demo)",
});

export const DEMO_ONBOARDING_COPY = Object.freeze({
  offerProgram: "Credit Reset Accelerator (demo)",
  templateRejectionDetail: "Carrier asked for the business name in the opt-out line. (demo)",
});

export function assertUniqueDisplayNames(names, code = "DEMO_CONTACT_DISPLAY_NAMES_NOT_UNIQUE") {
  const normalized = names.map((name) => name.trim().toLocaleLowerCase("en-US"));
  if (normalized.some((name) => name.length === 0) || new Set(normalized).size !== names.length) {
    throw new Error(code);
  }
}

// The four login accounts are people on screen, so they follow the same rules as every other demo
// display value: distinct, non-empty, `(demo)` marked, and never colliding with a seeded lead.
assertFixtureNames(Object.values(DEMO_STAFF_NAMES), 4, "DEMO_STAFF_NAME_FIXTURES_INVALID");
if (Object.values(DEMO_STAFF_NAMES).some((name) => !name.endsWith(DEMO_TAG))
  || Object.values(DEMO_SUPPORT_TENANT_NAMES).some((name) => !name.endsWith(DEMO_TAG))) {
  throw new Error("DEMO_STAFF_NAME_MISSING_DEMO_TAG");
}
{
  const taken = new Set([...LEAD_NAMES, ...COACH_NAMES].map((name) => name.toLocaleLowerCase("en-US")));
  if (Object.values(DEMO_STAFF_NAMES).some((name) => taken.has(name.toLocaleLowerCase("en-US")))) {
    throw new Error("DEMO_STAFF_NAME_COLLIDES_WITH_FIXTURE");
  }
}
