import { describe, expect, it } from "vitest";

import type { ContentScreenResult } from "./contracts";
import {
  contentScreenFilingGate,
  contentScreenInputHash,
  screenA2pContent,
} from "./content-screen";

const cleanSources = [
  { page: "https://example.test", text: "Business education and appointment scheduling." },
  { page: "published-offer", text: "A synthetic coaching program." },
] as const;

describe("A2P content screen", () => {
  it("normalizes website and published-offer content into one deterministic input hash", () => {
    const first = contentScreenInputHash(cleanSources);
    const reordered = contentScreenInputHash([...cleanSources].reverse());
    expect(reordered).toBe(first);
    expect(contentScreenInputHash([
      { ...cleanSources[0], text: "  BUSINESS   education and appointment scheduling. " },
      cleanSources[1],
    ])).toBe(first);
  });

  it("keeps clean and fixed-vocabulary hit flows distinct with exact page evidence", () => {
    expect(screenA2pContent(cleanSources)).toMatchObject({ state: "clean", matches: [] });
    expect(screenA2pContent([
      { page: "https://example.test/services", text: "We guarantee funding and offer debt relief." },
      cleanSources[1],
    ])).toMatchObject({
      state: "flagged",
      matches: [
        { page: "https://example.test/services", phrase: "debt relief" },
        { page: "https://example.test/services", phrase: "guarantee funding" },
      ],
    });
  });

  it("invalidates prior confirmation when website or offer input changes", () => {
    const originalHash = contentScreenInputHash(cleanSources);
    const changedHash = contentScreenInputHash([
      cleanSources[0],
      { page: "published-offer", text: "A changed synthetic coaching program." },
    ]);
    const screen: ContentScreenResult = {
      screenId: "screen-synthetic",
      inputHash: originalHash,
      state: "confirmed",
      matches: [{ phrase: "synthetic", page: "published-offer" }],
      coachAcknowledgedAt: "2026-08-17T12:00:00.000Z",
      adminConfirmedAt: "2026-08-17T12:01:00.000Z",
    };
    expect(contentScreenFilingGate(screen, changedHash)).toEqual({
      ready: false,
      code: "A2P_CONTENT_SCREEN_STALE",
    });
  });

  it("requires both coach acknowledgement and admin confirmation after a hit", () => {
    const flagged: ContentScreenResult = {
      screenId: "screen-synthetic",
      inputHash: "a".repeat(64),
      state: "flagged",
      matches: [{ phrase: "credit repair", page: "https://example.test" }],
      coachAcknowledgedAt: null,
      adminConfirmedAt: null,
    };
    expect(contentScreenFilingGate(flagged, flagged.inputHash)).toEqual({
      ready: false,
      code: "A2P_CONTENT_ACKNOWLEDGEMENT_REQUIRED",
    });
    expect(contentScreenFilingGate({
      ...flagged,
      coachAcknowledgedAt: "2026-08-17T12:00:00.000Z",
    }, flagged.inputHash)).toEqual({
      ready: false,
      code: "A2P_CONTENT_ADMIN_CONFIRMATION_REQUIRED",
    });
    expect(contentScreenFilingGate({
      ...flagged,
      coachAcknowledgedAt: "2026-08-17T12:00:00.000Z",
      adminConfirmedAt: "2026-08-17T12:01:00.000Z",
    }, flagged.inputHash)).toEqual({ ready: true });
  });
});
