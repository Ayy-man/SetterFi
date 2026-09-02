-- Client-approved A2P campaign content is append-only.  The approval snapshots the exact
-- already-confirmed opt-in artifact and content-screen evidence that the client approved with
-- its sample messages; later approvals create a new version rather than changing a filing.
set search_path = public, extensions;

insert into public.audit_actions (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('onboarding.campaign_content_approved', 'human', 'tenant', false, true, 'Campaign content approval logged', 'Client campaign content approval recorded in the audit log')
on conflict (key) do nothing;

create table public.onboarding_approved_campaign_contents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  version int not null check (version > 0),
  artifact_id uuid not null references public.onboarding_optin_artifacts(id) on delete restrict,
  artifact_version int not null check (artifact_version > 0),
  artifact_hash text not null check (artifact_hash ~ '^[0-9a-f]{64}$'),
  marketing_language_hash text not null check (marketing_language_hash ~ '^[0-9a-f]{64}$'),
  non_marketing_language_hash text not null check (non_marketing_language_hash ~ '^[0-9a-f]{64}$'),
  terms_url text not null check (terms_url ~ '^https://'),
  privacy_url text not null check (privacy_url ~ '^https://'),
  campaign_description_hash text not null check (campaign_description_hash ~ '^[0-9a-f]{64}$'),
  content_screen_id uuid not null references public.onboarding_content_screens(id) on delete restrict,
  content_screen_input_hash text not null check (content_screen_input_hash ~ '^[0-9a-f]{64}$'),
  sample_messages jsonb not null check (jsonb_typeof(sample_messages) = 'array' and jsonb_array_length(sample_messages) > 0),
  sample_messages_hash text not null check (sample_messages_hash ~ '^[0-9a-f]{64}$'),
  approved_at timestamptz not null default now(),
  approved_by uuid not null references public.users(id) on delete restrict,
  audit_id bigint not null references public.audit_log(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (tenant_id, version),
  unique (id, tenant_id)
);
create index onboarding_approved_campaign_contents_tenant_version_idx
  on public.onboarding_approved_campaign_contents (tenant_id, version desc);

create table public.a2p_campaign_filing_content_refs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provisioning_step_id uuid not null unique references public.provisioning_steps(id) on delete restrict,
  approved_campaign_content_id uuid not null references public.onboarding_approved_campaign_contents(id) on delete restrict,
  approved_campaign_content_version int not null check (approved_campaign_content_version > 0),
  provider_submission_ref text not null check (nullif(btrim(provider_submission_ref), '') is not null),
  filed_at timestamptz not null default now()
);

create function app.reject_approved_campaign_content_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'APPROVED_CAMPAIGN_CONTENT_APPEND_ONLY';
end;
$$;
create trigger onboarding_approved_campaign_contents_reject_mutation
before update or delete on public.onboarding_approved_campaign_contents
for each row execute function app.reject_approved_campaign_content_mutation();

alter table public.onboarding_approved_campaign_contents enable row level security;
alter table public.onboarding_approved_campaign_contents force row level security;
alter table public.a2p_campaign_filing_content_refs enable row level security;
alter table public.a2p_campaign_filing_content_refs force row level security;
create policy onboarding_approved_campaign_contents_tenant_read on public.onboarding_approved_campaign_contents
  for select to authenticated using (app.owns_tenant(tenant_id));
create policy onboarding_approved_campaign_contents_platform_read on public.onboarding_approved_campaign_contents
  for select to authenticated using (app.is_platform_operator());
create policy a2p_campaign_filing_content_refs_tenant_read on public.a2p_campaign_filing_content_refs
  for select to authenticated using (app.owns_tenant(tenant_id));
create policy a2p_campaign_filing_content_refs_platform_read on public.a2p_campaign_filing_content_refs
  for select to authenticated using (app.is_platform_operator());
revoke all on public.onboarding_approved_campaign_contents, public.a2p_campaign_filing_content_refs from public, anon, authenticated, service_role;
grant select on public.onboarding_approved_campaign_contents, public.a2p_campaign_filing_content_refs to authenticated, service_role;

