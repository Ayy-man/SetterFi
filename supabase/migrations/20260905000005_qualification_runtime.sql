-- One inbound lead row may advance qualification once. The receipt is the replay boundary: an
-- outbound retry can safely call this RPC again, while a changed command for the same inbound is
-- rejected instead of silently rewriting the lead's qualification.

create table public.qualification_turn_receipts (
  inbound_message_id uuid primary key references public.messages(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  command_hash text not null check (command_hash ~ '^[0-9a-f]{64}$'),
  command_payload jsonb not null,
  created_at timestamptz not null default now()
);

create index qualification_turn_receipts_tenant_created_idx
  on public.qualification_turn_receipts (tenant_id, created_at desc);

alter table public.qualification_turn_receipts enable row level security;
alter table public.qualification_turn_receipts force row level security;
revoke all on table public.qualification_turn_receipts from public, anon, authenticated, service_role;

create or replace function public.apply_qualification_turn(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_contact_id uuid,
  p_inbound_message_id uuid,
  p_expected_current_step text,
  p_expected_current_step_asks integer,
  p_step_id text,
  p_next_step_id text,
  p_next_step_asks integer,
  p_field text,
  p_value jsonb,
  p_outcome public.outcome,
  p_dq_reason text,
  p_rule_id text
)
returns table (
  replayed boolean,
  current_step text,
  current_step_asks integer,
  qualification_outcome public.outcome,
  conversation_status public.convo_status
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  contact_row public.contacts%rowtype;
  existing_receipt public.qualification_turn_receipts%rowtype;
  payload jsonb;
  payload_hash text;
  inserted_count integer;
begin
  if p_expected_current_step_asks < 0 or p_expected_current_step_asks > 3
    or p_next_step_asks < 0 or p_next_step_asks > 3
    or (p_field is null) <> (p_value is null)
    or (p_field is not null and p_field not in
      ('credit', 'goal', 'timeline', 'businessStage', 'annualRevenue'))
    or (p_outcome is not null and nullif(btrim(p_rule_id), '') is null)
    or (p_outcome in ('HARD_DQ'::public.outcome, 'SOFT_DQ'::public.outcome)
      and nullif(btrim(p_dq_reason), '') is null)
    or (p_outcome = 'BOOK'::public.outcome and p_dq_reason is not null) then
    raise exception 'QUALIFICATION_TURN_INPUT_INVALID';
  end if;

  payload := jsonb_build_object(
    'expected_current_step', p_expected_current_step,
    'expected_current_step_asks', p_expected_current_step_asks,
    'step_id', p_step_id,
    'next_step_id', p_next_step_id,
    'next_step_asks', p_next_step_asks,
    'field', p_field,
    'value', p_value,
    'outcome', p_outcome,
    'dq_reason', p_dq_reason,
    'rule_id', p_rule_id
  );
  payload_hash := encode(extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.qualification_turn_receipts (
    inbound_message_id, tenant_id, conversation_id, contact_id, command_hash, command_payload
  ) values (
    p_inbound_message_id, p_expected_tenant, p_conversation_id, p_contact_id,
    payload_hash, payload
  ) on conflict (inbound_message_id) do nothing;
  get diagnostics inserted_count = row_count;

  select * into existing_receipt
  from public.qualification_turn_receipts receipt
  where receipt.inbound_message_id = p_inbound_message_id
  for update;
  if existing_receipt.inbound_message_id is null then
    raise exception 'QUALIFICATION_TURN_RECEIPT_RESERVATION_FAILED';
  end if;
  if inserted_count = 0 then
    if existing_receipt.tenant_id is distinct from p_expected_tenant
      or existing_receipt.conversation_id is distinct from p_conversation_id
      or existing_receipt.contact_id is distinct from p_contact_id
      or existing_receipt.command_hash is distinct from payload_hash then
      raise exception 'QUALIFICATION_TURN_REPLAY_MISMATCH';
    end if;
    select * into conversation_row from public.conversations
      where id = p_conversation_id and tenant_id = p_expected_tenant;
    select * into contact_row from public.contacts
      where id = p_contact_id and tenant_id = p_expected_tenant;
    return query select true, conversation_row.current_step, conversation_row.current_step_asks,
      contact_row.outcome, conversation_row.status;
    return;
  end if;

  select * into conversation_row from public.conversations
  where id = p_conversation_id and tenant_id = p_expected_tenant for update;
  select * into contact_row from public.contacts
  where id = p_contact_id and tenant_id = p_expected_tenant for update;
  if conversation_row.id is null or contact_row.id is null
    or conversation_row.contact_id is distinct from p_contact_id
    or not exists (
      select 1 from public.messages message
      where message.id = p_inbound_message_id
        and message.tenant_id = p_expected_tenant
        and message.conversation_id = p_conversation_id
        and message.direction = 'in'
        and message.author = 'lead'
    ) then
    raise exception 'QUALIFICATION_TURN_SCOPE_MISMATCH';
  end if;
  if conversation_row.current_step is distinct from p_expected_current_step
    or conversation_row.current_step_asks is distinct from p_expected_current_step_asks then
    raise exception 'QUALIFICATION_TURN_CAS_MISMATCH';
  end if;
  if contact_row.outcome is not null and p_outcome is not null
    and contact_row.outcome is distinct from p_outcome then
    raise exception 'QUALIFICATION_OUTCOME_CONFLICT';
  end if;

  update public.contacts contact
  set credit_range = case when p_field = 'credit' then
        trim(both '"' from p_value::text)::public.credit_range else contact.credit_range end,
      funding_goal = case when p_field = 'goal' then
        trim(both '"' from p_value::text)::public.funding_goal else contact.funding_goal end,
      timeline = case when p_field = 'timeline' then
        trim(both '"' from p_value::text)::public.funding_timeline else contact.timeline end,
      business_stage = case when p_field = 'businessStage' then
        trim(both '"' from p_value::text)::public.business_stage else contact.business_stage end,
      annual_revenue_cents = case when p_field = 'annualRevenue' then
        (p_value #>> '{}')::bigint else contact.annual_revenue_cents end,
      outcome = coalesce(p_outcome, contact.outcome),
      dq_reason = case when p_outcome in ('HARD_DQ'::public.outcome, 'SOFT_DQ'::public.outcome)
        then p_dq_reason else contact.dq_reason end,
      pipeline_stage = case
        when contact.stage_set_by = 'system' and p_outcome = 'HARD_DQ'::public.outcome
          then 'disqualified'::public.pipeline_stage
        when contact.stage_set_by = 'system' and p_outcome = 'SOFT_DQ'::public.outcome
          then 'long_term_followup'::public.pipeline_stage
        else contact.pipeline_stage end,
      stage_set_at = case when contact.stage_set_by = 'system' and p_outcome in
        ('HARD_DQ'::public.outcome, 'SOFT_DQ'::public.outcome) then now() else contact.stage_set_at end,
      updated_at = now()
  where contact.id = p_contact_id;

  update public.conversations conversation
  set current_step = p_next_step_id,
      current_step_asks = p_next_step_asks,
      status = case p_outcome
        when 'HARD_DQ'::public.outcome then 'closed'::public.convo_status
        when 'SOFT_DQ'::public.outcome then 'nurture'::public.convo_status
        else conversation.status end,
      status_reason = case p_outcome
        when 'HARD_DQ'::public.outcome then 'hard_dq'::public.convo_status_reason
        when 'SOFT_DQ'::public.outcome then 'soft_dq'::public.convo_status_reason
        else conversation.status_reason end,
      status_changed_at = case when p_outcome in
        ('HARD_DQ'::public.outcome, 'SOFT_DQ'::public.outcome) then now()
        else conversation.status_changed_at end,
      updated_at = now()
  where conversation.id = p_conversation_id;

  select * into conversation_row from public.conversations where id = p_conversation_id;
  select * into contact_row from public.contacts where id = p_contact_id;
  return query select false, conversation_row.current_step, conversation_row.current_step_asks,
    contact_row.outcome, conversation_row.status;
end;
$$;

revoke execute on function public.apply_qualification_turn(
  uuid,uuid,uuid,uuid,text,integer,text,text,integer,text,jsonb,
  public.outcome,text,text
) from public, anon, authenticated;
grant execute on function public.apply_qualification_turn(
  uuid,uuid,uuid,uuid,text,integer,text,text,integer,text,jsonb,
  public.outcome,text,text
) to service_role;
