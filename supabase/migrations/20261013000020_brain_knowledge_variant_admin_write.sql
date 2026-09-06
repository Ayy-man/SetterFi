-- Brain knowledge question variants: the admin write path.
--
-- 20261013000014 created `brain_knowledge_entry_variants`, taught publish to copy it and ranking
-- to read it, and left no way to add a row outside SQL. This migration registers the audit action
-- and adds the one RPC that inserts a variant and its audit row in a single transaction, so a
-- variant can never exist without the row that says who added it. The table's own rules stand:
-- rows are immutable, and only the service client can write, so the route calls this through the
-- service role after the actor has been checked.

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('brain.knowledge.variant_added', 'human', 'platform', false, false,
    'Phrasing logged', 'Knowledge phrasing recorded in the audit log')
on conflict (key) do nothing;

create or replace function public.add_brain_knowledge_entry_variant(
  p_actor_id uuid,
  p_entry_id uuid,
  p_variant text,
  p_embedding vector(1536)
)
returns table (variant_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  entry public.brain_knowledge_entries%rowtype;
  cleaned text := btrim(p_variant);
  new_variant_id uuid;
  written_audit_id bigint;
begin
  perform app.phase2_assert_platform_actor(p_actor_id);
  if nullif(cleaned, '') is null then raise exception 'BRAIN_VARIANT_TEXT_REQUIRED'; end if;
  if length(cleaned) > 500 then raise exception 'BRAIN_VARIANT_TOO_LONG'; end if;
  if p_embedding is null then raise exception 'BRAIN_VARIANT_EMBEDDING_REQUIRED'; end if;

  select * into entry from public.brain_knowledge_entries where id = p_entry_id for share;
  if entry.id is null then raise exception 'BRAIN_KNOWLEDGE_ENTRY_NOT_FOUND'; end if;
  -- A variant that only restates the question adds a second embedding of the same text, which
  -- changes nothing about ranking and reads as a duplicate on the screen.
  if lower(btrim(entry.question)) = lower(cleaned) then
    raise exception 'BRAIN_VARIANT_MATCHES_QUESTION';
  end if;
  if exists (
    select 1 from public.brain_knowledge_entry_variants existing
    where existing.entry_id = entry.id and lower(existing.variant) = lower(cleaned)
  ) then
    raise exception 'BRAIN_VARIANT_DUPLICATE';
  end if;

  insert into public.brain_knowledge_entry_variants (entry_id, variant, embedding, created_by)
  values (entry.id, cleaned, p_embedding, p_actor_id)
  returning id into new_variant_id;

  written_audit_id := app.write_audit_row(
    'brain.knowledge.variant_added', p_actor_id, null, 'brain_knowledge_entry', entry.id::text,
    null, jsonb_build_object(
      'variant_id', new_variant_id,
      'variant', cleaned,
      'question', entry.question
    )
  );
  return query select new_variant_id, written_audit_id;
end;
$$;

revoke execute on function public.add_brain_knowledge_entry_variant(uuid, uuid, text, vector)
  from public, anon, authenticated;
grant execute on function public.add_brain_knowledge_entry_variant(uuid, uuid, text, vector)
  to service_role;
