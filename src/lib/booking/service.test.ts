import { describe, expect, it, vi } from "vitest";

import type { CalendarDriver } from "@/lib/integrations/types";

import {
  bookingIntentIdempotencyKey,
  createBookingService,
  MAX_CALENDAR_ERROR_LENGTH,
} from "./service";
import type {
  BookingContext,
  BookingDomainEvent,
  BookingRepository,
  CalendarConnection,
  CalendarSlot,
  ProposedSlotSet,
} from "./types";

const context: BookingContext = {
  tenantId: "tenant-1",
  conversationId: "conversation-1",
  contactId: "contact-1",
  providerContactId: "provider-contact-1",
  leadName: "Jordan Lee",
  channel: "sms",
  leadTimezone: "America/Los_Angeles",
  qualification: {
    creditBand: "680–719",
    fundingGoal: "$50K–100K",
    timeline: "1–3 months",
  },
  isTest: false,
};

const connection: CalendarConnection = {
  id: "calendar-1",
  tenantId: context.tenantId,
  provider: "ghl",
  externalCalendarId: "provider-calendar-1",
  externalLocationId: "provider-location-1",
  timezone: "America/New_York",
  bookingUrl: "https://calendar.example.test/book",
};

const slot: CalendarSlot = {
  id: "slot-1",
  startAt: "2026-08-20T14:00:00.000Z",
  endAt: "2026-08-20T14:30:00.000Z",
  timezone: connection.timezone,
};

function proposal(proposedAt: string): ProposedSlotSet {
  return {
    calendarConnectionId: connection.id,
    rangeStartAt: "2026-08-20T00:00:00.000Z",
    rangeEndAt: "2026-08-27T00:00:00.000Z",
    proposedAt,
    presentationTimezone: context.leadTimezone!,
    slots: [{ ...slot, display: "2026-08-20 07:00 America/Los_Angeles" }],
  };
}

