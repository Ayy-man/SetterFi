-- Phase 13: durable keyword goals, first-touch DM ad attribution, and the Meta CAPI custody tables.
-- Provider delivery and source-transition enqueue functions are appended later in this migration;
-- this first section establishes the additive data and privilege contract they depend on.

set search_path = public, extensions;

create type public.keyword_goal_mode as enum ('resource', 'book');

create function app.normalize_keyword(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(normalize(btrim(value), NFC));
$$;

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('keyword_goal.saved', 'human', 'tenant', false, true,
    'Keyword goal saved', 'Keyword goal change recorded in the audit log'),
  ('keyword_goal.deactivated', 'human', 'tenant', false, true,
    'Keyword goal deactivation logged', 'Keyword goal deactivation recorded in the audit log'),
  ('capi.dataset.provisioned', 'human', 'tenant', false, true,
    'Conversion tracking setup logged', 'Conversion tracking dataset setup recorded in the audit log'),
  ('capi.event.sent', 'system', 'tenant', false, false,
    'Conversion event send logged', 'Meta conversion event send recorded in the audit log')
on conflict (key) do nothing;

create table public.keyword_goals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  keyword text not null check (char_length(btrim(keyword)) between 1 and 120),
  normalized_keyword text generated always as (app.normalize_keyword(keyword)) stored,
  goal public.keyword_goal_mode not null,
  resource_url text,
  resource_message text check (resource_message is null or char_length(resource_message) <= 1000),
  post_booking_url text,
  post_booking_message text check (
    post_booking_message is null or char_length(post_booking_message) <= 1000
  ),
  active boolean not null default true,
  created_by uuid not null references public.users(id) on delete restrict,
  updated_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint keyword_goals_tenant_normalized_keyword_key unique (tenant_id, normalized_keyword),
  constraint keyword_goals_goal_shape_chk check (
    (goal = 'resource' and resource_url is not null)
    or (goal = 'book' and resource_url is null and resource_message is null)
  ),
  constraint keyword_goals_resource_url_chk check (
    resource_url is null or resource_url ~* '^https://[^[:space:]]+$'
  ),
  constraint keyword_goals_post_booking_url_chk check (
    post_booking_url is null or post_booking_url ~* '^https://[^[:space:]]+$'
  )
);
create index keyword_goals_tenant_active_idx
  on public.keyword_goals (tenant_id, active, normalized_keyword, id);
create trigger set_keyword_goals_updated_at before update on public.keyword_goals
for each row execute function app.set_updated_at();

alter table public.conversations
  add column keyword_goal_id uuid references public.keyword_goals(id) on delete set null,
  add column ad_id text check (ad_id is null or char_length(ad_id) between 1 and 255),
  add column ad_source text check (ad_source is null or ad_source = 'ADS'),
  add column ad_ref text check (ad_ref is null or char_length(ad_ref) between 1 and 500),
  add column ctwa_clid text check (ctwa_clid is null or char_length(ctwa_clid) between 1 and 500),
  add column ads_context_data jsonb not null default '{}'::jsonb check (
    jsonb_typeof(ads_context_data) = 'object'
    and octet_length(ads_context_data::text) <= 2048
    and ads_context_data - array['adTitle', 'postId']::text[] = '{}'::jsonb
  ),
  add column ad_attribution_captured_at timestamptz,
  add constraint conversations_ad_attribution_shape_chk check (
    (ad_attribution_captured_at is null
      and ad_id is null and ad_source is null and ad_ref is null and ctwa_clid is null
      and ads_context_data = '{}'::jsonb)
    or
    (ad_attribution_captured_at is not null
      and (ad_id is not null or ad_source is not null or ad_ref is not null
        or ctwa_clid is not null or ads_context_data <> '{}'::jsonb))
  ),
  add constraint conversations_ad_channel_shape_chk check (
    (channel = 'whatsapp' and ad_id is null and ad_source is null and ad_ref is null
      and ads_context_data = '{}'::jsonb)
    or (channel in ('messenger', 'instagram') and ctwa_clid is null)
    or (channel not in ('messenger', 'instagram', 'whatsapp')
      and ad_id is null and ad_source is null and ad_ref is null and ctwa_clid is null
      and ads_context_data = '{}'::jsonb)
  );
create index conversations_keyword_goal_idx
  on public.conversations (tenant_id, keyword_goal_id) where keyword_goal_id is not null;
create index conversations_ad_id_idx
  on public.conversations (tenant_id, ad_id) where ad_id is not null;

create table public.capi_datasets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  channel public.messaging_channel not null check (channel in ('messenger', 'instagram', 'whatsapp')),
  channel_connection_id uuid not null references public.channel_connections(id) on delete cascade,
  source_asset_id text not null check (char_length(btrim(source_asset_id)) between 1 and 255),
  dataset_id text check (dataset_id is null or char_length(btrim(dataset_id)) between 1 and 255),
  status text not null default 'not_set_up'
    check (status in ('not_set_up', 'provisioning', 'connected', 'failed')),
  provider_receipt jsonb not null default '{}'::jsonb check (
    jsonb_typeof(provider_receipt) = 'object' and octet_length(provider_receipt::text) <= 4096
  ),
  is_mock boolean not null default false,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  provisioned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint capi_datasets_tenant_channel_key unique (tenant_id, channel),
  constraint capi_datasets_connection_key unique (channel_connection_id),
  constraint capi_datasets_status_shape_chk check (
    (status = 'connected' and dataset_id is not null and provisioned_at is not null
      and provider_receipt <> '{}'::jsonb and last_error is null)
    or (status = 'failed' and dataset_id is null and last_error is not null)
    or (status in ('not_set_up', 'provisioning') and dataset_id is null and provisioned_at is null)
  )
);
create index capi_datasets_tenant_status_idx
  on public.capi_datasets (tenant_id, status, channel);
