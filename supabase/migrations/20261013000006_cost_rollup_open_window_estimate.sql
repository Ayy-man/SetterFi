-- Cost roll-ups for an open billing period are running estimates.
--
-- The nightly billing-cost-rollup job recomputes model cost from message_traces for the
-- subscription's current period. On any tenant whose traces keep accumulating, the second night
-- produces a different figure for the same window, and the write RPC treated that as a replay
-- mismatch, so the job failed every night after the first. The table keeps one row per
-- (tenant, window_start, window_end): the margin projection and the analytics history both read
-- one row per window, so a second row per recompute would double count. The row is therefore
-- rewritten in place while the period is open, and `computed_at` records the last computation.
--
-- The rule is anchored on the stored row, not the clock: a row whose `computed_at` precedes its
-- `window_end` was computed while the period was still open and is an estimate that any later
-- computation may replace. Once a row has been computed at or after `window_end` it is final, and
-- the replay guard from Phase 6 still refuses a later write with different figures.

create or replace function public.write_tenant_cost_rollup(
  p_expected_tenant uuid,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_recognized_subscription_cents bigint,
  p_model_cents bigint,
  p_messaging_cents bigint,
  p_embedding_cents bigint,
  p_missing_sources text[],
  p_source_evidence jsonb
)
returns table (rollup_id uuid, complete boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  tenant_row public.tenants%rowtype;
  existing public.tenant_cost_rollups%rowtype;
  new_id uuid := gen_random_uuid();
  missing text[] := coalesce(p_missing_sources, '{}'::text[]);
  model_value bigint := p_model_cents;
  messaging_value bigint := p_messaging_cents;
  embedding_value bigint := p_embedding_cents;
  evidence jsonb := coalesce(p_source_evidence, '{}'::jsonb);
  is_complete boolean;
  total bigint;
begin
  perform app.assert_not_impersonating();
  select * into tenant_row from public.tenants where id = p_expected_tenant for update;
  if tenant_row.id is null then raise exception 'PHASE6_TENANT_NOT_FOUND'; end if;
  if p_window_start is null or p_window_end <= p_window_start
    or p_recognized_subscription_cents < 0
    or coalesce(p_model_cents, 0) < 0 or coalesce(p_messaging_cents, 0) < 0
    or coalesce(p_embedding_cents, 0) < 0 then
    raise exception 'COST_ROLLUP_INPUT_INVALID';
  end if;
  if not tenant_row.is_demo then
    messaging_value := null;
    embedding_value := null;
    missing := array_append(missing, 'messaging');
    missing := array_append(missing, 'embedding');
  end if;
  if model_value is null then missing := array_append(missing, 'model'); end if;
  if messaging_value is null then missing := array_append(missing, 'messaging'); end if;
  if embedding_value is null then missing := array_append(missing, 'embedding'); end if;
  select coalesce(array_agg(distinct source order by source), '{}'::text[])
  into missing from unnest(missing) source where nullif(btrim(source), '') is not null;
  is_complete := cardinality(missing) = 0
    and model_value is not null and messaging_value is not null and embedding_value is not null;
  total := case when is_complete then model_value + messaging_value + embedding_value else null end;
  select * into existing from public.tenant_cost_rollups
  where tenant_id = p_expected_tenant and window_start = p_window_start and window_end = p_window_end
  for update;
  if existing.id is not null then
    if existing.computed_at < existing.window_end then
      -- A running estimate: replace it with the newer computation and stamp when that happened.
      update public.tenant_cost_rollups set
        recognized_subscription_cents = p_recognized_subscription_cents,
        model_cents = model_value,
        messaging_cents = messaging_value,
        embedding_cents = embedding_value,
        total_cost_cents = total,
        complete = is_complete,
        missing_sources = missing,
        source_evidence = evidence,
        computed_at = now()
      where id = existing.id;
      return query select existing.id, is_complete;
      return;
    end if;
    -- A final figure for a closed period: an identical replay is idempotent, anything else is
    -- a mismatch and is refused rather than silently rewriting settled evidence.
    if existing.recognized_subscription_cents is distinct from p_recognized_subscription_cents
      or existing.model_cents is distinct from model_value
      or existing.messaging_cents is distinct from messaging_value
      or existing.embedding_cents is distinct from embedding_value
      or existing.missing_sources is distinct from missing
      or existing.source_evidence is distinct from evidence then
      raise exception 'COST_ROLLUP_REPLAY_MISMATCH';
    end if;
    return query select existing.id, existing.complete;
    return;
  end if;
  insert into public.tenant_cost_rollups (
    id, tenant_id, window_start, window_end, recognized_subscription_cents,
    model_cents, messaging_cents, embedding_cents, total_cost_cents,
    complete, missing_sources, source_evidence
  ) values (
    new_id, p_expected_tenant, p_window_start, p_window_end,
    p_recognized_subscription_cents, model_value, messaging_value, embedding_value,
    total, is_complete, missing, evidence
  );
  return query select new_id, is_complete;
end;
$$;

comment on column public.tenant_cost_rollups.computed_at is
  'When this row was last computed. Before window_end the row is a running estimate the nightly job rewrites; at or after window_end it is final and replay-guarded.';
