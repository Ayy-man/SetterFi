-- Phase 8 operational custody and handover contracts.
--
-- This is the phase's sole migration. It completes support, notification delivery,
-- export audit, and dual-role affiliate foundations without activating a provider.
-- Newly-added enum values are compared through text inside this transaction so the
-- file applies identically to an existing ledger and to a fresh migration chain.

alter type public.webhook_provider add value 'resend';
alter type public.notification_delivery_status add value 'accepted' after 'sending';

-- ---------------------------------------------------------------------------
-- 1. Registry-backed notifications and unapproved delivery copy
-- ---------------------------------------------------------------------------

alter table public.notifications
  add column rule_id uuid references public.alert_rules(id) on delete restrict,
  add column source_event_id text,
  add column content jsonb not null default '{}'::jsonb,
  add column is_test boolean not null default false,
  add column recipient_email text,
  add constraint notifications_recipient_chk check (
    user_id is not null or nullif(btrim(recipient_email), '') is not null
  );

create unique index notifications_rule_recipient_source_uidx
  on public.notifications (rule_id, user_id, recipient_email, source_event_id) nulls not distinct
  where source_event_id is not null;
create index notifications_bell_idx
  on public.notifications (user_id, created_at desc, id desc);

alter table public.alert_rules
  add column email_subject text,
  add column email_body text,
  add column slack_text text;

update public.alert_rules
set email_subject = 'SETTERFI_DEMO_PLACEHOLDER_EMAIL_SUBJECT_' || upper(replace(event_key, '.', '_')),
    email_body = 'SETTERFI_DEMO_PLACEHOLDER_EMAIL_BODY_' || upper(replace(event_key, '.', '_')),
    slack_text = 'SETTERFI_DEMO_PLACEHOLDER_SLACK_TEXT_' || upper(replace(event_key, '.', '_'));

alter table public.notification_deliveries
  add column next_attempt_at timestamptz,
  add column lease_token uuid,
  add column lease_expires_at timestamptz,
  add column terminal_at timestamptz,
  add column last_error_code text;

update public.notification_deliveries
set next_attempt_at = case
      when status::text in ('pending', 'failed') then coalesce(last_attempt_at, created_at)
      else null
    end,
    terminal_at = case
      when status::text in ('delivered', 'unavailable') then coalesce(delivered_at, updated_at)
      else null
    end;

alter table public.notification_deliveries
  add constraint notification_delivery_lease_chk check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  add constraint notification_delivery_due_chk check (
    (status::text in ('pending', 'failed') and next_attempt_at is not null and terminal_at is null)
    or (status::text in ('sending', 'accepted') and next_attempt_at is null and terminal_at is null)
    or (status::text in ('delivered', 'unavailable') and next_attempt_at is null and (
      terminal_at is not null
      or (destination::text = 'bell' and status::text = 'delivered' and delivered_at is not null)
    ))
  ),
  add constraint notification_delivery_active_lease_chk check (
    (status::text = 'sending' and lease_token is not null)
    or (status::text <> 'sending' and lease_token is null)
  );

create index notification_deliveries_due_idx
  on public.notification_deliveries (status, next_attempt_at, created_at, id);

