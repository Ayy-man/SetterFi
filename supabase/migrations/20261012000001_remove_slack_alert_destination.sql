-- Remove the Slack alert destination.
--
-- Slack was never requested. It entered the spec from an access-list line in the client intake
-- ("Tier 1 access granted: project email, Supabase, Slack, OpenRouter"), which was the client
-- handing over logins rather than asking for a feature, and became "alerts can go to a Slack
-- webhook" somewhere between that line and docs/PRODUCT.md. docs/CLIENT-QUESTIONS-R2.md section 4
-- carries the question in writing -- "it was specified before anyone checked whether your team uses
-- it" -- and it was never asked and never answered. Alerts keep the two destinations that were
-- actually asked for: the in-app bell and email.
--
-- Nothing shipped routes to Slack. alert_rules.default_destinations defaults to '{bell}' and every
-- migration-seeded rule takes bell or email. The single row that targets it is the hand-inserted
-- 'phase8.demo.slack' rule that scripts/seed-phase8-demo.mjs writes and no migration creates, which
-- is item A5 on the launch checklist; deleting it here is what that item asks for.
--
-- Postgres cannot drop a value from an enum, so notification_destination is rebuilt without it.
-- That forces the two functions carrying the type in their signature to be dropped and recreated.
-- Their bodies are unchanged apart from the removal of the Slack branches.

-- ---------------------------------------------------------------------------
-- 1. Remove every row that targets Slack. Children first: notification_delivery_attempts
--    references notification_deliveries with on delete restrict, so it cannot be left to cascade.
--
--    That table is append-only: `notification_delivery_attempts_immutable` raises on any delete,
--    which is what keeps the attempt ledger honest. The rows removed here are demo residue from the
--    hand-inserted 'phase8.demo.slack' rule, and they cannot survive the enum rebuild in section 3
--    because 'slack' has no value left to cast to. So the guard comes off for the deletes and goes
--    back on unchanged at the end of section 3, and nothing else may run between the two.
-- ---------------------------------------------------------------------------

drop trigger if exists notification_delivery_attempts_immutable
  on public.notification_delivery_attempts;

delete from public.notification_delivery_attempts
where destination = 'slack';

delete from public.notification_deliveries
where destination = 'slack';

-- The demo rule's own notifications and their deliveries, which may carry a bell row too. These
-- follow notifications.rule_id rather than notifications.kind: the seeder writes the rule's
-- notifications under kinds of its own choosing ('phase8.slack.retry' is the one in the hosted
-- data), so matching on kind misses them and the rule delete then trips notifications_rule_id_fkey.
delete from public.notification_delivery_attempts
where delivery_id in (
  select delivery.id
  from public.notification_deliveries delivery
  join public.notifications notification on notification.id = delivery.notification_id
  join public.alert_rules rule on rule.id = notification.rule_id
  where rule.event_key = 'phase8.demo.slack'
);

delete from public.notification_deliveries
where notification_id in (
  select notification.id
  from public.notifications notification
  join public.alert_rules rule on rule.id = notification.rule_id
  where rule.event_key = 'phase8.demo.slack'
);

delete from public.notifications
where rule_id in (select id from public.alert_rules where event_key = 'phase8.demo.slack');

-- notification_preferences.rule_id cascades on rule delete; this clears Slack preferences held
-- against rules that survive.
delete from public.notification_preferences where destination = 'slack';

delete from public.alert_rules where event_key = 'phase8.demo.slack';

-- ---------------------------------------------------------------------------
-- 2. Strip Slack out of the rule default arrays before the type is rebuilt. A rule left with an
--    empty array would silently stop producing deliveries, so anything emptied falls back to the
--    bell, which is the column default and the destination that needs no provider.
-- ---------------------------------------------------------------------------

update public.alert_rules
set default_destinations = array_remove(default_destinations, 'slack')
where 'slack' = any (default_destinations);

update public.alert_rules
set default_destinations = '{bell}'
where cardinality(default_destinations) = 0;

-- ---------------------------------------------------------------------------
-- 3. Rebuild the enum without 'slack'.
-- ---------------------------------------------------------------------------

drop function if exists public.set_notification_preference(
  uuid, uuid, public.notification_destination, boolean);
drop function if exists public.claim_notification_deliveries(uuid, int, int, timestamptz);

