import { describe, expect, it } from "vitest";

import {
  DEMO_COACH_SETUP_BASELINE,
  deriveLegacySetupProgress,
  deriveSetupProgress,
  readOnboardingPreview,
  type OnboardingPreviewHandoff,
} from "@/lib/onboarding-progress";

const empty: OnboardingPreviewHandoff = { channels: {}, calendar: null, offerIncludes: [] };

describe("deriveSetupProgress", () => {
  it("reads a walked-through setup with nothing done as a true zero", () => {
    const progress = deriveSetupProgress(empty);
    expect(progress.done).toBe(0);
    expect(progress.completed).toBe(false);
    expect(progress.next?.id).toBe("channel");
  });

  it("falls back to the seeded demo coach when there is no saved preview", () => {
    // A clean browser must not read "0 of 4" on a page that simultaneously shows a
    // live agent, a populated inbox, and real funnel analytics.
    const progress = deriveSetupProgress(null);
    expect(progress.done).toBeGreaterThan(0);
    expect(progress.readyChannels).toContain("Instagram");
  });

  it("never reads complete while a channel is still provisioning", () => {
    // The honest-states rule: SMS carrier review and WhatsApp verification each add a
    // slot the meter cannot fill, so the ratio can never reach 4 of 4.
    const progress = deriveSetupProgress(DEMO_COACH_SETUP_BASELINE);
    expect(progress.smsPending).toBe(true);
    expect(progress.whatsappPending).toBe(true);
    expect(progress.done).toBeLessThan(progress.total);
  });

  it("counts one pending channel as exactly one outstanding slot", () => {
    const oneReady = deriveSetupProgress({ channels: { instagram: "ready" } });
    const alsoPending = deriveSetupProgress({ channels: { instagram: "ready", sms: "pending" } });
    expect(alsoPending.total).toBe(oneReady.total + 1);
    expect(alsoPending.done).toBe(oneReady.done);
  });

  it("does not tick the channel step for a channel that cannot yet receive a lead", () => {
    const progress = deriveSetupProgress({ channels: { sms: "pending" } });
    expect(progress.steps.find((step) => step.id === "channel")?.state).toBe("todo");
  });

  it("requires the coach to actually work the offer step, not just carry defaults", () => {
    const untouched = deriveSetupProgress({ offerIncludes: ["Business funding"], offerTouched: false });
    expect(untouched.steps.find((step) => step.id === "offer")?.state).toBe("todo");

    const touched = deriveSetupProgress({ offerIncludes: ["Business funding"], offerTouched: true });
    expect(touched.steps.find((step) => step.id === "offer")?.state).toBe("done");
  });

  it("reports completion only once the coach finished the handoff", () => {
    expect(deriveSetupProgress({ ...DEMO_COACH_SETUP_BASELINE, handoff: true }).completed).toBe(true);
  });
});

describe("Phase 5 live progress authority", () => {
  const live = { SETTERFI_PHASE5_LIVE: "true" };
  const off = { SETTERFI_PHASE5_LIVE: "false" };

  it("suppresses the legacy browser preview before storage can become authority", () => {
    expect(readOnboardingPreview(live)).toBeNull();
  });

  it("suppresses the browser-storage and demo-baseline sidebar instrument while live", () => {
    expect(deriveLegacySetupProgress(DEMO_COACH_SETUP_BASELINE, live)).toBeNull();
    expect(deriveLegacySetupProgress(null, live)).toBeNull();
  });

  it("preserves the byte-for-byte legacy progress behavior while the flag is off", () => {
    expect(deriveLegacySetupProgress(null, off)).toEqual(deriveSetupProgress(null));
    expect(deriveLegacySetupProgress(empty, off)).toEqual(deriveSetupProgress(empty));
  });
});
