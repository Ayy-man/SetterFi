-- Per-coach presentation settings for the platform-owned Brain question library.
--
-- Question wording and tags remain platform authority in brain_knowledge_entries. A tenant may
-- only choose whether a published shared question runs and where it appears; deleting an override
-- restores the platform default rather than copying Brain text into tenant storage.

create table public.tenant_question_settings (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  question_id uuid not null references public.brain_knowledge_entries(id) on delete cascade,
  position integer not null check (position >= 0),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, question_id)
);

create index tenant_question_settings_tenant_position_idx
  on public.tenant_question_settings (tenant_id, position, question_id);
create trigger set_tenant_question_settings_updated_at
before update on public.tenant_question_settings
for each row execute function app.set_updated_at();

alter table public.tenant_question_settings enable row level security;
alter table public.tenant_question_settings force row level security;
create policy tenant_question_settings_service_read on public.tenant_question_settings
  for select to service_role using (true);
revoke all on public.tenant_question_settings from public, anon, authenticated, service_role;
grant select on public.tenant_question_settings to service_role;

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('coach.question_order.saved', 'human', 'tenant', false, true,
   'Question order logged', 'Qualification-question order recorded in the audit log'),
  ('coach.question.enabled.changed', 'human', 'tenant', false, true,
   'Question setting logged', 'Qualification-question setting recorded in the audit log')
on conflict (key) do nothing;

-- The platform table has no mutable position column. `created_at, id` is consequently the stable
-- platform order, and each tenant's sparse row falls back to it until a coach writes an override.
-- analytics_tenants supplies the established demo exclusion; actor wrappers widen it only after
-- proving that the reader owns that demo tenant. No test-event relation participates in this
-- projection, so no test fixture can become a qualifying question.
create function app.coach_question_defaults(p_expected_tenant uuid)
returns table (question_id uuid, question_text text, question_tag text, default_position integer)
language sql
stable
security definer
set search_path = ''
as $$
  with eligible_tenant as (
    select tenant.tenant_id
    from public.analytics_tenants tenant
    where tenant.tenant_id = p_expected_tenant
  ), platform_questions as (
    select question.id as question_id,
      question.question as question_text,
      question.category as question_tag,
      (row_number() over (order by question.created_at, question.id) - 1)::integer as default_position
    from public.brain_knowledge_entries question
    where question.status = 'published'
      and question.disposition = 'shared'
  )
  select question.question_id, question.question_text, question.question_tag, question.default_position
  from eligible_tenant tenant
  cross join platform_questions question;
$$;

create function public.read_coach_questions(p_expected_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare rows jsonb;
begin
  perform app.phase7_session_actor(p_expected_tenant, false);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', question.question_id,
    'text', question.question_text,
    'tag', question.question_tag,
    'enabled', coalesce(setting.enabled, true),
    'position', coalesce(setting.position, question.default_position)
  ) order by coalesce(setting.position, question.default_position), question.question_id), '[]'::jsonb)
  into rows
  from app.coach_question_defaults(p_expected_tenant) question
  left join public.tenant_question_settings setting
    on setting.tenant_id = p_expected_tenant
    and setting.question_id = question.question_id;

  return jsonb_build_object('tenantId', p_expected_tenant, 'questions', rows);
end;
$$;

