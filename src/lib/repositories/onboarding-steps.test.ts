import { describe, expect, it } from "vitest";

import { listProvisioningTrackerRows } from "./onboarding-steps";

const tenantlessRow = {
  signup_intent_id: "52000000-0000-4000-8000-000000000001",
  tenant_id: null,
  business_name: null,
  signup_state: "failed",
  step_key: null,
  state: "failed",
  attempts: 1,
  error_code: "SIGNUP_SYNTHETIC_FAILURE",
  blocking_party: "system",
  blocking_provider: null,
  stalled_since: "2026-08-17T12:00:00.000Z",
  is_demo: null,
  content_screen_id: null,
  content_screen_state: null,
};

describe("listProvisioningTrackerRows", () => {
  it("refuses a non-platform role before creating the tracker query", async () => {
    let queried = false;
    await expect(listProvisioningTrackerRows("coach", async () => {
      queried = true;
      return [tenantlessRow];
    })).rejects.toThrow(/PROVISIONING_TRACKER_PLATFORM_ROLE_REQUIRED/);
    expect(queried).toBe(false);
  });

  it.each(["owner", "admin", "success", "build"] as const)(
    "permits platform role %s and preserves tenantless failure evidence",
    async (role) => {
      await expect(listProvisioningTrackerRows(role, async () => [tenantlessRow])).resolves.toEqual([
        {
          signupIntentId: tenantlessRow.signup_intent_id,
          tenantId: null,
          businessName: null,
          signupState: "failed",
          currentStep: null,
          state: "failed",
          attempts: 1,
          errorCode: "SIGNUP_SYNTHETIC_FAILURE",
          blockingParty: "system",
          blockingProvider: null,
          stalledSince: tenantlessRow.stalled_since,
          isDemo: null,
          contentScreenId: null,
          contentScreenState: null,
        },
      ]);
    },
  );

  it("rejects a malformed projection row rather than widening the closed contracts", async () => {
    await expect(listProvisioningTrackerRows("admin", async () => [{
      ...tenantlessRow,
      state: "invented_state",
    }])).rejects.toThrow(/PROVISIONING_TRACKER_ROW_INVALID/);
  });

  it("maps demo classification and eligible content confirmation evidence", async () => {
    await expect(listProvisioningTrackerRows("admin", async () => [{
      ...tenantlessRow,
      tenant_id: "tenant-1",
      business_name: "Synthetic Coach",
      is_demo: true,
      content_screen_id: "screen-1",
      content_screen_state: "awaiting_admin",
    }])).resolves.toEqual([
      expect.objectContaining({
        isDemo: true,
        contentScreenId: "screen-1",
        contentScreenState: "awaiting_admin",
      }),
    ]);
  });
});
