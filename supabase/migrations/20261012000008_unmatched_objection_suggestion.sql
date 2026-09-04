-- Advisory objection classification hook (round-2 team-lead request, optional): storage for a
-- suggested brain_objection match on an unmatched objection, kept strictly separate from the
-- confirmed match. `unmatched_objections.brain_objection_id` (20260813000001_init.sql:641) is set
-- only when an admin resolves the row (see `resolved_by`/`resolved_at` alongside it), and every
-- objection stat counted anywhere reads that confirmed field. This migration adds three new
-- nullable columns a classifier may fill in without ever touching the confirmed field, so the
-- counted source for objection stats stays the admin's own deterministic confirmation. No admin
-- UI reads these columns yet and no classifier call is wired up (see
-- src/lib/brain/objection-classifier.ts) -- this is storage plus a write path only.

alter table public.unmatched_objections
  add column suggested_brain_objection_id uuid references public.brain_objections(id) on delete set null,
  add column suggestion_confidence numeric,
  add column suggestion_model_version text,
  add column suggested_at timestamptz;

alter table public.unmatched_objections
  add constraint unmatched_objections_suggestion_confidence_range
  check (suggestion_confidence is null or (suggestion_confidence >= 0 and suggestion_confidence <= 1));

alter table public.unmatched_objections
  add constraint unmatched_objections_suggestion_fields_together
  check (
    (suggested_brain_objection_id is null and suggestion_confidence is null
      and suggestion_model_version is null and suggested_at is null)
    or (suggested_brain_objection_id is not null and suggestion_confidence is not null
      and suggestion_model_version is not null and suggested_at is not null)
  );

create function public.write_unmatched_objection_suggestion(
  p_expected_tenant uuid,
  p_unmatched_objection_id uuid,
  p_brain_objection_id uuid,
  p_confidence numeric,
  p_model_version text
)
returns table (unmatched_objection_id uuid, suggested_brain_objection_id uuid, suggested_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  objection_row public.unmatched_objections%rowtype;
  brain_objection_row public.brain_objections%rowtype;
  written_at timestamptz := now();
begin
  select * into objection_row from public.unmatched_objections where id = p_unmatched_objection_id;
  if objection_row.id is null then raise exception 'UNMATCHED_OBJECTION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, objection_row.tenant_id, 'unmatched_objection');
  select * into brain_objection_row from public.brain_objections where id = p_brain_objection_id;
  if brain_objection_row.id is null then raise exception 'BRAIN_OBJECTION_NOT_FOUND'; end if;
  if p_confidence is null or p_confidence < 0 or p_confidence > 1 then
    raise exception 'OBJECTION_SUGGESTION_CONFIDENCE_INVALID';
  end if;
  if nullif(btrim(p_model_version), '') is null then
    raise exception 'OBJECTION_SUGGESTION_MODEL_VERSION_REQUIRED';
  end if;
  -- A suggestion never touches the confirmed match: an already-resolved row keeps its resolution,
  -- and re-suggesting a still-open row simply overwrites the prior suggestion with the latest one.
  update public.unmatched_objections set
    suggested_brain_objection_id = p_brain_objection_id,
    suggestion_confidence = p_confidence,
    suggestion_model_version = btrim(p_model_version),
    suggested_at = written_at,
    updated_at = written_at
  where id = p_unmatched_objection_id;
  return query select objection_row.id, p_brain_objection_id, written_at;
end;
$$;

revoke execute on function public.write_unmatched_objection_suggestion(uuid, uuid, uuid, numeric, text)
  from public, anon, authenticated;
grant execute on function public.write_unmatched_objection_suggestion(uuid, uuid, uuid, numeric, text)
  to service_role;
