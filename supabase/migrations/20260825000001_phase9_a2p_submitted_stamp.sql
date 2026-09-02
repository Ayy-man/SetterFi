-- Phase 9 — Plan 09-01
--
-- The coach-facing SMS registration day counter reads its start date from
-- external_ref->>'submittedAt' on the a2p_campaign provisioning step
-- (see public.read_coach_a2p_registration). Under the real driver nothing ever wrote that key,
-- so the counter had no source: the honest-state promise rendered with no data behind it.
--
-- The admin action that establishes the filing date is the A2P filing confirmation, which today
-- writes audit rows only. This replaces public.confirm_onboarding_content_screen so the same
-- confirmation also stamps the start date, once. The stamp is idempotent by construction: the
-- update only matches a row that has no usable submittedAt yet, so a repeat confirmation can
-- never move the counter forward and the coach never sees the clock reset.
--
-- Existing behaviour — actor assertion, tenant assertion, the acknowledgement gate, both audit
-- rows, and the already-confirmed short circuit that returns the prior filing audit id — is
-- preserved byte-for-byte. The stamp runs before the short circuit so a screen confirmed before
-- this migration is backfilled with its original admin_confirmed_at rather than today's date.

create or replace function public.confirm_onboarding_content_screen(
  p_expected_tenant uuid,
  p_screen_id uuid,
  p_actor_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  screen_row public.onboarding_content_screens%rowtype;
  logged_id bigint;
  filing_id bigint;
  stamp_at timestamptz;
begin
  perform app.assert_not_impersonating();
  perform app.assert_phase5_actor(p_actor_id, p_expected_tenant, true);
  select * into screen_row from public.onboarding_content_screens where id = p_screen_id for update;
  if screen_row.id is null then raise exception 'ONBOARDING_CONTENT_SCREEN_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, screen_row.tenant_id, 'content_screen');
  if not screen_row.is_current or screen_row.result <> 'flagged'
    or screen_row.acknowledged_at is null then
    raise exception 'ONBOARDING_CONTENT_ADMIN_CONFIRMATION_FORBIDDEN';
  end if;

  -- Stamp the registration start date the day counter reads. A row that already carries a usable
  -- value is excluded by the predicate, so this can only ever add the date, never reset it.
  stamp_at := coalesce(screen_row.admin_confirmed_at, now());
  update public.provisioning_steps step
  set external_ref = coalesce(step.external_ref, '{}'::jsonb)
        || jsonb_build_object(
             'submittedAt',
             to_char(stamp_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           ),
      updated_at = now()
  where step.tenant_id = p_expected_tenant
    and step.step_key = 'a2p_campaign'
    and coalesce(
      nullif(btrim(coalesce(step.external_ref ->> 'submittedAt', '')), ''),
      nullif(btrim(coalesce(step.external_ref ->> 'submitted_at', '')), '')
    ) is null;

  if screen_row.admin_confirmed_at is not null then
    select id into logged_id from public.audit_log
    where action = 'onboarding.content_admin_confirmed' and target_id = p_screen_id::text
    order by id desc limit 1;
    return logged_id;
  end if;
  update public.onboarding_content_screens
  set admin_confirmed_at = now(), admin_confirmed_by = p_actor_id where id = p_screen_id;
  logged_id := app.write_audit_row(
    'onboarding.content_admin_confirmed', p_actor_id, p_expected_tenant,
    'onboarding_content_screen', p_screen_id::text, null,
    jsonb_build_object('input_hash', screen_row.input_hash)
  );
  filing_id := app.write_audit_row(
    'onboarding.a2p_filing_confirmed', p_actor_id, p_expected_tenant,
    'onboarding_content_screen', p_screen_id::text, null,
    jsonb_build_object('content_confirmation_audit_id', logged_id)
  );
  return filing_id;
end;
$$;
