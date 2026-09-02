import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../supabase/migrations/20260905000007_booking_slot_selection.sql", import.meta.url),
  "utf8",
);

describe("booking slot selection custody", () => {
  it("keeps the emission ledger RPC-only and binds provenance to an unambiguous emitted token", () => {
    expect(migration).toContain(
      "revoke all on table public.booking_slot_emissions from public, anon, authenticated, service_role",
    );
    expect(migration).toContain("alter table public.booking_slot_emissions force row level security");
    expect(migration).not.toMatch(/grant\s+(?:select|insert|update)[\s\S]*booking_slot_emissions\s+to\s+service_role/iu);
    expect(migration).toContain("position('[slot_id:' || slot_id || ']' in outbound_body)");
  });

  it("claims an exact lead-authored slot id once and completes only against a scoped appointment", () => {
    expect(migration).toContain("btrim(message.body) = p_exact_slot_id");
    expect(migration).toContain("and slot_emission.consumed_at is null");
    expect(migration).toContain("and appointment.conversation_id = emission.conversation_id");
    expect(migration).toContain("and appointment.contact_id = emission.contact_id");
    expect(migration).toContain("finalize_booking_slot_confirmation");
    expect(migration).toContain("confirmation_outbound_message_id");
    expect(migration).toContain("outbound_message.direction = 'out'");
  });

  it("serializes selection, retires older offers, and recovers a committed send before reoffering", () => {
    expect(migration).not.toContain("for update skip locked");
    expect(migration).toContain("set superseded_at = now()");
    expect(migration).toContain("and slot_emission.booking_completed_at is null");
    expect(migration).toContain("return query select 'busy'::text");
    expect(migration).toContain("release_booking_slot_selection_for_reoffer");
    expect(migration).toContain("and slot_emission.reoffered_at is null");
    expect(migration).toContain("when emission.conflict_pending_at is not null then 'conflict_pending'");
    expect(migration).toContain("BOOKING_SLOT_RECOVERY_MISMATCH");
    expect(migration).toContain("message.created_at >= conversation_row.proposed_slots_at");
    expect(migration).toContain("record_booking_slot_conflict_reoffer");
    expect(migration).toContain("checkpoint_booking_slot_conflict");
    expect(migration).toContain("conflict_pending_at");
    expect(migration).toContain("then 'conflict_pending'");
    expect(migration).toContain("reoffer_booking_intent_id");
    expect(migration).toContain("conversation_row.proposed_slots is distinct from p_proposal");
    expect(migration).toContain("intent.selected_slot_id is distinct from emission.selected_slot_id");
    expect(migration).not.toContain("conversation_row.proposed_slots_at > emission.proposed_at");
    const completion = migration.slice(
      migration.indexOf("create or replace function public.complete_booking_slot_selection"),
      migration.indexOf("create or replace function public.finalize_booking_slot_confirmation"),
    );
    expect(completion).not.toContain("set status = 'closed'");
  });

  it("keeps fetched proposals monotonic so a stale worker receives the current winner", () => {
    expect(migration).toContain("record_booking_proposed_slots");
    expect(migration).toContain("conversation_row.proposed_slots_at < p_proposed_at");
    expect(migration).toContain("return conversation_row.proposed_slots");
    expect(migration.match(/jsonb_array_length\(p_proposal -> 'slots'\) < 1/g)).toHaveLength(2);
    expect(migration.match(/count\(distinct slot ->> 'id'\)/g)).toHaveLength(2);
    const validators = ["BOOKING_SLOT_CONFLICT_REOFFER_INPUT_INVALID", "BOOKING_PROPOSAL_INPUT_INVALID"];
    for (const errorCode of validators) {
      const errorAt = migration.indexOf(`raise exception '${errorCode}'`);
      const validation = migration.slice(Math.max(0, errorAt - 1_500), errorAt);
      for (const field of ["id", "startAt", "endAt", "timezone", "display"]) {
        expect(validation).toContain(`slot ->> '${field}'`);
      }
    }
  });
});
