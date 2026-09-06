-- `20261013000013_brain_import_hardening.sql` gave knowledge entries a `tenant_id` (the
-- `tenant_specific` disposition writes it) and `20261013000014_brain_knowledge_provenance_variants.sql`
-- hung question variants beneath them, but neither table gained a tenant policy. Entries carry
-- `admin_write` (all commands) and `published_read`; variants carry only `phase2_platform_read`.
-- A tenant-specific entry can never be published (`brain_knowledge_entries_publishable_chk`
-- requires the `shared` disposition), so a coach could not read the knowledge written for their
-- own tenant, nor the variants that belong to it.
--
-- This adds one read policy per table, shaped like `tenant_read` on the lead tables in
-- `20260817000001_phase1_demo_path.sql`: `app.owns_tenant(tenant_id)` resolves the caller's tenant
-- through `app.current_tenant_id()`, so a `coach_member` is admitted only through an unrevoked
-- membership, and a row whose `tenant_id` is null (the `shared` and `needs_rewrite` dispositions)
-- never matches. Platform users keep `published_read` and `phase2_platform_read` unchanged. No
-- write policy or grant changes: `admin_write` remains the only write path on entries, and
-- variants keep no write grant for `authenticated` at all.

drop policy if exists tenant_read on public.brain_knowledge_entries;
create policy tenant_read on public.brain_knowledge_entries for select to authenticated
  using (app.owns_tenant(tenant_id));
comment on policy tenant_read on public.brain_knowledge_entries is
  'A tenant member reads the knowledge entries scoped to their own tenant (disposition tenant_specific), whatever their status. Rows with a null tenant_id are governed by published_read alone.';

-- The variant row has no tenant column of its own; membership is inherited from the parent entry.
-- The subquery runs under the caller's policies on brain_knowledge_entries, so a variant is
-- visible exactly when its entry is visible through tenant_read.
drop policy if exists tenant_read on public.brain_knowledge_entry_variants;
create policy tenant_read on public.brain_knowledge_entry_variants for select to authenticated
  using (
    exists (
      select 1
      from public.brain_knowledge_entries entry
      where entry.id = brain_knowledge_entry_variants.entry_id
        and app.owns_tenant(entry.tenant_id)
    )
  );
comment on policy tenant_read on public.brain_knowledge_entry_variants is
  'A tenant member reads the question variants of the knowledge entries scoped to their own tenant. Inherits the parent entry''s tenant_id; there is no tenant write path for variants.';