-- The attempt target check names the old type through its destination column, so it is dropped
-- before the column is retyped and recreated afterwards without the Slack arm.
alter table public.notification_delivery_attempts
  drop constraint if exists notification_delivery_attempt_target_chk;

-- The delivery receipt check carries a literal bound to the old enum (`destination = 'bell'`), and
-- a check constraint is not re-parsed when the column is retyped, so the retype would fail on
-- `operator does not exist: notification_destination_next = notification_destination`. It is
-- dropped here and recreated unchanged at the end of this section.
alter table public.notification_deliveries
  drop constraint if exists notification_delivery_receipt_chk;

create type public.notification_destination_next as enum ('bell', 'email');

alter table public.alert_rules
  alter column default_destinations drop default,
  alter column default_destinations type public.notification_destination_next[]
    using default_destinations::text[]::public.notification_destination_next[],
  alter column default_destinations set default '{bell}';

alter table public.notification_preferences
  alter column destination type public.notification_destination_next
    using destination::text::public.notification_destination_next;

alter table public.notification_deliveries
  alter column destination type public.notification_destination_next
    using destination::text::public.notification_destination_next;

alter table public.notification_delivery_attempts
  alter column destination type public.notification_destination_next
    using destination::text::public.notification_destination_next;

drop type public.notification_destination;
alter type public.notification_destination_next rename to notification_destination;

alter table public.notification_delivery_attempts
  add constraint notification_delivery_attempt_target_chk check (
    destination::text = 'email'
    and nullif(btrim(recipient_email), '') is not null
    and destination_url is null
  );

-- Recreated exactly as `20260817000002_phase1_review_fixes.sql` left it. Bell delivery is
-- database-local and has no provider receipt, which is the whole point of the constraint.
alter table public.notification_deliveries
  add constraint notification_delivery_receipt_chk check (
    (status = 'delivered'
      and delivered_at is not null
      and (destination = 'bell' or provider_reference is not null))
    or (status <> 'delivered' and delivered_at is null)
  );

-- The append-only guard goes back on, recreated exactly as
-- `20260824000001_phase8_operate_handover.sql` declared it. Its function body never named the enum,
-- so the function itself needs no change.
create trigger notification_delivery_attempts_immutable
before update or delete on public.notification_delivery_attempts
for each row execute function app.enforce_notification_attempt_immutable();

-- ---------------------------------------------------------------------------
-- 4. Drop the columns that existed only to carry Slack.
-- ---------------------------------------------------------------------------

alter table public.alert_rules drop column if exists slack_text;
alter table public.tenant_settings drop column if exists alert_webhook_url;
alter table public.platform_settings drop column if exists alert_webhook_url;

-- ---------------------------------------------------------------------------
-- 5. Recreate the two functions. set_notification_preference is byte-identical apart from the
--    rebuilt type in its signature; claim_notification_deliveries loses the webhook joins, the
--    resolved_url branch and the Slack skip, and destination_url is now always null.
-- ---------------------------------------------------------------------------

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
      account.email as account_email
    from public.notification_deliveries delivery
    join public.notifications notification on notification.id = delivery.notification_id
    left join public.users account on account.id = notification.user_id
    where delivery.destination::text = 'email'
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
      when candidate.user_id is not null then candidate.account_email
      else candidate.stored_recipient_email
    end;
    if nullif(btrim(resolved_email), '') is null then
      continue;
    end if;

    new_attempt_number := candidate.attempts + 1;
    new_attempt_id := gen_random_uuid();
    insert into public.notification_delivery_attempts (
      id, delivery_id, attempt_number, worker_id, destination,
      recipient_email, destination_url, started_at
    ) values (
      new_attempt_id, candidate.id, new_attempt_number, p_worker_id, candidate.destination,
      resolved_email, null, p_now
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
    destination_url := null;
    event_key := candidate.kind;
    title := candidate.title;
    body := candidate.body;
    link := candidate.link;
    is_test := candidate.is_test;
    return next;
  end loop;
end;
$$;

revoke all on function public.set_notification_preference(
  uuid, uuid, public.notification_destination, boolean) from public;
grant execute on function public.set_notification_preference(
  uuid, uuid, public.notification_destination, boolean) to service_role;

revoke all on function public.claim_notification_deliveries(uuid, int, int, timestamptz) from public;
grant execute on function public.claim_notification_deliveries(uuid, int, int, timestamptz)
  to service_role;