create or replace function app.assert_a2p_filing_ready(p_tenant_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.onboarding_optin_artifacts artifact
    where artifact.tenant_id = p_tenant_id and artifact.is_current
      and artifact.confirmed_at is not null and not artifact.placeholder
  ) then raise exception 'A2P_ARTIFACT_NOT_APPROVED'; end if;
  if not exists (
    select 1 from public.onboarding_content_screens screen
    where screen.tenant_id = p_tenant_id and screen.is_current
      and (screen.result = 'clean' or (screen.result = 'flagged' and screen.acknowledged_at is not null and screen.admin_confirmed_at is not null))
  ) then raise exception 'A2P_CONTENT_SCREEN_NOT_APPROVED'; end if;
  if not exists (
    select 1
    from public.onboarding_approved_campaign_contents content
    join public.onboarding_optin_artifacts artifact on artifact.id = content.artifact_id
    join public.onboarding_content_screens screen on screen.id = content.content_screen_id
    where content.tenant_id = p_tenant_id
      and artifact.tenant_id = p_tenant_id and artifact.is_current and artifact.confirmed_at is not null and not artifact.placeholder
      and screen.tenant_id = p_tenant_id and screen.is_current
      and (screen.result = 'clean' or (screen.result = 'flagged' and screen.acknowledged_at is not null and screen.admin_confirmed_at is not null))
      and content.artifact_version = artifact.version and content.artifact_hash = artifact.artifact_hash
      and content.marketing_language_hash = artifact.marketing_language_hash
      and content.non_marketing_language_hash = artifact.non_marketing_language_hash
      and content.terms_url = artifact.terms_url and content.privacy_url = artifact.privacy_url
      and content.campaign_description_hash = artifact.campaign_description_hash
      and content.content_screen_input_hash = screen.input_hash
  ) then raise exception 'A2P_CAMPAIGN_CONTENT_NOT_APPROVED'; end if;
end;
$$;

