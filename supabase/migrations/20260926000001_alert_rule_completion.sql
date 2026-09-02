-- Complete the agent-inactivity alert with a service-owned state query and durable notification
-- path. `messages` is the authority: only persisted outbound agent rows prove agent activity.
-- A tenant without one is not an inactivity episode and is deliberately omitted.
set search_path = public, extensions;

alter table public.job_receipts
  drop constraint if exists job_receipts_job_key_check;
alter table public.job_receipts
  add constraint job_receipts_job_key_check check (job_key in (
    'a2p-probe', 'agent-inactivity-sweep', 'appointment-reconcile', 'billing-allowances',
    'billing-cost-rollup', 'compliance-reconcile', 'contact-deletion-recovery', 'engine-evals',
    'followups', 'ghl-install-reconcile', 'inbound-recovery', 'notification-deliveries',
    'outbound-reconciliation', 'provisioning-run', 'stripe-webhooks', 'tenant-health-rollup'
  ));

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('notification.agent.inactive_72h', 'system', 'tenant', false, true,
   'Agent inactivity notification recorded', 'Agent inactivity notification recorded')
on conflict (key) do nothing;

insert into public.alert_rules
  (event_key, scope, name, description, category, audience_roles, include_success_owner,
   include_billing_contact, default_destinations, suppressible, default_enabled,
   email_subject, email_body, slack_text)
values
  ('agent.inactive_72h', 'tenant', 'Agent inactive 72h',
   'The agent has not sent a production message for at least seventy-two hours.', 'agent', '{coach}',
   true, false, '{bell}', true, true,
   'SETTERFI_DEMO_PLACEHOLDER_EMAIL_SUBJECT_AGENT_INACTIVE_72H',
   'SETTERFI_DEMO_PLACEHOLDER_EMAIL_BODY_AGENT_INACTIVE_72H',
   'SETTERFI_DEMO_PLACEHOLDER_SLACK_TEXT_AGENT_INACTIVE_72H')
on conflict (event_key, scope) do nothing;

create or replace function public.list_agent_inactivity_candidates(p_inactive_before timestamptz)
returns table (
  tenant_id uuid,
  last_agent_message_id uuid,
  last_agent_message_at timestamptz,
  is_test boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    message.tenant_id,
    message.id,
    message.created_at,
    message.is_test
  from public.messages as message
  join lateral (
    select latest.id
    from public.messages as latest
    where latest.tenant_id = message.tenant_id
      and latest.direction = 'out'
      and latest.author = 'agent'
      and latest.is_test = message.is_test
    order by latest.created_at desc, latest.id desc
    limit 1
  ) as newest on newest.id = message.id
  where message.direction = 'out'
    and message.author = 'agent'
    and message.created_at <= p_inactive_before;
$$;

revoke execute on function public.list_agent_inactivity_candidates(timestamptz)
  from public, anon, authenticated;
grant execute on function public.list_agent_inactivity_candidates(timestamptz) to service_role;
