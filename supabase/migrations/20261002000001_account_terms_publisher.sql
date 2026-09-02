-- The write half of the account-terms registry. `20260925000002` built the table, the acceptance
-- RPC and the read path; nothing could put a row in it, so `SETTERFI_ACCOUNT_TERMS_LIVE` could
-- never be switched on without every signup 400ing against an empty registry.
--
-- This migration adds no legal copy and invents no state. A draft is created with the copy the
-- publishing authority supplies, and publishing flips that same row. There is deliberately no
-- unpublish or supersede: `account_terms_versions` has no column that could record one, and the
-- one-published partial unique index is left to refuse a second publication out loud.
set search_path = public, extensions;

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('account.terms.drafted', 'human', 'platform', false, false,
    'Terms draft logged', 'Account terms draft recorded in the audit log'),
  ('account.terms.published', 'human', 'platform', false, false,
    'Terms publication logged', 'Account terms publication recorded in the audit log')
on conflict (key) do nothing;

-- Publishing the contract every coach signs is an owner/admin act. The route authorizes too; this
-- is the half that survives a route being called from somewhere nobody reviewed.
create or replace function app.assert_account_terms_actor(p_actor_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.users%rowtype;
begin
  if p_actor_id is null then raise exception 'ACCOUNT_TERMS_ACTOR_REQUIRED'; end if;
  select * into actor from public.users where id = p_actor_id;
  if actor.id is null or actor.role not in ('owner', 'admin') then
    raise exception 'ACCOUNT_TERMS_ACTOR_FORBIDDEN';
  end if;
end;
$$;

/**
 * Creates one draft. The hash is supplied by the caller and checked twice: once by this function's
 * shape guard, and once by the table's own CHECK, which recomputes sha256(terms || U+001F ||
 * privacy) in the database. A draft whose hash does not describe its bodies cannot exist.
 */
create or replace function public.create_account_terms_draft(
  p_actor_id uuid,
  p_version_key text,
  p_terms_body text,
  p_privacy_body text,
  p_content_hash text
)
returns table (terms_version_id uuid, terms_version_key text, terms_content_hash text, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_key text := nullif(btrim(p_version_key), '');
  created_id uuid;
  logged_id bigint;
begin
  perform app.assert_account_terms_actor(p_actor_id);
  if normalized_key is null
    or nullif(btrim(p_terms_body), '') is null
    or nullif(btrim(p_privacy_body), '') is null
    or p_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'ACCOUNT_TERMS_DRAFT_INVALID';
  end if;

  begin
    insert into public.account_terms_versions
      (version_key, terms_body, privacy_body, content_hash, publication_state)
    values (normalized_key, p_terms_body, p_privacy_body, p_content_hash, 'draft')
    returning id into created_id;
  exception
    when unique_violation then raise exception 'ACCOUNT_TERMS_VERSION_KEY_TAKEN';
    when check_violation then raise exception 'ACCOUNT_TERMS_CONTENT_HASH_MISMATCH';
  end;

  logged_id := app.write_audit_row(
    'account.terms.drafted', p_actor_id, null, 'account_terms_version', normalized_key, null,
    jsonb_build_object('version_key', normalized_key, 'content_hash', p_content_hash)
  );

  terms_version_id := created_id;
  terms_version_key := normalized_key;
  terms_content_hash := p_content_hash;
  audit_id := logged_id;
  return next;
end;
$$;

/**
 * Publishes one existing draft, named by the exact pair the admin was shown. A second publication
 * is refused by `account_terms_versions_one_published_uidx` and reaches the caller as a named code
 * rather than a generic failure, because "another version is already published" is a fact an admin
 * needs stated. Nothing here can unpublish the standing version.
 */
create or replace function public.publish_account_terms(
  p_actor_id uuid,
  p_version_key text,
  p_content_hash text
)
returns table (
  terms_version_id uuid,
  terms_version_key text,
  terms_content_hash text,
  terms_published_at timestamptz,
  audit_id bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_key text := nullif(btrim(p_version_key), '');
  published_row public.account_terms_versions%rowtype;
  logged_id bigint;
begin
  perform app.assert_account_terms_actor(p_actor_id);
  if normalized_key is null or p_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'ACCOUNT_TERMS_PUBLISH_INVALID';
  end if;

  begin
    update public.account_terms_versions as account_terms_version
    set publication_state = 'published',
        published_at = now(),
        published_by = p_actor_id
    where account_terms_version.version_key = normalized_key
      and account_terms_version.content_hash = p_content_hash
      and account_terms_version.publication_state = 'draft'
    returning * into published_row;
  exception
    when unique_violation then raise exception 'ACCOUNT_TERMS_ALREADY_PUBLISHED';
  end;
  if published_row.id is null then raise exception 'ACCOUNT_TERMS_DRAFT_NOT_FOUND'; end if;

  logged_id := app.write_audit_row(
    'account.terms.published', p_actor_id, null, 'account_terms_version', normalized_key, null,
    jsonb_build_object(
      'version_key', normalized_key,
      'content_hash', p_content_hash,
      'published_at', published_row.published_at
    )
  );

  terms_version_id := published_row.id;
  terms_version_key := published_row.version_key;
  terms_content_hash := published_row.content_hash;
  terms_published_at := published_row.published_at;
  audit_id := logged_id;
  return next;
end;
$$;

revoke execute on function app.assert_account_terms_actor(uuid) from public, anon, authenticated;
revoke execute on function public.create_account_terms_draft(uuid, text, text, text, text)
  from public, anon, authenticated;
revoke execute on function public.publish_account_terms(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.create_account_terms_draft(uuid, text, text, text, text) to service_role;
grant execute on function public.publish_account_terms(uuid, text, text) to service_role;
grant select on table public.account_terms_versions to service_role;