create table public.notification_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.notification_deliveries(id) on delete restrict,
  attempt_number int not null check (attempt_number > 0),
  worker_id uuid not null,
  destination public.notification_destination not null,
  recipient_email text,
  destination_url text,
  started_at timestamptz not null,
  finished_at timestamptz,
  outcome text check (outcome in ('accepted', 'delivered', 'retryable', 'failed', 'unavailable')),
  provider_reference text,
  error_code text,
  error_detail text,
  created_at timestamptz not null default now(),
  constraint notification_delivery_attempt_number_key unique (delivery_id, attempt_number),
  constraint notification_delivery_attempt_target_chk check (
    (destination::text = 'email' and nullif(btrim(recipient_email), '') is not null and destination_url is null)
    or (destination::text = 'slack' and nullif(btrim(destination_url), '') is not null and recipient_email is null)
  ),
  constraint notification_delivery_attempt_finish_chk check (
    (finished_at is null and outcome is null and provider_reference is null
      and error_code is null and error_detail is null)
    or (finished_at is not null and outcome is not null)
  ),
  constraint notification_delivery_attempt_outcome_chk check (
    outcome is null
    or (outcome in ('accepted', 'delivered') and nullif(btrim(provider_reference), '') is not null)
    or (outcome in ('retryable', 'failed', 'unavailable') and nullif(btrim(error_code), '') is not null)
  )
);
create index notification_delivery_attempts_delivery_idx
  on public.notification_delivery_attempts (delivery_id, attempt_number desc);

create or replace function app.enforce_notification_attempt_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'NOTIFICATION_DELIVERY_ATTEMPT_IMMUTABLE';
  end if;
  if old.finished_at is not null
    or new.finished_at is null
    or (to_jsonb(new) - array['finished_at','outcome','provider_reference','error_code','error_detail'])
      is distinct from
      (to_jsonb(old) - array['finished_at','outcome','provider_reference','error_code','error_detail']) then
    raise exception 'NOTIFICATION_DELIVERY_ATTEMPT_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger notification_delivery_attempts_immutable
before update or delete on public.notification_delivery_attempts
for each row execute function app.enforce_notification_attempt_immutable();

alter table public.notification_delivery_attempts enable row level security;
alter table public.notification_delivery_attempts force row level security;
create policy notification_delivery_attempts_recipient_read
  on public.notification_delivery_attempts for select to authenticated
  using (exists (
    select 1 from public.notification_deliveries delivery
    join public.notifications notification on notification.id = delivery.notification_id
    where delivery.id = notification_delivery_attempts.delivery_id
      and (notification.user_id = app.current_user_id() or app.owns_tenant(notification.tenant_id))
  ));
create policy notification_delivery_attempts_platform_read
  on public.notification_delivery_attempts for select to authenticated
  using (app.is_platform_operator());

revoke all on public.notification_delivery_attempts from public, anon, authenticated;
grant select on public.notification_delivery_attempts to authenticated;
grant select on public.notification_delivery_attempts to service_role;
revoke execute on function app.enforce_notification_attempt_immutable()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Phase 6 legacy removal after the replacement ledgers are present
-- ---------------------------------------------------------------------------

do $$
declare
  live_dependency text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'commission_ledger'
      and column_name = 'entry_kind'
  ) or not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'commission_payout_events'
  ) then
    raise exception 'PHASE6_COMMISSION_REPLACEMENT_MISSING';
  end if;

  select dependent.relname into live_dependency
  from pg_catalog.pg_depend dependency
  join pg_catalog.pg_rewrite rewrite on rewrite.oid = dependency.objid
  join pg_catalog.pg_class dependent on dependent.oid = rewrite.ev_class
  join pg_catalog.pg_attribute attribute
    on attribute.attrelid = dependency.refobjid and attribute.attnum = dependency.refobjsubid
  where dependency.refobjid in ('public.commission_ledger'::regclass, 'public.referrals'::regclass)
    and attribute.attname in ('status', 'paid_by', 'paid_at', 'updated_at', 'clawback')
    and dependent.relkind in ('v', 'm')
  limit 1;
  if live_dependency is not null then
    raise exception 'PHASE8_LEGACY_COLUMN_VIEW_DEPENDENCY:%', live_dependency;
  end if;
end
$$;

-- The generic timestamp trigger is incompatible with the immutable Phase 6 ledger and must go
-- before updated_at. Dropping status also drops commission_ledger_status_idx automatically;
-- the frozen Phase 6 comments on all five columns disappear with their columns.
drop trigger if exists set_updated_at on public.commission_ledger;
alter table public.commission_ledger
  drop column status,
  drop column paid_by,
  drop column paid_at,
  drop column updated_at;
