import { afterEach, describe, expect, it, vi } from "vitest";

const providerStartAt = "2026-08-21T15:00:00.000Z";
const providerEndAt = "2026-08-21T15:30:00.000Z";

function query(data: unknown) {
  return {
    select: () => ({
      eq: () => ({
        eq: () => ({
          neq: () => ({
            gte: () => ({
              lte: async () => ({ data, error: null }),
            }),
          }),
        }),
      }),
    }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/integrations/selector");
  vi.doUnmock("@/lib/jobs/job-receipts");
  vi.doUnmock("@/lib/notifications/events");
  vi.doUnmock("@/lib/supabase/server");
  vi.resetModules();
});

describe("appointment reconciliation job", () => {
  it("persists an authoritative provider reschedule once, without a pending command", async () => {
    vi.stubEnv("SETTERFI_PHASE1_LIVE", "true");
    vi.stubEnv("CRON_SECRET", "reconcile-secret");

    const appointment = {
      id: "appointment-1",
      tenant_id: "tenant-1",
      conversation_id: "conversation-1",
      contact_id: "contact-1",
      provider: "ghl",
      external_id: "provider-appointment-1",
      start_at: "2026-08-20T14:00:00.000Z",
      end_at: "2026-08-20T14:30:00.000Z",
      timezone: "America/New_York",
      created_source: "agent",
      attributed_to_agent: true,
      is_test: false,
      status: "scheduled",
      attendance_source: null,
      billable_events: [{ id: "billable-1" }],
      contacts: {
        name: "Jordan Lee",
        last_channel: "sms",
        timezone: "America/Los_Angeles",
        ghl_contact_id: "provider-contact-1",
        credit_range: null,
        funding_goal: null,
        timeline: null,
      },
      calendar_connections: {
        id: "connection-1",
        external_location_id: "location-1",
        timezone: "America/New_York",
      },
    };
    const rpc = vi.fn(async (functionName: string, args?: Record<string, unknown>) => {
      if (functionName === "claim_booking_lifecycle_outbox") return { data: [], error: null };
      if (functionName === "claim_calendar_reconciliation") {
        return {
          data: [{
            id: "connection-1",
            tenant_id: "tenant-1",
            provider: "ghl",
            external_calendar_id: "calendar-1",
            external_location_id: "location-1",
            timezone: "America/New_York",
            booking_url: null,
            reconcile_claim_token: "claim-1",
          }],
          error: null,
        };
      }
      if (functionName === "reschedule_appointment") {
        appointment.start_at = args?.p_to_start_at as string;
        appointment.end_at = args?.p_to_end_at as string;
        return { data: 123, error: null };
      }
      if (functionName === "finish_calendar_reconciliation") return { data: null, error: null };
      throw new Error(`Unexpected RPC: ${functionName}`);
    });

    vi.doMock("@/lib/supabase/server", () => ({
      createSupabaseServiceClient: () => ({ rpc, from: () => query([appointment]) }),
    }));
    vi.doMock("@/lib/integrations/selector", () => ({
      selectCalendarDriver: () => ({
        listAppointments: async () => [{
          externalId: "provider-appointment-1",
          contactId: "provider-contact-1",
          startAt: providerStartAt,
          endAt: providerEndAt,
          status: "scheduled",
        }],
      }),
    }));
    vi.doMock("@/lib/notifications/events", () => ({
      createBookingEventEmitter: () => vi.fn(),
      createNotificationRepository: () => ({}),
    }));
    vi.doMock("@/lib/jobs/job-receipts", () => ({
      runJobWithReceipt: async (_job: string, work: () => Promise<unknown>) => work(),
    }));

    const { GET } = await import("./handler");
    const request = () => new Request("https://setterfi.test/api/jobs/appointment-reconcile", {
      headers: { authorization: "Bearer reconcile-secret" },
    });

    expect((await GET(request())).status).toBe(200);
    expect((await GET(request())).status).toBe(200);

    expect(rpc.mock.calls.filter(([functionName]) => functionName === "reschedule_appointment"))
      .toEqual([["reschedule_appointment", {
        p_expected_tenant: "tenant-1",
        p_appointment_id: "appointment-1",
        p_to_start_at: providerStartAt,
        p_to_end_at: providerEndAt,
        p_initiated_by: "provider",
        p_actor_id: null,
      }]]);
    expect(rpc.mock.calls.some(([functionName]) => functionName === "record_appointment_lifecycle_command"))
      .toBe(false);
  });
});
