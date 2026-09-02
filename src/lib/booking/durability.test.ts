import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260905000001_booking_recovery_scheduler.sql",
), "utf8");
const lifecycleOutboxMigration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260905000006_booking_lifecycle_outbox.sql",
), "utf8");
const reconcileRoute = readFileSync(resolve(
  process.cwd(),
  "src/app/api/jobs/appointment-reconcile/handler.ts",
), "utf8");

describe("durable appointment reconciliation scheduler", () => {
  it("claims a bounded due set with lock skipping and advances fairness at claim time", () => {
    expect(migration).toContain("order by connection.reconcile_next_at, connection.id");
    expect(migration).toContain("for update skip locked");
    expect(migration).toContain("limit least(greatest(coalesce(p_limit, 1), 1), 100)");
    expect(migration).toContain("reconcile_next_at = p_now + interval '1 day'");
    expect(migration).toContain("reconcile_claim_token = gen_random_uuid()");
    expect(migration).toContain("and connection.reconcile_claim_token = p_claim_token");
    expect(reconcileRoute).toContain('client.rpc("claim_calendar_reconciliation"');
    expect(reconcileRoute).toContain('client.rpc("finish_calendar_reconciliation"');
    expect(reconcileRoute).not.toContain('.order("id", { ascending: true })');
  });

  it("uses the durable notification emitter instead of dropping appointment events", () => {
    expect(reconcileRoute).toContain("createBookingEventEmitter(createNotificationRepository())");
    expect(reconcileRoute).not.toContain("emitDomainEvent: async () => undefined");
  });
});

describe("durable booking intent contract", () => {
  it("leases one creator and exposes provider and local completion checkpoints", () => {
    expect(migration).toContain("create table public.booking_intents");
    expect(migration).toContain("lease_until = p_now + interval '5 minutes'");
    expect(migration).toContain("lease_token = claim_token");
    expect(migration).toContain("and booking.lease_token = p_claim_token");
    expect(migration).toContain("create or replace function public.record_booking_intent_provider");
    expect(migration).toContain("create or replace function public.complete_booking_intent");
    expect(migration).toContain("BOOKING_INTENT_REPLAY_MISMATCH");
    expect(migration).toContain("and conversation.contact_id = p_contact_id");
    expect(migration).toMatch(/from public\.contacts contact[\s\S]*for update/);
    expect(migration).toContain("to_jsonb(contact_row) ->> 'deletion_intent_id'");
    expect(migration).toContain("BOOKING_CONTACT_DELETION_PENDING");
  });
});

describe("atomic booking lifecycle outbox", () => {
  it("cancels and enqueues inside one service-role RPC", () => {
    expect(lifecycleOutboxMigration).toContain(
      "create or replace function public.cancel_appointment_with_outbox",
    );
    expect(lifecycleOutboxMigration).toContain("select public.cancel_appointment(");
    expect(lifecycleOutboxMigration).toContain("insert into public.booking_lifecycle_outbox");
    expect(lifecycleOutboxMigration).toContain("if not appointment.is_test then");
    expect(reconcileRoute).toContain('client.rpc("cancel_appointment_with_outbox"');
    expect(reconcileRoute).not.toContain('client.rpc("cancel_appointment",');
  });

  it("uses bounded lock-skipping claims and fences stale dispatchers", () => {
    expect(lifecycleOutboxMigration).toContain("for update skip locked");
    expect(lifecycleOutboxMigration).toContain(
      "limit least(greatest(coalesce(p_limit, 1), 1), 100)",
    );
    expect(lifecycleOutboxMigration).toContain("and event.claim_token = p_claim_token");
    expect(lifecycleOutboxMigration).toContain("to service_role;");
    expect(reconcileRoute).toContain('"claim_booking_lifecycle_outbox"');
    expect(reconcileRoute).toContain('client.rpc("finish_booking_lifecycle_outbox"');
  });
});
