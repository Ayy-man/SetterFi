-- Round 3 backend gap (Setup lane, "Backend gaps hit, for Codex round 2"): the A2P projection
-- carries `submittedAt` but nothing for when the carrier decided, so an approved carrier step
-- reads "Approved" with no date beside it while every other finished step on the Setup screen
-- carries one. `provisioning_steps.completed_at` is exactly that receipt timestamp -- the same
-- field the Setup lane's own notes describe every other step ticking on -- so this adds it to the
-- projection rather than inventing a second clock. PostgreSQL cannot add an OUT column with
-- `create or replace`, so the function is dropped and recreated, the same way the original
-- migration's sibling functions in this file already do for the same reason.

set search_path = public, extensions;

drop function if exists public.read_coach_a2p_registration(uuid);

create function public.read_coach_a2p_registration(
  p_expected_tenant uuid
)
returns table (
  submitted_at timestamptz,
  approved_at timestamptz,
  registration_state text,
  terminal_rejection boolean,
  terminal_code text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  sms_row public.provisioning_steps%rowtype;
  campaign_row public.provisioning_steps%rowtype;
  receipt_result text;
  receipt_code text;
  submitted_value text;
begin
  perform app.assert_not_impersonating();
  select * into sms_row
  from public.provisioning_steps step
  where step.tenant_id = p_expected_tenant and step.step_key = 'sms_live';
  if sms_row.id is null then return; end if;
  perform app.assert_expected_tenant(p_expected_tenant, sms_row.tenant_id, 'coach_a2p_registration');

  select * into campaign_row
  from public.provisioning_steps step
  where step.tenant_id = p_expected_tenant and step.step_key = 'a2p_campaign';
  submitted_value := coalesce(
    campaign_row.external_ref ->> 'submittedAt',
    campaign_row.external_ref ->> 'submitted_at'
  );

  select receipt.result, receipt.provider_code
  into receipt_result, receipt_code
  from public.a2p_probe_receipts receipt
  where receipt.tenant_id = p_expected_tenant
  order by receipt.observed_at desc, receipt.created_at desc
  limit 1;

  return query select
    case
      when submitted_value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then submitted_value::timestamptz
      else null
    end,
    -- Ticks on the same receipt every other finished step reads: null unless the carrier step is
    -- actually done, never a state word standing in for a date.
    case when sms_row.state = 'done' then sms_row.completed_at else null end,
    sms_row.state::text,
    sms_row.state = 'blocked' or coalesce(receipt_result = 'terminal_rejection', false),
    case
      when not (
        sms_row.state = 'blocked' or coalesce(receipt_result = 'terminal_rejection', false)
      ) then null
      when coalesce(sms_row.error_code, receipt_code, '') ~ '^[A-Za-z0-9_.:-]{1,100}$'
        then coalesce(sms_row.error_code, receipt_code)
      else 'A2P_TERMINAL_REJECTION'
    end;
end;
$$;

comment on function public.read_coach_a2p_registration(uuid) is
  'Service-only coach-safe registration clock and terminal classification projection scoped by expected tenant.';

revoke execute on function public.read_coach_a2p_registration(uuid)
  from public, anon, authenticated;
grant execute on function public.read_coach_a2p_registration(uuid) to service_role;