create trigger set_capi_datasets_updated_at before update on public.capi_datasets
for each row execute function app.set_updated_at();

create table public.capi_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  dataset_id uuid references public.capi_datasets(id) on delete restrict,
  channel public.messaging_channel not null check (channel in ('messenger', 'instagram', 'whatsapp')),
  appointment_id uuid references public.appointments(id) on delete restrict,
  event_name text not null,
  dedup_key text not null,
  event_time timestamptz not null,
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  value numeric(14,2) check (value is null or value >= 0),
  status text not null default 'pending' check (
    status in ('pending', 'processing', 'retry', 'sent', 'terminal_failed', 'excluded_test', 'mock_sent')
  ),
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null default 8 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  claim_token uuid,
  claimed_until timestamptz,
  provider_receipt jsonb not null default '{}'::jsonb check (
    jsonb_typeof(provider_receipt) = 'object' and octet_length(provider_receipt::text) <= 8192
  ),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  sent_at timestamptz,
  is_test boolean not null default false,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint capi_events_event_name_chk check (event_name in ('QualifiedLead', 'Purchase')),
  constraint capi_events_conversation_event_key unique (conversation_id, event_name),
  constraint capi_events_dedup_key_key unique (dedup_key),
  constraint capi_events_dedup_shape_chk check (
    dedup_key = conversation_id::text || ':' || event_name
  ),
  constraint capi_events_appointment_shape_chk check (
    (event_name = 'QualifiedLead' and appointment_id is null)
    or (event_name = 'Purchase' and appointment_id is not null)
  ),
  constraint capi_events_value_shape_chk check (
    (currency is null and value is null) or (currency is not null and value is not null)
  ),
  constraint capi_events_claim_shape_chk check (
    (claim_token is null and claimed_until is null and status <> 'processing')
    or (claim_token is not null and claimed_until is not null and status = 'processing')
  ),
  constraint capi_events_test_demo_status_chk check (
    (not is_test and not is_demo) or status = 'excluded_test'
  ),
  constraint capi_events_terminal_shape_chk check (
    (status in ('sent', 'mock_sent') and sent_at is not null and provider_receipt <> '{}'::jsonb
      and last_error is null)
    or (status = 'terminal_failed' and sent_at is null and last_error is not null)
    or (status = 'excluded_test' and sent_at is null)
    or (status in ('pending', 'processing', 'retry') and sent_at is null)
  )
);
create index capi_events_due_idx
  on public.capi_events (next_attempt_at, created_at, id)
  where status in ('pending', 'retry');
create index capi_events_tenant_created_idx
  on public.capi_events (tenant_id, created_at desc, id desc);
create trigger set_capi_events_updated_at before update on public.capi_events
for each row execute function app.set_updated_at();

create function app.enforce_keyword_goal_actor_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.phase4_assert_tenant_actor(new.tenant_id, new.created_by);
  perform app.phase4_assert_tenant_actor(new.tenant_id, new.updated_by);
  return new;
end;
$$;
create trigger keyword_goals_actor_tenant_guard
before insert or update of tenant_id, created_by, updated_by on public.keyword_goals
for each row execute function app.enforce_keyword_goal_actor_tenant();

create function app.enforce_conversation_first_touch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  goal_row public.keyword_goals%rowtype;
begin
  if tg_op = 'UPDATE' and old.first_touch_keyword is not null
    and new.first_touch_keyword is distinct from old.first_touch_keyword then
    raise exception 'CONVERSATION_FIRST_TOUCH_IMMUTABLE';
  end if;
  if tg_op = 'UPDATE' and old.keyword_goal_id is not null
    and new.keyword_goal_id is distinct from old.keyword_goal_id then
    raise exception 'CONVERSATION_KEYWORD_GOAL_IMMUTABLE';
  end if;
  if tg_op = 'UPDATE' and old.ad_attribution_captured_at is not null and (
    new.ad_id is distinct from old.ad_id or new.ad_source is distinct from old.ad_source
    or new.ad_ref is distinct from old.ad_ref or new.ctwa_clid is distinct from old.ctwa_clid
    or new.ads_context_data is distinct from old.ads_context_data
    or new.ad_attribution_captured_at is distinct from old.ad_attribution_captured_at
  ) then raise exception 'CONVERSATION_AD_ATTRIBUTION_IMMUTABLE'; end if;
  if new.keyword_goal_id is not null then
    select * into goal_row from public.keyword_goals where id = new.keyword_goal_id;
    if goal_row.id is null or goal_row.tenant_id <> new.tenant_id then
      raise exception 'CONVERSATION_KEYWORD_GOAL_TENANT_MISMATCH';
    end if;
    if new.first_touch_keyword is null
      or app.normalize_keyword(new.first_touch_keyword) <> goal_row.normalized_keyword then
      raise exception 'CONVERSATION_KEYWORD_GOAL_LABEL_MISMATCH';
    end if;
  end if;
  return new;
end;
$$;
create trigger conversations_first_touch_guard
before insert or update of first_touch_keyword, keyword_goal_id, ad_id, ad_source, ad_ref, ctwa_clid,
  ads_context_data, ad_attribution_captured_at, tenant_id, channel
on public.conversations
for each row execute function app.enforce_conversation_first_touch();

create function app.enforce_capi_dataset_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  connection public.channel_connections%rowtype;
begin
  select * into connection from public.channel_connections where id = new.channel_connection_id;
  if connection.id is null or connection.tenant_id <> new.tenant_id
    or connection.channel <> new.channel or connection.provider <> 'meta_direct' then
    raise exception 'CAPI_DATASET_CONNECTION_MISMATCH';
  end if;
  return new;
