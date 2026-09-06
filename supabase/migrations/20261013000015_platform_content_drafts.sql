-- Platform agent content (the automated-experience disclosure, platform frame, role boundary and
-- the held reply for every moderator class) is read by the reply pipeline from
-- `platform_settings.agent_content` together with the `approved` flag. Until now the only writer
-- was a migration, so the owner had no way to review a change before it reached a lead.
--
-- This adds a draft lane beside the approved row. A draft is written to `agent_content_draft`
-- and nothing else: the pipeline keeps reading `agent_content`, so an unapproved draft cannot
-- reach a lead by construction rather than by a flag check. Approval copies the draft over the
-- approved row inside one function, flips `approved`, and writes the audit row before returning,
-- following the Brain publish RPC.
--
-- Mission and qualification are not part of the draft. They are compiled into the Brain snapshot
-- and edited there; the platform-content editor reads them back only so the owner can see the
-- values the legacy prompt path would use.
--
-- Approval is refused while any slot the pipeline sends verbatim is still a placeholder. That
-- covers the editable fields, the held replies, and the STOP/HELP/START control copy and
-- scope-ladder replies that `20260819000001_phase3_compliance_safety.sql` added and deliberately
-- left unapproved: flipping `approved` also arms those, so they are part of the same review.

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('platform_content.draft.saved', 'human', 'platform', false, false,
   'Platform content draft logged', 'Platform agent content draft recorded in the audit log'),
  ('platform_content.approved', 'human', 'platform', true, false,
   'Platform content approval logged', 'Platform agent content approval recorded in the audit log')
on conflict (key) do nothing;

alter table public.platform_settings
  add column agent_content_draft jsonb,
  add column agent_content_draft_hash text,
  add column agent_content_draft_saved_at timestamptz,
  add column agent_content_draft_saved_by uuid references public.users(id) on delete set null,
  add column agent_content_approved_at timestamptz,
  add column agent_content_approved_by uuid references public.users(id) on delete set null,
  add constraint platform_settings_agent_content_draft_shape_chk check (
    agent_content_draft is null
    or (
      jsonb_typeof(agent_content_draft) = 'object'
      and jsonb_typeof(agent_content_draft -> 'heldReplies') = 'object'
    )
  ),
  add constraint platform_settings_agent_content_draft_hash_chk check (
    (agent_content_draft is null) = (agent_content_draft_hash is null)
    and (agent_content_draft is null) = (agent_content_draft_saved_at is null)
  );

comment on column public.platform_settings.agent_content_draft is
  'Owner-saved platform agent content awaiting approval. Never read by the reply pipeline; approve_platform_agent_content copies it into agent_content.';

