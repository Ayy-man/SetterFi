/**
 * Closed measurement vocabulary shared by repositories and rendered surfaces.
 *
 * A metric is not renderable merely because a number exists. Its database provenance,
 * population, exclusion treatment, history state, and audience are part of the value so a
 * later surface cannot silently reinterpret the same key or expose economics to a coach.
 *
 * **The column names in `denominator`, `window` and `clock` are deliberate and stay.** Audits keep
 * re-finding `went_live_at`, `appointment start_at`, `latency_ms`, `current_period_start` and
 * `public.platform_margin_projection` here and reading them as leaked identifiers. They reach only
 * the CSV methodology export, which exists so a figure can be reconciled against the query that
 * produced it, and to the person doing that reconciliation the column name is the precise answer
 * rather than a leak. Checked 2026-09-01: no rendered surface prints these fields except the
 * `Window:` sentence on `/admin/agent-performance`. That sentence is the one place the rule is
 * different, and `asOf` -- a bare RPC parameter name inside prose -- was a real defect there;
 * `admin-measurement-view-models.ts` resolves it to the measurement instant on the way to any
 * surface. Re-check this note before adding a rendered descriptor field, not before an audit.
 */

export const COACH_METRIC_KEYS = [
  "coach.new_leads",
  "coach.active_leads",
  "coach.qualified_leads",
  "coach.disqualified_leads",
  "coach.booked_contacts",
  "coach.conversion_rate",
  "coach.average_time_to_book",
  "coach.pipeline_win_rate",
  "coach.agent_win_rate",
  "coach.show_rate",
  "coach.allowance_used",
  "coach.allowance_limit",
  "coach.funnel.entered",
  "coach.funnel.qualified",
  "coach.funnel.booked",
  "coach.step.response_rate",
  "coach.keyword.conversations",
  "coach.keyword.qualified_rate",
  "coach.keyword.response_rate",
  "coach.keyword.booked_rate",
] as const;

export const PLATFORM_METRIC_KEYS = [
  "platform.new_signups",
  "platform.active_subscriptions",
  "platform.gross_mrr",
  "platform.affiliate_commission",
  "platform.booked_appointments",
  "platform.churn_rate",
  "platform.ltv",
  "platform.average_retention",
  "platform.growth_rate",
  "platform.guardrail_block_rate",
  "platform.guardrail_rule_fire_rate",
  "platform.holding_reply_rate",
  "platform.escalation_rate",
  "platform.scope_block_rate",
  "platform.no_show_rate",
  "platform.reschedule_rate",
  "platform.cadence_completion_rate",
  "platform.followup_reply_rate",
  "platform.cross_channel_continuation_rate",
  "platform.time_to_live",
  "platform.provisioning_step_failure_rate",
  "platform.a2p_approval_rate",
  "platform.a2p_median_days_to_clear",
  "platform.meta_live_sms_registering_share",
  "platform.eval_case_count",
  "platform.knowledge_usage_count",
  "platform.margin",
] as const;

export const EVAL_METRIC_KEYS = [
  "eval.suite_pass_rate",
  "eval.false_block_rate",
  "eval.cost_per_case",
  "eval.cost_per_thousand",
  "eval.latency_p50",
  "eval.latency_p95",
] as const;

/**
 * The two numbers the coach Top objections panel renders.
 *
 * These are coach-audience metrics and they are deliberately NOT members of COACH_METRIC_KEYS.
 * That array is the exact expected row set of `public.read_coach_measurement`, which returns
 * twenty rows, and `parseMetricEvidenceRows` refuses any payload whose row count disagrees with
 * its expected key list. A twenty-first member would crash every coach dashboard read against
 * hosted while unit fixtures — which build their metrics by mapping over the same array — stayed
 * green. The rollup has its own RPC and its own validation, so it gets its own array.
 */
export const COACH_OBJECTION_METRIC_KEYS = [
  "coach.objection.conversations",
  "coach.objection.booked_rate",
] as const;

export const METRIC_KEYS = [
  ...COACH_METRIC_KEYS,
  ...PLATFORM_METRIC_KEYS,
  ...EVAL_METRIC_KEYS,
  ...COACH_OBJECTION_METRIC_KEYS,
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];
export type MetricState =
  | "available"
  | "still_filling"
  | "needs_more_history"
  | "unavailable";
export type MetricUnit = "count" | "percent" | "seconds" | "days" | "cents" | "credits";
export type MetricAudience = "coach" | "platform" | "admin_only";
export type MetricEconomics = "none" | "revenue" | "commission" | "cost" | "margin";

export type MetricSource = {
  table: string;
  columns: readonly string[];
};

export type MetricDefinition = {
  key: MetricKey;
  name: string;
  label: string;
  denominator: string;
  window: string;
  clock: string;
  cohortRule: string;
  unit: MetricUnit;
  history: string;
  sources: readonly MetricSource[];
  population: string;
  demoDisposition: string;
  testDisposition: string;
  unavailableRendering: "ABSENT";
  audience: MetricAudience;
  economics: MetricEconomics;
  requiresPositiveDenominator: boolean;
  /**
   * A percent that measures a change rather than a share of a population.
   *
   * Every other percent metric is a part over a whole, so its numerator sits between zero and its
   * denominator and its value between 0 and 100. A period-over-period change is neither: the
   * numerator is a net movement that goes negative when the platform shrinks, and the value passes
   * 100 the moment a period more than doubles the one before it. Reading a change as a share meant
   * the parser refused the whole platform snapshot with `MEASUREMENT_RATE_POPULATION_INVALID` on
   * the first month with fewer signups than the last, so the Overview would go dark exactly when
   * the number it exists to show turned bad. Set it only on a metric whose cohort rule is a change.
   */
  signedRate?: boolean;
};

export type MetricEvidence = {
  metricKey: MetricKey;
  numerator: number | null;
  denominator: number | null;
  value: number | null;
  state: MetricState;
  windowStart: string | null;
  windowEnd: string | null;
};

const REAL_ANALYTICS_DISPOSITION = {
  demoDisposition: "Excluded when tenants.is_demo=true; visible only in an explicitly labelled Demo data view.",
  testDisposition: "Excluded when is_test=true; visible only in an explicitly labelled Test mode view.",
  unavailableRendering: "ABSENT",
} as const;

type DefinitionInput = Omit<
  MetricDefinition,
  "demoDisposition" | "testDisposition" | "unavailableRendering"
>;

function defineMetric(input: DefinitionInput): MetricDefinition {
  return { ...input, ...REAL_ANALYTICS_DISPOSITION };
}