function makeHarness({
  initialProposal = proposal("2026-08-20T13:55:00.000Z"),
  bookingContext = context,
  primaryCalendar = connection,
  fetchSlots,
  createAppointment,
  listAppointments,
  recordProposedSlots,
  claimBookingIntent,
  recordBookingIntentProvider,
  renewBookingIntentLease,
  recordProviderAppointment,
  leaseHeartbeatMs = 60_000,
  providerRequestTimeoutMs = 240_000,
  times = ["2026-08-20T14:00:00.000Z"],
  simulatedCalendar,
}: {
  simulatedCalendar?: CalendarDriver;
  initialProposal?: ProposedSlotSet | null;
  bookingContext?: BookingContext;
  primaryCalendar?: CalendarConnection | null;
  fetchSlots?: CalendarDriver["fetchSlots"];
  createAppointment?: CalendarDriver["createAppointment"];
  listAppointments?: CalendarDriver["listAppointments"];
  recordProposedSlots?: BookingRepository["recordProposedSlots"];
  claimBookingIntent?: BookingRepository["claimBookingIntent"];
  recordBookingIntentProvider?: BookingRepository["recordBookingIntentProvider"];
  renewBookingIntentLease?: BookingRepository["renewBookingIntentLease"];
  recordProviderAppointment?: BookingRepository["recordProviderAppointment"];
  leaseHeartbeatMs?: number;
  providerRequestTimeoutMs?: number;
  times?: string[];
} = {}) {
  const calls = {
    fetch: [] as Parameters<CalendarDriver["fetchSlots"]>[0][],
    create: [] as Parameters<CalendarDriver["createAppointment"]>[0][],
    health: [] as Parameters<BookingRepository["recordCalendarSlotFetch"]>[0][],
    proposals: [] as ProposedSlotSet[],
    appointmentInputs: [] as Parameters<BookingRepository["recordProviderAppointment"]>[0][],
    intentClaims: [] as Parameters<BookingRepository["claimBookingIntent"]>[0][],
    intentProviderWrites: [] as Parameters<BookingRepository["recordBookingIntentProvider"]>[0][],
    intentLeaseRenewals: [] as Parameters<BookingRepository["renewBookingIntentLease"]>[0][],
    intentCompletions: [] as Parameters<BookingRepository["completeBookingIntent"]>[0][],
    intentReleases: [] as Parameters<BookingRepository["releaseBookingIntent"]>[0][],
    conflictCheckpoints: [] as Parameters<BookingRepository["checkpointBookingConflict"]>[0][],
    providerLists: [] as Parameters<CalendarDriver["listAppointments"]>[0][],
    events: [] as BookingDomainEvent[],
    linkSentAt: [] as string[],
  };
  let storedProposal = initialProposal;
  let appointmentId: string | null = null;
  let billableEventId: string | null = null;
  let auditSequence = 0;
  let intentAttempts = 0;
  let intentProviderExternalId: string | null = null;
  let intentCompleted = false;
  let timeIndex = 0;

  const calendar: CalendarDriver = {
    async fetchSlots(input) {
      calls.fetch.push(input);
      return fetchSlots ? fetchSlots(input) : [slot];
    },
    async createAppointment(input) {
      calls.create.push(input);
      return createAppointment ? createAppointment(input) : { externalId: "provider-appointment-1" };
    },
    async updateAppointment() {
      return { externalId: "provider-appointment-1" };
    },
    async cancelAppointment() {},
    async listAppointments(input) {
      calls.providerLists.push(input);
      return listAppointments ? listAppointments(input) : [];
    },
  };

  const repository: BookingRepository = {
    async getBookingContext() {
      return bookingContext;
    },
    async getPrimaryCalendar() {
      return primaryCalendar;
    },
    async getProposedSlots() {
      return storedProposal;
    },
    async recordProposedSlots(input) {
      const selected = recordProposedSlots ? await recordProposedSlots(input) : input.proposal;
      storedProposal = selected;
      calls.proposals.push(selected);
      return selected;
    },
    async recordCalendarSlotFetch(input) {
      calls.health.push(input);
    },
    async recordProviderAppointment(input) {
      calls.appointmentInputs.push(input);
      if (recordProviderAppointment) return recordProviderAppointment(input);
      if (appointmentId === null) {
        appointmentId = "appointment-1";
        billableEventId = bookingContext.isTest ? null : "billable-1";
        auditSequence += 1;
        return { appointmentId, billableEventId, auditId: auditSequence };
      }
      return { appointmentId, billableEventId, auditId: null };
    },
    async claimBookingIntent(input) {
      calls.intentClaims.push(input);
      if (claimBookingIntent) return claimBookingIntent(input);
      if (intentCompleted) {
        return {
          kind: "completed",
          intentId: "intent-1",
          providerExternalId: intentProviderExternalId!,
          appointment: { appointmentId: appointmentId!, billableEventId, auditId: null },
        };
      }
      if (intentProviderExternalId) {
        return {
          kind: "provider_created",
          intentId: "intent-1",
          providerExternalId: intentProviderExternalId,
        };
      }
      const recoveryRequired = intentAttempts > 0;
      intentAttempts += 1;
      return { kind: "claimed", intentId: "intent-1", claimToken: "claim-1", recoveryRequired };
    },
    async recordBookingIntentProvider(input) {
      calls.intentProviderWrites.push(input);
      if (recordBookingIntentProvider) await recordBookingIntentProvider(input);
      intentProviderExternalId = input.providerExternalId;
    },
    async renewBookingIntentLease(input) {
      calls.intentLeaseRenewals.push(input);
      return renewBookingIntentLease ? renewBookingIntentLease(input) : true;
    },
    async completeBookingIntent(input) {
      calls.intentCompletions.push(input);
      intentCompleted = true;
    },
    async releaseBookingIntent(input) {
      calls.intentReleases.push(input);
    },
    async checkpointBookingConflict(input) {
      calls.conflictCheckpoints.push(input);
    },
    async recordBookingLinkSent(input) {
      calls.linkSentAt.push(input.sentAt);
    },
  };

  const service = createBookingService({
    simulatedCalendar,
    calendar,
    repository,
    emitDomainEvent: async (event) => void calls.events.push(event),
    now: () => new Date(times[Math.min(timeIndex++, times.length - 1)]),
    leaseHeartbeatMs,
    providerRequestTimeoutMs,
  });

  return { service, calls };
}