end;
$$;
create trigger capi_datasets_tenant_guard
before insert or update of tenant_id, channel, channel_connection_id on public.capi_datasets
for each row execute function app.enforce_capi_dataset_tenant();

create function app.enforce_capi_event_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation public.conversations%rowtype;
  dataset public.capi_datasets%rowtype;
  appointment public.appointments%rowtype;
begin
  select * into conversation from public.conversations where id = new.conversation_id;
  if conversation.id is null or conversation.tenant_id <> new.tenant_id
    or conversation.channel <> new.channel then
    raise exception 'CAPI_EVENT_CONVERSATION_MISMATCH';
  end if;
  if new.dataset_id is not null then
    select * into dataset from public.capi_datasets where id = new.dataset_id;
    if dataset.id is null or dataset.tenant_id <> new.tenant_id or dataset.channel <> new.channel then
      raise exception 'CAPI_EVENT_DATASET_MISMATCH';
    end if;
  end if;
  if new.appointment_id is not null then
    select * into appointment from public.appointments where id = new.appointment_id;
    if appointment.id is null or appointment.tenant_id <> new.tenant_id
      or appointment.conversation_id is distinct from new.conversation_id then
      raise exception 'CAPI_EVENT_APPOINTMENT_MISMATCH';
    end if;
  end if;
  return new;
end;
$$;
create trigger capi_events_tenant_guard
before insert or update of tenant_id, conversation_id, dataset_id, channel, appointment_id
on public.capi_events
for each row execute function app.enforce_capi_event_tenant();

alter table public.keyword_goals enable row level security;
alter table public.keyword_goals force row level security;
alter table public.capi_datasets enable row level security;
alter table public.capi_datasets force row level security;
alter table public.capi_events enable row level security;
alter table public.capi_events force row level security;

create policy keyword_goals_tenant_read on public.keyword_goals
  for select to authenticated using (app.owns_tenant(tenant_id));
create policy keyword_goals_service_read on public.keyword_goals
  for select to service_role using (true);
create policy capi_datasets_tenant_read on public.capi_datasets
  for select to authenticated using (app.owns_tenant(tenant_id));
create policy capi_datasets_service_read on public.capi_datasets
  for select to service_role using (true);
create policy capi_events_service_rpc on public.capi_events
  for select to service_role using (true);

revoke all on public.keyword_goals, public.capi_datasets, public.capi_events
  from public, anon, authenticated, service_role;
grant select on public.keyword_goals, public.capi_datasets to authenticated, service_role;

revoke execute on function app.enforce_keyword_goal_actor_tenant(),
  app.enforce_conversation_first_touch(), app.enforce_capi_dataset_tenant(),
  app.enforce_capi_event_tenant()
from public, anon, authenticated, service_role;

-- A provider call happens outside PostgreSQL, but its safe receipt, dataset read-back, and human
-- audit row commit together. The advisory lock makes two setup clicks converge on the same row;
-- a real receipt can never be overwritten by a mock run after the live flag is switched off.
create function public.provision_capi_dataset(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_channel public.messaging_channel,
  p_channel_connection_id uuid,
  p_source_asset_id text,
  p_dataset_id text,
  p_provider_receipt jsonb,
  p_is_mock boolean,
  p_now timestamptz
)
returns table (
  dataset_row_id uuid,
  tenant_id uuid,
  channel public.messaging_channel,
  channel_connection_id uuid,
  source_asset_id text,
  dataset_id text,
  status text,
  provider_receipt jsonb,
  is_mock boolean,
  provisioned_at timestamptz,
  updated_at timestamptz,
  audit_id bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  connection public.channel_connections%rowtype;
  current_dataset public.capi_datasets%rowtype;
  written_dataset public.capi_datasets%rowtype;
  written_audit_id bigint;
  expected_mode text := case when p_is_mock then 'mock' else 'real' end;
begin
  perform app.phase4_assert_tenant_actor(p_expected_tenant, p_actor_id);
  if p_channel not in ('messenger', 'instagram', 'whatsapp') then
    raise exception 'CAPI_DATASET_CHANNEL_INVALID';
  end if;
  if nullif(btrim(p_source_asset_id), '') is null or nullif(btrim(p_dataset_id), '') is null then
    raise exception 'CAPI_DATASET_IDENTIFIER_REQUIRED';
  end if;
  if p_now is null then raise exception 'CAPI_DATASET_TIME_REQUIRED'; end if;
  if jsonb_typeof(p_provider_receipt) <> 'object'
    or p_provider_receipt - array[
      'provider', 'mode', 'operation', 'receiptId', 'accepted'
    ]::text[] <> '{}'::jsonb
    or p_provider_receipt ->> 'provider' <> 'meta'
    or p_provider_receipt ->> 'mode' <> expected_mode
    or p_provider_receipt ->> 'operation' <> 'get_or_create'
    or p_provider_receipt ->> 'accepted' <> 'true'
    or nullif(btrim(p_provider_receipt ->> 'receiptId'), '') is null
    or char_length(p_provider_receipt ->> 'receiptId') > 200 then
    raise exception 'CAPI_DATASET_RECEIPT_INVALID';
  end if;

  select * into connection from public.channel_connections
  where id = p_channel_connection_id for share;
  if connection.id is null or connection.tenant_id <> p_expected_tenant
    or connection.channel <> p_channel or connection.provider <> 'meta_direct'
    or connection.state not in ('ready', 'live') then
    raise exception 'CAPI_DATASET_CONNECTION_MISMATCH';
  end if;
  if p_channel = 'whatsapp' then
    if coalesce(connection.external_ref ->> 'waba_id', connection.external_ref ->> 'wabaId')
      is distinct from btrim(p_source_asset_id) then
      raise exception 'CAPI_DATASET_SOURCE_ASSET_MISMATCH';
    end if;
  elsif connection.external_account_id is distinct from btrim(p_source_asset_id) then
    raise exception 'CAPI_DATASET_SOURCE_ASSET_MISMATCH';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_expected_tenant::text || ':capi_dataset:' || p_channel::text, 0
  ));
  select * into current_dataset from public.capi_datasets
  where capi_datasets.tenant_id = p_expected_tenant and capi_datasets.channel = p_channel
  for update;
  if current_dataset.id is not null and (
    current_dataset.channel_connection_id <> p_channel_connection_id
    or current_dataset.source_asset_id <> btrim(p_source_asset_id)
  ) then raise exception 'CAPI_DATASET_ASSET_MISMATCH'; end if;
  if current_dataset.id is not null and not current_dataset.is_mock and p_is_mock then
    raise exception 'CAPI_DATASET_REAL_DOWNGRADE_REFUSED';
  end if;

  insert into public.capi_datasets (
    tenant_id, channel, channel_connection_id, source_asset_id, dataset_id, status,
    provider_receipt, is_mock, last_error, provisioned_at, created_at, updated_at
  ) values (
    p_expected_tenant, p_channel, p_channel_connection_id, btrim(p_source_asset_id),
    btrim(p_dataset_id), 'connected', p_provider_receipt, p_is_mock, null, p_now, p_now, p_now
  )
  on conflict (tenant_id, channel) do update set
    dataset_id = excluded.dataset_id,
    status = 'connected',
    provider_receipt = excluded.provider_receipt,
    is_mock = excluded.is_mock,
    last_error = null,
    provisioned_at = excluded.provisioned_at,
    updated_at = excluded.updated_at
  returning * into written_dataset;

  written_audit_id := app.write_audit_row(
    'capi.dataset.provisioned', p_actor_id, p_expected_tenant,
    'capi_dataset', written_dataset.id::text, null,
    jsonb_build_object(
      'channel', p_channel,
      'connectionId', p_channel_connection_id,
      'sourceAssetId', btrim(p_source_asset_id),
      'datasetId', btrim(p_dataset_id),
      'providerMode', expected_mode,
      'receiptId', p_provider_receipt ->> 'receiptId'
    ), null, null, 'dashboard'
  );

  return query select
    written_dataset.id, written_dataset.tenant_id, written_dataset.channel,
    written_dataset.channel_connection_id, written_dataset.source_asset_id,
    written_dataset.dataset_id, written_dataset.status, written_dataset.provider_receipt,
    written_dataset.is_mock, written_dataset.provisioned_at, written_dataset.updated_at,
    written_audit_id;