const tenantContactSource = [{
  table: "public.analytics_contacts",
  columns: ["contact_id", "tenant_id", "created_at", "pipeline_stage", "outcome"],
}] as const;
const appointmentSource = [{
  table: "public.analytics_appointments",
  columns: ["appointment_id", "tenant_id", "contact_id", "status", "attributed_to_agent", "start_at", "created_at"],
}] as const;

export const METRIC_DEFINITIONS = {
  "coach.new_leads": defineMetric({
    key: "coach.new_leads", name: "newLeads", label: "New leads", unit: "count",
    denominator: "Distinct contacts created in the selected tenant-local window.",
    window: "Selected 1D, 1W, 1M, 3M, All, or paired Custom half-open window.",
    clock: "Tenant IANA timezone from public.analytics_tenants.timezone.",
    cohortRule: "A contact belongs to the cohort once, by contacts.created_at.",
    sources: tenantContactSource,
    population: "Distinct non-demo, non-test contacts for the expected tenant whose created_at is inside the selected half-open window.",
    history: "Available for any valid window; an empty sourced population is zero.",
    audience: "coach", economics: "none", requiresPositiveDenominator: false,
  }),
  "coach.active_leads": defineMetric({
    key: "coach.active_leads", name: "activeLeads", label: "Active leads", unit: "count",
    denominator: "Distinct contacts in the selected creation cohort.",
    window: "Selected contact-creation cohort window.", clock: "Tenant IANA timezone.",
    cohortRule: "Cohort contacts whose stored pipeline_stage is new_lead, qualifying, or long_term_followup at read time.",
    sources: tenantContactSource,
    population: "Distinct selected-cohort contacts in a nonterminal stored pipeline stage.",
    history: "Current partial cohorts are still filling.", audience: "coach", economics: "none",
    requiresPositiveDenominator: false,
  }),
  "coach.qualified_leads": defineMetric({
    key: "coach.qualified_leads", name: "qualifiedLeads", label: "Qualified leads", unit: "count",
    denominator: "Distinct contacts in the selected creation cohort.",
    window: "Selected contact-creation cohort window.", clock: "Tenant IANA timezone.",
    cohortRule: "Cohort contacts stored as booked or qualified_no_buy, or carrying a declared qualified outcome.",
    sources: tenantContactSource,
    population: "Distinct selected-cohort contacts with stored qualified evidence.",
    history: "Current partial cohorts are still filling.", audience: "coach", economics: "none",
    requiresPositiveDenominator: false,
  }),
  "coach.disqualified_leads": defineMetric({
    key: "coach.disqualified_leads", name: "disqualifiedLeads", label: "Disqualified leads", unit: "count",
    denominator: "Distinct contacts in the selected creation cohort.",
    window: "Selected contact-creation cohort window.", clock: "Tenant IANA timezone.",
    cohortRule: "Cohort contacts whose stored pipeline_stage is disqualified.",
    sources: tenantContactSource,
    population: "Distinct selected-cohort contacts with pipeline_stage=disqualified.",
    history: "Current partial cohorts are still filling.", audience: "coach", economics: "none",
    requiresPositiveDenominator: false,
  }),
  "coach.booked_contacts": defineMetric({
    key: "coach.booked_contacts", name: "bookedContacts", label: "Booked contacts", unit: "count",
    denominator: "Distinct contacts in the selected creation cohort.",
    window: "Selected contact-creation cohort window; appointment creation may occur later.",
    clock: "Tenant IANA timezone for cohort membership.",
    cohortRule: "A cohort contact counts once after any non-canceled appointment, even when that appointment is created after the window closes.",
    sources: [...tenantContactSource, ...appointmentSource],
    population: "Distinct selected-cohort contacts with at least one appointment whose status is not canceled.",
    history: "Current partial cohorts are still filling.", audience: "coach", economics: "none",
    requiresPositiveDenominator: false,
  }),
  "coach.conversion_rate": defineMetric({
    key: "coach.conversion_rate", name: "conversionRate", label: "Lead-to-booked conversion", unit: "percent",
    denominator: "Distinct contacts created in the selected window.",
    window: "Selected contact-creation cohort window; later bookings attribute back to that cohort.",
    clock: "Tenant IANA timezone for contact cohort boundaries.",
    cohortRule: "Numerator is those same distinct contacts that ever receive a non-canceled appointment; event-date windowing is forbidden.",
    sources: [...tenantContactSource, ...appointmentSource],
    population: "Booked distinct contacts divided by all distinct contacts from the identical creation cohort, capped structurally at 100%.",
    history: "The current cohort is still filling; no sourced denominator renders ABSENT.",
    audience: "coach", economics: "none", requiresPositiveDenominator: true,
  }),
  "coach.average_time_to_book": defineMetric({
    key: "coach.average_time_to_book", name: "averageTimeToBook", label: "Average time to book", unit: "seconds",
    denominator: "Selected-cohort contacts with a first non-canceled appointment.",
    window: "Selected contact-creation cohort window.", clock: "Stored timestamptz elapsed time; cohort boundaries use tenant timezone.",
    cohortRule: "Each booked cohort contact contributes first appointment created_at minus contact created_at once.",
    sources: [...tenantContactSource, ...appointmentSource],
    population: "Booked distinct contacts in the selected creation cohort with both timestamps sourced.",
    history: "Current partial cohorts are still filling; no booked contact renders ABSENT.",
    audience: "coach", economics: "none", requiresPositiveDenominator: true,
  }),
  "coach.pipeline_win_rate": defineMetric({
    key: "coach.pipeline_win_rate", name: "pipelineWinRate", label: "Pipeline win rate", unit: "percent",
    denominator: "Distinct contacts stored in booked, qualified_no_buy, or disqualified.",
    window: "Selected contact-creation cohort window.", clock: "Tenant IANA timezone.",
    cohortRule: "Booked divided by booked plus qualified_no_buy plus disqualified; new_lead, qualifying, long_term_followup, and no_show are open and excluded.",
    sources: tenantContactSource,
    population: "All terminal selected-cohort contacts, regardless of who created the appointment; booked is the numerator.",
    history: "No terminal population renders ABSENT; current cohorts are still filling.",
    audience: "coach", economics: "none", requiresPositiveDenominator: true,
  }),
  "coach.agent_win_rate": defineMetric({
    key: "coach.agent_win_rate", name: "agentWinRate", label: "Agent-attributed win rate", unit: "percent",
    denominator: "Distinct contacts stored in booked, qualified_no_buy, or disqualified.",
    window: "Selected contact-creation cohort window.", clock: "Tenant IANA timezone.",
    cohortRule: "Numerator is terminal contacts with a non-canceled appointment where attributed_to_agent=true; pipeline booked alone is insufficient.",
    sources: [...tenantContactSource, ...appointmentSource],
    population: "Agent-attributed booked contacts divided by the same terminal population used by pipeline win rate.",
    history: "No terminal population renders ABSENT; current cohorts are still filling.",
    audience: "coach", economics: "none", requiresPositiveDenominator: true,
  }),
  "coach.show_rate": defineMetric({
    key: "coach.show_rate", name: "showRate", label: "Show rate (self-reported)", unit: "percent",
    denominator: "Past non-canceled appointments in the selected cohort.",
    window: "Selected contact-creation cohort window.", clock: "Tenant IANA timezone for cohort and as-of comparison.",
    cohortRule: "Completed plus unmarked past appointments count as shown; explicit no_show does not; the result never affects billing.",
    sources: appointmentSource,
    population: "Past, non-canceled appointments attached to selected-cohort contacts, with attendance treated as self-reported.",
    history: "No past eligible appointments renders ABSENT.", audience: "coach", economics: "none",
    requiresPositiveDenominator: true,
  }),
  "coach.allowance_used": defineMetric({
    key: "coach.allowance_used", name: "allowanceUsed", label: "Allowance used", unit: "count",
    denominator: "Signed billable-event quantity in the current subscription period.",
    window: "Current billing subscription period; the analytics picker never changes it.", clock: "Subscription current_period_start/current_period_end instants.",
    cohortRule: "Sum public.analytics_billable_events.quantity for the tenant subscription period; appointment cancellation does not auto-reverse it.",
    sources: [{ table: "public.analytics_billable_events", columns: ["tenant_id", "quantity", "occurred_at"] }, { table: "public.analytics_billing_subscriptions", columns: ["tenant_id", "current_period_start", "current_period_end"] }],
    population: "All sourced signed billable events for the expected tenant inside its current mirrored subscription period.",
    history: "Missing current subscription-period evidence renders ABSENT.", audience: "coach", economics: "none",
    requiresPositiveDenominator: false,
  }),
  "coach.allowance_limit": defineMetric({
    key: "coach.allowance_limit", name: "allowanceLimit", label: "Appointment allowance", unit: "count",
    denominator: "The effective allowance attached to the current mirrored subscription Price.",
    window: "Current billing subscription period; the analytics picker never changes it.", clock: "Subscription current_period_start/current_period_end instants.",
    cohortRule: "Resolve the mirrored Stripe Price through public.tiers; an unmatched Price has no allowance.",
    sources: [{ table: "public.analytics_billing_subscriptions", columns: ["tenant_id", "tier_id", "stripe_price_id", "current_period_start", "current_period_end"] }, { table: "public.tiers", columns: ["id", "call_allowance"] }],
    population: "The expected tenant's current trialing or active subscription with a matched tier.",
    history: "Missing subscription or unmatched Price renders ABSENT.", audience: "coach", economics: "none",
    requiresPositiveDenominator: false,
  }),
  "coach.funnel.entered": defineMetric({
    key: "coach.funnel.entered", name: "funnelEntered", label: "Entered funnel", unit: "count",
    denominator: "Distinct contacts created in the selected window.", window: "Selected contact-creation cohort window.",
    clock: "Tenant IANA timezone.", cohortRule: "Each selected-cohort contact enters once.",
    sources: tenantContactSource, population: "All distinct contacts in the selected creation cohort.",
    history: "Available for any valid window.", audience: "coach", economics: "none", requiresPositiveDenominator: false,
  }),
  "coach.funnel.qualified": defineMetric({
    key: "coach.funnel.qualified", name: "funnelQualified", label: "Qualified", unit: "count",
    denominator: "Distinct contacts created in the selected window.", window: "Selected contact-creation cohort window.",
    clock: "Tenant IANA timezone.", cohortRule: "The same qualified evidence as coach.qualified_leads, counted once per cohort contact.",
    sources: tenantContactSource, population: "Distinct selected-cohort contacts with stored qualified evidence.",
    history: "Current partial cohorts are still filling.", audience: "coach", economics: "none", requiresPositiveDenominator: false,
  }),
  "coach.funnel.booked": defineMetric({
    key: "coach.funnel.booked", name: "funnelBooked", label: "Booked", unit: "count",
    denominator: "Distinct contacts created in the selected window.", window: "Selected contact-creation cohort window; later bookings attribute back.",
    clock: "Tenant IANA timezone.", cohortRule: "The same non-canceled booked-contact evidence as coach.booked_contacts.",
    sources: [...tenantContactSource, ...appointmentSource], population: "Distinct selected-cohort contacts with a non-canceled appointment.",
    history: "Current partial cohorts are still filling.", audience: "coach", economics: "none", requiresPositiveDenominator: false,
  }),
  "coach.step.response_rate": defineMetric({
    key: "coach.step.response_rate", name: "stepResponseRate", label: "Response by step", unit: "percent",
    denominator: "Distinct contacts with an asked event for the step.", window: "Selected contact-creation cohort window.",
    clock: "Tenant IANA timezone for cohort membership; event occurred_at is stored as timestamptz.",
    cohortRule: "Distinct contacts with answered events divided by distinct contacts with asked events for the identical stored step_key.",
    sources: [{ table: "public.analytics_conversation_step_events", columns: ["contact_id", "step_key", "event_kind", "occurred_at"] }],
    population: "Selected-cohort contacts with persisted asked/answered step events; re-asks do not duplicate a contact.",
    history: "A step with no asked contacts renders ABSENT.", audience: "coach", economics: "none", requiresPositiveDenominator: true,
  }),
  "coach.keyword.conversations": defineMetric({
    key: "coach.keyword.conversations", name: "keywordConversations", label: "Keyword conversations", unit: "count",
    denominator: "All eligible conversations attached to selected-cohort contacts.", window: "Selected contact-creation cohort window.",
    clock: "Tenant IANA timezone.", cohortRule: "Group conversations by trimmed first_touch_keyword; null or blank is the mandatory No keyword row.",
    sources: [{ table: "public.analytics_conversations", columns: ["conversation_id", "contact_id", "first_touch_keyword"] }],
    population: "Every eligible conversation exactly once, including No keyword, so groups conserve to the conversation denominator.",
    history: "Available for any sourced conversation population.", audience: "coach", economics: "none", requiresPositiveDenominator: false,
  }),
  "coach.keyword.qualified_rate": defineMetric({
    key: "coach.keyword.qualified_rate", name: "keywordQualifiedRate", label: "Keyword qualified rate", unit: "percent",
    denominator: "Eligible conversations in the keyword group.", window: "Selected contact-creation cohort window.", clock: "Tenant IANA timezone.",
    cohortRule: "Distinct qualified attached contacts divided by conversations attributed to that keyword, including No keyword.",
    sources: [{ table: "public.analytics_conversations", columns: ["conversation_id", "contact_id", "first_touch_keyword"] }, ...tenantContactSource],
    population: "Keyword-group conversations and their distinct attached contacts with stored qualified evidence.",
    history: "A keyword group with no conversations renders ABSENT.", audience: "coach", economics: "none", requiresPositiveDenominator: true,
  }),
  "coach.keyword.response_rate": defineMetric({
    key: "coach.keyword.response_rate", name: "keywordResponseRate", label: "Keyword response rate", unit: "percent",
    denominator: "Eligible conversations in the keyword group.", window: "Selected contact-creation cohort window.", clock: "Tenant IANA timezone.",
    cohortRule: "Conversations with a later inbound message divided by all conversations in the keyword group, including No keyword.",
    sources: [{ table: "public.analytics_conversations", columns: ["conversation_id", "contact_id", "first_touch_keyword", "created_at"] }, { table: "public.analytics_messages", columns: ["conversation_id", "direction", "created_at"] }],
    population: "Keyword-group conversations with persisted inbound response evidence after conversation creation.",
    history: "A keyword group with no conversations renders ABSENT.", audience: "coach", economics: "none", requiresPositiveDenominator: true,
  }),
  "coach.keyword.booked_rate": defineMetric({
    key: "coach.keyword.booked_rate", name: "keywordBookedRate", label: "Keyword booked rate", unit: "percent",
    denominator: "Eligible conversations in the keyword group.", window: "Selected contact-creation cohort window; later bookings attribute back.",
    clock: "Tenant IANA timezone.", cohortRule: "Distinct attached contacts with a non-canceled appointment divided by conversations in the keyword group.",
    sources: [{ table: "public.analytics_conversations", columns: ["conversation_id", "contact_id", "first_touch_keyword"] }, ...appointmentSource],
    population: "Keyword-group conversations whose attached distinct contacts later receive a non-canceled appointment.",
    history: "A keyword group with no conversations renders ABSENT.", audience: "coach", economics: "none", requiresPositiveDenominator: true,
  }),

  "platform.new_signups": defineMetric({
    key: "platform.new_signups", name: "newSignups", label: "New signups", unit: "count",
    denominator: "Non-demo tenants created in the trailing 30-day window.", window: "Trailing 30 days ending at asOf.", clock: "UTC.",
    cohortRule: "Each real tenant counts once by tenants.created_at.", sources: [{ table: "public.analytics_tenants", columns: ["tenant_id", "created_at"] }],
    population: "Distinct real tenants created during the half-open trailing-30-day window.", history: "Available from first signup.",
    audience: "platform", economics: "none", requiresPositiveDenominator: false,
  }),
  "platform.active_subscriptions": defineMetric({
    key: "platform.active_subscriptions", name: "activeSubscriptions", label: "Active subscriptions", unit: "count",
    denominator: "Current real-tenant subscription mirror rows.", window: "Point-in-time at asOf.", clock: "UTC.",
    cohortRule: "Count distinct real tenants with current status trialing or active.",
    sources: [{ table: "public.analytics_billing_subscriptions", columns: ["subscription_id", "tenant_id", "status", "provider_updated_at"] }],
    population: "Distinct non-demo tenants with a current mirrored trialing or active subscription.", history: "Available when the subscription mirror is sourced.",
    audience: "platform", economics: "none", requiresPositiveDenominator: false,
  }),
  "platform.gross_mrr": defineMetric({
    key: "platform.gross_mrr", name: "grossMrr", label: "Gross MRR", unit: "cents",
    denominator: "Current trialing or active subscriptions whose Stripe Price maps to a tier.", window: "Point-in-time at asOf using effective price history and tenant override.", clock: "UTC.",
    cohortRule: "Resolve stripe_price_id to tier_id, then effective tenant override or tier price version; affiliate commission is never netted.",
    sources: [{ table: "public.analytics_billing_subscriptions", columns: ["tenant_id", "tier_id", "stripe_price_id", "status"] }, { table: "public.analytics_tier_price_versions", columns: ["tier_id", "price_cents", "effective_at"] }, { table: "public.analytics_tenant_price_overrides", columns: ["tenant_id", "price_cents", "effective_at", "ends_at"] }],
    population: "Real tenants with a current active/trialing mirrored subscription and complete Price-to-tier evidence.",
    history: "Any unmatched Price or missing effective price makes the affected gross MRR evidence unavailable and the metric ABSENT.",
    audience: "admin_only", economics: "revenue", requiresPositiveDenominator: false,
  }),
  "platform.affiliate_commission": defineMetric({
    key: "platform.affiliate_commission", name: "affiliateCommission", label: "Affiliate commission", unit: "cents",
    denominator: "Signed commission ledger entries attributed through referrals.", window: "Trailing 30 days ending at asOf.", clock: "UTC.",
    cohortRule: "Derive tenant only through commission_ledger.referral_id to referrals.tenant_id; never infer or net against gross MRR.",
    sources: [{ table: "public.analytics_commission_ledger", columns: ["tenant_id", "referral_id", "entry_kind", "commission_cents", "invoice_paid_at", "created_at"] }],
    population: "Signed commission entries for real referred tenants in the trailing-30-day window.", history: "Available only from persisted referral-linked ledger evidence.",
    audience: "admin_only", economics: "commission", requiresPositiveDenominator: false,
  }),
  "platform.booked_appointments": defineMetric({
    key: "platform.booked_appointments", name: "bookedAppointments", label: "Booked appointments", unit: "count",
    denominator: "Non-canceled appointment rows for real tenants.", window: "Trailing 30 days ending at asOf.", clock: "UTC.",
    cohortRule: "Count appointment performance rows by created_at, independently of billable allowance events.", sources: appointmentSource,
    population: "Non-canceled, non-test appointments for real tenants created in the trailing-30-day window.", history: "Available from the first persisted appointment.",
    audience: "platform", economics: "none", requiresPositiveDenominator: false,
  }),
  "platform.churn_rate": defineMetric({
    key: "platform.churn_rate", name: "churnRate", label: "Churn rate", unit: "percent",
    denominator: "Subscriptions active at the start of a completed billing cycle.", window: "Most recent complete billing cycle.", clock: "UTC subscription-period boundaries.",
    cohortRule: "Canceled subscriptions from the opening active cohort divided by that same cohort.",
    sources: [{ table: "public.analytics_billing_subscriptions", columns: ["subscription_id", "tenant_id", "status", "current_period_start", "current_period_end", "cancel_at_period_end"] }],
    population: "Real-tenant subscriptions observed across one complete mirrored billing cycle.", history: "Needs one complete billing cycle; before then the metric is ABSENT, never 0%.",
    audience: "admin_only", economics: "none", requiresPositiveDenominator: true,
  }),
  "platform.ltv": defineMetric({
    key: "platform.ltv", name: "ltv", label: "Lifetime value", unit: "cents",
    denominator: "Real subscriptions with a completed observed lifetime.", window: "All complete subscription history through asOf.", clock: "UTC.",
    cohortRule: "Use only persisted subscription revenue over completed lifetimes; no retention assumption or extrapolation.",
    sources: [{ table: "public.analytics_billing_subscriptions", columns: ["tenant_id", "status", "created_at", "current_period_end"] }, { table: "public.analytics_tier_price_versions", columns: ["tier_id", "price_cents", "effective_at"] }],
    population: "Real tenants with complete observed subscription lifetime and matched price evidence.", history: "Needs enough completed lifetimes; otherwise ABSENT.",
    audience: "admin_only", economics: "revenue", requiresPositiveDenominator: true,
  }),
  "platform.average_retention": defineMetric({
    key: "platform.average_retention", name: "averageRetention", label: "Average retention", unit: "days",
    denominator: "Real subscriptions with a completed observed lifetime.", window: "All complete subscription history through asOf.", clock: "UTC.",
    cohortRule: "Average persisted end minus start duration only for completed lifetimes; active age is not a lifetime estimate.",
    sources: [{ table: "public.analytics_billing_subscriptions", columns: ["tenant_id", "status", "created_at", "current_period_end"] }],
    population: "Real tenants with a complete observed subscription lifetime.", history: "Needs enough completed lifetimes; otherwise ABSENT.",
    audience: "admin_only", economics: "none", requiresPositiveDenominator: true,
  }),
  "platform.growth_rate": defineMetric({
    key: "platform.growth_rate", name: "growthRate", label: "Growth rate", unit: "percent",
    denominator: "Real active subscriptions in the prior complete 30-day period.", window: "Two adjacent complete 30-day UTC periods.", clock: "UTC.",
    cohortRule: "Current-period net active-subscription change divided by the prior-period active population.",
    sources: [{ table: "public.analytics_billing_subscriptions", columns: ["tenant_id", "status", "created_at", "provider_updated_at"] }],
    population: "Real subscription mirror rows with two complete comparable periods.", history: "Needs two complete comparable periods and a positive prior population; otherwise ABSENT.",
    audience: "admin_only", economics: "none", requiresPositiveDenominator: true, signedRate: true,
  }),
  "platform.guardrail_block_rate": defineMetric({
    key: "platform.guardrail_block_rate", name: "guardrailBlockRate", label: "Guardrail block rate", unit: "percent",
    denominator: "Eligible message trace outcomes in the trailing 30 days.", window: "Trailing 30 days ending at asOf.", clock: "UTC.",
    cohortRule: "Traces with a persisted blocking violation divided by allowed-outcome traces; unknown outcomes are excluded as unavailable.",
    sources: [{ table: "public.analytics_message_traces", columns: ["message_id", "outcome", "violations", "created_at"] }],
    population: "Real, non-test message traces with an allowed persisted outcome in the trailing-30-day window.", history: "No eligible trace denominator renders ABSENT.",
    audience: "platform", economics: "none", requiresPositiveDenominator: true,
  }),
  "platform.guardrail_rule_fire_rate": defineMetric({
    key: "platform.guardrail_rule_fire_rate", name: "guardrailRuleFireRate", label: "Guardrail rule-fire rate", unit: "percent",
    denominator: "Eligible message traces in the trailing 30 days.", window: "Trailing 30 days ending at asOf.", clock: "UTC.",
    cohortRule: "Traces naming a persisted rule_fired divided by all eligible trace outcomes.",
    sources: [{ table: "public.analytics_message_traces", columns: ["message_id", "outcome", "rule_fired", "created_at"] }],
    population: "Real, non-test message traces with an allowed persisted outcome in the trailing-30-day window.", history: "No eligible trace denominator renders ABSENT.",
    audience: "platform", economics: "none", requiresPositiveDenominator: true,
  }),
  "platform.holding_reply_rate": defineMetric({
    key: "platform.holding_reply_rate", name: "holdingReplyRate", label: "Holding reply rate", unit: "percent",
    denominator: "Eligible message trace outcomes in the trailing 30 days.", window: "Trailing 30 days ending at asOf.", clock: "UTC.",
    cohortRule: "Persisted outcome=held divided by all allowed persisted outcomes.",
    sources: [{ table: "public.analytics_message_traces", columns: ["message_id", "outcome", "created_at"] }],
    population: "Real, non-test message traces with an allowed persisted outcome in the trailing-30-day window.", history: "No eligible trace denominator renders ABSENT.",
    audience: "platform", economics: "none", requiresPositiveDenominator: true,
  }),
  "platform.escalation_rate": defineMetric({
    key: "platform.escalation_rate", name: "escalationRate", label: "Escalation rate", unit: "percent",
    denominator: "Eligible conversations active in the trailing 30 days.", window: "Trailing 30 days ending at asOf.", clock: "UTC.",
    cohortRule: "Conversations with persisted escalation state or audit evidence divided by eligible conversations.",
    sources: [{ table: "public.analytics_conversations", columns: ["conversation_id", "status", "status_reason", "last_message_at"] }, { table: "public.analytics_audit_log", columns: ["action", "target_id", "created_at"] }],
    population: "Real, non-test conversations with activity in the trailing-30-day window.", history: "No eligible conversation denominator renders ABSENT.",
    audience: "platform", economics: "none", requiresPositiveDenominator: true,
  }),
  "platform.scope_block_rate": defineMetric({
    key: "platform.scope_block_rate", name: "scopeBlockRate", label: "Scope-block rate", unit: "percent",
    denominator: "Eligible conversations active in the trailing 30 days.", window: "Trailing 30 days ending at asOf.", clock: "UTC.",
    cohortRule: "Distinct conversations with conversation.scope_blocked audit evidence divided by eligible conversations.",
    sources: [{ table: "public.analytics_conversations", columns: ["conversation_id", "last_message_at"] }, { table: "public.analytics_audit_log", columns: ["action", "target_id", "created_at"] }],
    population: "Real, non-test conversations with activity in the trailing-30-day window.", history: "No eligible conversation denominator renders ABSENT.",
    audience: "platform", economics: "none", requiresPositiveDenominator: true,
  }),
  "platform.no_show_rate": defineMetric({
    key: "platform.no_show_rate", name: "noShowRate", label: "No-show rate", unit: "percent",
    denominator: "Appointments explicitly marked completed or no_show.", window: "Trailing 30 days by appointment start_at.", clock: "UTC.",
    cohortRule: "Explicit no_show appointments divided by completed plus no_show; scheduled past appointments are unknown and excluded.",
    sources: appointmentSource, population: "Real, non-test appointments with explicit completed or no_show status and start_at in the trailing-30-day window.",
    history: "No explicit attendance denominator renders ABSENT.", audience: "platform", economics: "none", requiresPositiveDenominator: true,
  }),
  "platform.reschedule_rate": defineMetric({
    key: "platform.reschedule_rate", name: "rescheduleRate", label: "Reschedule rate", unit: "percent",
    denominator: "Eligible appointment rows in the trailing 30 days.", window: "Trailing 30 days ending at asOf.", clock: "UTC.",
    cohortRule: "Distinct appointments with at least one append-only reschedule event divided by eligible appointments.",
    sources: [...appointmentSource, { table: "public.analytics_appointment_reschedules", columns: ["appointment_id", "created_at"] }],
    population: "Real, non-test appointments with created_at in the trailing-30-day window.", history: "No eligible appointment denominator renders ABSENT.",
    audience: "platform", economics: "none", requiresPositiveDenominator: true,
  }),
  "platform.cadence_completion_rate": defineMetric({
    key: "platform.cadence_completion_rate", name: "cadenceCompletionRate", label: "Cadence completion rate", unit: "percent",
    denominator: "Conversations that entered a persisted follow-up cadence.", window: "Trailing 30 days ending at asOf.", clock: "UTC.",
    cohortRule: "Conversations with status=nurture and status_reason=cadence_exhausted divided by cadence-entry conversations.",
    sources: [{ table: "public.analytics_conversations", columns: ["conversation_id", "status", "status_reason", "cadence_anchor_at"] }, { table: "public.analytics_followups", columns: ["conversation_id", "touch_no", "status", "created_at"] }],
    population: "Real, non-test conversations whose cadence_anchor_at enters the trailing-30-day window.", history: "No cadence-entry denominator renders ABSENT.",
    audience: "platform", economics: "none", requiresPositiveDenominator: true,
  }),
  "platform.followup_reply_rate": defineMetric({
    key: "platform.followup_reply_rate", name: "followupReplyRate", label: "Follow-up reply rate", unit: "percent",
    denominator: "Sent follow-up touches.", window: "Reply within seven days after send and before the next touch; sends selected from trailing 30 days.", clock: "UTC.",
    cohortRule: "A sent touch is replied when persisted inbound evidence arrives before min(sent_at+7 days,next touch sent_at).",
    sources: [{ table: "public.analytics_followups", columns: ["conversation_id", "touch_no", "status", "sent_at"] }, { table: "public.analytics_messages", columns: ["conversation_id", "direction", "created_at"] }],
    population: "Real, non-test sent follow-up touches in the trailing-30-day send cohort.", history: "No sent-touch denominator renders ABSENT; open seven-day windows are still filling.",
    audience: "platform", economics: "none", requiresPositiveDenominator: true,
  }),
  "platform.cross_channel_continuation_rate": defineMetric({
    key: "platform.cross_channel_continuation_rate", name: "crossChannelContinuationRate", label: "Cross-channel continuation rate", unit: "percent",
    denominator: "Sent follow-up touches with a resolved identity.", window: "Reply within seven days after send and before the next touch; sends selected from trailing 30 days.", clock: "UTC.",
    cohortRule: "Resolved-identity touches replied on a different persisted channel divided by eligible resolved-identity touches.",
    sources: [{ table: "public.analytics_followups", columns: ["conversation_id", "touch_no", "resolved_identity_id", "sent_at"] }, { table: "public.analytics_contact_identities", columns: ["identity_id", "contact_id", "channel"] }, { table: "public.analytics_messages", columns: ["conversation_id", "direction", "created_at"] }],
    population: "Real, non-test sent touches with persisted resolved identity in the trailing-30-day send cohort.", history: "No eligible resolved-identity denominator renders ABSENT; open windows are still filling.",
    audience: "platform", economics: "none", requiresPositiveDenominator: true,
  }),
  "platform.time_to_live": defineMetric({
    key: "platform.time_to_live", name: "timeToLive", label: "Median time to live", unit: "days",
    denominator: "Real onboarding runs with both started_at and went_live_at.", window: "Trailing 30 days by went_live_at.", clock: "UTC elapsed time.",
    cohortRule: "Median persisted went_live_at minus started_at; unfinished runs never receive an estimated completion.",
    sources: [{ table: "public.analytics_onboarding_runs", columns: ["tenant_id", "started_at", "went_live_at"] }],
    population: "Completed real-tenant onboarding runs whose went_live_at falls in the trailing-30-day window.", history: "No completed run renders ABSENT.",
    audience: "platform", economics: "none", requiresPositiveDenominator: true,
  }),
  "platform.provisioning_step_failure_rate": defineMetric({
    key: "platform.provisioning_step_failure_rate", name: "provisioningStepFailureRate", label: "Provisioning step failure rate", unit: "percent",
    denominator: "Non-pending provisioning step attempts.", window: "Trailing 30 days ending at asOf.", clock: "UTC.",
    cohortRule: "Persisted failed attempts divided by attempts for each step; pending rows are not attempts.",
    sources: [{ table: "public.analytics_provisioning_steps", columns: ["tenant_id", "step_key", "state", "attempts", "created_at"] }],
    population: "Real-tenant provisioning steps with non-pending attempt evidence in the trailing-30-day window.", history: "No attempted-step denominator renders ABSENT.",
    audience: "platform", economics: "none", requiresPositiveDenominator: true,
  }),
  "platform.a2p_approval_rate": defineMetric({
    key: "platform.a2p_approval_rate", name: "a2pApprovalRate", label: "A2P approval rate", unit: "percent",
    denominator: "A2P campaign steps with terminal done or blocked state.", window: "All terminal A2P filings through asOf.", clock: "UTC.",
    cohortRule: "a2p_campaign state=done divided by done plus blocked; awaiting_provider remains registering and is excluded.",
    sources: [{ table: "public.analytics_provisioning_steps", columns: ["tenant_id", "step_key", "state", "completed_at"] }],
    population: "Real-tenant a2p_campaign steps in terminal done or permanently blocked state.", history: "No terminal filing denominator renders ABSENT.",
    audience: "platform", economics: "none", requiresPositiveDenominator: true,
  }),
  "platform.a2p_median_days_to_clear": defineMetric({
    key: "platform.a2p_median_days_to_clear", name: "a2pMedianDaysToClear", label: "Median A2P days to clear", unit: "days",
    denominator: "A2P campaign steps completed as done.", window: "All completed A2P filings through asOf.", clock: "UTC elapsed time.",
    cohortRule: "Median completed_at minus started_at only for a2p_campaign state=done; awaiting and blocked rows are not predicted.",
    sources: [{ table: "public.analytics_provisioning_steps", columns: ["tenant_id", "step_key", "state", "started_at", "completed_at"] }],
    population: "Real-tenant a2p_campaign steps with persisted done state and both timestamps.", history: "No approved filing renders ABSENT.",
    audience: "platform", economics: "none", requiresPositiveDenominator: true,
  }),
  "platform.meta_live_sms_registering_share": defineMetric({
    key: "platform.meta_live_sms_registering_share", name: "metaLiveSmsRegisteringShare", label: "Meta live while SMS is registering", unit: "percent",
    denominator: "Real tenants with a live Meta channel connection.", window: "Point-in-time at asOf.", clock: "UTC.",
    cohortRule: "Live-Meta tenants whose sms_live or a2p_campaign provisioning state is awaiting_provider divided by all live-Meta tenants.",
    sources: [{ table: "public.analytics_channel_connections", columns: ["tenant_id", "channel", "provider", "state"] }, { table: "public.analytics_provisioning_steps", columns: ["tenant_id", "step_key", "state"] }],
    population: "Real tenants with a persisted live Instagram, Messenger, or WhatsApp connection.", history: "No live-Meta denominator renders ABSENT.",
    audience: "platform", economics: "none", requiresPositiveDenominator: true,
  }),
  "platform.eval_case_count": defineMetric({
    key: "platform.eval_case_count", name: "evalCaseCount", label: "Eval cases", unit: "count",
    denominator: "Active evaluation cases in the shared repository.", window: "Point-in-time at asOf.", clock: "UTC.",
    cohortRule: "Count active repo cases with null source tenant plus active promoted cases from real tenants; demo promotions are excluded.",
    sources: [{ table: "public.analytics_eval_cases", columns: ["eval_case_id", "source_tenant_id", "suite", "active"] }],
    population: "Active shared-repository cases and active non-demo promotions.", history: "Available from the first persisted case.",
    audience: "platform", economics: "none", requiresPositiveDenominator: false,
  }),
  "platform.knowledge_usage_count": defineMetric({
    key: "platform.knowledge_usage_count", name: "knowledgeUsageCount", label: "Knowledge uses", unit: "count",
    denominator: "Persisted Brain knowledge usage events.", window: "Trailing 30 days ending at asOf.", clock: "UTC.",
    cohortRule: "Count append-only usage events; never read a counter stored on the knowledge entry.",
    sources: [{ table: "public.analytics_brain_knowledge_usage_events", columns: ["event_id", "tenant_id", "knowledge_entry_id", "used_at"] }],
    population: "Real-tenant, non-test knowledge usage events in the trailing-30-day window.", history: "Available from the first persisted event.",
    audience: "platform", economics: "none", requiresPositiveDenominator: false,
  }),
  "platform.margin": defineMetric({
    key: "platform.margin", name: "margin", label: "Margin", unit: "cents",
    denominator: "Complete real-tenant rows in the Phase 6 margin projection.", window: "Projection period carried by public.platform_margin_projection.", clock: "UTC.",
    cohortRule: "Use only complete projected gross revenue, commission, and provider usage-cost evidence; never scan raw trace JSON or fabricate a missing component.",
    sources: [{ table: "public.platform_margin_projection", columns: ["tenant_id", "window_start", "window_end", "recognized_subscription_cents", "total_cost_cents", "margin_cents"] }],
    population: "Real tenants whose Phase 6 projection row is complete for every margin component.", history: "Missing or incomplete projection evidence renders the metric ABSENT.",
    audience: "admin_only", economics: "margin", requiresPositiveDenominator: false,
  }),

  "eval.suite_pass_rate": defineMetric({
    key: "eval.suite_pass_rate", name: "suitePassRate", label: "Suite pass rate", unit: "percent",
    denominator: "Persisted results in one evidence-bound comparison arm and suite.", window: "The exact immutable comparison case set, not a date estimate.", clock: "UTC persisted run completion.",
    cohortRule: "Passed results divided by every result key in the identical draft/hash/version/corpus/case-set arm; not_configured has no numeric rate.",
    sources: [{ table: "public.eval_case_results", columns: ["run_id", "case_key", "suite", "passed"] }, { table: "public.eval_runs", columns: ["id", "comparison_id", "comparison_arm", "case_set_hash", "suites_complete"] }],
    population: "All results for one completed comparison arm and suite after exact evidence equality succeeds.", history: "Incomplete, mismatched, skipped, or not_configured evidence renders ABSENT.",
    audience: "admin_only", economics: "none", requiresPositiveDenominator: true,
  }),
  "eval.false_block_rate": defineMetric({
    key: "eval.false_block_rate", name: "falseBlockRate", label: "False-block rate", unit: "percent",
    denominator: "Expected-allow negative cases in one evidence-bound comparison arm.", window: "The exact immutable comparison case set.", clock: "UTC persisted run completion.",
    cohortRule: "Expected-allow cases incorrectly blocked divided by all expected-allow cases in the same arm.",
    sources: [{ table: "public.analytics_eval_cases", columns: ["eval_case_id", "suite", "active"] }, { table: "public.eval_case_results", columns: ["run_id", "case_id", "case_key", "trace", "passed"] }],
    population: "Expected-allow engine cases in one completed comparison arm with complete result identity.", history: "No negative-case denominator or incomplete evidence renders ABSENT.",
    audience: "admin_only", economics: "none", requiresPositiveDenominator: true,
  }),
  "eval.cost_per_case": defineMetric({
    key: "eval.cost_per_case", name: "costPerCase", label: "Provider credits per case", unit: "credits",
    denominator: "Comparison cases carrying persisted provider usage cost.", window: "The exact immutable comparison case set.", clock: "UTC persisted run completion.",
    cohortRule: "Sum provider credits from result trace usage.cost divided by cost-bearing cases; no currency conversion is allowed.",
    sources: [{ table: "public.eval_case_results", columns: ["run_id", "case_key", "trace.usage.cost"] }],
    population: "Cases in one completed comparison arm with a persisted provider-cost receipt.", history: "Mock or missing provider cost renders ABSENT.",
    audience: "admin_only", economics: "cost", requiresPositiveDenominator: true,
  }),
  "eval.cost_per_thousand": defineMetric({
    key: "eval.cost_per_thousand", name: "costPerThousand", label: "Provider credits per thousand cases", unit: "credits",
    denominator: "Comparison cases carrying persisted provider usage cost.", window: "The exact immutable comparison case set.", clock: "UTC persisted run completion.",
    cohortRule: "One thousand times provider credits from result trace usage.cost divided by cost-bearing cases; no currency conversion is allowed.",
    sources: [{ table: "public.eval_case_results", columns: ["run_id", "case_key", "trace.usage.cost"] }],
    population: "Cases in one completed comparison arm with a persisted provider-cost receipt.", history: "Mock or missing provider cost renders ABSENT.",
    audience: "admin_only", economics: "cost", requiresPositiveDenominator: true,
  }),
  "eval.latency_p50": defineMetric({
    key: "eval.latency_p50", name: "latencyP50", label: "Latency p50", unit: "seconds",
    denominator: "Comparison cases carrying persisted latency_ms.", window: "The exact immutable comparison case set.", clock: "Persisted elapsed milliseconds, summarized at UTC run completion.",
    cohortRule: "Nearest-rank p50 over latency_ms for the identical completed comparison arm.",
    sources: [{ table: "public.eval_case_results", columns: ["run_id", "case_key", "latency_ms"] }],
    population: "Cases in one completed comparison arm with persisted latency evidence.", history: "No latency-bearing case or incomplete evidence renders ABSENT.",
    audience: "admin_only", economics: "none", requiresPositiveDenominator: true,
  }),
  "eval.latency_p95": defineMetric({
    key: "eval.latency_p95", name: "latencyP95", label: "Latency p95", unit: "seconds",
    denominator: "Comparison cases carrying persisted latency_ms.", window: "The exact immutable comparison case set.", clock: "Persisted elapsed milliseconds, summarized at UTC run completion.",
    cohortRule: "Nearest-rank p95 over latency_ms for the identical completed comparison arm.",
    sources: [{ table: "public.eval_case_results", columns: ["run_id", "case_key", "latency_ms"] }],
    population: "Cases in one completed comparison arm with persisted latency evidence.", history: "No latency-bearing case or incomplete evidence renders ABSENT.",
    audience: "admin_only", economics: "none", requiresPositiveDenominator: true,
  }),

  "coach.objection.conversations": defineMetric({
    key: "coach.objection.conversations", name: "objectionConversations", label: "Objection conversations", unit: "count",
    denominator: "Distinct conversations carrying at least one usage event for the objection.",
    window: "Trailing 30 days ending at the requested asOf.",
    clock: "The window is instant-anchored to the requested asOf rather than snapped to calendar days, so it carries no tenant-timezone dependence at all.",
    cohortRule: "A conversation counts once per objection however many times that objection was raised in it.",
    sources: [
      { table: "public.analytics_brain_objection_usage_events", columns: ["tenant_id", "conversation_id", "objection_id", "hard_gate", "used_at"] },
      { table: "public.brain_snapshot_objections", columns: ["snapshot_id", "objection_id", "label", "hard_gate"] },
    ],
    population: "Real-tenant, non-test objection usage events for the expected tenant whose used_at falls inside the half-open trailing-30-day window.",
    history: "Available from the first persisted usage event; no recorded match renders an empty panel rather than a zero row.",
    audience: "coach", economics: "none", requiresPositiveDenominator: false,
  }),
  "coach.objection.booked_rate": defineMetric({
    key: "coach.objection.booked_rate", name: "objectionBookedRate", label: "Objection booked rate", unit: "percent",
    denominator: "PROPOSED AND UNAPPROVED: distinct conversations carrying a usage event for the objection. The rule is not approved, so no denominator is in force.",
    window: "PROPOSED AND UNAPPROVED: the reporting window is one of the four things the client must approve before this metric may render at all.",
    clock: "PROPOSED AND UNAPPROVED: no clock is in force, because no attribution rule is.",
    cohortRule: "PROPOSED AND UNAPPROVED: whether a booking counts only after the objection's first hit, whether it must be agent-attributed, and the maximum attribution period are all unanswered (10-SPEC:373-381).",
    sources: [
      { table: "public.analytics_brain_objection_usage_events", columns: ["tenant_id", "conversation_id", "objection_id", "hard_gate", "used_at"] },
      { table: "public.brain_snapshot_objections", columns: ["snapshot_id", "objection_id", "label", "hard_gate"] },
    ],
    population: "None in force. The rollup returns a null rate for every row while the attribution state reads awaiting_definition.",
    history: "The attribution rule is unapproved, so the metric renders as an explicit awaiting-definition state and never as zero.",
    audience: "coach", economics: "none", requiresPositiveDenominator: true,
  }),
} as const satisfies Record<MetricKey, MetricDefinition>;

