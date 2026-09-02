-- The SetterFi account contract is supplied and approved outside the application. This migration
-- creates no legal copy: an absent published row means there is nothing a customer can accept.
set search_path = public, extensions;

create type public.account_terms_publication_state as enum ('draft', 'published');

create table public.account_terms_versions (
  id uuid primary key default gen_random_uuid(),
  version_key text not null unique check (nullif(btrim(version_key), '') is not null),
  terms_body text not null check (nullif(btrim(terms_body), '') is not null),
  privacy_body text not null check (nullif(btrim(privacy_body), '') is not null),
  -- sha256(terms_body || U+001F || privacy_body), computed by the publishing authority.
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  publication_state public.account_terms_publication_state not null default 'draft',
  published_at timestamptz,
  published_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  constraint account_terms_versions_publication_shape_chk check (
    (publication_state = 'published') = (published_at is not null and published_by is not null)
  ),
  constraint account_terms_versions_content_hash_chk check (
    content_hash = encode(extensions.digest(convert_to(terms_body || E'\x1f' || privacy_body, 'UTF8'), 'sha256'), 'hex')
  ),
  unique (version_key, content_hash)
);

create unique index account_terms_versions_one_published_uidx
  on public.account_terms_versions ((publication_state))
  where publication_state = 'published';

create or replace function app.reject_published_account_terms_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.publication_state = 'published' then
    raise exception 'ACCOUNT_TERMS_PUBLISHED_VERSION_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger account_terms_versions_published_immutable
before update or delete on public.account_terms_versions
for each row execute function app.reject_published_account_terms_mutation();

-- The intent is the durable pre-tenant record. Completion promotes this information into an
-- append-only account receipt in the same transaction that assigns the tenant id.
alter table public.signup_intents
  add column account_terms_version_key text,
  add column account_terms_content_hash text,
  add column account_terms_accepted_at timestamptz,
  add column account_terms_request_context jsonb,
  add constraint signup_intents_account_terms_shape_chk check (
    (account_terms_version_key is null
      and account_terms_content_hash is null
      and account_terms_accepted_at is null
      and account_terms_request_context is null)
    or
    (account_terms_version_key is not null
      and account_terms_content_hash ~ '^[0-9a-f]{64}$'
      and account_terms_accepted_at is not null
      and jsonb_typeof(account_terms_request_context) = 'object')
  ),
  add constraint signup_intents_account_terms_version_fkey
    foreign key (account_terms_version_key, account_terms_content_hash)
    references public.account_terms_versions(version_key, content_hash)
    on delete restrict;

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('account.terms.accepted', 'human', 'tenant', false, true,
    'Account terms acceptance recorded', 'Account terms acceptance recorded in the audit log')
on conflict (key) do nothing;

create table public.account_terms_acceptances (
  id uuid primary key default gen_random_uuid(),
  signup_intent_id uuid not null unique references public.signup_intents(id) on delete restrict,
  auth_user_id uuid not null unique,
  tenant_id uuid not null unique references public.tenants(id) on delete restrict,
  version_key text not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  accepted_at timestamptz not null,
  request_context jsonb not null check (jsonb_typeof(request_context) = 'object'),
  audit_id bigint not null unique references public.audit_log(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (version_key, content_hash)
    references public.account_terms_versions(version_key, content_hash)
    on delete restrict
);

alter table public.account_terms_versions enable row level security;
alter table public.account_terms_versions force row level security;
alter table public.account_terms_acceptances enable row level security;
alter table public.account_terms_acceptances force row level security;
revoke all on table public.account_terms_versions from public, anon, authenticated;
revoke all on table public.account_terms_acceptances from public, anon, authenticated;

-- This function receives request facts captured by the route, never a browser-supplied receipt.
-- It records only the currently published version and refuses a retry that tries to change history.
create or replace function public.record_signup_account_terms_acceptance(
  p_auth_user_id uuid,
  p_version_key text,
  p_content_hash text,
  p_request_context jsonb
)
returns table(version_key text, content_hash text, accepted_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  intent_row public.signup_intents%rowtype;
  version_row public.account_terms_versions%rowtype;
  accepted_at_value timestamptz := now();
begin
  if p_auth_user_id is null
    or nullif(btrim(p_version_key), '') is null
    or p_content_hash !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_request_context) <> 'object' then
    raise exception 'ACCOUNT_TERMS_ACCEPTANCE_INVALID';
  end if;

  select * into intent_row
  from public.signup_intents as signup_intent
  where signup_intent.auth_user_id = p_auth_user_id
  for update;
  if intent_row.id is null or intent_row.state = 'completed' then
    raise exception 'ACCOUNT_TERMS_SIGNUP_INTENT_REQUIRED';
  end if;

  select * into version_row
  from public.account_terms_versions as account_terms_version
  where account_terms_version.version_key = btrim(p_version_key)
    and account_terms_version.content_hash = p_content_hash
    and account_terms_version.publication_state = 'published';
  if version_row.id is null then
    raise exception 'ACCOUNT_TERMS_VERSION_NOT_PUBLISHED';
  end if;

  if intent_row.account_terms_version_key is not null and (
    intent_row.account_terms_version_key <> version_row.version_key
    or intent_row.account_terms_content_hash <> version_row.content_hash
  ) then
    raise exception 'ACCOUNT_TERMS_ACCEPTANCE_REPLAY_MISMATCH';
  end if;

  update public.signup_intents as signup_intent
  set account_terms_version_key = version_row.version_key,
      account_terms_content_hash = version_row.content_hash,
      account_terms_accepted_at = coalesce(signup_intent.account_terms_accepted_at, accepted_at_value),
      account_terms_request_context = coalesce(signup_intent.account_terms_request_context, p_request_context),
      updated_at = now()
  where signup_intent.id = intent_row.id
  returning signup_intent.account_terms_version_key,
    signup_intent.account_terms_content_hash,
    signup_intent.account_terms_accepted_at
  into version_key, content_hash, accepted_at;
  return next;
end;
$$;

revoke execute on function public.record_signup_account_terms_acceptance(uuid, text, text, jsonb)
  from public, anon, authenticated;

create or replace function app.materialize_signup_account_terms_acceptance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  written_audit_id bigint;
begin
  if old.tenant_id is null and new.tenant_id is not null
    and new.account_terms_version_key is not null then
    written_audit_id := app.write_audit_row(
      'account.terms.accepted', new.auth_user_id, new.tenant_id, 'account_terms_version',
      new.account_terms_version_key, null,
      jsonb_build_object(
        'version_key', new.account_terms_version_key,
        'content_hash', new.account_terms_content_hash,
        'accepted_at', new.account_terms_accepted_at,
        'request_context', new.account_terms_request_context
      )
    );
    insert into public.account_terms_acceptances (
      signup_intent_id, auth_user_id, tenant_id, version_key, content_hash, accepted_at,
      request_context, audit_id
    ) values (
      new.id, new.auth_user_id, new.tenant_id, new.account_terms_version_key,
      new.account_terms_content_hash, new.account_terms_accepted_at,
      new.account_terms_request_context, written_audit_id
    );
  end if;
  return new;
end;
$$;

create trigger signup_intents_materialize_account_terms_acceptance
after update on public.signup_intents
for each row execute function app.materialize_signup_account_terms_acceptance();