create function public.read_coach_questions_for_actor(
  p_actor_id uuid,
  p_expected_tenant uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_actor_id is null then raise exception 'PHASE7_SESSION_ACTOR_REQUIRED'; end if;
  perform set_config('app.phase7_reader_actor', p_actor_id::text, true);
  perform app.phase7_session_actor(p_expected_tenant, false);
  perform app.phase7_widen_to_own_demo_tenant(p_expected_tenant);
  return public.read_coach_questions(p_expected_tenant);
end;
$$;

create function public.reorder_coach_questions(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_question_ids uuid[]
)
returns table (audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_ids uuid[];
  written_audit_id bigint;
begin
  if p_question_ids is null
    or cardinality(p_question_ids) <> cardinality(array(select distinct id from unnest(p_question_ids) id)) then
    raise exception 'COACH_QUESTION_ORDER_INVALID';
  end if;
  if p_actor_id is null then raise exception 'PHASE7_SESSION_ACTOR_REQUIRED'; end if;
  perform set_config('app.phase7_reader_actor', p_actor_id::text, true);
  perform app.phase7_session_actor(p_expected_tenant, false);
  perform app.phase7_widen_to_own_demo_tenant(p_expected_tenant);

  select coalesce(array_agg(question.question_id order by question.default_position, question.question_id), '{}'::uuid[])
  into expected_ids
  from app.coach_question_defaults(p_expected_tenant) question;
  if p_question_ids <> expected_ids
    and (cardinality(p_question_ids) <> cardinality(expected_ids)
      or exists (
        select 1
        from unnest(p_question_ids) provided
        full join unnest(expected_ids) expected on expected = provided
        where expected is null or provided is null
      )) then
    raise exception 'COACH_QUESTION_ORDER_INVALID';
  end if;

  insert into public.tenant_question_settings (tenant_id, question_id, position, enabled)
  select p_expected_tenant, provided.question_id, (provided.position_ordinal - 1)::integer,
    coalesce(existing.enabled, true)
  from unnest(p_question_ids) with ordinality as provided(question_id, position_ordinal)
  left join public.tenant_question_settings existing
    on existing.tenant_id = p_expected_tenant and existing.question_id = provided.question_id
  on conflict (tenant_id, question_id) do update
  set position = excluded.position, enabled = excluded.enabled, updated_at = now();

  written_audit_id := app.write_audit_row(
    'coach.question_order.saved', p_actor_id, p_expected_tenant, 'tenant_question_settings',
    p_expected_tenant::text, null, jsonb_build_object('questionIds', to_jsonb(p_question_ids)),
    null, null, 'dashboard'
  );
  return query select written_audit_id;
end;
$$;

create function public.set_coach_question_enabled(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_question_id uuid,
  p_enabled boolean
)
returns table (audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  default_question record;
  written_audit_id bigint;
begin
  if p_question_id is null or p_enabled is null then raise exception 'COACH_QUESTION_SETTING_INVALID'; end if;
  if p_actor_id is null then raise exception 'PHASE7_SESSION_ACTOR_REQUIRED'; end if;
  perform set_config('app.phase7_reader_actor', p_actor_id::text, true);
  perform app.phase7_session_actor(p_expected_tenant, false);
  perform app.phase7_widen_to_own_demo_tenant(p_expected_tenant);

  select * into default_question
  from app.coach_question_defaults(p_expected_tenant) question
  where question.question_id = p_question_id;
  if default_question.question_id is null then raise exception 'COACH_QUESTION_NOT_FOUND'; end if;

  insert into public.tenant_question_settings (tenant_id, question_id, position, enabled)
  values (p_expected_tenant, p_question_id, default_question.default_position, p_enabled)
  on conflict (tenant_id, question_id) do update
  set enabled = excluded.enabled, updated_at = now();

  written_audit_id := app.write_audit_row(
    'coach.question.enabled.changed', p_actor_id, p_expected_tenant, 'tenant_question_settings',
    p_question_id::text, null, jsonb_build_object('questionId', p_question_id, 'enabled', p_enabled),
    null, null, 'dashboard'
  );
  return query select written_audit_id;
end;
$$;

revoke all on function app.coach_question_defaults(uuid) from public, anon, authenticated, service_role;
revoke execute on function
  public.read_coach_questions(uuid),
  public.read_coach_questions_for_actor(uuid,uuid),
  public.reorder_coach_questions(uuid,uuid,uuid[]),
  public.set_coach_question_enabled(uuid,uuid,uuid,boolean)
from public, anon, authenticated;
grant execute on function
  public.read_coach_questions(uuid),
  public.read_coach_questions_for_actor(uuid,uuid),
  public.reorder_coach_questions(uuid,uuid,uuid[]),
  public.set_coach_question_enabled(uuid,uuid,uuid,boolean)
to service_role;

comment on table public.tenant_question_settings is
  'Sparse tenant overrides for platform-owned Brain questions. Missing rows inherit the platform position and enabled=true.';
comment on function public.read_coach_questions_for_actor(uuid,uuid) is
  'Actor-authorized read of merged platform Brain questions. The actor id must come from a server-validated session and is re-verified against users and live impersonation state.';
