-- The platform measurement reader treats these stored values as evidence. Repair the few values
-- that can be normalized without losing their receipt, then make future inversions impossible.

update public.provisioning_steps
set started_at = least(started_at, completed_at)
where started_at is not null
  and completed_at is not null
  and completed_at < started_at;

update public.provisioning_steps
set attempts = greatest(attempts, 0)
where attempts < 0;

update public.followups
set touch_no = 1
where touch_no < 1;

update public.onboarding_runs
set started_at = least(started_at, went_live_at)
where started_at is not null
  and went_live_at is not null
  and went_live_at < started_at;

update public.tenant_cost_rollups
set recognized_subscription_cents = greatest(recognized_subscription_cents, 0),
    model_cents = case when model_cents is null then null else greatest(model_cents, 0) end,
    messaging_cents = case when messaging_cents is null then null else greatest(messaging_cents, 0) end,
    embedding_cents = case when embedding_cents is null then null else greatest(embedding_cents, 0) end
where recognized_subscription_cents < 0
   or model_cents < 0
   or messaging_cents < 0
   or embedding_cents < 0;

update public.tenant_cost_rollups
set total_cost_cents = model_cents + messaging_cents + embedding_cents
where complete
  and model_cents is not null
  and messaging_cents is not null
  and embedding_cents is not null
  and total_cost_cents is distinct from model_cents + messaging_cents + embedding_cents;

update public.tenant_cost_rollups
set complete = false,
    total_cost_cents = null,
    missing_sources = array_remove(array[
      case when model_cents is null then 'model' end,
      case when messaging_cents is null then 'messaging' end,
      case when embedding_cents is null then 'embedding' end
    ], null)
where complete
  and (model_cents is null or messaging_cents is null or embedding_cents is null);

update public.message_traces
set latency_ms = greatest(latency_ms, 0)
where latency_ms < 0;

update public.message_traces
set cost = greatest(cost, 0)
where cost < 0;

update public.message_traces
set usage = (
  select jsonb_object_agg(
    key,
    case
      when jsonb_typeof(value) = 'number' and (value #>> '{}')::numeric < 0 then '0'::jsonb
      else value
    end
  )
  from jsonb_each(usage)
)
where usage is not null
  and jsonb_path_exists(usage, '$.* ? (@.type() == "number" && @ < 0)');

-- Protects PLATFORM_PROVISIONING_ROWS_INVALID.
alter table public.provisioning_steps
  add constraint measurement_provisioning_time_order_chk
    check (completed_at is null or started_at is null or completed_at >= started_at) not valid,
  add constraint measurement_provisioning_attempts_nonnegative_chk
    check (attempts >= 0) not valid;

-- Protects PLATFORM_FOLLOWUP_ROWS_INVALID.
alter table public.followups
  add constraint measurement_followups_touch_no_chk
    check (touch_no >= 1) not valid;

-- Protects MEASUREMENT_COUNT_INVALID for platform.time_to_live.
alter table public.onboarding_runs
  add constraint measurement_onboarding_time_order_chk
    check (went_live_at is null or went_live_at >= started_at) not valid;

-- Protects PLATFORM_MARGIN_EVIDENCE_INCOMPLETE.
alter table public.tenant_cost_rollups
  add constraint measurement_cost_rollups_nonnegative_cents_chk
    check (
      recognized_subscription_cents >= 0
      and coalesce(model_cents, 0) >= 0
      and coalesce(messaging_cents, 0) >= 0
      and coalesce(embedding_cents, 0) >= 0
      and coalesce(total_cost_cents, 0) >= 0
    ) not valid,
  add constraint measurement_cost_rollups_complete_total_chk
    check (
      not complete
      or (
        model_cents is not null
        and messaging_cents is not null
        and embedding_cents is not null
        and total_cost_cents is not null
        and total_cost_cents = model_cents + messaging_cents + embedding_cents
      )
    ) not valid;

-- Protects PLATFORM_GUARDRAIL_ROWS_INVALID.
alter table public.message_traces
  add constraint measurement_message_traces_latency_nonnegative_chk
    check (latency_ms is null or latency_ms >= 0) not valid,
  add constraint measurement_message_traces_cost_nonnegative_chk
    check (cost is null or cost >= 0) not valid,
  add constraint measurement_message_traces_usage_nonnegative_chk
    check (
      usage is null
      or not jsonb_path_exists(usage, '$.* ? (@.type() == "number" && @ < 0)')
    ) not valid;

alter table public.provisioning_steps
  validate constraint measurement_provisioning_time_order_chk,
  validate constraint measurement_provisioning_attempts_nonnegative_chk;

alter table public.followups
  validate constraint measurement_followups_touch_no_chk;

alter table public.onboarding_runs
  validate constraint measurement_onboarding_time_order_chk;

alter table public.tenant_cost_rollups
  validate constraint measurement_cost_rollups_nonnegative_cents_chk,
  validate constraint measurement_cost_rollups_complete_total_chk;

alter table public.message_traces
  validate constraint measurement_message_traces_latency_nonnegative_chk,
  validate constraint measurement_message_traces_cost_nonnegative_chk,
  validate constraint measurement_message_traces_usage_nonnegative_chk;