create function public.approve_onboarding_campaign_content(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_sample_messages jsonb
)
returns table(content_id uuid, version int, approved_at timestamptz, audit_id bigint)
language plpgsql security definer set search_path = '' as $$
declare artifact_row public.onboarding_optin_artifacts%rowtype; screen_row public.onboarding_content_screens%rowtype; step_row public.provisioning_steps%rowtype; actor_row public.users%rowtype; next_version int; new_content_id uuid; logged_id bigint; approval_at timestamptz := now(); sample_hash text;
begin
  perform app.assert_not_impersonating();
  select * into actor_row from public.users where id = p_actor_id;
  if actor_row.id is null or actor_row.role <> 'coach' or actor_row.tenant_id is distinct from p_expected_tenant then
    raise exception 'A2P_CAMPAIGN_CLIENT_APPROVER_REQUIRED';
  end if;
  if jsonb_typeof(p_sample_messages) <> 'array' or jsonb_array_length(p_sample_messages) = 0
    or exists (select 1 from jsonb_array_elements(p_sample_messages) message where jsonb_typeof(message) <> 'string' or nullif(btrim(message #>> '{}'), '') is null) then
    raise exception 'A2P_SAMPLE_MESSAGES_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_expected_tenant::text, 0));
  select * into step_row from public.provisioning_steps where tenant_id = p_expected_tenant and step_key = 'a2p_campaign' for update;
  if step_row.id is null then raise exception 'A2P_CAMPAIGN_STEP_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, step_row.tenant_id, 'onboarding_campaign_content');
  if step_row.state = 'running' then raise exception 'A2P_CAMPAIGN_APPROVAL_FILING_IN_PROGRESS'; end if;
  select * into artifact_row from public.onboarding_optin_artifacts where tenant_id = p_expected_tenant and is_current for share;
  if artifact_row.id is null or artifact_row.confirmed_at is null or artifact_row.placeholder then raise exception 'A2P_ARTIFACT_NOT_APPROVED'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, artifact_row.tenant_id, 'onboarding_campaign_artifact');
  select * into screen_row from public.onboarding_content_screens where tenant_id = p_expected_tenant and is_current for share;
  if screen_row.id is null or not (screen_row.result = 'clean' or (screen_row.result = 'flagged' and screen_row.acknowledged_at is not null and screen_row.admin_confirmed_at is not null)) then raise exception 'A2P_CONTENT_SCREEN_NOT_APPROVED'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, screen_row.tenant_id, 'onboarding_campaign_content_screen');
  select coalesce(max(content.version), 0) + 1 into next_version from public.onboarding_approved_campaign_contents content where content.tenant_id = p_expected_tenant;
  sample_hash := encode(extensions.digest(convert_to(p_sample_messages::text, 'utf8'), 'sha256'), 'hex');
  new_content_id := gen_random_uuid();
  logged_id := app.write_audit_row(
    'onboarding.campaign_content_approved', p_actor_id, p_expected_tenant, 'onboarding_approved_campaign_content', new_content_id::text, null,
    jsonb_build_object('version', next_version, 'artifact_id', artifact_row.id, 'artifact_version', artifact_row.version, 'content_screen_id', screen_row.id, 'sample_messages_hash', sample_hash)
  );
  insert into public.onboarding_approved_campaign_contents (
    id,
    tenant_id, version, artifact_id, artifact_version, artifact_hash, marketing_language_hash, non_marketing_language_hash, terms_url, privacy_url, campaign_description_hash, content_screen_id, content_screen_input_hash, sample_messages, sample_messages_hash, approved_at, approved_by, audit_id
  ) values (
    new_content_id, p_expected_tenant, next_version, artifact_row.id, artifact_row.version, artifact_row.artifact_hash, artifact_row.marketing_language_hash, artifact_row.non_marketing_language_hash, artifact_row.terms_url, artifact_row.privacy_url, artifact_row.campaign_description_hash, screen_row.id, screen_row.input_hash, p_sample_messages, sample_hash, approval_at, p_actor_id, logged_id
  );
  return query select new_content_id, next_version, approval_at, logged_id;
end;
$$;

create function app.record_a2p_campaign_filing_content_ref()
returns trigger language plpgsql security definer set search_path = '' as $$
declare content_row public.onboarding_approved_campaign_contents%rowtype; submission_ref text;
begin
  if new.step_key <> 'a2p_campaign' or new.state <> 'awaiting_provider' or old.state <> 'running' then return new; end if;
  submission_ref := nullif(btrim(new.external_ref ->> 'submissionRef'), '');
  if submission_ref is null then raise exception 'A2P_CAMPAIGN_SUBMISSION_REFERENCE_REQUIRED'; end if;
  select content.* into content_row from public.onboarding_approved_campaign_contents content
  join public.onboarding_optin_artifacts artifact on artifact.id = content.artifact_id
  join public.onboarding_content_screens screen on screen.id = content.content_screen_id
  where content.tenant_id = new.tenant_id and artifact.is_current and screen.is_current
    and content.artifact_version = artifact.version and content.artifact_hash = artifact.artifact_hash
    and content.marketing_language_hash = artifact.marketing_language_hash and content.non_marketing_language_hash = artifact.non_marketing_language_hash
    and content.terms_url = artifact.terms_url and content.privacy_url = artifact.privacy_url and content.campaign_description_hash = artifact.campaign_description_hash
    and content.content_screen_input_hash = screen.input_hash
  order by content.version desc limit 1;
  if content_row.id is null then raise exception 'A2P_CAMPAIGN_CONTENT_NOT_APPROVED'; end if;
  insert into public.a2p_campaign_filing_content_refs (tenant_id, provisioning_step_id, approved_campaign_content_id, approved_campaign_content_version, provider_submission_ref)
  values (new.tenant_id, new.id, content_row.id, content_row.version, submission_ref)
  on conflict (provisioning_step_id) do nothing;
  return new;
end;
$$;
create trigger provisioning_steps_record_a2p_campaign_filing_content_ref
after update of state, external_ref on public.provisioning_steps
for each row execute function app.record_a2p_campaign_filing_content_ref();

revoke execute on function public.approve_onboarding_campaign_content(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.approve_onboarding_campaign_content(uuid,uuid,jsonb) to service_role;

comment on table public.onboarding_approved_campaign_contents is
  'Append-only client approvals of exact A2P sample messages tied to the confirmed opt-in and content-screen versions.';
comment on table public.a2p_campaign_filing_content_refs is
  'The immutable approved campaign-content version attached to the submitted carrier filing.';