describe("provider-first booking", () => {
  it("derives a stable intent key from the tenant, conversation, calendar, slot, and start", () => {
    const input = {
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      calendarConnectionId: connection.id,
      selectedSlotId: slot.id,
      startAt: slot.startAt,
    };
    expect(bookingIntentIdempotencyKey(input)).toBe(bookingIntentIdempotencyKey({ ...input }));
    expect(bookingIntentIdempotencyKey(input)).not.toBe(bookingIntentIdempotencyKey({
      ...input,
      conversationId: "conversation-2",
    }));
  });

  it("returns in progress while another creator owns the durable intent lease", async () => {
    const { service, calls } = makeHarness({
      claimBookingIntent: async () => ({ kind: "busy", intentId: "intent-busy" }),
    });

    await expect(service.bookDirectAppointment({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      selectedSlotId: slot.id,
    })).resolves.toEqual({ kind: "in_progress", intentId: "intent-busy" });
    expect(calls.create).toEqual([]);
    expect(calls.appointmentInputs).toEqual([]);
  });

  it("keeps a simulated thread's calendar traffic away from the real provider", async () => {
    const simulatedFetches: Parameters<CalendarDriver["fetchSlots"]>[0][] = [];
    const simulatedCalendar: CalendarDriver = {
      async fetchSlots(input) { simulatedFetches.push(input); return [slot]; },
      async createAppointment() { return { externalId: "simulated:appointment" }; },
      async updateAppointment(input) { return { externalId: input.externalId }; },
      async cancelAppointment() {},
      async listAppointments() { return []; },
    };
    const { service, calls } = makeHarness({
      bookingContext: { ...context, isTest: true, simulated: true },
      simulatedCalendar,
    });
    const result = await service.proposeSlots({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      rangeStartAt: "2026-08-20T00:00:00.000Z",
      rangeEndAt: "2026-08-27T00:00:00.000Z",
    });
    expect(result.kind).toBe("offered");
    expect(simulatedFetches).toHaveLength(1);
    expect(calls.fetch).toHaveLength(0);
  });

  it("fetches slots on each proposing turn and records a healthy provider read", async () => {
    const { service, calls } = makeHarness();

    const first = await service.proposeSlots({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      rangeStartAt: "2026-08-20T00:00:00.000Z",
      rangeEndAt: "2026-08-27T00:00:00.000Z",
    });
    const second = await service.proposeSlots({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      rangeStartAt: "2026-08-20T00:00:00.000Z",
      rangeEndAt: "2026-08-27T00:00:00.000Z",
    });

    expect(calls.fetch).toHaveLength(2);
    expect(calls.fetch[0].timezone).toBe("America/Los_Angeles");
    expect(first).toMatchObject({
      kind: "offered",
      proposal: { slots: [{ display: "2026-08-20 07:00 America/Los_Angeles" }] },
    });
    expect(second.kind).toBe("offered");
    expect(calls.health).toEqual([
      {
        tenantId: context.tenantId,
        calendarConnectionId: connection.id,
        ok: true,
        error: null,
        fetchedAt: "2026-08-20T14:00:00.000Z",
      },
      {
        tenantId: context.tenantId,
        calendarConnectionId: connection.id,
        ok: true,
        error: null,
        fetchedAt: "2026-08-20T14:00:00.000Z",
      },
    ]);
  });

  it("persists, returns, and recovers from the same first five provider-ordered slots", async () => {
    const providerSlots = Array.from({ length: 7 }, (_, index): CalendarSlot => ({
      id: `slot-${index + 1}`,
      startAt: new Date(Date.parse(slot.startAt) + index * 60 * 60_000).toISOString(),
      endAt: new Date(Date.parse(slot.endAt) + index * 60 * 60_000).toISOString(),
      timezone: slot.timezone,
    }));
    const casInputs: ProposedSlotSet[] = [];
    const { service, calls } = makeHarness({
      fetchSlots: async () => providerSlots,
      recordProposedSlots: async ({ proposal: candidate }) => {
        casInputs.push(candidate);
        return candidate;
      },
    });

    const result = await service.proposeSlots({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      rangeStartAt: "2026-08-20T00:00:00.000Z",
      rangeEndAt: "2026-08-27T00:00:00.000Z",
    });
    const expectedIds = providerSlots.slice(0, 5).map(({ id }) => id);
    expect(result).toMatchObject({
      kind: "offered",
      proposal: { slots: expectedIds.map((id) => ({ id })) },
    });
    expect(casInputs[0].slots.map(({ id }) => id)).toEqual(expectedIds);
    expect(calls.proposals[0].slots.map(({ id }) => id)).toEqual(expectedIds);
    await expect(service.bookDirectAppointment({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      selectedSlotId: providerSlots[5].id,
    })).resolves.toEqual({ kind: "unavailable", reason: "slot_not_offered" });
    expect(calls.create).toEqual([]);
  });

  it("returns typed no-slots availability without persisting an empty proposal", async () => {
    const { service, calls } = makeHarness({ fetchSlots: async () => [] });
    await expect(service.proposeSlots({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      rangeStartAt: "2026-08-20T00:00:00.000Z",
      rangeEndAt: "2026-08-27T00:00:00.000Z",
    })).resolves.toEqual({ kind: "unavailable", reason: "no_slots" });
    expect(calls.health).toEqual([expect.objectContaining({ ok: true, error: null })]);
    expect(calls.proposals).toEqual([]);
  });

  it("records bounded failure details and replaces them with a newer healthy read", async () => {
    let attempt = 0;
    const longError = `CALENDAR_SLOT_FETCH_TIMEOUT:${"x".repeat(400)}`;
    const { service, calls } = makeHarness({
      fetchSlots: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error(longError);
        return [slot];
      },
      times: ["2026-08-20T14:00:00.000Z", "2026-08-20T14:01:00.000Z"],
    });
    const input = {
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      rangeStartAt: "2026-08-20T00:00:00.000Z",
      rangeEndAt: "2026-08-27T00:00:00.000Z",
    };

    const failed = await service.proposeSlots(input);
    const recovered = await service.proposeSlots(input);

    expect(failed).toMatchObject({
      kind: "unhealthy",
      health: {
        kind: "unhealthy",
        fetchedAt: "2026-08-20T14:00:00.000Z",
      },
    });
    expect(calls.health[0]).toMatchObject({ ok: false, fetchedAt: "2026-08-20T14:00:00.000Z" });
    expect(calls.health[0].error).toHaveLength(MAX_CALENDAR_ERROR_LENGTH);
    expect(recovered).toMatchObject({
      kind: "offered",
      health: { kind: "healthy", fetchedAt: "2026-08-20T14:01:00.000Z" },
    });
    expect(calls.health[1]).toMatchObject({
      ok: true,
      error: null,
      fetchedAt: "2026-08-20T14:01:00.000Z",
    });
  });

  it("does not mark the calendar unhealthy when storing a successful proposal fails", async () => {
    const { service, calls } = makeHarness({
      recordProposedSlots: async () => {
        throw new Error("PROPOSAL_WRITE_FAILED");
      },
    });

    await expect(
      service.proposeSlots({
        tenantId: context.tenantId,
        conversationId: context.conversationId,
        rangeStartAt: "2026-08-20T00:00:00.000Z",
        rangeEndAt: "2026-08-27T00:00:00.000Z",
      }),
    ).rejects.toThrow("PROPOSAL_WRITE_FAILED");
    expect(calls.health).toEqual([
      {
        tenantId: context.tenantId,
        calendarConnectionId: connection.id,
        ok: true,
        error: null,
        fetchedAt: "2026-08-20T14:00:00.000Z",
      },
    ]);
  });

  it("aborts a slot fetch before the booking lease window and timestamps only after success", async () => {
    let receivedSignal: AbortSignal | undefined;
    const { service } = makeHarness({
      providerRequestTimeoutMs: 5,
      fetchSlots: async (input) => {
        receivedSignal = input.signal;
        return new Promise((_, reject) => input.signal?.addEventListener("abort", () => {
          reject(new Error("CALENDAR_SLOT_FETCH_ABORTED"));
        }, { once: true }));
      },
    });
    await expect(service.proposeSlots({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      rangeStartAt: "2026-08-20T00:00:00.000Z",
      rangeEndAt: "2026-08-21T00:00:00.000Z",
    })).resolves.toMatchObject({ kind: "unhealthy" });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("returns the newer proposal when the CAS rejects a stale fetch worker", async () => {
    const newer = proposal("2026-08-20T14:01:00.000Z");
    const { service } = makeHarness({ recordProposedSlots: async () => newer });
    await expect(service.proposeSlots({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      rangeStartAt: "2026-08-20T00:00:00.000Z",
      rangeEndAt: "2026-08-21T00:00:00.000Z",
    })).resolves.toMatchObject({ kind: "offered", proposal: newer });
  });

  it("refetches a stale offer before creation and never sends a free-slot override", async () => {
    const { service, calls } = makeHarness({
      initialProposal: proposal("2026-08-20T13:40:00.000Z"),
      times: ["2026-08-20T14:00:00.000Z", "2026-08-20T14:00:01.000Z"],
    });

    const result = await service.bookDirectAppointment({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      selectedSlotId: slot.id,
    });

    expect(result.kind).toBe("booked");
    expect(calls.fetch).toHaveLength(1);
    expect(calls.create).toEqual([
      {
        locationId: connection.externalLocationId,
        calendarId: connection.externalCalendarId,
        contactId: context.providerContactId,
        startAt: slot.startAt,
        endAt: slot.endAt,
        timezone: connection.timezone,
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(Object.keys(calls.create[0]).sort()).not.toContain("ignoreFreeSlotValidation");
    expect(calls.appointmentInputs).toHaveLength(1);
    expect(calls.intentLeaseRenewals.length).toBeGreaterThanOrEqual(2);
  });

  it("fences provider creation when the booking intent lease cannot be renewed", async () => {
    const { service, calls } = makeHarness({ renewBookingIntentLease: async () => false });
    const result = await service.bookDirectAppointment({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      selectedSlotId: slot.id,
    });
    expect(result).toEqual({ kind: "provider_error", error: "BOOKING_INTENT_LEASE_LOST" });
    expect(calls.create).toEqual([]);
    expect(calls.appointmentInputs).toEqual([]);
  });

  it("renews the fenced lease while a slow provider create remains in flight", async () => {
    vi.useFakeTimers();
    try {
      const { service, calls } = makeHarness({
        leaseHeartbeatMs: 10,
        createAppointment: async () => {
          await vi.advanceTimersByTimeAsync(25);
          return { externalId: "provider-appointment-slow" };
        },
      });
      await expect(service.bookDirectAppointment({
        tenantId: context.tenantId,
        conversationId: context.conversationId,
        selectedSlotId: slot.id,
      })).resolves.toMatchObject({ kind: "booked", providerExternalId: "provider-appointment-slow" });
      expect(calls.intentLeaseRenewals.length).toBeGreaterThanOrEqual(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a provider create before the five-minute lease can expire", async () => {
    let receivedSignal: AbortSignal | undefined;
    const { service, calls } = makeHarness({
      providerRequestTimeoutMs: 5,
      createAppointment: async (input) => {
        receivedSignal = input.signal;
        return new Promise((_, reject) => input.signal?.addEventListener("abort", () => {
          reject(new Error("BOOKING_PROVIDER_REQUEST_ABORTED"));
        }, { once: true }));
      },
    });
    await expect(service.bookDirectAppointment({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      selectedSlotId: slot.id,
    })).resolves.toEqual({ kind: "provider_error", error: "BOOKING_PROVIDER_REQUEST_TIMEOUT" });
    expect(receivedSignal?.aborted).toBe(true);
    expect(calls.appointmentInputs).toEqual([]);
  });

  it("re-offers current slots after a provider conflict without writing locally", async () => {
    const replacement = { ...slot, id: "slot-2", startAt: "2026-08-20T15:00:00.000Z" };
    const { service, calls } = makeHarness({
      fetchSlots: async () => [replacement],
      createAppointment: async () => {
        throw { status: 409, code: "slot_conflict" };
      },
    });

    const result = await service.bookDirectAppointment({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      selectedSlotId: slot.id,
      conflictContext: { emissionId: "emission-1", inboundMessageId: "inbound-1" },
    });

    expect(result).toMatchObject({
      kind: "reoffer",
      reason: "slot_conflict",
      intentId: "intent-1",
      proposal: {
        presentationTimezone: context.leadTimezone,
        slots: [{ id: replacement.id, display: "2026-08-20 08:00 America/Los_Angeles" }],
      },
    });
    expect(calls.appointmentInputs).toEqual([]);
    expect(calls.events).toEqual([]);
    expect(calls.intentReleases).toEqual([]);
    expect(calls.conflictCheckpoints).toEqual([expect.objectContaining({
      intentId: "intent-1",
      emissionId: "emission-1",
      inboundMessageId: "inbound-1",
    })]);
    expect(calls.proposals).toEqual([]);
  });

  it("keeps the durable conflict checkpoint when replacement fetching fails", async () => {
    const { service, calls } = makeHarness({
      createAppointment: async () => { throw { status: 409, code: "slot_conflict" }; },
      fetchSlots: async () => { throw new Error("CALENDAR_SLOT_FETCH_FAILED"); },
    });
    await expect(service.bookDirectAppointment({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      selectedSlotId: slot.id,
      conflictContext: { emissionId: "emission-1", inboundMessageId: "inbound-1" },
    })).resolves.toEqual({
      kind: "reoffer_pending", intentId: "intent-1", error: "CALENDAR_SLOT_FETCH_FAILED",
    });
    expect(calls.conflictCheckpoints).toHaveLength(1);
    expect(calls.intentReleases).toEqual([]);
    expect(calls.proposals).toEqual([]);
  });

  it("keeps conflict pending when replacement availability contains zero slots", async () => {
    const { service, calls } = makeHarness({
      createAppointment: async () => { throw { status: 409, code: "slot_conflict" }; },
      fetchSlots: async () => [],
    });
    await expect(service.bookDirectAppointment({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      selectedSlotId: slot.id,
      conflictContext: { emissionId: "emission-1", inboundMessageId: "inbound-1" },
    })).resolves.toEqual({ kind: "no_slots", conflictPending: true, intentId: "intent-1" });
    expect(calls.conflictCheckpoints).toHaveLength(1);
    expect(calls.proposals).toEqual([]);
    expect(calls.create).toHaveLength(1);
  });

  it("does not write locally when appointment creation errors", async () => {
    const { service, calls } = makeHarness({
      createAppointment: async () => {
        throw new Error("CALENDAR_CREATE_FAILED");
      },
    });

    const result = await service.bookDirectAppointment({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      selectedSlotId: slot.id,
    });

    expect(result).toEqual({ kind: "provider_error", error: "CALENDAR_CREATE_FAILED" });
    expect(calls.appointmentInputs).toEqual([]);
    expect(calls.intentReleases).toEqual([]);
  });

  it("recovers after an ambiguous provider error instead of issuing another create", async () => {
    let createAttempt = 0;
    const { service, calls } = makeHarness({
      createAppointment: async () => {
        createAttempt += 1;
        throw new Error("CALENDAR_CREATE_RESPONSE_LOST");
      },
      listAppointments: async () => [{
        externalId: "provider-appointment-after-timeout",
        contactId: context.providerContactId,
        startAt: slot.startAt,
        endAt: slot.endAt,
        status: "scheduled",
      }],
    });
    const input = {
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      selectedSlotId: slot.id,
    };

    await expect(service.bookDirectAppointment(input)).resolves.toEqual({
      kind: "provider_error",
      error: "CALENDAR_CREATE_RESPONSE_LOST",
    });
    await expect(service.bookDirectAppointment(input)).resolves.toMatchObject({
      kind: "booked",
      providerExternalId: "provider-appointment-after-timeout",
    });

    expect(createAttempt).toBe(1);
    expect(calls.providerLists).toHaveLength(1);
    expect(calls.intentProviderWrites.at(-1)).toMatchObject({ recovered: true });
  });

  it("recovers an equivalent provider instant with a different ISO offset representation", async () => {
    let creates = 0;
    const { service } = makeHarness({
      createAppointment: async () => {
        creates += 1;
        throw new Error("CALENDAR_CREATE_RESPONSE_LOST");
      },
      listAppointments: async () => [{
        externalId: "equivalent-instant",
        contactId: context.providerContactId,
        startAt: slot.startAt.replace(".000Z", "+00:00"),
        endAt: slot.endAt.replace(".000Z", "+00:00"),
        status: "scheduled",
      }],
    });
    const input = { tenantId: context.tenantId, conversationId: context.conversationId, selectedSlotId: slot.id };
    await service.bookDirectAppointment(input);
    await expect(service.bookDirectAppointment(input)).resolves.toMatchObject({
      kind: "booked", providerExternalId: "equivalent-instant",
    });
    expect(creates).toBe(1);
  });

  it("fails the provider envelope when recovery returns an invalid timestamp", async () => {
    let creates = 0;
    const { service } = makeHarness({
      createAppointment: async () => {
        creates += 1;
        throw new Error("CALENDAR_CREATE_RESPONSE_LOST");
      },
      listAppointments: async () => [{
        externalId: "invalid-time",
        contactId: context.providerContactId,
        startAt: "not-an-instant",
        endAt: slot.endAt,
        status: "scheduled",
      }],
    });
    const input = { tenantId: context.tenantId, conversationId: context.conversationId, selectedSlotId: slot.id };
    await service.bookDirectAppointment(input);
    await expect(service.bookDirectAppointment(input)).resolves.toEqual({
      kind: "provider_error", error: "CALENDAR_PROVIDER_ENVELOPE_INVALID",
    });
    expect(creates).toBe(1);
  });

  it("filters exact-time recovery candidates by the intended contact before ambiguity", async () => {
    const { service, calls } = makeHarness({
      createAppointment: async () => {
        throw new Error("CALENDAR_CREATE_RESPONSE_LOST");
      },
      listAppointments: async () => [
        {
          externalId: "other-contact-1", contactId: "other-1", startAt: slot.startAt,
          endAt: slot.endAt, status: "scheduled",
        },
        {
          externalId: "intended-contact", contactId: context.providerContactId, startAt: slot.startAt,
          endAt: slot.endAt, status: "scheduled",
        },
        {
          externalId: "other-contact-2", contactId: "other-2", startAt: slot.startAt,
          endAt: slot.endAt, status: "scheduled",
        },
      ],
    });
    const input = { tenantId: context.tenantId, conversationId: context.conversationId, selectedSlotId: slot.id };
    await service.bookDirectAppointment(input);
    await expect(service.bookDirectAppointment(input)).resolves.toMatchObject({
      kind: "booked", providerExternalId: "intended-contact",
    });
    expect(calls.intentProviderWrites.at(-1)).toMatchObject({ recovered: true });
  });

  it("refuses recovery when the exact-time provider event belongs to another contact", async () => {
    let createAttempt = 0;
    const { service, calls } = makeHarness({
      createAppointment: async () => {
        createAttempt += 1;
        throw new Error("CALENDAR_CREATE_RESPONSE_LOST");
      },
      listAppointments: async () => [{
        externalId: "somebody-elses-appointment",
        contactId: "different-provider-contact",
        startAt: slot.startAt,
        endAt: slot.endAt,
        status: "scheduled",
      }],
    });
    const input = {
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      selectedSlotId: slot.id,
    };

    await service.bookDirectAppointment(input);
    await expect(service.bookDirectAppointment(input)).resolves.toEqual({
      kind: "provider_error",
      error: "CALENDAR_BOOKING_RECOVERY_CONTACT_MISMATCH",
    });

    expect(createAttempt).toBe(1);
    expect(calls.appointmentInputs).toEqual([]);
  });

  it("does not create or write when a stale-slot refetch fails", async () => {
    const { service, calls } = makeHarness({
      initialProposal: proposal("2026-08-20T13:40:00.000Z"),
      fetchSlots: async () => {
        throw new Error("CALENDAR_SLOT_FETCH_FAILED");
      },
    });

    const result = await service.bookDirectAppointment({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      selectedSlotId: slot.id,
    });

    expect(result).toEqual({ kind: "provider_error", error: "CALENDAR_SLOT_FETCH_FAILED" });
    expect(calls.create).toEqual([]);
    expect(calls.appointmentInputs).toEqual([]);
  });

  it("absorbs one provider replay into one appointment, billable row, and event", async () => {
    const { service, calls } = makeHarness();
    const input = {
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      selectedSlotId: slot.id,
    };

    const first = await service.bookDirectAppointment(input);
    const replay = await service.bookDirectAppointment(input);

    expect(first).toMatchObject({
      kind: "booked",
      appointment: { appointmentId: "appointment-1", billableEventId: "billable-1" },
    });
    expect(replay).toMatchObject({
      kind: "booked",
      appointment: { appointmentId: "appointment-1", billableEventId: "billable-1" },
    });
    expect(calls.appointmentInputs).toHaveLength(1);
    expect(new Set(calls.appointmentInputs.map((input) => input.externalId))).toEqual(
      new Set(["provider-appointment-1"]),
    );
    expect(calls.events.map((event) => event.key)).toEqual(["appointment.booked"]);
    expect(calls.intentCompletions).toHaveLength(1);
  });

  it("recovers a provider appointment after the provider-id checkpoint fails", async () => {
    let checkpointAttempt = 0;
    const { service, calls } = makeHarness({
      recordBookingIntentProvider: async () => {
        checkpointAttempt += 1;
        if (checkpointAttempt === 1) throw new Error("INTENT_PROVIDER_CHECKPOINT_FAILED");
      },
      listAppointments: async () => [{
        externalId: "provider-appointment-1",
        contactId: context.providerContactId,
        startAt: slot.startAt,
        endAt: slot.endAt,
        status: "scheduled",
      }],
    });
    const input = {
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      selectedSlotId: slot.id,
    };

    await expect(service.bookDirectAppointment(input))
      .rejects.toThrow("INTENT_PROVIDER_CHECKPOINT_FAILED");
    const recovered = await service.bookDirectAppointment(input);

    expect(recovered).toMatchObject({
      kind: "booked",
      providerExternalId: "provider-appointment-1",
    });
    expect(calls.create).toHaveLength(1);
    expect(calls.providerLists).toHaveLength(1);
    expect(calls.intentReleases).toEqual([expect.objectContaining({ claimToken: "claim-1" })]);
    expect(calls.intentProviderWrites.at(-1)).toMatchObject({
      claimToken: "claim-1",
      recovered: true,
    });
  });

  it("reuses the provider checkpoint when local appointment persistence retries", async () => {
    let persistenceAttempt = 0;
    const { service, calls } = makeHarness({
      recordProviderAppointment: async () => {
        persistenceAttempt += 1;
        if (persistenceAttempt === 1) throw new Error("LOCAL_APPOINTMENT_WRITE_FAILED");
        return { appointmentId: "appointment-1", billableEventId: "billable-1", auditId: 1 };
      },
    });
    const input = {
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      selectedSlotId: slot.id,
    };

    await expect(service.bookDirectAppointment(input))
      .rejects.toThrow("LOCAL_APPOINTMENT_WRITE_FAILED");
    await expect(service.bookDirectAppointment(input)).resolves.toMatchObject({ kind: "booked" });

    expect(calls.create).toHaveLength(1);
    expect(calls.providerLists).toEqual([]);
    expect(calls.appointmentInputs).toHaveLength(2);
  });

  it("inherits test billing suppression and emits no notification event", async () => {
    const { service, calls } = makeHarness({ bookingContext: { ...context, isTest: true } });

    const result = await service.bookDirectAppointment({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      selectedSlotId: slot.id,
    });

    expect(result).toMatchObject({ kind: "booked", appointment: { billableEventId: null } });
    expect(calls.events).toEqual([]);
  });

  it("stamps the provider-derived booking-link attribution anchor without creating a row", async () => {
    const { service, calls } = makeHarness();

    const result = await service.prepareBookingLink({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
    });

    expect(result).toEqual({ kind: "link", bookingUrl: connection.bookingUrl });
    expect(calls.linkSentAt).toEqual(["2026-08-20T14:00:00.000Z"]);
    expect(calls.create).toEqual([]);
    expect(calls.appointmentInputs).toEqual([]);
  });
});
