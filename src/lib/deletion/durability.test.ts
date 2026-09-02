import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../supabase/migrations/20260905000010_backend_security_sagas.sql", import.meta.url),
  "utf8",
);

describe("contact deletion durability migration", () => {
  it("claims and validates the database preview before any provider work can begin", () => {
    expect(migration).toContain("create table public.contact_deletion_intents");
    expect(migration).toContain("create or replace function public.begin_contact_deletion_intent");
    expect(migration).toContain("contact_row.deletion_preview_token is distinct from p_preview_token");
    expect(migration).toContain("contact_row.deletion_preview_actor_id is distinct from p_actor_id");
    expect(migration).toContain("contact_row.deletion_previewed_at < now() - interval '15 minutes'");
    expect(migration).toContain("app.contact_deletion_snapshot_digest(p_contact_id) is distinct from p_snapshot_digest");
    expect(migration).toContain("app.contact_deletion_provider_target_digest(p_contact_id) is distinct from p_provider_target_digest");
    expect(migration).toContain("contact_deletion_intents_active_contact_uidx");
    expect(migration).toContain("set deletion_intent_id = intent.id, deletion_pending_at = now()");
  });

  it("checkpoints provider proof and finalizes local deletion as separately retryable transactions", () => {
    expect(migration).toContain("checkpoint_contact_deletion_provider");
    expect(migration).toContain("status = 'provider_confirmed'");
    expect(migration).toContain("finalize_contact_deletion_intent");
    expect(migration).toContain("if intent.status = 'completed'");
    expect(migration).toContain("delete from public.contacts where id = intent.contact_id");
    expect(migration).toContain("set status = 'completed', audit_id = logged_id");
  });

  it("keeps every saga function service-role-only", () => {
    expect(migration).toContain("alter table public.contact_deletion_intents force row level security");
    expect(migration).toContain("revoke all on table public.contact_deletion_intents from public, anon, authenticated, service_role");
    expect(migration).toMatch(/revoke execute on function public\.begin_contact_deletion_intent[\s\S]*from public, anon, authenticated/);
    expect(migration).toMatch(/grant execute on function public\.begin_contact_deletion_intent[\s\S]*to service_role/);
    expect(migration).toContain("drop function public.delete_contact_compliance");
    expect(migration).toMatch(/delete_contact_compliance\([\s\S]*from public, anon, authenticated, service_role/);
  });

  it("serializes every contact-linked writer on the contact row while provider deletion is in flight", () => {
    for (const table of [
      "contacts", "contact_identities", "contact_notes", "contact_duplicate_candidates",
      "conversations", "messages", "message_traces", "conversation_step_events",
      "brain_objection_usage_events", "unmatched_objections", "appointments", "followups", "suppression_entries",
      "eval_cases", "billable_events", "booking_intents", "booking_slot_emissions",
      "booking_lifecycle_outbox", "outbound_send_attempts", "inbound_engine_turns",
      "qualification_turn_receipts", "consent_binding_redemptions",
    ]) {
      expect(migration).toContain(`create trigger ${table}_deletion_intent_guard`);
    }
    expect(migration).toContain("CONTACT_DELETE_INTENT_MUTATION_BLOCKED");
    expect(migration).toMatch(/from public\.contacts contact[\s\S]*order by contact\.id[\s\S]*for update/);
    expect(migration).not.toContain("contact-delete-writer:");
    expect(migration).not.toContain("lock table public.appointments");
  });

  it("binds preview and finalization to traces, notes, provider sagas, and auxiliary cascades", () => {
    for (const relation of [
      "message_traces", "contact_notes", "duplicate_candidates", "conversation_step_events",
      "objection_usage_events", "booking_intents", "booking_slot_emissions",
      "booking_lifecycle_outbox", "outbound_send_attempts", "inbound_engine_turns",
      "qualification_turn_receipts", "consent_binding_redemptions",
    ]) {
      expect(migration).toContain(`'${relation}'`);
    }
    expect(migration).toContain("CONTACT_DELETE_BOOKING_IN_FLIGHT");
  });

  it("revalidates ordinary actors and permits only audited owner/admin recovery", () => {
    expect(migration.match(/perform app\.assert_contact_deletion_actor\(p_expected_tenant, p_actor_id\)/g)?.length)
      .toBeGreaterThanOrEqual(4);
    expect(migration).toContain("actor.role = 'coach'");
    expect(migration).toContain("actor.role in ('owner', 'admin')");
    expect(migration).toContain("actor.role = 'success'");
    expect(migration).toContain("success_owner_id = p_actor_id");
    expect(migration).toContain("actor_role not in ('owner', 'admin')");
    expect(migration).toContain("create or replace function public.adopt_contact_deletion_recovery");
    expect(migration).toContain("'contact.delete.recovery_adopted'");
    expect(migration).toContain("intent.recovery_actor_id is distinct from p_actor_id");
  });

  it("binds GHL provider evidence to immutable account/install custody and cluster-wide preview", () => {
    expect(migration).toContain("add column provider_account_id text");
    expect(migration).toContain("add column ghl_install_id uuid");
    expect(migration).toContain("GHL_IDENTITY_ACCOUNT_REASSIGNMENT_FORBIDDEN");
    expect(migration).toContain("GHL_IDENTITY_ACCOUNT_REMEDIATION_REQUIRED");
    expect(migration).toContain("target.frame, '' order by target.frame collate \"C\"");
    expect(migration).toContain("'mergedContacts', cardinality(app.contact_deletion_cluster_ids(p_contact_id)) - 1");
    expect(migration).toContain("create or replace function public.get_contact_deletion_cluster_metadata");
    expect(migration).toContain("'mergeAuditsRedacted'");
  });

  it("allows empty tombstone sets but validates non-empty entries", () => {
    expect(migration).not.toContain("coalesce(cardinality(p_tombstone_channels), 0) = 0");
    expect(migration.match(/if coalesce\(cardinality\(p_tombstone_hashes\), 0\) > 0 then/g))
      .toHaveLength(2);
  });

  it("leases stale intents for crash recovery with backoff and explicit operator custody", () => {
    expect(migration).toContain("recovery_attempt_count integer not null default 0");
    expect(migration).toContain("recovery_lease_token uuid");
    expect(migration).toContain("recovery_operator_required boolean not null default false");
    expect(migration).toContain("create or replace function public.claim_contact_deletion_recovery");
    expect(migration).toContain("for update skip locked");
    expect(migration).toContain("create or replace function public.finalize_contact_deletion_recovery");
    expect(migration).toContain("app.contact_deletion_system_lease");
    expect(migration).toContain("create or replace function public.list_contact_deletion_recovery_intents");
    expect(migration).toContain("create or replace function public.claim_contact_deletion_recovery_intent");
    expect(migration).toContain("if intent.recovery_lease_expires_at > now() then");
    expect(migration).toContain("raise exception 'CONTACT_DELETE_RECOVERY_ACTIVE'");
    expect(migration).toContain("set recovery_lease_token = gen_random_uuid()");
    expect(migration).toContain("create or replace function public.renew_contact_deletion_lease");
    expect(migration).toContain("create or replace function public.release_contact_deletion_lease");
    expect(migration).toMatch(
      /grant execute on function public\.begin_contact_deletion_intent\(uuid,uuid,uuid,text,uuid,uuid,text,text,text\)[\s\S]*public\.checkpoint_contact_deletion_provider\(uuid,uuid,uuid,uuid,jsonb\)[\s\S]*to service_role/,
    );
  });
});
