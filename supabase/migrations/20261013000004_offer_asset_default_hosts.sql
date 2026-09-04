-- Links a coach may save: the platform's hosts, the tenant's own whitelist, and their website.
--
-- Links are the only way an agent shares a file, and tenant_settings.link_whitelist is platform
-- owned and usually empty, so every link a coach pasted was refused with nothing they could do.
-- The list here mirrors DEFAULT_ASSET_HOSTS in src/lib/offer/asset-hosts.ts; change both or
-- neither. save_offer_draft is recreated to check against it.
set search_path = public, extensions;

create or replace function app.offer_asset_allowed_hosts(p_tenant uuid)
returns text[]
language sql
security definer
set search_path = ''
as $$
  select array(
    select distinct host from (
      select unnest(array[
        'drive.google.com', 'docs.google.com', 'dropbox.com', 'notion.site', 'loom.com',
        'youtube.com', 'youtu.be', 'vimeo.com', 'calendly.com'
      ]) as host
      union all
      select lower(btrim(allowed)) from public.tenant_settings as settings
        cross join lateral unnest(coalesce(settings.link_whitelist, '{}')) as allowed
        where settings.tenant_id = p_tenant
      union all
      select lower(regexp_replace(profile.website_url, '^https?://([^/:]+).*$', '\1'))
        from public.business_profiles as profile
        where profile.tenant_id = p_tenant and profile.website_url ~ '^https?://'
    ) as hosts
    where nullif(host, '') is not null
  );
$$;

revoke execute on function app.offer_asset_allowed_hosts(uuid) from public, anon, authenticated;

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
    'cadencePurposes', 'qualificationRules', 'voiceGuidelines', 'contentHash'
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

  if jsonb_typeof(coalesce(p_offer -> 'qualificationRules', '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_offer -> 'qualificationRules', '[]'::jsonb)) > 12 then raise exception 'OFFER_RULE_CAP_EXCEEDED'; end if;
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
    qualification_rules = coalesce(p_offer -> 'qualificationRules', '[]'::jsonb),
    voice_guidelines = nullif(btrim(p_offer ->> 'voiceGuidelines'), ''),
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
  allowed_hosts := app.offer_asset_allowed_hosts(p_expected_tenant);
  delete from public.offer_assets as stored_asset where stored_asset.offer_id = draft.id;
  for asset in select item.value from jsonb_array_elements(coalesce(p_offer -> 'assets', '[]'::jsonb)) as item(value) loop
    asset_host := lower(regexp_replace(asset ->> 'url', '^https://([^/]+).*$','\1'));
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

revoke execute on function public.save_offer_draft(uuid,uuid,uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.save_offer_draft(uuid,uuid,uuid,text,jsonb) to service_role;
