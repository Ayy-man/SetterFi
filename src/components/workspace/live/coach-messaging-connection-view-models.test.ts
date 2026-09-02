import { describe, expect, it } from "vitest";

import {
  COACH_MESSAGING_CONNECTION_NOTE,
  coachMessagingConnectionState,
} from "./coach-messaging-connection-view-models";

const location = (installState: string, reauthorizationRequiredAt: string | null = null) =>
  ({ installState, reauthorizationRequiredAt });

describe("coachMessagingConnectionState", () => {
  it("reads connected only from a usable location", () => {
    const state = coachMessagingConnectionState({ checked: true, locations: [location("token_ok")] });
    expect(state.status).toBe("connected");
    expect(state.tone).toBe("good");
  });

  it("never reads connected while a location is awaiting re-approval", () => {
    const state = coachMessagingConnectionState({
      checked: true,
      locations: [location("token_ok", "2026-08-20T00:00:00.000Z")],
    });
    expect(state.status).toBe("needs-reapproval");
    expect(state.tone).toBe("bad");
  });

  it("reports connected when one location is usable and another is not", () => {
    const state = coachMessagingConnectionState({
      checked: true,
      locations: [location("failed"), location("token_ok")],
    });
    expect(state.status).toBe("connected");
  });

  it("does not call a stored row without a credential connected", () => {
    const state = coachMessagingConnectionState({ checked: true, locations: [location("installed")] });
    expect(state.status).toBe("in-progress");
    expect(state.tone).toBe("pending");
  });

  it("separates removal on the provider's side from a failed attempt", () => {
    expect(coachMessagingConnectionState({ checked: true, locations: [location("uninstalled")] }).status)
      .toBe("removed");
    expect(coachMessagingConnectionState({ checked: true, locations: [location("failed")] }).status)
      .toBe("failed");
  });

  it("reads no stored row as not connected", () => {
    const state = coachMessagingConnectionState({ checked: true, locations: [] });
    expect(state.status).toBe("not-connected");
    expect(state.tone).toBe("neutral");
  });

  it("says a failed read could not be checked rather than not connected", () => {
    const state = coachMessagingConnectionState({ checked: false, locations: [] });
    expect(state.status).toBe("unchecked");
    expect(state.tone).toBe("neutral");
    expect(state.label).not.toMatch(/not connected/i);
    expect(state.detail).toMatch(/could not/i);
  });

  it("ignores rows handed to it alongside a failed read", () => {
    const state = coachMessagingConnectionState({ checked: false, locations: [location("token_ok")] });
    expect(state.status).toBe("unchecked");
  });

  it("names no provider and no backend plumbing in any copy it can produce", () => {
    const states = [
      coachMessagingConnectionState({ checked: false, locations: [] }),
      coachMessagingConnectionState({ checked: true, locations: [] }),
      coachMessagingConnectionState({ checked: true, locations: [location("installed")] }),
      coachMessagingConnectionState({ checked: true, locations: [location("failed")] }),
      coachMessagingConnectionState({ checked: true, locations: [location("uninstalled")] }),
      coachMessagingConnectionState({ checked: true, locations: [location("token_ok", "x")] }),
      coachMessagingConnectionState({ checked: true, locations: [location("token_ok")] }),
    ];
    const copy = JSON.stringify(states) + COACH_MESSAGING_CONNECTION_NOTE;
    expect(copy).not.toMatch(/GoHighLevel|HighLevel|GHL|Twilio|LeadConnector/i);
    // Nothing here may read as an action the coach can take: the install route refuses their role.
    expect(copy).not.toMatch(/click|connect now|approve here|start the install/i);
  });

  it("tells the coach the connection is started for them rather than by them", () => {
    expect(COACH_MESSAGING_CONNECTION_NOTE).toMatch(/SetterFi team/);
  });
});
