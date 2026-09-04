-- A published Brain snapshot must carry a platform prompt.
--
-- publish_brain_draft wrote coalesce(payload ->> 'compiledPlatform', '') and so accepted a draft
-- with none; the runtime then refused every turn against it (RUNTIME_BRAIN_COMPILED_PLATFORM_INVALID).
-- Hosted snapshot v5 (2026-09-02, the Phase 7 demo seed) was exactly that, and no agent turn ran
-- until it was superseded. Refuse at publish, where the author can see it.
set search_path = public, extensions;

create or replace function app.assert_brain_snapshot_has_platform()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if nullif(btrim(new.compiled_platform), '') is null then
    raise exception 'BRAIN_COMPILED_PLATFORM_REQUIRED';
  end if;
  return new;
end;
$$;

drop trigger if exists brain_snapshot_platform_required on public.brain_snapshots;
create trigger brain_snapshot_platform_required
  before insert on public.brain_snapshots
  for each row execute function app.assert_brain_snapshot_has_platform();
