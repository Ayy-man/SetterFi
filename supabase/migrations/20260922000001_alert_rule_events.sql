-- Four Phase 8 alert-board rules now have state owners that emit durable notifications. The
-- notification row remains service-owned and idempotent by the existing rule/recipient/source key.
set search_path = public, extensions;

-- Notification rows already exist, so this migration tightens their established service-only
-- write custody before routing these new source facts through the RPC below.
alter table public.notifications enable row level security;
alter table public.notifications force row level security;
revoke insert, update, delete on public.notifications from public, anon, authenticated;

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('notification.channel.disconnected', 'system', 'tenant', false, true,
    'Channel disconnection notification recorded', 'Channel disconnection notification recorded'),
  ('notification.a2p.cleared', 'system', 'tenant', false, true,
    'A2P clearance notification recorded', 'A2P clearance notification recorded'),
  ('notification.onboarding.stalled', 'system', 'tenant', false, true,
    'Onboarding stall notification recorded', 'Onboarding stall notification recorded'),
  ('notification.billing.payment_completed', 'system', 'tenant', false, true,
    'Completed payment notification recorded', 'Completed payment notification recorded')
on conflict (key) do nothing;

insert into public.alert_rules
  (event_key, scope, name, description, category, audience_roles, include_success_owner,
   include_billing_contact, default_destinations, suppressible, default_enabled,
   email_subject, email_body, slack_text)
values
  ('channel.disconnected', 'tenant', 'Channel disconnected',
   'A provider confirmed that a channel connection was revoked.', 'channel', '{coach}', true,
   false, '{bell}', true, true,
   'SETTERFI_DEMO_PLACEHOLDER_EMAIL_SUBJECT_CHANNEL_DISCONNECTED',
   'SETTERFI_DEMO_PLACEHOLDER_EMAIL_BODY_CHANNEL_DISCONNECTED',
   'SETTERFI_DEMO_PLACEHOLDER_SLACK_TEXT_CHANNEL_DISCONNECTED'),
  ('onboarding.a2p_cleared', 'tenant', 'A2P cleared',
   'A carrier confirmed A2P clearance for this account.', 'onboarding', '{coach}', true,
   false, '{bell}', true, true,
   'SETTERFI_DEMO_PLACEHOLDER_EMAIL_SUBJECT_ONBOARDING_A2P_CLEARED',
   'SETTERFI_DEMO_PLACEHOLDER_EMAIL_BODY_ONBOARDING_A2P_CLEARED',
   'SETTERFI_DEMO_PLACEHOLDER_SLACK_TEXT_ONBOARDING_A2P_CLEARED'),
  ('onboarding.stalled', 'tenant', 'Onboarding stalled',
   'A setup step exhausted its configured automatic retries and needs review.', 'onboarding',
   '{coach}', true, false, '{bell}', true, true,
   'SETTERFI_DEMO_PLACEHOLDER_EMAIL_SUBJECT_ONBOARDING_STALLED',
   'SETTERFI_DEMO_PLACEHOLDER_EMAIL_BODY_ONBOARDING_STALLED',
   'SETTERFI_DEMO_PLACEHOLDER_SLACK_TEXT_ONBOARDING_STALLED'),
  ('billing.payment_completed', 'tenant', 'Payment completed',
   'A subscription invoice was paid.', 'billing', '{coach}', false, true, '{bell}', true, true,
   'SETTERFI_DEMO_PLACEHOLDER_EMAIL_SUBJECT_BILLING_PAYMENT_COMPLETED',
   'SETTERFI_DEMO_PLACEHOLDER_EMAIL_BODY_BILLING_PAYMENT_COMPLETED',
   'SETTERFI_DEMO_PLACEHOLDER_SLACK_TEXT_BILLING_PAYMENT_COMPLETED')
on conflict (event_key, scope) do nothing;

create or replace function public.record_alert_rule_notification(
  p_notification_id uuid,
  p_tenant_id uuid,
  p_user_id uuid,
  p_recipient_email text,
  p_rule_id uuid,
  p_source_event_id text,
  p_event_key text,
  p_title text,
  p_body text,
  p_link text,
  p_is_test boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  notification_id uuid;
  rule_row public.alert_rules%rowtype;
begin
  if nullif(btrim(p_source_event_id), '') is null
    or nullif(btrim(p_event_key), '') is null
    or nullif(btrim(p_title), '') is null
    or nullif(btrim(p_body), '') is null
    or nullif(btrim(p_link), '') is null
    or left(p_link, 1) <> '/'
  then
    raise exception 'ALERT_RULE_NOTIFICATION_INPUT_INVALID';
  end if;
  if p_user_id is null and nullif(btrim(p_recipient_email), '') is null then
    raise exception 'ALERT_RULE_NOTIFICATION_RECIPIENT_REQUIRED';
  end if;

  select * into rule_row
  from public.alert_rules
  where id = p_rule_id and scope = 'tenant' and event_key = p_event_key;
  if rule_row.id is null then
    raise exception 'ALERT_RULE_NOTIFICATION_RULE_MISMATCH';
  end if;

  insert into public.notifications
    (id, tenant_id, user_id, recipient_email, rule_id, source_event_id, kind, title, body, link, is_test)
  values
    (coalesce(p_notification_id, gen_random_uuid()), p_tenant_id, p_user_id,
     nullif(btrim(p_recipient_email), ''), p_rule_id, p_source_event_id, p_event_key,
     p_title, p_body, p_link, p_is_test)
  on conflict do nothing
  returning id into notification_id;

  if notification_id is null then
    select id into notification_id
    from public.notifications
    where rule_id = p_rule_id
      and source_event_id = p_source_event_id
      and user_id is not distinct from p_user_id
      and recipient_email is not distinct from nullif(btrim(p_recipient_email), '');
  end if;
  if notification_id is null then
    raise exception 'ALERT_RULE_NOTIFICATION_DEDUPE_READ_FAILED';
  end if;
  return notification_id;
end;
$$;

revoke execute on function public.record_alert_rule_notification(
  uuid,uuid,uuid,text,uuid,text,text,text,text,text,boolean
) from public, anon, authenticated;
grant execute on function public.record_alert_rule_notification(
  uuid,uuid,uuid,text,uuid,text,text,text,text,text,boolean
) to service_role;