export function metricDefinition(key: string): MetricDefinition {
  if (!METRIC_KEYS.includes(key as MetricKey)) throw new Error("METRIC_DEFINITION_MISSING");
  return METRIC_DEFINITIONS[key as MetricKey];
}

export function metricLabel(key: string) {
  return metricDefinition(key).label;
}

/**
 * A nonnumeric state is absence, while a sourced count of zero remains valid database truth.
 *
 * `still_filling` is a reading, not an absence. The RPC sets it on every row whose window is still
 * open (`cohort_state := case when as_of < window_end ...`), and every preset window ends at the
 * next local midnight, so a coach who never picks a custom range never sees a row in any other
 * state. Refusing it here refused every count on `/coach/home` for the life of the account -- the
 * "Not yet" the client saw in September over a book of 37 active leads. The value it carries is the
 * true count as of now; what the state adds is that the window has not closed, and that is the
 * caller's caption to print (DECISIONS T12-1: partial periods are marked, not withheld).
 * `needs_more_history` and `unavailable` still carry nothing usable and stay absence.
 */
export function availableMetric(evidence: MetricEvidence): number | null {
  const definition = metricDefinition(evidence.metricKey);
  if (
    (evidence.state !== "available" && evidence.state !== "still_filling")
    || evidence.value === null
    || !Number.isFinite(evidence.value)
  ) {
    return null;
  }
  if (definition.requiresPositiveDenominator && (
    evidence.numerator === null
    || !Number.isFinite(evidence.numerator)
    || evidence.denominator === null
    || !Number.isFinite(evidence.denominator)
    || evidence.denominator <= 0
  )) {
    return null;
  }
  return evidence.value;
}
