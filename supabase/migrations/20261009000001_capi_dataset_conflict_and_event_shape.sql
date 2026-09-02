-- Phase 13 repair: two defects shipped in 20261007000001_keyword_goals_capi.sql.
--
-- 1. provision_capi_dataset declares OUT parameters named tenant_id and channel. Inside plpgsql
--    those names shadow the columns in the ON CONFLICT index-inference expression, so every call
--    aborted with "column reference tenant_id is ambiguous" and no coach could ever finish
--    conversion tracking setup. Naming the unique constraint instead removes the inference step.
--
-- 2. capi_events_appointment_shape_chk enumerated the two accepted event names a second time, so
--    an unknown event name violated the appointment shape rule before the event-name rule. The
--    writer saw a confusing appointment complaint for what is really a rejected event name.
--    The appointment rule now only speaks about appointments, and capi_events_event_name_chk stays
--    the single gate on which event names exist.

set search_path = public, extensions;

alter table public.capi_events
  drop constraint capi_events_appointment_shape_chk;
alter table public.capi_events
  add constraint capi_events_appointment_shape_chk check (
    event_name not in ('QualifiedLead', 'Purchase')
    or (event_name = 'QualifiedLead' and appointment_id is null)
    or (event_name = 'Purchase' and appointment_id is not null)
  );

create or replace function public.provision_capi_dataset(
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
  on conflict on constraint capi_datasets_tenant_channel_key do update set
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

