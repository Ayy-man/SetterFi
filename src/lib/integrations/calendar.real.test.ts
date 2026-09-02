import { describe, expect, it } from "vitest";

import { environmentValue, realArmSkipReason } from "@/lib/env-contract";

import { CalendarProviderError, createRealCalendarDriver } from "./calendar";

const required = [
  "GHL_CLIENT_ID",
  "GHL_CLIENT_SECRET",
  "GHL_WEBHOOK_PUBLIC_KEY",
  "SETTERFI_GHL_TEST_ACCESS_TOKEN",
  "SETTERFI_GHL_TEST_LOCATION_ID",
  "SETTERFI_GHL_TEST_CALENDAR_ID",
  "SETTERFI_GHL_TEST_CONTACT_ID",
] as const;
const skipReason = realArmSkipReason("calendar", "SETTERFI_GHL_DRIVER", required);

describe.skipIf(Boolean(skipReason))(
  `Calendar real arm — SKIPPED: ${skipReason ?? "configured"}`,
  () => {
    it("rejects a second write to one seeded-test-calendar slot and cleans up created IDs", async () => {
      const locationId = environmentValue("SETTERFI_GHL_TEST_LOCATION_ID")!;
      const calendarId = environmentValue("SETTERFI_GHL_TEST_CALENDAR_ID")!;
      const contactId = environmentValue("SETTERFI_GHL_TEST_CONTACT_ID")!;
      const driver = createRealCalendarDriver({
        getLocationAccessToken: async () => environmentValue("SETTERFI_GHL_TEST_ACCESS_TOKEN")!,
      });
      const start = new Date(Date.now() + 24 * 60 * 60_000);
      const end = new Date(start.getTime() + 7 * 24 * 60 * 60_000);
      const slots = await driver.fetchSlots({
        locationId,
        calendarId,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        timezone: "UTC",
      });
      expect(slots.length).toBeGreaterThan(0);
      const slot = slots[0];
      const createdIds: string[] = [];
      let secondWriteAccepted = false;
      let rejectionStatus: number | null = null;
      let rejectionBodyShape: string | null = null;
      try {
        const first = await driver.createAppointment({
          locationId,
          calendarId,
          contactId,
          startAt: slot.startAt,
          endAt: slot.endAt,
          timezone: slot.timezone,
        });
        createdIds.push(first.externalId);
        try {
          const second = await driver.createAppointment({
            locationId,
            calendarId,
            contactId,
            startAt: slot.startAt,
            endAt: slot.endAt,
            timezone: slot.timezone,
          });
          createdIds.push(second.externalId);
          secondWriteAccepted = true;
        } catch (error) {
          expect(error).toBeInstanceOf(CalendarProviderError);
          rejectionStatus = (error as CalendarProviderError).status;
          rejectionBodyShape = (error as CalendarProviderError).bodyShape;
        }
        expect(secondWriteAccepted).toBe(false);
        expect(createdIds).toHaveLength(1);
        expect(rejectionStatus).toBeGreaterThanOrEqual(400);
        expect(rejectionStatus).toBeLessThan(500);
        expect(rejectionBodyShape).toBeTruthy();
      } finally {
        await Promise.all(
          createdIds.map((externalId) => driver.cancelAppointment({ locationId, externalId })),
        );
      }
    });
  },
);