create function app.assert_platform_content_admin(p_actor_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor_row public.users%rowtype;
begin
  perform app.assert_not_impersonating();
  select * into actor_row from public.users where id = p_actor_id;
  if actor_row.id is null or actor_row.role not in ('owner', 'admin') then
    raise exception 'PLATFORM_CONTENT_ADMIN_REQUIRED';
  end if;
end;
$$;

-- The exact keys a draft may carry. Anything else (mission, qualification, control copy) is
-- refused rather than silently stored, so the editor cannot grow into a second writer of slots it
-- does not own.
create function app.assert_platform_content_draft_shape(p_draft jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  draft_keys text[];
  held_keys text[];
  slot text;
begin
  if p_draft is null or jsonb_typeof(p_draft) <> 'object' then
    raise exception 'PLATFORM_CONTENT_DRAFT_INVALID:shape';
  end if;
  select coalesce(array_agg(key order by key), '{}') into draft_keys from jsonb_object_keys(p_draft) key;
  if draft_keys <> array['automatedExperienceDisclosure', 'heldReplies', 'platformFrame', 'roleBoundary'] then
    raise exception 'PLATFORM_CONTENT_DRAFT_INVALID:keys';
  end if;
  foreach slot in array array['automatedExperienceDisclosure', 'platformFrame', 'roleBoundary'] loop
    if jsonb_typeof(p_draft -> slot) <> 'string' or nullif(btrim(p_draft ->> slot), '') is null then
      raise exception 'PLATFORM_CONTENT_DRAFT_INVALID:%', slot;
    end if;
  end loop;
  if jsonb_typeof(p_draft -> 'heldReplies') <> 'object' then
    raise exception 'PLATFORM_CONTENT_DRAFT_INVALID:heldReplies';
  end if;
  select coalesce(array_agg(key order by key), '{}') into held_keys
  from jsonb_object_keys(p_draft -> 'heldReplies') key;
  if held_keys <> array['CLAIM', 'ECHO', 'JUDGE', 'LEN', 'LINK', 'NUM', 'REVOKE', 'SCOPE'] then
    raise exception 'PLATFORM_CONTENT_DRAFT_INVALID:heldReplies.keys';
  end if;
  foreach slot in array held_keys loop
    if jsonb_typeof(p_draft -> 'heldReplies' -> slot) <> 'string'
      or nullif(btrim(p_draft -> 'heldReplies' ->> slot), '') is null then
      raise exception 'PLATFORM_CONTENT_DRAFT_INVALID:heldReplies.%', slot;
    end if;
  end loop;
end;
$$;

-- Every slot the pipeline can send to a lead verbatim, and whether it is still a placeholder. The
-- editor reads this to explain why approval would be refused; approval calls it and refuses on a
-- non-empty result, so the two can never disagree.
create function public.platform_agent_content_blockers(p_content jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  blockers text[] := '{}';
  slot text;
  value text;
begin
  if p_content is null or jsonb_typeof(p_content) <> 'object' then
    return array['agent_content'];
  end if;
  foreach slot in array array[
    'automatedExperienceDisclosure', 'platformFrame', 'roleBoundary',
    'scopeDeflection1', 'scopeDeflection2', 'scopeClosing'
  ] loop
    value := p_content ->> slot;
    if jsonb_typeof(p_content -> slot) is distinct from 'string' or nullif(btrim(value), '') is null
      or btrim(value) like '[DRAFT]%' or btrim(value) like 'SETTERFI_DEMO_PLACEHOLDER_%' then
      blockers := blockers || slot;
    end if;
  end loop;
  foreach slot in array array['CLAIM', 'ECHO', 'JUDGE', 'LEN', 'LINK', 'NUM', 'REVOKE', 'SCOPE'] loop
    value := p_content -> 'heldReplies' ->> slot;
    if jsonb_typeof(p_content -> 'heldReplies' -> slot) is distinct from 'string'
      or nullif(btrim(value), '') is null
      or btrim(value) like '[DRAFT]%' or btrim(value) like 'SETTERFI_DEMO_PLACEHOLDER_%' then
      blockers := blockers || ('heldReplies.' || slot);
    end if;
  end loop;
  foreach slot in array array['STOP', 'HELP', 'START'] loop
    value := p_content -> 'controlCopy' ->> slot;
    if jsonb_typeof(p_content -> 'controlCopy' -> slot) is distinct from 'string'
      or nullif(btrim(value), '') is null
      or btrim(value) like '[DRAFT]%' or btrim(value) like 'SETTERFI_DEMO_PLACEHOLDER_%' then
      blockers := blockers || ('controlCopy.' || slot);
    end if;
  end loop;
  return blockers;
end;
$$;

create function public.save_platform_agent_content_draft(
  p_actor_id uuid,
  p_draft jsonb
)
returns table (draft_hash text, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized jsonb;
  computed_hash text;
  logged_id bigint;
begin
  perform app.assert_platform_content_admin(p_actor_id);
  perform app.assert_platform_content_draft_shape(p_draft);
  normalized := jsonb_build_object(
    'automatedExperienceDisclosure', btrim(p_draft ->> 'automatedExperienceDisclosure'),
    'platformFrame', btrim(p_draft ->> 'platformFrame'),
    'roleBoundary', btrim(p_draft ->> 'roleBoundary'),
    'heldReplies', (
      select jsonb_object_agg(key, btrim(value))
      from jsonb_each_text(p_draft -> 'heldReplies')
    )
  );
  computed_hash := encode(sha256(convert_to(normalized::text, 'UTF8')), 'hex');
  update public.platform_settings set
    agent_content_draft = normalized,
    agent_content_draft_hash = computed_hash,
    agent_content_draft_saved_at = now(),
    agent_content_draft_saved_by = p_actor_id,
    updated_at = now()
  where singleton;
  if not found then raise exception 'PLATFORM_SETTINGS_ROW_REQUIRED'; end if;
  logged_id := app.write_audit_row(
    'platform_content.draft.saved', p_actor_id, null, 'platform_settings', 'singleton',
    null, jsonb_build_object('draftHash', computed_hash)
  );
  return query select computed_hash, logged_id;
end;
$$;

create function public.approve_platform_agent_content(
  p_actor_id uuid,
  p_expected_draft_hash text,
  p_reason text
)
returns table (audit_id bigint, content_hash text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  settings_row public.platform_settings%rowtype;
  merged jsonb;
  blockers text[];
  normalized_reason text := nullif(btrim(p_reason), '');
  logged_id bigint;
  merged_hash text;
begin
  perform app.assert_platform_content_admin(p_actor_id);
  if normalized_reason is null then raise exception 'PLATFORM_CONTENT_REASON_REQUIRED'; end if;
  select * into settings_row from public.platform_settings where singleton for update;
  if settings_row.singleton is null then raise exception 'PLATFORM_SETTINGS_ROW_REQUIRED'; end if;
  if settings_row.agent_content_draft is null then raise exception 'PLATFORM_CONTENT_DRAFT_REQUIRED'; end if;
  if settings_row.agent_content_draft_hash is distinct from p_expected_draft_hash then
    raise exception 'PLATFORM_CONTENT_DRAFT_STALE';
  end if;
  merged := settings_row.agent_content || settings_row.agent_content_draft;
  blockers := public.platform_agent_content_blockers(merged);
  if coalesce(array_length(blockers, 1), 0) > 0 then
    raise exception 'PLATFORM_CONTENT_NOT_APPROVABLE:%', array_to_string(blockers, ',');
  end if;
  merged_hash := encode(sha256(convert_to(merged::text, 'UTF8')), 'hex');
  update public.platform_settings set
    agent_content = merged,
    approved = true,
    agent_content_draft = null,
    agent_content_draft_hash = null,
    agent_content_draft_saved_at = null,
    agent_content_draft_saved_by = null,
    agent_content_approved_at = now(),
    agent_content_approved_by = p_actor_id,
    updated_at = now()
  where singleton;
  logged_id := app.write_audit_row(
    'platform_content.approved', p_actor_id, null, 'platform_settings', 'singleton',
    normalized_reason, jsonb_build_object(
      'draftHash', settings_row.agent_content_draft_hash,
      'contentHash', merged_hash,
      'previouslyApproved', settings_row.approved,
      'fields', (select coalesce(jsonb_agg(key order by key), '[]'::jsonb) from jsonb_object_keys(settings_row.agent_content_draft) key)
    )
  );
  return query select logged_id, merged_hash;
end;
$$;

revoke execute on function app.assert_platform_content_admin(uuid) from public, anon, authenticated;
revoke execute on function app.assert_platform_content_draft_shape(jsonb) from public, anon, authenticated;
revoke execute on function public.platform_agent_content_blockers(jsonb) from public, anon, authenticated;
revoke execute on function public.save_platform_agent_content_draft(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.approve_platform_agent_content(uuid, text, text) from public, anon, authenticated;
grant execute on function public.platform_agent_content_blockers(jsonb) to service_role;
grant execute on function public.save_platform_agent_content_draft(uuid, jsonb) to service_role;
grant execute on function public.approve_platform_agent_content(uuid, text, text) to service_role;

comment on function public.save_platform_agent_content_draft(uuid, jsonb) is
  'Stores owner-edited platform agent content as an unapproved draft beside the approved row and logs it. The actor id must come from a server-validated owner or admin session.';
comment on function public.approve_platform_agent_content(uuid, text, text) is
  'Copies the saved draft into agent_content, sets approved, and writes the platform_content.approved audit row. Refuses while any lead-facing slot is still a placeholder.';