alter table public.referrals drop column clawback;

-- ---------------------------------------------------------------------------
-- 3. Support, reassignment, preferences, queue claims, and receipts
-- ---------------------------------------------------------------------------

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values (
  'tenant.success_owner.reassigned', 'human', 'tenant', true, false,
  'Reassignment logged', 'Success owner reassignment recorded in the audit log'
);

create or replace function public.create_support_thread(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_subject text,
  p_body text
)
returns table (thread_id uuid, message_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.users%rowtype;
  tenant_row public.tenants%rowtype;
  created_thread uuid := gen_random_uuid();
  created_message uuid := gen_random_uuid();
begin
  perform app.assert_not_impersonating();
  if nullif(btrim(p_subject), '') is null then raise exception 'SUPPORT_SUBJECT_REQUIRED'; end if;
  if nullif(btrim(p_body), '') is null then raise exception 'SUPPORT_BODY_REQUIRED'; end if;
  select * into tenant_row from public.tenants where id = p_expected_tenant;
  perform app.assert_expected_tenant(p_expected_tenant, tenant_row.id, 'support_thread');
  select * into actor from public.users where id = p_actor_id;
  if actor.id is null or not (
    actor.tenant_id = p_expected_tenant and actor.role in ('coach', 'coach_member')
    or actor.role in ('owner', 'admin', 'success')
  ) then raise exception 'SUPPORT_ACTOR_FORBIDDEN'; end if;
  insert into public.support_threads (id, tenant_id, subject, created_by, is_test)
  values (created_thread, p_expected_tenant, btrim(p_subject), p_actor_id, tenant_row.is_demo);
  insert into public.support_messages
    (id, tenant_id, thread_id, author_id, body, internal, is_test)
  values (created_message, p_expected_tenant, created_thread, p_actor_id, btrim(p_body), false, tenant_row.is_demo);
  return query select created_thread, created_message;
end;
$$;

create or replace function public.append_support_message(
  p_expected_tenant uuid,
  p_thread_id uuid,
  p_actor_id uuid,
  p_body text,
  p_internal boolean
)
returns table (message_id uuid, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.users%rowtype;
  thread_row public.support_threads%rowtype;
  created_message uuid := gen_random_uuid();
  written_at timestamptz := now();
begin
  perform app.assert_not_impersonating();
  if nullif(btrim(p_body), '') is null then raise exception 'SUPPORT_BODY_REQUIRED'; end if;
  select * into thread_row from public.support_threads where id = p_thread_id for update;
  perform app.assert_expected_tenant(p_expected_tenant, thread_row.tenant_id, 'support_message');
  select * into actor from public.users where id = p_actor_id;
  if actor.id is null or not (
    actor.tenant_id = p_expected_tenant and actor.role in ('coach', 'coach_member')
    or actor.role in ('owner', 'admin', 'success')
  ) then raise exception 'SUPPORT_ACTOR_FORBIDDEN'; end if;
  if p_internal and actor.role not in ('owner', 'admin', 'success') then
    raise exception 'SUPPORT_INTERNAL_NOTE_FORBIDDEN';
  end if;
  insert into public.support_messages
    (id, tenant_id, thread_id, author_id, body, internal, is_test, created_at)
  values (
    created_message, p_expected_tenant, p_thread_id, p_actor_id, btrim(p_body),
    p_internal, thread_row.is_test, written_at
  );
  update public.support_threads set updated_at = written_at where id = p_thread_id;
  return query select created_message, written_at;
end;
$$;

create or replace function public.reassign_success_owner(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_assignee_id uuid,
  p_reason text
)
returns table (tenant_id uuid, success_owner uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.users%rowtype;
  assignee public.users%rowtype;
  tenant_row public.tenants%rowtype;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  if nullif(btrim(p_reason), '') is null then raise exception 'SUCCESS_OWNER_REASON_REQUIRED'; end if;
  select * into actor from public.users where id = p_actor_id;
  if actor.id is null or actor.role not in ('owner', 'admin', 'success') then
    raise exception 'SUCCESS_OWNER_ACTOR_FORBIDDEN';
  end if;
  select * into assignee from public.users where id = p_assignee_id;
  if assignee.id is null or assignee.role <> 'success' then
    raise exception 'SUCCESS_OWNER_ASSIGNEE_INVALID';
  end if;
  select * into tenant_row from public.tenants where id = p_expected_tenant for update;
  perform app.assert_expected_tenant(p_expected_tenant, tenant_row.id, 'success_owner');
  update public.tenants set success_owner = p_assignee_id where id = p_expected_tenant;
  logged_id := app.write_audit_row(
    'tenant.success_owner.reassigned', p_actor_id, p_expected_tenant, 'tenant',
    p_expected_tenant::text, p_reason,
    jsonb_build_object('prior_success_owner', tenant_row.success_owner, 'success_owner', p_assignee_id),
    p_assignee_id
  );
  return query select p_expected_tenant, p_assignee_id, logged_id;
end;
$$;

drop policy if exists notification_preferences_self_insert on public.notification_preferences;
drop policy if exists notification_preferences_self_update on public.notification_preferences;
revoke insert, update, delete on public.notification_preferences from authenticated;
grant select on public.notification_preferences to authenticated;

create or replace function public.set_notification_preference(
  p_user_id uuid,
  p_rule_id uuid,
  p_destination public.notification_destination,
  p_enabled boolean
)
returns table (preference_id uuid, enabled boolean, locked boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  rule_row public.alert_rules%rowtype;
  existing_id uuid;
  is_locked boolean;
begin
  perform app.assert_not_impersonating();
  if not exists (select 1 from public.users where id = p_user_id) then
    raise exception 'NOTIFICATION_PREFERENCE_USER_NOT_FOUND';
  end if;
  select * into rule_row from public.alert_rules where id = p_rule_id;
  if rule_row.id is null then raise exception 'NOTIFICATION_PREFERENCE_RULE_NOT_FOUND'; end if;
  is_locked := not rule_row.suppressible;
  if is_locked and not p_enabled then raise exception 'NOTIFICATION_PREFERENCE_LOCKED'; end if;
  insert into public.notification_preferences (user_id, rule_id, destination, enabled)
  values (p_user_id, p_rule_id, p_destination, p_enabled)
  on conflict (user_id, rule_id, destination)
  do update set enabled = excluded.enabled, updated_at = now()
  returning id into existing_id;
  return query select existing_id, p_enabled, is_locked;
end;
$$;

create or replace function public.claim_notification_deliveries(
  p_worker_id uuid,
  p_limit int,
  p_lease_seconds int,
  p_now timestamptz
)
returns table (
  delivery_id uuid,
  notification_id uuid,
  attempt_id uuid,
  attempt_number int,
  destination public.notification_destination,
  tenant_id uuid,
  user_id uuid,
  recipient_email text,
  destination_url text,
  event_key text,
  title text,
  body text,
  link text,
  is_test boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate record;
  new_attempt_id uuid;
  new_attempt_number int;
  resolved_email text;
  resolved_url text;
begin
  perform app.assert_not_impersonating();
  if p_worker_id is null then raise exception 'NOTIFICATION_WORKER_REQUIRED'; end if;
  if p_limit < 1 or p_limit > 100 then raise exception 'NOTIFICATION_CLAIM_LIMIT_INVALID'; end if;
  if p_lease_seconds < 1 or p_lease_seconds > 900 then raise exception 'NOTIFICATION_LEASE_INVALID'; end if;
  if p_now is null then raise exception 'NOTIFICATION_CLAIM_TIME_REQUIRED'; end if;

  for candidate in
    select delivery.*, notification.tenant_id, notification.user_id,
      notification.recipient_email as stored_recipient_email, notification.kind,
      notification.title, notification.body, notification.link, notification.is_test,
      account.email as account_email,
      tenant.alert_webhook_url as tenant_webhook_url,
      platform.alert_webhook_url as platform_webhook_url
    from public.notification_deliveries delivery
    join public.notifications notification on notification.id = delivery.notification_id
    left join public.users account on account.id = notification.user_id
    left join public.tenant_settings tenant on tenant.tenant_id = notification.tenant_id
    left join public.platform_settings platform on platform.singleton
    where delivery.destination::text in ('email', 'slack')
      and delivery.status::text in ('pending', 'failed')
      and delivery.terminal_at is null
      and delivery.next_attempt_at <= p_now
      and (delivery.lease_expires_at is null or delivery.lease_expires_at <= p_now)
      and delivery.attempts < 6
    order by delivery.next_attempt_at, delivery.created_at, delivery.id
    for update of delivery skip locked
    limit p_limit
  loop
    resolved_email := case
      when candidate.destination::text = 'email' and candidate.user_id is not null
        then candidate.account_email
      when candidate.destination::text = 'email'
        then candidate.stored_recipient_email
      else null
    end;
    resolved_url := case
      when candidate.destination::text = 'slack'
        then coalesce(nullif(btrim(candidate.tenant_webhook_url), ''), nullif(btrim(candidate.platform_webhook_url), ''))
      else null
    end;
    if candidate.destination::text = 'email' and nullif(btrim(resolved_email), '') is null then
      continue;
    end if;
    if candidate.destination::text = 'slack' and nullif(btrim(resolved_url), '') is null then
      continue;
    end if;

    new_attempt_number := candidate.attempts + 1;
    new_attempt_id := gen_random_uuid();
    insert into public.notification_delivery_attempts (
      id, delivery_id, attempt_number, worker_id, destination,
      recipient_email, destination_url, started_at
    ) values (
      new_attempt_id, candidate.id, new_attempt_number, p_worker_id, candidate.destination,
      resolved_email, resolved_url, p_now
    );
    update public.notification_deliveries
    set status = 'sending', attempts = new_attempt_number, last_attempt_at = p_now,
        next_attempt_at = null, lease_token = p_worker_id,
        lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
        last_error_code = null, error = null
    where id = candidate.id;

    delivery_id := candidate.id;
    notification_id := candidate.notification_id;
    attempt_id := new_attempt_id;
    attempt_number := new_attempt_number;
    destination := candidate.destination;
    tenant_id := candidate.tenant_id;
    user_id := candidate.user_id;
    recipient_email := resolved_email;
    destination_url := resolved_url;
    event_key := candidate.kind;
    title := candidate.title;
    body := candidate.body;
    link := candidate.link;
    is_test := candidate.is_test;
    return next;
  end loop;
end;
$$;

create or replace function public.finish_notification_delivery_attempt(
  p_worker_id uuid,
  p_delivery_id uuid,
  p_attempt_number int,
  p_outcome text,
  p_provider_reference text,
  p_error_code text,
  p_error_detail text,
  p_retry_at timestamptz,
  p_now timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  delivery_row public.notification_deliveries%rowtype;
  attempt_row public.notification_delivery_attempts%rowtype;
  terminal boolean := false;
begin
  perform app.assert_not_impersonating();
  select * into delivery_row from public.notification_deliveries
  where id = p_delivery_id for update;
  select * into attempt_row from public.notification_delivery_attempts
  where delivery_id = p_delivery_id and attempt_number = p_attempt_number for update;
  if delivery_row.id is null or attempt_row.id is null
    or attempt_row.worker_id <> p_worker_id
    or delivery_row.lease_token <> p_worker_id
    or delivery_row.attempts <> p_attempt_number
    or delivery_row.status::text <> 'sending'
    or attempt_row.finished_at is not null then
    raise exception 'NOTIFICATION_DELIVERY_ATTEMPT_STALE';
  end if;
  if p_outcome not in ('accepted', 'delivered', 'retryable', 'failed', 'unavailable') then
    raise exception 'NOTIFICATION_DELIVERY_OUTCOME_INVALID';
  end if;
  if p_outcome in ('accepted', 'delivered') and nullif(btrim(p_provider_reference), '') is null then
    raise exception 'NOTIFICATION_PROVIDER_REFERENCE_REQUIRED';
  end if;
  if p_outcome in ('retryable', 'failed', 'unavailable') and nullif(btrim(p_error_code), '') is null then
    raise exception 'NOTIFICATION_DELIVERY_ERROR_CODE_REQUIRED';
  end if;

  if p_outcome = 'accepted' then
    update public.notification_deliveries
    set status = p_outcome::public.notification_delivery_status,
        provider_reference = p_provider_reference, lease_token = null, lease_expires_at = null,
        next_attempt_at = null, last_error_code = null, error = null
    where id = p_delivery_id;
  elsif p_outcome = 'delivered' then
    terminal := true;
    update public.notification_deliveries
    set status = p_outcome::public.notification_delivery_status,
        provider_reference = p_provider_reference, delivered_at = p_now, terminal_at = p_now,
        lease_token = null, lease_expires_at = null, next_attempt_at = null,
        last_error_code = null, error = null
    where id = p_delivery_id;
  elsif p_outcome = 'retryable' and p_attempt_number < 6 then
    if p_retry_at is null or p_retry_at <= p_now then raise exception 'NOTIFICATION_RETRY_TIME_INVALID'; end if;
    update public.notification_deliveries
    set status = 'failed', next_attempt_at = p_retry_at,
        lease_token = null, lease_expires_at = null,
        last_error_code = p_error_code, error = p_error_detail
    where id = p_delivery_id;
  else
    terminal := true;
    update public.notification_deliveries
    set status = ('unavailable'::text)::public.notification_delivery_status,
        terminal_at = p_now, next_attempt_at = null,
        lease_token = null, lease_expires_at = null,
        last_error_code = p_error_code, error = p_error_detail
    where id = p_delivery_id;
  end if;

  update public.notification_delivery_attempts
  set finished_at = p_now, outcome = p_outcome,
      provider_reference = p_provider_reference, error_code = p_error_code,
      error_detail = p_error_detail
  where id = attempt_row.id;
end;
$$;

create or replace function public.apply_resend_delivery_receipt(
  p_provider_event_id text,
  p_provider_reference text,
  p_event_type text,
  p_occurred_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  receipt public.webhook_events%rowtype;
  delivery_row public.notification_deliveries%rowtype;
begin
  perform app.assert_not_impersonating();
  select * into receipt from public.webhook_events
  where provider::text = 'resend' and provider_event_id = p_provider_event_id
  for update;
  if receipt.id is null or not receipt.signature_verified then
    raise exception 'RESEND_SIGNED_RECEIPT_NOT_FOUND';
  end if;
  if receipt.event_type is distinct from p_event_type
    or receipt.payload #>> '{data,email_id}' is distinct from p_provider_reference then
    raise exception 'RESEND_RECEIPT_PAYLOAD_MISMATCH';
  end if;
  if receipt.status::text = 'processed' then return; end if;
  if p_event_type not in ('email.delivered', 'email.bounced') then
    raise exception 'RESEND_RECEIPT_EVENT_UNSUPPORTED';
  end if;
  select * into delivery_row from public.notification_deliveries
  where destination::text = 'email' and provider_reference = p_provider_reference
  for update;
  if delivery_row.id is null or delivery_row.status::text not in ('accepted', 'delivered', 'unavailable') then
    raise exception 'RESEND_DELIVERY_NOT_ACCEPTED';
  end if;
  if p_event_type = 'email.delivered' then
    update public.notification_deliveries
    set status = ('delivered'::text)::public.notification_delivery_status,
        delivered_at = coalesce(delivered_at, p_occurred_at),
        terminal_at = coalesce(terminal_at, p_occurred_at),
        next_attempt_at = null, lease_token = null, lease_expires_at = null
    where id = delivery_row.id;
  else
    update public.notification_deliveries
    set status = ('unavailable'::text)::public.notification_delivery_status,
        terminal_at = coalesce(terminal_at, p_occurred_at),
        next_attempt_at = null, lease_token = null, lease_expires_at = null,
        last_error_code = 'RESEND_BOUNCED', error = 'Signed provider bounce receipt'
    where id = delivery_row.id;
  end if;
  update public.webhook_events set status = 'processed', processed_at = now(), error = null
  where id = receipt.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Named-tenant platform export audit pairs
-- ---------------------------------------------------------------------------

drop function public.start_platform_export(uuid,text,jsonb,text[],text);
drop function public.finish_platform_export(uuid,bigint,bigint,bigint,text);

create function public.start_platform_export(
  p_actor_id uuid,
  p_resource text,
  p_filter jsonb,
  p_columns text[],
  p_reason text,
  p_subject_tenant uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_not_impersonating();
  perform app.phase2_assert_platform_actor(p_actor_id);
  if nullif(btrim(p_resource), '') is null then raise exception 'PLATFORM_EXPORT_RESOURCE_REQUIRED'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'PLATFORM_EXPORT_REASON_REQUIRED'; end if;
  if p_columns is null or cardinality(p_columns) = 0 then raise exception 'PLATFORM_EXPORT_COLUMNS_REQUIRED'; end if;
  if p_subject_tenant is not null and not exists (
    select 1 from public.tenants where id = p_subject_tenant
  ) then raise exception 'PLATFORM_EXPORT_TENANT_NOT_FOUND'; end if;
  return app.write_audit_row(
    'platform_export.started', p_actor_id, null,
    case when p_subject_tenant is null then 'platform_export' else 'platform_export_tenant' end,
    coalesce(p_subject_tenant::text, p_resource), p_reason,
    jsonb_build_object('resource', p_resource, 'filter', coalesce(p_filter, '{}'::jsonb), 'columns', p_columns)
  );
end;
$$;

create function public.finish_platform_export(
  p_actor_id uuid,
  p_export_id bigint,
  p_rows bigint,
  p_bytes bigint,
  p_reason text,
  p_subject_tenant uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  started public.audit_log%rowtype;
  expected_type text;
begin
  perform app.assert_not_impersonating();
  perform app.phase2_assert_platform_actor(p_actor_id);
  if p_rows < 0 then raise exception 'PLATFORM_EXPORT_ROW_COUNT_INVALID'; end if;
  if p_bytes < 0 then raise exception 'PLATFORM_EXPORT_BYTE_COUNT_INVALID'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'PLATFORM_EXPORT_REASON_REQUIRED'; end if;
  expected_type := case when p_subject_tenant is null then 'platform_export' else 'platform_export_tenant' end;
  select * into started from public.audit_log
  where id = p_export_id and action = 'platform_export.started' for update;
  if started.id is null or started.actor_id <> p_actor_id or started.tenant_id is not null
    or started.target_type <> expected_type
    or (p_subject_tenant is not null and started.target_id <> p_subject_tenant::text)
    or (p_subject_tenant is null and started.target_id is distinct from started.payload ->> 'resource') then
    raise exception 'PLATFORM_EXPORT_START_NOT_FOUND';
  end if;
  if exists (
    select 1 from public.audit_log finished
    where finished.action = 'platform_export.finished'
      and (finished.payload ->> 'started_audit_id')::bigint = p_export_id
  ) then raise exception 'PLATFORM_EXPORT_ALREADY_FINISHED'; end if;
  return app.write_audit_row(
    'platform_export.finished', p_actor_id, null, started.target_type, started.target_id, p_reason,
    jsonb_build_object(
      'started_audit_id', p_export_id, 'resource', started.payload ->> 'resource',
      'row_count', p_rows, 'byte_count', p_bytes
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Database-authenticated dual-role affiliate capability
-- ---------------------------------------------------------------------------

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  app_user record;
  active_session record;
  claims jsonb;
  metadata jsonb;
  has_affiliate_access boolean;
begin
  select role, tenant_id into app_user
  from public.users
  where id = (event ->> 'user_id')::uuid;
  if app_user.role is null then return event; end if;

  select exists (
    select 1 from public.affiliates where user_id = (event ->> 'user_id')::uuid
  ) into has_affiliate_access;
  claims := coalesce(event -> 'claims', '{}'::jsonb);
  metadata := coalesce(claims -> 'app_metadata', '{}'::jsonb)
    - 'role' - 'tenant_id' - 'affiliate_access'
    - 'impersonating_tenant' - 'impersonation_session_id';
  metadata := metadata || jsonb_strip_nulls(jsonb_build_object(
    'role', app_user.role,
    'tenant_id', app_user.tenant_id,
    'affiliate_access', has_affiliate_access
  ));

  if app_user.role in ('owner', 'admin', 'success') then
    select id into active_session
    from public.impersonation_sessions
    where actor_id = (event ->> 'user_id')::uuid
      and ended_at is null and expires_at > now()
    order by started_at desc, id desc limit 1;
    if active_session.id is not null then
      metadata := metadata || jsonb_build_object('impersonation_session_id', active_session.id);
    end if;
  end if;
  claims := jsonb_set(claims, '{app_metadata}', metadata);
  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Explicit function custody
-- ---------------------------------------------------------------------------

revoke execute on function public.create_support_thread(uuid,uuid,text,text)
  from public, anon, authenticated;
revoke execute on function public.append_support_message(uuid,uuid,uuid,text,boolean)
  from public, anon, authenticated;
revoke execute on function public.reassign_success_owner(uuid,uuid,uuid,text)
  from public, anon, authenticated;
revoke execute on function public.set_notification_preference(uuid,uuid,public.notification_destination,boolean)
  from public, anon, authenticated;
revoke execute on function public.claim_notification_deliveries(uuid,int,int,timestamptz)
  from public, anon, authenticated;
revoke execute on function public.finish_notification_delivery_attempt(uuid,uuid,int,text,text,text,text,timestamptz,timestamptz)
  from public, anon, authenticated;
revoke execute on function public.apply_resend_delivery_receipt(text,text,text,timestamptz)
  from public, anon, authenticated;
revoke execute on function public.start_platform_export(uuid,text,jsonb,text[],text,uuid)
  from public, anon, authenticated;
revoke execute on function public.finish_platform_export(uuid,bigint,bigint,bigint,text,uuid)
  from public, anon, authenticated;
revoke execute on function public.custom_access_token_hook(jsonb)
  from public, anon, authenticated;

grant execute on function public.create_support_thread(uuid,uuid,text,text) to service_role;
grant execute on function public.append_support_message(uuid,uuid,uuid,text,boolean) to service_role;
grant execute on function public.reassign_success_owner(uuid,uuid,uuid,text) to service_role;
grant execute on function public.set_notification_preference(uuid,uuid,public.notification_destination,boolean) to service_role;
grant execute on function public.claim_notification_deliveries(uuid,int,int,timestamptz) to service_role;
grant execute on function public.finish_notification_delivery_attempt(uuid,uuid,int,text,text,text,text,timestamptz,timestamptz) to service_role;
grant execute on function public.apply_resend_delivery_receipt(text,text,text,timestamptz) to service_role;
grant execute on function public.start_platform_export(uuid,text,jsonb,text[],text,uuid) to service_role;
grant execute on function public.finish_platform_export(uuid,bigint,bigint,bigint,text,uuid) to service_role;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
