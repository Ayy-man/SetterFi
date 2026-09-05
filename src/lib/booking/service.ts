/**
 * Provider-first slot proposal and direct booking.
 *
 * The service resolves the primary calendar and booking identity from repositories rather than
 * accepting either from the caller. It records provider health on every attempted slot fetch and
 * cannot persist an appointment until the calendar has returned its durable external id.
 */

import type { CalendarDriver } from "@/lib/integrations/types";

import type {
  BookingDomainEvent,
  BookingLinkResult,
  BookingRepository,
  BookingResult,
  CalendarConnection,
  CalendarHealthChange,
  CalendarSlot,
  OfferedSlot,
  ProposedSlotSet,
  SlotProposalResult,
} from "./types";

export const MAX_PROPOSED_SLOT_AGE_MS = 15 * 60_000;
export const MAX_CALENDAR_ERROR_LENGTH = 240;

export function bookingIntentIdempotencyKey(input: {
  tenantId: string;
  conversationId: string;
  calendarConnectionId: string;
  selectedSlotId: string;
  startAt: string;
}) {
  return JSON.stringify([
    "booking-intent-v1",
    input.tenantId,
    input.conversationId,
    input.calendarConnectionId,
    input.selectedSlotId,
    input.startAt,
  ]);
}

type BookingServiceDependencies = {
  calendar: CalendarDriver;
  /** Used instead of `calendar` for a context marked `simulated`; absent means always real. */
  simulatedCalendar?: CalendarDriver;
  repository: BookingRepository;
  emitDomainEvent: (event: BookingDomainEvent) => Promise<void>;
  now?: () => Date;
  leaseClock?: () => Date;
  leaseHeartbeatMs?: number;
  providerRequestTimeoutMs?: number;
};

type ProposalInput = {
  tenantId: string;
  conversationId: string;
  rangeStartAt: string;
  rangeEndAt: string;
};

type DirectBookingInput = {
  tenantId: string;
  conversationId: string;
  selectedSlotId: string;
  conflictContext?: { emissionId: string; inboundMessageId: string };
};

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim() || "Calendar slot fetch failed";
  return normalized.slice(0, MAX_CALENDAR_ERROR_LENGTH);
}

function isConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; status?: unknown };
  return candidate.status === 409 ||
    candidate.code === "slot_conflict" ||
    candidate.code === "CALENDAR_SLOT_CONFLICT";
}

function providerInstant(value: string) {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) throw new Error("CALENDAR_PROVIDER_ENVELOPE_INVALID");
  return instant;
}

