-- Durable, value-free history for changes to coach-owned offer drafts and publications.
set search_path = public, extensions;

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('offer.changed', 'human', 'tenant', false, true,
    'Offer field change logged', 'Changed offer fields recorded in the audit log'),
  ('offer.draft.saved', 'human', 'tenant', false, true,
    'Offer draft save logged', 'Offer draft save recorded in the audit log')
on conflict (key) do nothing;

create table public.offer_change_trail (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  offer_id uuid not null,
  actor_id uuid not null references public.users(id) on delete restrict,
  event text not null check (event in ('draft_saved', 'published')),
  changed_keys text[] not null default '{}',
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  audit_id bigint not null references public.audit_log(id) on delete restrict,
  change_audit_id bigint references public.audit_log(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (offer_id, tenant_id) references public.offer_layers(id, tenant_id) on delete restrict
);
create index offer_change_trail_offer_created_idx
  on public.offer_change_trail (tenant_id, offer_id, created_at desc, id desc);

create function app.reject_offer_change_trail_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'OFFER_CHANGE_TRAIL_APPEND_ONLY';
end;
$$;
create trigger offer_change_trail_reject_mutation
before update or delete on public.offer_change_trail
for each row execute function app.reject_offer_change_trail_mutation();

alter table public.offer_change_trail enable row level security;
alter table public.offer_change_trail force row level security;
revoke all on public.offer_change_trail from public, anon, authenticated;
grant select on public.offer_change_trail to service_role;
create policy offer_change_trail_service_read on public.offer_change_trail
  for select to service_role using (true);

-- Compares the stored revision against the normalized request shape before the write mutates it.
-- The result contains field names only; sensitive values remain in their original offer tables.
create function app.offer_change_keys(p_prior public.offer_layers, p_offer jsonb)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  stored_prices jsonb;
  incoming_prices jsonb;
  stored_proof jsonb;
  incoming_proof jsonb;
  stored_assets jsonb;
  incoming_assets jsonb;
  stored_cadence jsonb;
  incoming_cadence jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'label', price.label, 'amountCents', price.amount_cents, 'billingPeriod', price.billing_period
  ) order by price.label, price.amount_cents, price.billing_period nulls first), '[]'::jsonb)
  into stored_prices
  from public.offer_prices as price
  where price.offer_id = p_prior.id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'label', item.value ->> 'label', 'amountCents', item.value -> 'amountCents',
    'billingPeriod', item.value -> 'billingPeriod'
  ) order by item.value ->> 'label', item.value -> 'amountCents', item.value -> 'billingPeriod'), '[]'::jsonb)
  into incoming_prices
  from jsonb_array_elements(coalesce(p_offer -> 'prices', '[]'::jsonb)) as item(value);

  select coalesce(jsonb_agg(jsonb_build_object('title', proof_entry.title, 'detail', proof_entry.detail)
    order by proof_entry.title, proof_entry.detail), '[]'::jsonb)
  into stored_proof
  from public.offer_proof_entries as proof_entry
  where proof_entry.offer_id = p_prior.id;
  select coalesce(jsonb_agg(jsonb_build_object('title', item.value ->> 'title', 'detail', item.value ->> 'detail')
    order by item.value ->> 'title', item.value ->> 'detail'), '[]'::jsonb)
  into incoming_proof
  from jsonb_array_elements(coalesce(p_offer -> 'proof', '[]'::jsonb)) as item(value);

  select coalesce(jsonb_agg(jsonb_build_object(
    'slug', asset.slug, 'label', asset.label, 'url', asset.url
  ) order by asset.slug, asset.label, asset.url), '[]'::jsonb)
  into stored_assets
  from public.offer_assets as asset
  where asset.offer_id = p_prior.id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'slug', item.value ->> 'slug', 'label', item.value ->> 'label', 'url', item.value ->> 'url'
  ) order by item.value ->> 'slug', item.value ->> 'label', item.value ->> 'url'), '[]'::jsonb)
  into incoming_assets
  from jsonb_array_elements(coalesce(p_offer -> 'assets', '[]'::jsonb)) as item(value);

  select coalesce(jsonb_agg(jsonb_build_object(
    'channelClass', cadence.channel_class, 'touchNo', cadence.touch_no,
    'purpose', cadence.purpose, 'assetId', cadence.asset_id
  ) order by cadence.channel_class, cadence.touch_no, cadence.purpose, cadence.asset_id nulls first), '[]'::jsonb)
  into stored_cadence
  from public.offer_cadence_purposes as cadence
  where cadence.offer_id = p_prior.id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'channelClass', item.value -> 'channelClass', 'touchNo', item.value -> 'touchNo',
    'purpose', item.value -> 'purpose', 'assetId', item.value -> 'assetId'
  ) order by item.value -> 'channelClass', item.value -> 'touchNo', item.value -> 'purpose', item.value -> 'assetId'), '[]'::jsonb)
  into incoming_cadence
  from jsonb_array_elements(coalesce(p_offer -> 'cadencePurposes', '[]'::jsonb)) as item(value);

  return array_remove(array[
    case when p_prior.program_name is distinct from nullif(btrim(p_offer ->> 'programName'), '') then 'programName' end,
    case when p_prior.program_description is distinct from nullif(btrim(p_offer ->> 'programDescription'), '') then 'programDescription' end,
    case when p_prior.credit_min is distinct from nullif(p_offer ->> 'creditMin', '')::int then 'creditMin' end,
    case when p_prior.funding_goal_min_cents is distinct from nullif(p_offer ->> 'fundingGoalMinCents', '')::bigint then 'fundingGoalMinCents' end,
    case when p_prior.funding_goal_max_cents is distinct from nullif(p_offer ->> 'fundingGoalMaxCents', '')::bigint then 'fundingGoalMaxCents' end,
    case when p_prior.monthly_revenue_min_cents is distinct from nullif(p_offer ->> 'monthlyRevenueMinCents', '')::bigint then 'monthlyRevenueMinCents' end,
    case when p_prior.products is distinct from array(select product.value from jsonb_array_elements_text(coalesce(p_offer -> 'products', '[]'::jsonb)) as product(value) order by product.value) then 'products' end,
    case when p_prior.credit_repair is distinct from nullif(p_offer ->> 'creditRepair', '') then 'creditRepair' end,
    case when p_prior.booking_horizon_days is distinct from coalesce(nullif(p_offer ->> 'bookingHorizonDays', '')::int, 21) then 'bookingHorizonDays' end,
    case when p_prior.booking_mode is distinct from coalesce(nullif(p_offer ->> 'bookingMode', ''), 'direct') then 'bookingMode' end,
    case when p_prior.brand_voice is distinct from nullif(p_offer ->> 'brandVoice', '') then 'brandVoice' end,
    case when p_prior.results_timeline_min_days is distinct from nullif(p_offer ->> 'resultsTimelineMinDays', '')::int then 'resultsTimelineMinDays' end,
    case when p_prior.results_timeline_max_days is distinct from nullif(p_offer ->> 'resultsTimelineMaxDays', '')::int then 'resultsTimelineMaxDays' end,
    case when p_prior.refund_posture is distinct from nullif(p_offer ->> 'refundPosture', '') then 'refundPosture' end,
    case when p_prior.voice_style_answer is distinct from nullif(btrim(p_offer ->> 'voiceStyleAnswer'), '') then 'voiceStyleAnswer' end,
    case when p_prior.voice_objection_answer is distinct from nullif(btrim(p_offer ->> 'voiceObjectionAnswer'), '') then 'voiceObjectionAnswer' end,
    case when p_prior.voice_followup_answer is distinct from nullif(btrim(p_offer ->> 'voiceFollowupAnswer'), '') then 'voiceFollowupAnswer' end,
    case when stored_prices is distinct from incoming_prices then 'prices' end,
    case when stored_proof is distinct from incoming_proof then 'proof' end,
    case when stored_assets is distinct from incoming_assets then 'assets' end,
    case when stored_cadence is distinct from incoming_cadence then 'cadencePurposes' end
  ], null);
