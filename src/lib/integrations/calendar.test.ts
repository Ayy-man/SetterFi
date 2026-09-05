import { describe, expect, it } from "vitest";

import {
  CalendarConflictError,
  CalendarProviderError,
  createMockCalendarDriver,
  createRealCalendarDriver,
} from "./calendar";
import { createSimulatedCalendarDriver, isSimulatedCalendarExternalId } from "./calendar";

const appointment = {
  locationId: "location-1",
  calendarId: "calendar-1",
  contactId: "contact-1",
  startAt: "2026-08-20T10:00:00.000Z",
  endAt: "2026-08-20T10:30:00.000Z",
  timezone: "UTC",
};

describe("calendar mock driver", () => {
  it("returns deterministic slots and enforces a provider-style collision without fetch", async () => {
    const driver = createMockCalendarDriver();
    const range = {
      locationId: appointment.locationId,
      calendarId: appointment.calendarId,
      startAt: appointment.startAt,
      endAt: "2026-08-21T10:00:00.000Z",
      timezone: appointment.timezone,
    };
    expect(await driver.fetchSlots(range)).toEqual(await driver.fetchSlots(range));
    await expect(driver.createAppointment(appointment)).resolves.toMatchObject({
      externalId: expect.stringMatching(/^mock-appointment-/),
    });
    await expect(driver.createAppointment(appointment)).rejects.toBeInstanceOf(CalendarConflictError);
  });
});

describe("calendar real driver", () => {
  it("attaches GHL calendar headers and omits the collision-bypass flag", async () => {
    let captured: RequestInit | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      captured = init;
      return new Response(JSON.stringify({ id: "appointment-1" }), { status: 200 });
    };
    const driver = createRealCalendarDriver({
      fetch: fetcher,
      getLocationAccessToken: async () => "injected-access-token",
    });
    await expect(driver.createAppointment(appointment)).resolves.toEqual({
      externalId: "appointment-1",
    });
    expect(captured?.headers).toMatchObject({
      Authorization: "Bearer injected-access-token",
      Version: "2021-04-15",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(captured?.body))).not.toHaveProperty("ignoreFreeSlotValidation");
  });

  it("normalizes slot maps and appointment lists", async () => {
    const responses = [
      new Response(
        JSON.stringify({
          slots: { "2026-08-20": { slots: ["2026-08-20T10:00:00.000Z"] } },
        }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({
          events: [
            {
              id: "appointment-1",
              contactId: appointment.contactId,
              startTime: appointment.startAt,
              endTime: appointment.endAt,
              appointmentStatus: "cancelled",
            },
          ],
        }),
        { status: 200 },
      ),
    ];
    const driver = createRealCalendarDriver({
      fetch: async () => responses.shift()!,
      getLocationAccessToken: async () => "injected-access-token",
    });
    await expect(
      driver.fetchSlots({
        locationId: appointment.locationId,
        calendarId: appointment.calendarId,
        startAt: appointment.startAt,
        endAt: "2026-08-21T10:00:00.000Z",
        timezone: "UTC",
      }),
    ).resolves.toEqual([
      {
        id: expect.stringMatching(/^ghl-slot-/),
        startAt: appointment.startAt,
        endAt: appointment.endAt,
        timezone: "UTC",
      },
    ]);
    await expect(
      driver.listAppointments({
        locationId: appointment.locationId,
        calendarId: appointment.calendarId,
        startAt: appointment.startAt,
        endAt: appointment.endAt,
      }),
    ).resolves.toEqual([
      {
        externalId: "appointment-1",
        contactId: appointment.contactId,
        startAt: appointment.startAt,
        endAt: appointment.endAt,
        status: "canceled",
      },
    ]);
  });

  it("cancels through the event path and updates through the appointment path", async () => {
    const urls: string[] = [];
    const methods: (string | undefined)[] = [];
    const driver = createRealCalendarDriver({
      fetch: async (input, init) => {
        urls.push(String(input));
        methods.push(init?.method);
        return new Response(JSON.stringify({ id: "appointment-1" }), { status: 200 });
      },
      getLocationAccessToken: async () => "injected-access-token",
    });
    await driver.updateAppointment({
      locationId: appointment.locationId,
      externalId: "appointment-1",
      startAt: appointment.startAt,
      endAt: appointment.endAt,
      timezone: appointment.timezone,
    });
    await driver.cancelAppointment({
      locationId: appointment.locationId,
      externalId: "appointment-1",
    });
    expect(urls).toEqual([
      "https://services.leadconnectorhq.com/calendars/events/appointments/appointment-1",
      "https://services.leadconnectorhq.com/calendars/events/appointment-1",
    ]);
    expect(methods).toEqual(["PUT", "DELETE"]);
  });

  it("rejects malformed successes and exposes only the error status and body shape", async () => {
    const malformed = createRealCalendarDriver({
      fetch: async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }),
      getLocationAccessToken: async () => "injected-access-token",
    });
    await expect(malformed.createAppointment(appointment)).rejects.toThrow(
      /CALENDAR_CREATE_ENVELOPE_INVALID/,
    );

    const failed = createRealCalendarDriver({
      fetch: async () => new Response(JSON.stringify({ privateDetail: "not-repeated" }), { status: 503 }),
      getLocationAccessToken: async () => "injected-access-token",
    });
    try {
      await failed.createAppointment(appointment);
    } catch (error) {
      expect(error).toBeInstanceOf(CalendarProviderError);
      expect(error).toMatchObject({ status: 503, bodyShape: "privateDetail" });
      expect(String(error)).not.toContain("not-repeated");
    }
  });

  it("rejects appointment readback without the documented provider contact identity", async () => {
    const driver = createRealCalendarDriver({
      fetch: async () => new Response(JSON.stringify({
        events: [{
          id: "appointment-1",
          startTime: appointment.startAt,
          endTime: appointment.endAt,
          appointmentStatus: "confirmed",
        }],
      }), { status: 200 }),
      getLocationAccessToken: async () => "injected-access-token",
    });

    await expect(driver.listAppointments({
      locationId: appointment.locationId,
      calendarId: appointment.calendarId,
      startAt: appointment.startAt,
      endAt: appointment.endAt,
    })).rejects.toThrow("CALENDAR_APPOINTMENT_ENVELOPE_INVALID");
  });
});

describe("simulated calendar driver", () => {
  it("issues provider-shaped slot ids and prefixed appointment ids", async () => {
    const driver = createSimulatedCalendarDriver();
    const [slot] = await driver.fetchSlots({ locationId: "loc", calendarId: "cal", startAt: "2026-09-06T17:00:00.000Z", endAt: "2026-09-06T18:00:00.000Z", timezone: "America/Los_Angeles" });
    expect(slot.id).toMatch(/^[A-Za-z0-9._~-]{1,200}$/u);
    const appointment = await driver.createAppointment({ locationId: "loc", calendarId: "cal", contactId: "c", startAt: slot.startAt, endAt: slot.endAt, timezone: slot.timezone });
    expect(isSimulatedCalendarExternalId(appointment.externalId)).toBe(true);
    expect(await driver.listAppointments({ locationId: "loc", calendarId: "cal", startAt: slot.startAt, endAt: slot.endAt })).toEqual([]);
  });
});
