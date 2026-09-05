/**
 * Calendar drivers treat the provider as the availability authority and never pre-write locally.
 *
 * Appointment creation deliberately omits ignoreFreeSlotValidation; a provider collision is a
 * typed result for the booking service to refetch and re-offer rather than a local double booking.
 */

import type { CalendarDriver } from "./types";

const GHL_BASE_URL = "https://services.leadconnectorhq.com";

type JsonObject = Record<string, unknown>;
type FetchLike = typeof fetch;

export class CalendarProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
    readonly bodyShape: string | null = null,
  ) {
    super(status === null ? code : `${code} (HTTP ${status})`);
    this.name = "CalendarProviderError";
  }
}

export class CalendarConflictError extends CalendarProviderError {
  constructor(status: number | null = null, bodyShape: string | null = null) {
    super("CALENDAR_SLOT_CONFLICT", status, bodyShape);
    this.name = "CalendarConflictError";
  }
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function shape(value: unknown) {
  const row = object(value);
  return row ? Object.keys(row).sort().join(",") : Array.isArray(value) ? "array" : typeof value;
}

function stableId(prefix: string, values: readonly string[]) {
  let hash = 2_166_136_261;
  for (const character of values.join("|")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

async function responseJson(response: Response, code: string) {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CalendarProviderError(`${code}_MALFORMED_JSON`, response.status, "non-json");
  }
  if (!response.ok) {
    if (response.status === 409 || response.status === 422) {
      throw new CalendarConflictError(response.status, shape(payload));
    }
    throw new CalendarProviderError(code, response.status, shape(payload));
  }
  return payload;
}

function slotRows(payload: unknown, timezone: string) {
  const row = object(payload);
  const slots = row?.slots;
  const candidates: unknown[] = [];
  if (Array.isArray(slots)) candidates.push(...slots);
  const slotMap = object(slots);
  if (slotMap) {
    for (const value of Object.values(slotMap)) {
      if (Array.isArray(value)) candidates.push(...value);
      const dated = object(value);
      if (Array.isArray(dated?.slots)) candidates.push(...dated.slots);
    }
  }
  return candidates.map((candidate, index) => {
    const item = object(candidate);
    const startAt = text(item?.startTime) ?? text(item?.startAt) ?? text(candidate);
    const endAt = text(item?.endTime) ?? text(item?.endAt);
    if (!startAt) throw new CalendarProviderError("CALENDAR_SLOT_ENVELOPE_INVALID");
    const derivedEnd = endAt ?? new Date(new Date(startAt).getTime() + 30 * 60_000).toISOString();
    return {
      id: text(item?.id) ?? stableId("ghl-slot", [startAt, derivedEnd, String(index)]),
      startAt,
      endAt: derivedEnd,
      timezone,
    };
  });
}

function appointmentRows(payload: unknown) {
  const row = object(payload);
  const events = Array.isArray(row?.events)
    ? row.events
    : Array.isArray(row?.appointments)
      ? row.appointments
      : null;
  if (!events) throw new CalendarProviderError("CALENDAR_LIST_ENVELOPE_INVALID");
  return events.map((event) => {
    const item = object(event);
    const externalId = text(item?.id);
    const contactId = text(item?.contactId);
    const startAt = text(item?.startTime) ?? text(item?.startAt);
    const endAt = text(item?.endTime) ?? text(item?.endAt);
    const providerStatus = text(item?.appointmentStatus) ?? text(item?.status);
    if (!externalId || !contactId || !startAt || !endAt || !providerStatus) {
      throw new CalendarProviderError("CALENDAR_APPOINTMENT_ENVELOPE_INVALID");
    }
    const status = providerStatus === "cancelled" ? "canceled" : providerStatus;
    return { externalId, contactId, startAt, endAt, status };
  });
}

export function createMockCalendarDriver(): CalendarDriver {
  const created = new Map<string, string>();
  return {
    fetchSlots: async (input) => [
      {
        id: stableId("mock-slot", [input.calendarId, input.startAt, input.timezone]),
        startAt: input.startAt,
        endAt: new Date(new Date(input.startAt).getTime() + 30 * 60_000).toISOString(),
        timezone: input.timezone,
      },
    ],
    createAppointment: async (input) => {
      const slotKey = `${input.calendarId}:${input.startAt}:${input.endAt}`;
      if (created.has(slotKey)) throw new CalendarConflictError();
      const externalId = stableId("mock-appointment", [
        input.locationId,
        input.calendarId,
        input.contactId,
        input.startAt,
      ]);
      created.set(slotKey, externalId);
      return { externalId };
    },
    updateAppointment: async (input) => ({ externalId: input.externalId }),
    cancelAppointment: async (input) => {
      for (const [slotKey, externalId] of created) {
        if (externalId === input.externalId) created.delete(slotKey);
      }
    },
    listAppointments: async () => [],
  };
}

export const SIMULATED_CALENDAR_ID_PREFIX = "simulated:";

export function isSimulatedCalendarExternalId(value: string | null | undefined) {
  return typeof value === "string" && value.startsWith(SIMULATED_CALENDAR_ID_PREFIX);
}

/**
 * The calendar arm of a simulated send. A demo tenant's test thread books against this instead
 * of the tenant's real calendar, so a rehearsal can walk the whole booking flow without a slot
 * ever being taken on a coach's provider. Its ids carry the same prefix as a simulated message,
 * and the lifecycle service treats them as never having existed at the provider.
 */
export function createSimulatedCalendarDriver(): CalendarDriver {
  const mock = createMockCalendarDriver();
  const simulatedId = (prefix: string, values: readonly string[]) =>
    `${SIMULATED_CALENDAR_ID_PREFIX}${stableId(prefix, values)}`;
  return {
    // A slot id travels through the lead's reply and is validated as a provider id (letters,
    // digits and ._~- only), so it carries no colon; only the appointment id needs the prefix.
    fetchSlots: async (input) => (await mock.fetchSlots(input)).map((slot) => ({
      ...slot,
      id: `simulated-${stableId("slot", [input.calendarId, input.startAt, input.timezone])}`,
    })),
    createAppointment: async (input) => ({
      externalId: simulatedId("appointment", [
        (await mock.createAppointment(input)).externalId,
      ]),
    }),
    updateAppointment: async (input) => ({ externalId: input.externalId }),
    cancelAppointment: async () => {},
    listAppointments: async () => [],
  };
}

function missingAccessToken(locationId: string): never {
  throw new CalendarProviderError(`GHL_LOCATION_ACCESS_TOKEN_UNAVAILABLE:${locationId}`);
}

export function createRealCalendarDriver({
  fetch: fetcher = fetch,
  getLocationAccessToken = async (locationId) => missingAccessToken(locationId),
}: {
  fetch?: FetchLike;
  getLocationAccessToken?: (locationId: string) => Promise<string>;
} = {}): CalendarDriver {
  async function request(
    locationId: string,
    path: string,
    init: RequestInit,
    code: string,
  ) {
    const accessToken = await getLocationAccessToken(locationId);
    const response = await fetcher(`${GHL_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Version: "2021-04-15",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    return { payload: await responseJson(response, code), status: response.status };
  }

  return {
    fetchSlots: async (input) => {
      const query = new URLSearchParams({
        startDate: input.startAt,
        endDate: input.endAt,
        timezone: input.timezone,
      });
      const { payload } = await request(
        input.locationId,
        `/calendars/${encodeURIComponent(input.calendarId)}/free-slots?${query}`,
        { method: "GET", signal: input.signal },
        "CALENDAR_SLOT_FETCH_FAILED",
      );
      return slotRows(payload, input.timezone);
    },
    createAppointment: async (input) => {
      const { payload, status } = await request(
        input.locationId,
        "/calendars/events/appointments",
        {
          method: "POST",
          signal: input.signal,
          body: JSON.stringify({
            calendarId: input.calendarId,
            locationId: input.locationId,
            contactId: input.contactId,
            startTime: input.startAt,
            endTime: input.endAt,
            timezone: input.timezone,
          }),
        },
        "CALENDAR_APPOINTMENT_CREATE_FAILED",
      );
      const externalId = text(object(payload)?.id);
      if (!externalId) {
        throw new CalendarProviderError("CALENDAR_CREATE_ENVELOPE_INVALID", status, shape(payload));
      }
      return { externalId };
    },
    updateAppointment: async (input) => {
      const { payload, status } = await request(
        input.locationId,
        `/calendars/events/appointments/${encodeURIComponent(input.externalId)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            startTime: input.startAt,
            endTime: input.endAt,
            timezone: input.timezone,
          }),
        },
        "CALENDAR_APPOINTMENT_UPDATE_FAILED",
      );
      const externalId = text(object(payload)?.id) ?? text(object(payload)?.eventId);
      if (!externalId) {
        throw new CalendarProviderError("CALENDAR_UPDATE_ENVELOPE_INVALID", status, shape(payload));
      }
      return { externalId };
    },
    cancelAppointment: async (input) => {
      // Deleting an appointment is an *event* delete in GHL v2, not an appointment delete: the
      // provider exposes DELETE /calendars/events/{eventId}. The appointments sub-path only
      // exists for create and update, so cancelling through it silently 404s.
      await request(
        input.locationId,
        `/calendars/events/${encodeURIComponent(input.externalId)}`,
        { method: "DELETE" },
        "CALENDAR_APPOINTMENT_CANCEL_FAILED",
      );
    },
    listAppointments: async (input) => {
      const query = new URLSearchParams({
        locationId: input.locationId,
        calendarId: input.calendarId,
        startTime: input.startAt,
        endTime: input.endAt,
      });
      const { payload } = await request(
        input.locationId,
        `/calendars/events?${query}`,
        { method: "GET", signal: input.signal },
        "CALENDAR_APPOINTMENT_LIST_FAILED",
      );
      return appointmentRows(payload);
    },
  };
}