end;
$$;

create or replace function public.save_offer_draft(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_draft_id uuid,
  p_expected_content_hash text,
  p_offer jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  draft public.offer_layers%rowtype;
  unknown_key text;
  next_version int;
  price jsonb;
  proof jsonb;
  asset jsonb;
  purpose jsonb;
  asset_host text;
  allowed_hosts text[];
  changed_keys text[];
  saved_audit_id bigint;
  changed_audit_id bigint;
begin
  perform app.assert_not_impersonating();
  if not exists (
    select 1 from public.users as actor
    where actor.id = p_actor_id
      and (actor.tenant_id = p_expected_tenant or actor.role in ('owner', 'admin', 'success'))
  ) then raise exception 'OFFER_ACTOR_NOT_AUTHORIZED'; end if;
  if jsonb_typeof(p_offer) <> 'object' then raise exception 'OFFER_PAYLOAD_INVALID'; end if;
  select key into unknown_key from jsonb_object_keys(p_offer) as key
  where key not in (
    'programName', 'programDescription', 'creditMin', 'fundingGoalMinCents',
    'fundingGoalMaxCents', 'monthlyRevenueMinCents', 'products', 'creditRepair',
    'bookingHorizonDays', 'bookingMode', 'brandVoice', 'resultsTimelineMinDays',
    'resultsTimelineMaxDays', 'refundPosture', 'voiceStyleAnswer',
    'voiceObjectionAnswer', 'voiceFollowupAnswer', 'prices', 'proof', 'assets',
    'cadencePurposes', 'contentHash'
  ) limit 1;
  if unknown_key is not null then raise exception 'OFFER_PLATFORM_FIELD_FORBIDDEN:%', unknown_key; end if;
  if p_draft_id is not null then
    select * into draft from public.offer_layers as offer
    where offer.id = p_draft_id and offer.status = 'draft' for update;
    if draft.id is null then raise exception 'OFFER_DRAFT_NOT_FOUND'; end if;
    perform app.assert_expected_tenant(p_expected_tenant, draft.tenant_id, 'offer_draft');
    if draft.content_hash is distinct from p_expected_content_hash then raise exception 'OFFER_DRAFT_STALE'; end if;
  else
    if exists (select 1 from public.offer_layers as offer where offer.tenant_id = p_expected_tenant and offer.status = 'draft') then raise exception 'OFFER_DRAFT_ALREADY_EXISTS'; end if;
    select coalesce(max(offer.version), 0) + 1 into next_version from public.offer_layers as offer where offer.tenant_id = p_expected_tenant;
    insert into public.offer_layers (tenant_id, id, status, version)
    values (p_expected_tenant, gen_random_uuid(), 'draft', next_version) returning * into draft;
  end if;

  if jsonb_typeof(coalesce(p_offer -> 'prices', '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_offer -> 'prices', '[]'::jsonb)) > 8 then raise exception 'OFFER_PRICE_CAP_EXCEEDED'; end if;
  if jsonb_typeof(coalesce(p_offer -> 'proof', '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_offer -> 'proof', '[]'::jsonb)) > 12 then raise exception 'OFFER_PROOF_CAP_EXCEEDED'; end if;
  if jsonb_typeof(coalesce(p_offer -> 'assets', '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_offer -> 'assets', '[]'::jsonb)) > 12 then raise exception 'OFFER_ASSET_CAP_EXCEEDED'; end if;

  changed_keys := app.offer_change_keys(draft, p_offer);
  update public.offer_layers as offer set
    program_name = nullif(btrim(p_offer ->> 'programName'), ''),
    program_description = nullif(btrim(p_offer ->> 'programDescription'), ''),
    credit_min = nullif(p_offer ->> 'creditMin', '')::int,
    funding_goal_min_cents = nullif(p_offer ->> 'fundingGoalMinCents', '')::bigint,
    funding_goal_max_cents = nullif(p_offer ->> 'fundingGoalMaxCents', '')::bigint,
    monthly_revenue_min_cents = nullif(p_offer ->> 'monthlyRevenueMinCents', '')::bigint,
    products = coalesce(array(select product.value from jsonb_array_elements_text(coalesce(p_offer -> 'products', '[]'::jsonb)) as product(value) order by product.value), '{}'),
    credit_repair = nullif(p_offer ->> 'creditRepair', ''),
    booking_horizon_days = coalesce(nullif(p_offer ->> 'bookingHorizonDays', '')::int, 21),
    booking_mode = coalesce(nullif(p_offer ->> 'bookingMode', ''), 'direct'),
    brand_voice = nullif(p_offer ->> 'brandVoice', ''),
    results_timeline_min_days = nullif(p_offer ->> 'resultsTimelineMinDays', '')::int,
    results_timeline_max_days = nullif(p_offer ->> 'resultsTimelineMaxDays', '')::int,
    refund_posture = nullif(p_offer ->> 'refundPosture', ''),
    voice_style_answer = nullif(btrim(p_offer ->> 'voiceStyleAnswer'), ''),
    voice_objection_answer = nullif(btrim(p_offer ->> 'voiceObjectionAnswer'), ''),
    voice_followup_answer = nullif(btrim(p_offer ->> 'voiceFollowupAnswer'), ''),
    content_hash = nullif(p_offer ->> 'contentHash', ''), updated_at = now()
  where offer.id = draft.id;

  delete from public.offer_prices as stored_price where stored_price.offer_id = draft.id;
  for price in select item.value from jsonb_array_elements(coalesce(p_offer -> 'prices', '[]'::jsonb)) as item(value) loop
    insert into public.offer_prices (offer_id, tenant_id, label, amount_cents, billing_period)
    values (draft.id, p_expected_tenant, price ->> 'label', (price ->> 'amountCents')::bigint, nullif(price ->> 'billingPeriod', ''));
  end loop;
  delete from public.offer_proof_entries as stored_proof where stored_proof.offer_id = draft.id;
  for proof in select item.value from jsonb_array_elements(coalesce(p_offer -> 'proof', '[]'::jsonb)) as item(value) loop
    insert into public.offer_proof_entries (offer_id, tenant_id, title, detail)
    values (draft.id, p_expected_tenant, proof ->> 'title', proof ->> 'detail');
  end loop;
  select settings.link_whitelist into allowed_hosts from public.tenant_settings as settings where settings.tenant_id = p_expected_tenant;
  delete from public.offer_assets as stored_asset where stored_asset.offer_id = draft.id;
  for asset in select item.value from jsonb_array_elements(coalesce(p_offer -> 'assets', '[]'::jsonb)) as item(value) loop
    asset_host := lower(regexp_replace(asset ->> 'url', '^https://([^/]+).*$','\\1'));
    if allowed_hosts is null or not exists (select 1 from unnest(allowed_hosts) as allowed where asset_host = lower(allowed) or asset_host like '%.' || lower(allowed)) then raise exception 'OFFER_ASSET_HOST_NOT_WHITELISTED'; end if;
    insert into public.offer_assets (offer_id, tenant_id, slug, label, url)
    values (draft.id, p_expected_tenant, asset ->> 'slug', asset ->> 'label', asset ->> 'url');
  end loop;
  delete from public.offer_cadence_purposes as stored_purpose where stored_purpose.offer_id = draft.id;
  for purpose in select item.value from jsonb_array_elements(coalesce(p_offer -> 'cadencePurposes', '[]'::jsonb)) as item(value) loop
    insert into public.offer_cadence_purposes (tenant_id, offer_id, channel_class, touch_no, purpose, asset_id)
    values (p_expected_tenant, draft.id, (purpose ->> 'channelClass')::public.cadence_channel_class,
      (purpose ->> 'touchNo')::int, (purpose ->> 'purpose')::public.followup_purpose, nullif(purpose ->> 'assetId', ''));
  end loop;

  saved_audit_id := app.write_audit_row('offer.draft.saved', p_actor_id, p_expected_tenant, 'offer_layer', draft.id::text,
    null, jsonb_build_object('content_hash', nullif(p_offer ->> 'contentHash', ''), 'changed_keys', to_jsonb(changed_keys)));
  if cardinality(changed_keys) > 0 then
    changed_audit_id := app.write_audit_row('offer.changed', p_actor_id, p_expected_tenant, 'offer_layer', draft.id::text,
      null, jsonb_build_object('event', 'draft_saved', 'content_hash', nullif(p_offer ->> 'contentHash', ''), 'changed_keys', to_jsonb(changed_keys)));
  end if;
  insert into public.offer_change_trail (tenant_id, offer_id, actor_id, event, changed_keys, content_hash, audit_id, change_audit_id)
  values (p_expected_tenant, draft.id, p_actor_id, 'draft_saved', changed_keys,
    nullif(p_offer ->> 'contentHash', ''), saved_audit_id, changed_audit_id);
  return draft.id;
end;
$$;

create or replace function public.publish_offer_draft(
  p_expected_tenant uuid, p_actor_id uuid, p_draft_id uuid, p_expected_content_hash text
)
returns table (offer_id uuid, offer_version int, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  draft public.offer_layers%rowtype;
  prior public.offer_layers%rowtype;
  written_audit_id bigint;
  changed_audit_id bigint;
begin
  perform app.assert_not_impersonating();
  if not exists (select 1 from public.users as actor where actor.id = p_actor_id
    and (actor.tenant_id = p_expected_tenant or actor.role in ('owner', 'admin', 'success'))) then raise exception 'OFFER_ACTOR_NOT_AUTHORIZED'; end if;
  select * into draft from public.offer_layers as offer where offer.id = p_draft_id and offer.status = 'draft' for update;
  if draft.id is null then raise exception 'OFFER_DRAFT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, draft.tenant_id, 'offer_draft');
  if draft.content_hash is null or draft.content_hash <> p_expected_content_hash then raise exception 'OFFER_DRAFT_HASH_MISMATCH'; end if;
  select * into prior from public.offer_layers as offer where offer.tenant_id = p_expected_tenant and offer.status = 'published' for update;
  if prior.id is not null then update public.offer_layers as offer set status = 'superseded', updated_at = now() where offer.id = prior.id; end if;
  update public.offer_layers as offer set status = 'published', published_at = now(), updated_at = now() where offer.id = draft.id;
  written_audit_id := app.write_audit_row('offer.published', p_actor_id, p_expected_tenant, 'offer_layer', draft.id::text, null,
    jsonb_build_object('prior', case when prior.id is null then null else jsonb_build_object('id', prior.id, 'version', prior.version, 'content_hash', prior.content_hash) end,
      'new', jsonb_build_object('id', draft.id, 'version', draft.version, 'content_hash', draft.content_hash)));
  changed_audit_id := app.write_audit_row('offer.changed', p_actor_id, p_expected_tenant, 'offer_layer', draft.id::text, null,
    jsonb_build_object('event', 'published', 'content_hash', draft.content_hash, 'changed_keys', jsonb_build_array('status')));
  insert into public.offer_change_trail (tenant_id, offer_id, actor_id, event, changed_keys, content_hash, audit_id, change_audit_id)
  values (p_expected_tenant, draft.id, p_actor_id, 'published', array['status'], draft.content_hash, written_audit_id, changed_audit_id);
  return query select draft.id, draft.version, written_audit_id;
  return;
end;
$$;

create function public.list_offer_change_trail(
  p_expected_tenant uuid, p_actor_id uuid, p_offer_id uuid
)
returns table (
  change_id uuid, event text, changed_keys text[], content_hash text, changed_at timestamptz,
  actor_id uuid, actor_name text, audit_id bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.users%rowtype;
  offer public.offer_layers%rowtype;
begin
  perform app.assert_not_impersonating();
  select * into actor from public.users as workspace_user where workspace_user.id = p_actor_id;
  if actor.id is null or not (actor.tenant_id = p_expected_tenant or actor.role in ('owner', 'admin', 'success')) then raise exception 'OFFER_ACTOR_NOT_AUTHORIZED'; end if;
  select * into offer from public.offer_layers as offer_layer where offer_layer.id = p_offer_id for key share;
  if offer.id is null then raise exception 'OFFER_CHANGE_TRAIL_OFFER_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, offer.tenant_id, 'offer_change_trail');
  return query
  select trail.id, trail.event, trail.changed_keys, trail.content_hash, trail.created_at,
    trail.actor_id, actor_user.full_name, trail.audit_id
  from public.offer_change_trail as trail
  join public.users as actor_user on actor_user.id = trail.actor_id
  where trail.tenant_id = p_expected_tenant and trail.offer_id = p_offer_id
  order by trail.created_at desc, trail.id desc;
  return;
end;
$$;

revoke execute on function app.reject_offer_change_trail_mutation() from public, anon, authenticated;
revoke execute on function app.offer_change_keys(public.offer_layers, jsonb) from public, anon, authenticated;
revoke execute on function public.save_offer_draft(uuid,uuid,uuid,text,jsonb) from public, anon, authenticated;
revoke execute on function public.publish_offer_draft(uuid,uuid,uuid,text) from public, anon, authenticated;
revoke execute on function public.list_offer_change_trail(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.save_offer_draft(uuid,uuid,uuid,text,jsonb) to service_role;
grant execute on function public.publish_offer_draft(uuid,uuid,uuid,text) to service_role;
grant execute on function public.list_offer_change_trail(uuid,uuid,uuid) to service_role;