function formatInTimezone(instant: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute} ${timezone}`;
}

export function formatOfferedSlot(slot: CalendarSlot, timezone: string): OfferedSlot {
  return { ...slot, display: formatInTimezone(slot.startAt, timezone) };
}

export function isProposedSlotFresh(proposal: ProposedSlotSet, now: Date) {
  const proposedAt = Date.parse(proposal.proposedAt);
  const age = now.getTime() - proposedAt;
  return Number.isFinite(proposedAt) && age >= 0 && age <= MAX_PROPOSED_SLOT_AGE_MS;
}

export function createBookingService({
  calendar: realCalendar,
  simulatedCalendar,
  repository,
  emitDomainEvent,
  now = () => new Date(),
  leaseClock = () => new Date(),
  leaseHeartbeatMs = 60_000,
  providerRequestTimeoutMs = 240_000,
}: BookingServiceDependencies) {
  function calendarFor(context: { simulated?: boolean }) {
    return context.simulated && simulatedCalendar ? simulatedCalendar : realCalendar;
  }
  async function withProviderDeadline<T>(operation: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort("BOOKING_PROVIDER_REQUEST_TIMEOUT");
        reject(new Error("BOOKING_PROVIDER_REQUEST_TIMEOUT"));
      }, providerRequestTimeoutMs);
    });
    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }
  async function withBookingLease<T>(
    claim: Extract<Awaited<ReturnType<BookingRepository["claimBookingIntent"]>>, { kind: "claimed" }>,
    tenantId: string,
    operation: () => Promise<T>,
  ) {
    const renew = async () => {
      const renewed = await repository.renewBookingIntentLease({
        intentId: claim.intentId,
        claimToken: claim.claimToken,
        tenantId,
        now: leaseClock().toISOString(),
      });
      if (!renewed) throw new Error("BOOKING_INTENT_LEASE_LOST");
    };
    await renew();
    let heartbeatFailure: unknown = null;
    const timer = setInterval(() => {
      void renew().catch((error) => { heartbeatFailure ??= error; });
    }, leaseHeartbeatMs);
    try {
      const value = await operation();
      if (heartbeatFailure) throw heartbeatFailure;
      await renew();
      return value;
    } finally {
      clearInterval(timer);
    }
  }
  async function fetchAndPersistSlots(
    context: Awaited<ReturnType<BookingRepository["getBookingContext"]>>,
    connection: CalendarConnection,
    rangeStartAt: string,
    rangeEndAt: string,
    persistProposal = true,
  ): Promise<SlotProposalResult> {
    const presentationTimezone = context.leadTimezone ?? connection.timezone;
    const calendar = calendarFor(context);
    let slots: CalendarSlot[];

    try {
      slots = await withProviderDeadline((signal) => calendar.fetchSlots({
        locationId: connection.externalLocationId,
        calendarId: connection.externalCalendarId,
        startAt: rangeStartAt,
        endAt: rangeEndAt,
        timezone: presentationTimezone,
        signal,
      }));
    } catch (error) {
      const fetchedAt = now().toISOString();
      const boundedError = errorMessage(error);
      const health: Extract<CalendarHealthChange, { kind: "unhealthy" }> = {
        kind: "unhealthy",
        tenantId: context.tenantId,
        calendarConnectionId: connection.id,
        fetchedAt,
        error: boundedError,
      };
      await repository.recordCalendarSlotFetch({
        tenantId: context.tenantId,
        calendarConnectionId: connection.id,
        ok: false,
        error: boundedError,
        fetchedAt,
      });
      return { kind: "unhealthy", health };
    }

    // The proposal age starts after a successful provider response. Measuring before the request
    // can persist an already-expired offer when the provider is slow.
    const fetchedAt = now().toISOString();
    const proposal: ProposedSlotSet = {
      calendarConnectionId: connection.id,
      rangeStartAt,
      rangeEndAt,
      proposedAt: fetchedAt,
      presentationTimezone,
      // The emitted contract supports at most five exact opaque choices. Bound the provider set
      // before CAS persistence so the winning row, returned proposal, outbound tokens, and later
      // recovery all use the same deterministic provider-ordered subset.
      slots: slots.slice(0, 5).map((slot) => formatOfferedSlot(slot, presentationTimezone)),
    };
    const health: CalendarHealthChange = {
      kind: "healthy",
      tenantId: context.tenantId,
      calendarConnectionId: connection.id,
      fetchedAt,
    };
    await repository.recordCalendarSlotFetch({
      tenantId: context.tenantId,
      calendarConnectionId: connection.id,
      ok: true,
      error: null,
      fetchedAt,
    });
    if (slots.length === 0) return { kind: "unavailable", reason: "no_slots" };
    const recordedProposal = persistProposal
      ? await repository.recordProposedSlots({
          tenantId: context.tenantId,
          conversationId: context.conversationId,
          proposal,
        })
      : proposal;
    return { kind: "offered", proposal: recordedProposal, health };
  }

  async function proposeSlots(input: ProposalInput): Promise<SlotProposalResult> {
    const [context, connection] = await Promise.all([
      repository.getBookingContext(input.tenantId, input.conversationId),
      repository.getPrimaryCalendar(input.tenantId),
    ]);
    if (!connection) return { kind: "unavailable", reason: "primary_calendar_missing" };
    return fetchAndPersistSlots(context, connection, input.rangeStartAt, input.rangeEndAt);
  }

  async function fetchReplacementSlots(input: ProposalInput): Promise<SlotProposalResult> {
    const [context, connection] = await Promise.all([
      repository.getBookingContext(input.tenantId, input.conversationId),
      repository.getPrimaryCalendar(input.tenantId),
    ]);
    if (!connection) return { kind: "unavailable", reason: "primary_calendar_missing" };
    return fetchAndPersistSlots(
      context,
      connection,
      input.rangeStartAt,
      input.rangeEndAt,
      false,
    );
  }

  async function bookDirectAppointment(input: DirectBookingInput): Promise<BookingResult> {
    const [context, connection, storedProposal] = await Promise.all([
      repository.getBookingContext(input.tenantId, input.conversationId),
      repository.getPrimaryCalendar(input.tenantId),
      repository.getProposedSlots(input.tenantId, input.conversationId),
    ]);
    if (!connection) return { kind: "unavailable", reason: "primary_calendar_missing" };
    if (!storedProposal || storedProposal.calendarConnectionId !== connection.id) {
      return { kind: "unavailable", reason: "slot_not_offered" };
    }

    let proposal = storedProposal;
    if (!isProposedSlotFresh(proposal, now())) {
      const refreshed = await fetchAndPersistSlots(
        context,
        connection,
        proposal.rangeStartAt,
        proposal.rangeEndAt,
      );
      if (refreshed.kind !== "offered") {
        return refreshed.kind === "unhealthy"
          ? { kind: "provider_error", error: refreshed.health.error }
          : { kind: "unavailable", reason: "primary_calendar_missing" };
      }
      proposal = refreshed.proposal;
      if (!proposal.slots.some((slot) => slot.id === input.selectedSlotId)) {
        return { kind: "reoffer", reason: "slot_stale", proposal };
      }
    }

    const slot = proposal.slots.find((candidate) => candidate.id === input.selectedSlotId);
    if (!slot) return { kind: "unavailable", reason: "slot_not_offered" };

    const intentInput = {
      idempotencyKey: bookingIntentIdempotencyKey({
        tenantId: context.tenantId,
        conversationId: context.conversationId,
        calendarConnectionId: connection.id,
        selectedSlotId: slot.id,
        startAt: slot.startAt,
      }),
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      contactId: context.contactId,
      calendarConnectionId: connection.id,
      selectedSlotId: slot.id,
      startAt: slot.startAt,
      endAt: slot.endAt,
      timezone: connection.timezone,
    };
    const claim = await repository.claimBookingIntent({
      ...intentInput,
      now: now().toISOString(),
    });
    if (claim.kind === "busy") return { kind: "in_progress", intentId: claim.intentId };
    if (claim.kind === "completed") {
      return {
        kind: "booked",
        appointment: claim.appointment,
        providerExternalId: claim.providerExternalId,
        slot,
      };
    }

    let providerExternalId = claim.kind === "provider_created"
      ? claim.providerExternalId
      : null;
    let recovered = false;
    const calendar = calendarFor(context);
    try {
      if (claim.kind === "claimed") {
        const resolved = await withBookingLease(claim, context.tenantId, async () => {
          let externalId: string | null = null;
          let wasRecovered = false;
          if (claim.recoveryRequired) {
            const listed = (await withProviderDeadline((signal) => calendar.listAppointments({
              locationId: connection.externalLocationId,
              calendarId: connection.externalCalendarId,
              startAt: slot.startAt,
              endAt: slot.endAt,
              signal,
            }))).filter((candidate) => candidate.status !== "canceled");
            const expectedStart = providerInstant(slot.startAt);
            const expectedEnd = providerInstant(slot.endAt);
            const normalized = listed.map((candidate) => ({
              candidate,
              startAt: providerInstant(candidate.startAt),
              endAt: providerInstant(candidate.endAt),
            }));
            const exactTimeCandidates = normalized.filter((candidate) =>
              candidate.startAt === expectedStart && candidate.endAt === expectedEnd
            );
            const candidates = exactTimeCandidates.filter(
              ({ candidate }) => candidate.contactId === context.providerContactId,
            );
            if (candidates.length > 1) throw new Error("CALENDAR_BOOKING_RECOVERY_AMBIGUOUS");
            if (candidates.length === 1) {
              externalId = candidates[0].candidate.externalId;
              wasRecovered = true;
            } else if (exactTimeCandidates.length > 0) {
              throw new Error("CALENDAR_BOOKING_RECOVERY_CONTACT_MISMATCH");
            }
          }
          if (!externalId) {
            externalId = (await withProviderDeadline((signal) => calendar.createAppointment({
              locationId: connection.externalLocationId,
              calendarId: connection.externalCalendarId,
              contactId: context.providerContactId,
              startAt: slot.startAt,
              endAt: slot.endAt,
              timezone: connection.timezone,
              signal,
            }))).externalId;
          }
          return { externalId, wasRecovered };
        });
        providerExternalId = resolved.externalId;
        recovered = resolved.wasRecovered;
      }
    } catch (error) {
      if (claim.kind !== "claimed") throw error;
      if (!isConflict(error)) return { kind: "provider_error", error: errorMessage(error) };
      if (!input.conflictContext) {
        throw new Error("BOOKING_CONFLICT_CHECKPOINT_CONTEXT_REQUIRED");
      }
      await repository.checkpointBookingConflict({
        intentId: claim.intentId,
        claimToken: claim.claimToken,
        tenantId: context.tenantId,
        emissionId: input.conflictContext.emissionId,
        inboundMessageId: input.conflictContext.inboundMessageId,
        error: errorMessage(error),
        now: now().toISOString(),
      });
      const refreshed = await fetchAndPersistSlots(
        context,
        connection,
        proposal.rangeStartAt,
        proposal.rangeEndAt,
        false,
      );
      if (refreshed.kind !== "offered") {
        if (refreshed.kind === "unavailable" && refreshed.reason === "no_slots") {
          return { kind: "no_slots", conflictPending: true, intentId: claim.intentId };
        }
        return {
          kind: "reoffer_pending",
          intentId: claim.intentId,
          error: refreshed.kind === "unhealthy" ? refreshed.health.error : refreshed.reason,
        };
      }
      return {
        kind: "reoffer",
        reason: "slot_conflict",
        proposal: refreshed.proposal,
        intentId: claim.intentId,
      };
    }

    if (!providerExternalId) throw new Error("BOOKING_PROVIDER_ID_MISSING");

    if (claim.kind === "claimed") {
      try {
        await repository.recordBookingIntentProvider({
          intentId: claim.intentId,
          claimToken: claim.claimToken,
          tenantId: context.tenantId,
          providerExternalId,
          recovered,
        });
      } catch (error) {
        // If the checkpoint did not commit, make the intent immediately recoverable. If it did
        // commit but the response was lost, release safely refuses the provider_created state.
        await repository.releaseBookingIntent({
          intentId: claim.intentId,
          claimToken: claim.claimToken,
          tenantId: context.tenantId,
          error: errorMessage(error),
        }).catch(() => undefined);
        throw error;
      }
    }

    const appointment = await repository.recordProviderAppointment({
      tenantId: context.tenantId,
      contactId: context.contactId,
      conversationId: context.conversationId,
      calendarConnectionId: connection.id,
      provider: connection.provider,
      externalId: providerExternalId,
      startAt: slot.startAt,
      endAt: slot.endAt,
      timezone: connection.timezone,
      source: "agent",
      attributedToAgent: true,
    });

    // Notification insertion deduplicates by appointment source id. Keeping the intent incomplete
    // until this succeeds makes an emitter failure retryable without creating another provider row.
    if (!context.isTest) {
      await emitDomainEvent({
        key: "appointment.booked",
        ...context,
        appointmentId: appointment.appointmentId,
        calendarConnectionId: connection.id,
        calendarTimezone: connection.timezone,
        startAt: slot.startAt,
        endAt: slot.endAt,
        attributedToAgent: true,
      });
    }
    await repository.completeBookingIntent({
      intentId: claim.intentId,
      tenantId: context.tenantId,
      providerExternalId,
      appointment,
    });

    return {
      kind: "booked",
      appointment,
      providerExternalId,
      slot,
    };
  }

  async function prepareBookingLink(input: {
    tenantId: string;
    conversationId: string;
  }): Promise<BookingLinkResult> {
    const connection = await repository.getPrimaryCalendar(input.tenantId);
    if (!connection) return { kind: "unavailable", reason: "primary_calendar_missing" };
    if (!connection.bookingUrl) return { kind: "unavailable", reason: "booking_url_missing" };
    await repository.recordBookingLinkSent({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      sentAt: now().toISOString(),
    });
    return { kind: "link", bookingUrl: connection.bookingUrl };
  }

  return { proposeSlots, fetchReplacementSlots, bookDirectAppointment, prepareBookingLink };
}