end;
$$;

revoke all on function public.provision_capi_dataset(
  uuid,uuid,public.messaging_channel,uuid,text,text,jsonb,boolean,timestamptz
) from public, anon, authenticated;
grant execute on function public.provision_capi_dataset(
  uuid,uuid,public.messaging_channel,uuid,text,text,jsonb,boolean,timestamptz
) to service_role;

-- The prior thirteen-argument overload remains available to old workers. New callers use this
-- additive signature so the message, attribution, and exact keyword binding share one transaction.
create function public.persist_inbound_message(
  p_expected_tenant uuid,
  p_provider public.channel_provider,
  p_channel public.messaging_channel,
  p_provider_identity_id text,
  p_provider_account_id text,
  p_normalized_phone text,
  p_normalized_email text,
  p_provider_message_id text,
  p_body text,
  p_contact_name text,
  p_provider_window_observed_at timestamptz,
  p_provider_window_expires_at timestamptz,
  p_provider_window_source text,
  p_ad_id text,
  p_ad_source text,
  p_ad_ref text,
  p_ads_context_data jsonb,
  p_ctwa_clid text
)
returns table (
  contact_id uuid,
  conversation_id uuid,
  message_id uuid,
  message_inserted boolean,
  disclosure_pending boolean,
  provider_window_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  persisted record;
  matched_goal public.keyword_goals%rowtype;
  safe_context jsonb := coalesce(p_ads_context_data, '{}'::jsonb);
  has_attribution boolean;
begin
  perform app.assert_not_impersonating();
  if p_provider = 'ghl' and nullif(btrim(p_provider_account_id), '') is null then
    raise exception 'GHL_PROVIDER_ACCOUNT_ID_REQUIRED';
  end if;
  if p_provider <> 'ghl' and p_provider_account_id is not null then
    raise exception 'NON_GHL_PROVIDER_ACCOUNT_ID_FORBIDDEN';
  end if;
  if p_provider <> 'meta_direct' and (
    p_ad_id is not null or p_ad_source is not null or p_ad_ref is not null
    or p_ctwa_clid is not null or safe_context <> '{}'::jsonb
  ) then raise exception 'NON_META_ATTRIBUTION_FORBIDDEN'; end if;
  if jsonb_typeof(safe_context) <> 'object'
    or safe_context - array['adTitle', 'postId']::text[] <> '{}'::jsonb
    or octet_length(safe_context::text) > 2048 then
    raise exception 'INBOUND_ADS_CONTEXT_INVALID';
  end if;
  if p_ad_source is not null and p_ad_source <> 'ADS' then
    raise exception 'INBOUND_AD_SOURCE_INVALID';
  end if;
  if p_channel = 'whatsapp' and (
    p_ad_id is not null or p_ad_source is not null or p_ad_ref is not null
    or safe_context <> '{}'::jsonb
  ) then raise exception 'WHATSAPP_AD_ATTRIBUTION_INVALID'; end if;
  if p_channel in ('messenger', 'instagram') and p_ctwa_clid is not null then
    raise exception 'META_CLICK_ID_CHANNEL_INVALID';
  end if;
  if p_channel not in ('messenger', 'instagram', 'whatsapp') and (
    p_ad_id is not null or p_ad_source is not null or p_ad_ref is not null
    or p_ctwa_clid is not null or safe_context <> '{}'::jsonb
  ) then raise exception 'AD_ATTRIBUTION_CHANNEL_INVALID'; end if;

  perform set_config(
    'app.inbound_provider_account_id',
    coalesce(nullif(btrim(p_provider_account_id), ''), ''),
    true
  );
  select * into persisted from public.persist_inbound_message(
    p_expected_tenant, p_provider, p_channel, p_provider_identity_id,
    p_normalized_phone, p_normalized_email, p_provider_message_id, p_body,
    p_contact_name, p_provider_window_observed_at, p_provider_window_expires_at,
    p_provider_window_source
  );
  perform set_config('app.inbound_provider_account_id', '', true);

  if p_provider = 'ghl' and not exists (
    select 1 from public.contact_identities identity
    where identity.tenant_id = p_expected_tenant and identity.provider = p_provider
      and identity.channel = p_channel
      and identity.provider_identity_id = btrim(p_provider_identity_id)
      and identity.provider_account_id = btrim(p_provider_account_id)
      and identity.ghl_install_id is not null
  ) then raise exception 'GHL_IDENTITY_ACCOUNT_BINDING_MISMATCH'; end if;

  if persisted.message_inserted then
    select * into matched_goal from public.keyword_goals goal
    where goal.tenant_id = p_expected_tenant
      and goal.active
      and goal.normalized_keyword = app.normalize_keyword(p_body)
    order by goal.id
    limit 1;

    has_attribution := nullif(btrim(p_ad_id), '') is not null
      or p_ad_source is not null or nullif(btrim(p_ad_ref), '') is not null
      or nullif(btrim(p_ctwa_clid), '') is not null or safe_context <> '{}'::jsonb;

    update public.conversations conversation
    set first_touch_keyword = case
          when conversation.first_touch_keyword is null and matched_goal.id is not null
            then matched_goal.keyword
          else conversation.first_touch_keyword
        end,
        keyword_goal_id = case
          when conversation.first_touch_keyword is null
            and conversation.keyword_goal_id is null and matched_goal.id is not null
            then matched_goal.id
          else conversation.keyword_goal_id
        end,
        ad_id = case when conversation.ad_attribution_captured_at is null and has_attribution
          then nullif(btrim(p_ad_id), '') else conversation.ad_id end,
        ad_source = case when conversation.ad_attribution_captured_at is null and has_attribution
          then p_ad_source else conversation.ad_source end,
        ad_ref = case when conversation.ad_attribution_captured_at is null and has_attribution
          then nullif(btrim(p_ad_ref), '') else conversation.ad_ref end,
        ctwa_clid = case when conversation.ad_attribution_captured_at is null and has_attribution
          then nullif(btrim(p_ctwa_clid), '') else conversation.ctwa_clid end,
        ads_context_data = case
          when conversation.ad_attribution_captured_at is null and has_attribution then safe_context
          else conversation.ads_context_data
        end,
        ad_attribution_captured_at = case
          when conversation.ad_attribution_captured_at is null and has_attribution
            then coalesce(p_provider_window_observed_at, now())
          else conversation.ad_attribution_captured_at
        end
    where conversation.id = persisted.conversation_id
      and conversation.tenant_id = p_expected_tenant;
  end if;

  return query select persisted.contact_id, persisted.conversation_id, persisted.message_id,
    persisted.message_inserted, persisted.disclosure_pending,
    persisted.provider_window_expires_at;
end;
$$;

revoke execute on function public.persist_inbound_message(
  uuid,public.channel_provider,public.messaging_channel,text,text,text,text,text,text,text,
  timestamptz,timestamptz,text,text,text,text,jsonb,text
) from public, anon, authenticated;
grant execute on function public.persist_inbound_message(
  uuid,public.channel_provider,public.messaging_channel,text,text,text,text,text,text,text,
  timestamptz,timestamptz,text,text,text,text,jsonb,text
) to service_role;

create function public.save_keyword_goal(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_goal_id uuid,
  p_keyword text,
  p_goal public.keyword_goal_mode,
  p_resource_url text,
  p_resource_message text,
  p_post_booking_url text,
  p_post_booking_message text
)
returns table (keyword_goal_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.keyword_goals%rowtype;
  logged_id bigint;
begin
  perform app.phase4_assert_tenant_actor(p_expected_tenant, p_actor_id);
  if p_goal_id is null then
    insert into public.keyword_goals (
      tenant_id, keyword, goal, resource_url, resource_message,
      post_booking_url, post_booking_message, created_by, updated_by
    ) values (
      p_expected_tenant, btrim(p_keyword), p_goal, nullif(btrim(p_resource_url), ''),
      nullif(btrim(p_resource_message), ''), nullif(btrim(p_post_booking_url), ''),
      nullif(btrim(p_post_booking_message), ''), p_actor_id, p_actor_id
    ) returning * into saved;
  else
    select * into saved from public.keyword_goals goal
    where goal.id = p_goal_id for update;
    if saved.id is null then raise exception 'KEYWORD_GOAL_NOT_FOUND'; end if;
    perform app.assert_expected_tenant(p_expected_tenant, saved.tenant_id, 'keyword_goal');
    update public.keyword_goals
    set keyword = btrim(p_keyword), goal = p_goal,
        resource_url = nullif(btrim(p_resource_url), ''),
        resource_message = nullif(btrim(p_resource_message), ''),
        post_booking_url = nullif(btrim(p_post_booking_url), ''),
        post_booking_message = nullif(btrim(p_post_booking_message), ''),
        active = true, updated_by = p_actor_id
    where id = saved.id returning * into saved;
  end if;
  logged_id := app.write_audit_row(
    'keyword_goal.saved', p_actor_id, p_expected_tenant, 'keyword_goal', saved.id::text,
    null, jsonb_build_object('goal', saved.goal, 'active', saved.active)
  );
  return query select saved.id, logged_id;
end;
$$;

create function public.deactivate_keyword_goal(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_goal_id uuid
)
returns table (keyword_goal_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.keyword_goals%rowtype;
  logged_id bigint;
begin
  perform app.phase4_assert_tenant_actor(p_expected_tenant, p_actor_id);
  select * into saved from public.keyword_goals goal where goal.id = p_goal_id for update;
  if saved.id is null then raise exception 'KEYWORD_GOAL_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, saved.tenant_id, 'keyword_goal');
  update public.keyword_goals set active = false, updated_by = p_actor_id
  where id = saved.id returning * into saved;
  logged_id := app.write_audit_row(
    'keyword_goal.deactivated', p_actor_id, p_expected_tenant, 'keyword_goal', saved.id::text,
    null, jsonb_build_object('active', false)
  );
  return query select saved.id, logged_id;
end;
$$;

revoke execute on function public.save_keyword_goal(
  uuid,uuid,uuid,text,public.keyword_goal_mode,text,text,text,text
), public.deactivate_keyword_goal(uuid,uuid,uuid)
from public, anon, authenticated;
grant execute on function public.save_keyword_goal(
  uuid,uuid,uuid,text,public.keyword_goal_mode,text,text,text,text
), public.deactivate_keyword_goal(uuid,uuid,uuid)
to service_role;

revoke execute on function app.normalize_keyword(text) from public, anon, authenticated;
grant execute on function app.normalize_keyword(text) to service_role;

-- The receipt insert is the first committed BOOK transition. An AFTER trigger keeps the outbox
-- write inside the same transaction without creating a second qualification path.
create function app.enqueue_qualified_capi_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  contact_row public.contacts%rowtype;
  tenant_demo boolean;
begin
  if new.command_payload ->> 'outcome' is distinct from 'BOOK' then return new; end if;
  select * into conversation_row from public.conversations
    where id = new.conversation_id and tenant_id = new.tenant_id;
  if conversation_row.channel not in ('messenger', 'instagram', 'whatsapp') then return new; end if;
  select * into contact_row from public.contacts
    where id = new.contact_id and tenant_id = new.tenant_id;
  select is_demo into tenant_demo from public.tenants where id = new.tenant_id;
  insert into public.capi_events (
    tenant_id, conversation_id, dataset_id, channel, event_name, dedup_key, event_time,
    status, is_test, is_demo
  ) values (
    new.tenant_id, new.conversation_id,
    (select dataset.id from public.capi_datasets dataset
      where dataset.tenant_id = new.tenant_id and dataset.channel = conversation_row.channel
        and dataset.status = 'connected'),
    conversation_row.channel, 'QualifiedLead',
    new.conversation_id::text || ':QualifiedLead', now(),
    case when conversation_row.is_test or contact_row.is_test or tenant_demo
      then 'excluded_test' else 'pending' end,
    conversation_row.is_test or contact_row.is_test,
    tenant_demo
  ) on conflict (conversation_id, event_name) do nothing;
  return new;
end;
$$;

create trigger qualification_turn_enqueue_capi
after insert on public.qualification_turn_receipts
for each row execute function app.enqueue_qualified_capi_event();

-- Booking completion is not conversion evidence. Only the durable outbound confirmation update
-- can enqueue Purchase, and its trigger shares the finalizer's transaction and replay boundary.
create function app.enqueue_booked_capi_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  contact_row public.contacts%rowtype;
  appointment_row public.appointments%rowtype;
  tenant_demo boolean;
begin
  if old.booking_confirmed_at is not null or new.booking_confirmed_at is null then return new; end if;
  select * into conversation_row from public.conversations
    where id = new.conversation_id and tenant_id = new.tenant_id;
  if conversation_row.channel not in ('messenger', 'instagram', 'whatsapp') then return new; end if;
  select * into contact_row from public.contacts
    where id = new.contact_id and tenant_id = new.tenant_id;
  select * into appointment_row from public.appointments
    where id = new.appointment_id and tenant_id = new.tenant_id;
  select is_demo into tenant_demo from public.tenants where id = new.tenant_id;
  insert into public.capi_events (
    tenant_id, conversation_id, dataset_id, channel, appointment_id, event_name, dedup_key,
    event_time, currency, value, status, is_test, is_demo
  ) values (
    new.tenant_id, new.conversation_id,
    (select dataset.id from public.capi_datasets dataset
      where dataset.tenant_id = new.tenant_id and dataset.channel = conversation_row.channel
        and dataset.status = 'connected'),
    conversation_row.channel, new.appointment_id, 'Purchase',
    new.conversation_id::text || ':Purchase', new.booking_confirmed_at,
    null, null,
    case when conversation_row.is_test or contact_row.is_test or appointment_row.is_test
      or tenant_demo then 'excluded_test' else 'pending' end,
    conversation_row.is_test or contact_row.is_test or appointment_row.is_test,
    tenant_demo
  ) on conflict (conversation_id, event_name) do nothing;
  return new;
end;
$$;

create trigger booking_confirmation_enqueue_capi
after update of booking_confirmed_at on public.booking_slot_emissions
for each row execute function app.enqueue_booked_capi_event();

create function public.claim_capi_events(
  p_limit integer,
  p_now timestamptz default now()
)
returns table (
  event_id uuid, tenant_id uuid, conversation_id uuid, dataset_row_id uuid,
  channel public.messaging_channel, event_name text, event_time timestamptz,
  currency text, value numeric, is_test boolean, is_demo boolean,
  attempt_number integer, max_attempts integer, claim_token uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_limit < 1 or p_limit > 100 then raise exception 'CAPI_CLAIM_LIMIT_INVALID'; end if;

  -- A worker that died on its last leased attempt cannot remain processing forever.
  update public.capi_events event
  set status = 'terminal_failed', claim_token = null, claimed_until = null,
      last_error = 'CAPI_ATTEMPT_BUDGET_EXHAUSTED', updated_at = now()
  where event.status = 'processing' and event.claimed_until <= p_now
    and event.attempts >= event.max_attempts;

  return query
  with selected as (
    select event.id
    from public.capi_events event
    where (
      (event.status in ('pending', 'retry') and event.next_attempt_at <= p_now)
      or (event.status = 'processing' and event.claimed_until <= p_now)
    ) and event.attempts < event.max_attempts
    order by event.next_attempt_at, event.created_at, event.id
    limit p_limit for update skip locked
  ), claimed as (
    update public.capi_events event
    set status = 'processing', attempts = event.attempts + 1,
        claim_token = gen_random_uuid(), claimed_until = p_now + interval '5 minutes',
        updated_at = now()
    from selected where event.id = selected.id
    returning event.*
  )
  select claimed.id, claimed.tenant_id, claimed.conversation_id, claimed.dataset_id,
    claimed.channel, claimed.event_name, claimed.event_time, claimed.currency, claimed.value,
    claimed.is_test, claimed.is_demo, claimed.attempts, claimed.max_attempts,
    claimed.claim_token
  from claimed;
end;
$$;

create function public.finish_capi_event(
  p_event_id uuid,
  p_claim_token uuid,
  p_status text,
  p_provider_mode text,
  p_provider_receipt jsonb,
  p_error text,
  p_retry_at timestamptz,
  p_now timestamptz default now()
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  finished public.capi_events%rowtype;
begin
  if p_status not in ('sent', 'mock_sent', 'retry', 'terminal_failed', 'excluded_test')
    or p_provider_mode not in ('none', 'mock', 'real')
    or jsonb_typeof(coalesce(p_provider_receipt, '{}'::jsonb)) <> 'object'
    or (p_status in ('sent', 'mock_sent') and coalesce(p_provider_receipt, '{}'::jsonb) = '{}'::jsonb)
    or (p_status in ('retry', 'terminal_failed') and nullif(btrim(p_error), '') is null)
    or (p_status = 'retry' and p_retry_at is null)
    or (p_status <> 'retry' and p_retry_at is not null)
    or (p_status = 'sent' and p_provider_mode <> 'real')
    or (p_status = 'mock_sent' and p_provider_mode <> 'mock') then
    raise exception 'CAPI_FINISH_INPUT_INVALID';
  end if;
  update public.capi_events event
  set status = p_status,
      claim_token = null,
      claimed_until = null,
      next_attempt_at = coalesce(p_retry_at, event.next_attempt_at),
      provider_receipt = coalesce(p_provider_receipt, '{}'::jsonb),
      last_error = case when p_status in ('retry', 'terminal_failed')
        then left(p_error, 500) else null end,
      sent_at = case when p_status in ('sent', 'mock_sent') then p_now else null end,
      updated_at = now()
  where event.id = p_event_id and event.status = 'processing'
    and event.claim_token = p_claim_token
  returning * into finished;
  if finished.id is null then return false; end if;
  if p_status = 'sent' and p_provider_mode = 'real' then
    perform app.write_audit_row(
      'capi.event.sent', null, finished.tenant_id, 'capi_event', finished.id::text,
      null, jsonb_build_object('event_name', finished.event_name, 'provider_mode', 'real'),
      null, null, 'job'
    );
  end if;
  return true;
end;
$$;

revoke execute on function app.enqueue_qualified_capi_event(), app.enqueue_booked_capi_event(),
  public.claim_capi_events(integer,timestamptz),
  public.finish_capi_event(uuid,uuid,text,text,jsonb,text,timestamptz,timestamptz)
from public, anon, authenticated;
grant execute on function public.claim_capi_events(integer,timestamptz),
  public.finish_capi_event(uuid,uuid,text,text,jsonb,text,timestamptz,timestamptz)
to service_role;

-- Preserve the established measurement body under a private implementation name, then put the
-- exact, conversation-bound keyword projection at the public seam. Re-emitting the ~250-line
-- Phase 7 body here would make every unrelated metric vulnerable to transcription drift.
alter function public.read_coach_measurement(uuid,text,date,date,timestamptz)
  rename to read_coach_measurement_pre_phase13;

create function app.phase13_keyword_measurement(
  p_expected_tenant uuid,
  p_window_start timestamptz,
  p_window_end timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with attributed as (
    select analytics.conversation_id, analytics.created_at,
      btrim(conversation.first_touch_keyword) keyword
    from public.analytics_conversations analytics
    join public.conversations conversation on conversation.id = analytics.conversation_id
    join public.keyword_goals goal on goal.id = conversation.keyword_goal_id
      and goal.tenant_id = conversation.tenant_id
    join public.tenants tenant on tenant.id = conversation.tenant_id
    where analytics.tenant_id = p_expected_tenant
      and analytics.created_at >= p_window_start and analytics.created_at < p_window_end
      and not conversation.is_test and not tenant.is_demo
      and nullif(btrim(conversation.first_touch_keyword), '') is not null
  ), grouped as (
    select attributed.keyword,
      count(*)::bigint conversations,
      count(*) filter (where exists (
        select 1 from public.capi_events event
        where event.conversation_id = attributed.conversation_id
          and event.tenant_id = p_expected_tenant
          and event.event_name = 'QualifiedLead'
          and not event.is_test and not event.is_demo
      ))::bigint qualified_contacts,
      count(*) filter (where exists (
        select 1 from public.analytics_messages message
        where message.conversation_id = attributed.conversation_id
          and message.direction = 'in' and message.created_at > attributed.created_at
      ))::bigint responded_conversations,
      count(*) filter (where exists (
        select 1 from public.capi_events event
        where event.conversation_id = attributed.conversation_id
          and event.tenant_id = p_expected_tenant
          and event.event_name = 'Purchase'
          and not event.is_test and not event.is_demo
      ))::bigint booked_contacts
    from attributed group by attributed.keyword
  ), totals as (
    select coalesce(sum(conversations), 0)::bigint conversations,
      coalesce(sum(qualified_contacts), 0)::bigint qualified,
      coalesce(sum(responded_conversations), 0)::bigint responded,
      coalesce(sum(booked_contacts), 0)::bigint booked
    from grouped
  )
  select jsonb_build_object(
    'keywords', coalesce((
      select jsonb_agg(jsonb_build_object(
        'keyword', grouped.keyword,
        'conversations', grouped.conversations,
        'qualifiedContacts', grouped.qualified_contacts,
        'respondedConversations', grouped.responded_conversations,
        'bookedContacts', grouped.booked_contacts,
        'dataLabel', 'Database truth'
      ) order by grouped.keyword) from grouped
    ), '[]'::jsonb),
    'conversations', totals.conversations,
    'qualified', totals.qualified,
    'responded', totals.responded,
    'booked', totals.booked
  ) from totals;
$$;

create function public.read_coach_measurement(
  p_expected_tenant uuid,
  p_window text,
  p_custom_from date,
  p_custom_to date,
  p_as_of timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  snapshot jsonb;
  keyword_snapshot jsonb;
  keyword_metrics jsonb;
  opt_ins bigint;
  qualified bigint;
  responded bigint;
  booked bigint;
begin
  snapshot := public.read_coach_measurement_pre_phase13(
    p_expected_tenant, p_window, p_custom_from, p_custom_to, p_as_of
  );
  keyword_snapshot := app.phase13_keyword_measurement(
    p_expected_tenant,
    (snapshot ->> 'windowStart')::timestamptz,
    (snapshot ->> 'windowEnd')::timestamptz
  );
  opt_ins := (keyword_snapshot ->> 'conversations')::bigint;
  qualified := (keyword_snapshot ->> 'qualified')::bigint;
  responded := (keyword_snapshot ->> 'responded')::bigint;
  booked := (keyword_snapshot ->> 'booked')::bigint;

  select jsonb_agg(case metric ->> 'metricKey'
    when 'coach.keyword.conversations' then metric || jsonb_build_object(
      'numerator', opt_ins, 'denominator', opt_ins, 'value', opt_ins
    )
    when 'coach.keyword.qualified_rate' then metric || jsonb_build_object(
      'numerator', qualified, 'denominator', opt_ins,
      'value', case when opt_ins = 0 then null else qualified * 100.0 / opt_ins end,
      'state', case when opt_ins = 0 then 'unavailable' else metric ->> 'state' end
    )
    when 'coach.keyword.response_rate' then metric || jsonb_build_object(
      'numerator', responded, 'denominator', opt_ins,
      'value', case when opt_ins = 0 then null else responded * 100.0 / opt_ins end,
      'state', case when opt_ins = 0 then 'unavailable' else metric ->> 'state' end
    )
    when 'coach.keyword.booked_rate' then metric || jsonb_build_object(
      'numerator', booked, 'denominator', opt_ins,
      'value', case when opt_ins = 0 then null else booked * 100.0 / opt_ins end,
      'state', case when opt_ins = 0 then 'unavailable' else metric ->> 'state' end
    ) else metric end)
  into keyword_metrics from jsonb_array_elements(snapshot -> 'metrics') metric;

  return snapshot || jsonb_build_object(
    'keywords', keyword_snapshot -> 'keywords',
    'metrics', keyword_metrics
  );
end;
$$;

-- The actor wrapper is replaced so it resolves the new public seam rather than retaining the
-- renamed implementation OID. Its ownership-first demo widening remains unchanged; the exact
-- keyword helper still excludes every demo and test row explicitly.
create or replace function public.read_coach_measurement_for_actor(
  p_actor_id uuid,
  p_expected_tenant uuid,
  p_window text,
  p_custom_from date,
  p_custom_to date,
  p_as_of timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  widened uuid;
begin
  if p_actor_id is null then raise exception 'PHASE7_SESSION_ACTOR_REQUIRED'; end if;
  perform set_config('app.phase7_reader_actor', p_actor_id::text, true);
  perform app.phase7_session_actor(p_expected_tenant, false);
  perform app.phase7_widen_to_own_demo_tenant(p_expected_tenant);
  widened := nullif(current_setting('app.phase7_demo_tenant', true), '')::uuid;
  return public.read_coach_measurement(
    p_expected_tenant, p_window, p_custom_from, p_custom_to, p_as_of
  ) || jsonb_build_object('isDemo', widened is not null);
end;
$$;

revoke execute on function app.phase13_keyword_measurement(uuid,timestamptz,timestamptz),
  public.read_coach_measurement_pre_phase13(uuid,text,date,date,timestamptz),
  public.read_coach_measurement(uuid,text,date,date,timestamptz),
  public.read_coach_measurement_for_actor(uuid,uuid,text,date,date,timestamptz)
from public, anon, authenticated;
grant execute on function public.read_coach_measurement(uuid,text,date,date,timestamptz),
  public.read_coach_measurement_for_actor(uuid,uuid,text,date,date,timestamptz)
to service_role;
