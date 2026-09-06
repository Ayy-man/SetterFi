-- `20261013000015_platform_content_drafts.sql` opened a draft lane for the platform agent content
-- but let a draft carry only the three prompt texts and the held replies. Approval, though, is
-- refused while *any* lead-facing slot is a placeholder, and that includes the two scope
-- deflections, the scope closing line and the STOP/HELP/START control copy that
-- `20260819000001_phase3_compliance_safety.sql` seeded as SETTERFI_DEMO_PLACEHOLDER_*. Nothing
-- could write those, so on a real database the approval was unreachable: the editor printed the
-- blockers and had no field for them.
--
-- This widens the draft shape to every slot the blockers function checks. Mission and
-- qualification stay out; they are compiled from the Brain draft. The blockers function and the
-- approve function are unchanged: they already read the merged row slot by slot.

create or replace function app.assert_platform_content_draft_shape(p_draft jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  draft_keys text[];
  held_keys text[];
  control_keys text[];
  slot text;
begin
  if p_draft is null or jsonb_typeof(p_draft) <> 'object' then
    raise exception 'PLATFORM_CONTENT_DRAFT_INVALID:shape';
  end if;
  select coalesce(array_agg(key order by key), '{}') into draft_keys from jsonb_object_keys(p_draft) key;
  if draft_keys <> array[
    'automatedExperienceDisclosure', 'controlCopy', 'heldReplies', 'platformFrame', 'roleBoundary',
    'scopeClosing', 'scopeDeflection1', 'scopeDeflection2'
  ] then
    raise exception 'PLATFORM_CONTENT_DRAFT_INVALID:keys';
  end if;
  foreach slot in array array[
    'automatedExperienceDisclosure', 'platformFrame', 'roleBoundary',
    'scopeDeflection1', 'scopeDeflection2', 'scopeClosing'
  ] loop
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
  if jsonb_typeof(p_draft -> 'controlCopy') <> 'object' then
    raise exception 'PLATFORM_CONTENT_DRAFT_INVALID:controlCopy';
  end if;
  select coalesce(array_agg(key order by key), '{}') into control_keys
  from jsonb_object_keys(p_draft -> 'controlCopy') key;
  if control_keys <> array['HELP', 'START', 'STOP'] then
    raise exception 'PLATFORM_CONTENT_DRAFT_INVALID:controlCopy.keys';
  end if;
  foreach slot in array control_keys loop
    if jsonb_typeof(p_draft -> 'controlCopy' -> slot) <> 'string'
      or nullif(btrim(p_draft -> 'controlCopy' ->> slot), '') is null then
      raise exception 'PLATFORM_CONTENT_DRAFT_INVALID:controlCopy.%', slot;
    end if;
  end loop;
end;
$$;

create or replace function public.save_platform_agent_content_draft(
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
    'scopeDeflection1', btrim(p_draft ->> 'scopeDeflection1'),
    'scopeDeflection2', btrim(p_draft ->> 'scopeDeflection2'),
    'scopeClosing', btrim(p_draft ->> 'scopeClosing'),
    'heldReplies', (
      select jsonb_object_agg(key, btrim(value))
      from jsonb_each_text(p_draft -> 'heldReplies')
    ),
    'controlCopy', (
      select jsonb_object_agg(key, btrim(value))
      from jsonb_each_text(p_draft -> 'controlCopy')
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

-- A draft saved under the old shape has no control copy or scope lines and can no longer be
-- approved as-is; clearing it makes the editor start from the live row instead of serving a draft
-- the parser refuses.
update public.platform_settings set
  agent_content_draft = null,
  agent_content_draft_hash = null,
  agent_content_draft_saved_at = null,
  agent_content_draft_saved_by = null
where singleton
  and agent_content_draft is not null
  and (agent_content_draft ? 'controlCopy') is false;

alter table public.platform_settings
  drop constraint platform_settings_agent_content_draft_shape_chk,
  add constraint platform_settings_agent_content_draft_shape_chk check (
    agent_content_draft is null
    or (
      jsonb_typeof(agent_content_draft) = 'object'
      and jsonb_typeof(agent_content_draft -> 'heldReplies') = 'object'
      and jsonb_typeof(agent_content_draft -> 'controlCopy') = 'object'
    )
  );

comment on function public.save_platform_agent_content_draft(uuid, jsonb) is
  'Stores owner-edited platform agent content (prompt texts, scope ladder, held replies, STOP/HELP/START copy) as an unapproved draft beside the approved row and logs it. The actor id must come from a server-validated owner or admin session.';
