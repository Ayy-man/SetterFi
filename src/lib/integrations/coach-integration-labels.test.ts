import { describe, expect, it } from "vitest";

import {
  COACH_INTEGRATION_LABELS,
  coachIntegrationLabel,
} from "./coach-integration-labels";

describe("coach integration labels", () => {
  it("keeps the four approved product labels in their decided order", () => {
    expect(COACH_INTEGRATION_LABELS).toEqual([
      { channel: "instagram", label: "Instagram" },
      { channel: "messenger", label: "Facebook Messenger" },
      { channel: "whatsapp", label: "WhatsApp" },
      { channel: "sms", label: "Text messages (SMS)" },
    ]);
    expect(COACH_INTEGRATION_LABELS.map(({ channel }) => coachIntegrationLabel(channel)))
      .toEqual(COACH_INTEGRATION_LABELS.map(({ label }) => label));
  });

  it("keeps provider names and duration claims out of the approved label inventory", () => {
    const labels = COACH_INTEGRATION_LABELS.map(({ label }) => label).join(" ");
    expect(labels).not.toMatch(/GoHighLevel|GHL|Twilio|usually|up to|\d+[–-]\d+\s+(day|week)/i);
  });
});
