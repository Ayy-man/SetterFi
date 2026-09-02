-- Alec's five objection categories, with the hard gate kept independent of them.
--
-- `20260813000001_init.sql:400` shipped `brain_objections.category` as a nullable,
-- unconstrained `text`. The category vocabulary lived only in a fixture array a test
-- read back to itself, so "the categories are timing/clarity/pricing/compliance/partner"
-- was green in CI while the database accepted any string at all. This moves the rule to
-- the only place that can refuse a write: a CHECK constraint.
--
-- Three decisions, argued rather than restated:
--
-- 1. `hard_gate` is its own boolean, not a sixth category value. Alec's five-value list
--    drops "hard gate", and that value was the only marking of an objection whose answer
--    is bound by CLAUDE.md's pricing / guarantee / outcome rules. Riding it along as a
--    category would delete the marking to get the five values. Orthogonal means a row can
--    be `category = 'pricing'` and `hard_gate = true` at once, which the single-chip model
--    could never express, and it means the category filter can never accidentally hide a
--    gated objection.
--
-- 2. `category` is promoted to `not null`. A nullable category leaves rows that no chip in
--    the filter row can reach except All, so the per-chip counts stop summing to the list
--    underneath them and the UI lies about what it is showing. Zero rows are null today, so
--    the promotion costs nothing now and forces every future writer to state a category.
--
-- 3. The backfill runs before the constraint, because a CHECK on a populated column is
--    refused outright if a single row violates it. The hosted project
--    (checked 2026-08-19 against `/rest/v1/brain_objections`) holds
--    exactly one row — `81000000-0000-4000-8000-000000000009` "Needs more information",
--    `category = 'trust'` — so a bare `add constraint` fails on its first run against live.
--    The mapping is total rather than lucky: `clarify` renames to `clarity`; any spelling of
--    `hard gate` becomes `compliance` with the flag raised, since the gate exists to stop
--    invented pricing and guarantees and that is a compliance control; and everything else,
--    including `discipline` (which has no destination in Alec's list and matches zero rows
--    today), the live `trust` row, and null, falls through to `clarity`. `clarity` is the
--    catch-all because it is the only one of the five that asserts nothing about the
--    objection's subject beyond "the lead needs something explained", so it mislabels least.
--    Each rewrite raises a notice carrying the id and the old value, so a relabel lands in
--    the migration log instead of happening invisibly.
--
-- No policy DDL. `20260813000001_init.sql:912-926` already gives this table `published_read`
-- and `admin_write` (`for all`, `app.is_platform_admin()` on both `using` and `with check`),
-- and a new column inherits both. Adding policies here is what would widen the surface.

alter table public.brain_objections
  add column if not exists hard_gate boolean not null default false;

do $$
declare
  row_rec record;
  normalized text;
begin
  for row_rec in
    select id, category from public.brain_objections
  loop
    normalized := lower(trim(coalesce(row_rec.category, '')));

    if normalized in ('timing', 'clarity', 'pricing', 'compliance', 'partner') then
      -- Already one of the five; normalise casing/whitespace only if it drifted.
      if row_rec.category is distinct from normalized then
        update public.brain_objections set category = normalized where id = row_rec.id;
        raise notice 'brain_objections %: normalised category % -> %',
          row_rec.id, coalesce(row_rec.category, '<null>'), normalized;
      end if;

    elsif normalized = 'clarify' then
      update public.brain_objections set category = 'clarity' where id = row_rec.id;
      raise notice 'brain_objections %: remapped category % -> clarity',
        row_rec.id, coalesce(row_rec.category, '<null>');

    elsif normalized in ('hard gate', 'hard_gate', 'hard-gate') then
      update public.brain_objections
        set category = 'compliance', hard_gate = true
        where id = row_rec.id;
      raise notice 'brain_objections %: remapped category % -> compliance with hard_gate = true',
        row_rec.id, coalesce(row_rec.category, '<null>');

    else
      update public.brain_objections set category = 'clarity' where id = row_rec.id;
      raise notice 'brain_objections %: remapped unrecognised category % -> clarity',
        row_rec.id, coalesce(row_rec.category, '<null>');
    end if;
  end loop;
end
$$;

alter table public.brain_objections
  alter column category set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.brain_objections'::regclass
      and conname = 'brain_objections_category_check'
  ) then
    alter table public.brain_objections
      add constraint brain_objections_category_check
      check (category in ('timing', 'clarity', 'pricing', 'compliance', 'partner'));
  end if;
end
$$;

-- Mirrors brain_knowledge_entries_category_idx. The Objections filter reads exactly this
-- pair: one category chip at a time, over the published/draft status the tab is showing.
create index if not exists brain_objections_category_idx
  on public.brain_objections (category, status);
