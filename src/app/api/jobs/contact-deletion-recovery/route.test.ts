import { afterEach, describe, expect, it, vi } from "vitest";

import { createContactDeletionRecoveryHandler } from "./handler";

afterEach(() => vi.unstubAllEnvs());

describe("contact deletion recovery job", () => {
  it("requires the cron bearer secret and returns durable recovery counts", async () => {
    vi.stubEnv("SETTERFI_PHASE1_LIVE", "true");
    vi.stubEnv("SETTERFI_PHASE3_LIVE", "true");
    vi.stubEnv("SETTERFI_CONTACT_DELETE_LIVE", "true");
    const recover = vi.fn(async () => ({
      claimed: 2, completed: 1, retried: 0, operatorRequired: 1,
    }));
    const handler = createContactDeletionRecoveryHandler({ secret: "cron-a", recover });
    expect((await handler(new Request("https://setterfi.test/api/jobs/contact-deletion-recovery"))).status)
      .toBe(401);
    const response = await handler(new Request(
      "https://setterfi.test/api/jobs/contact-deletion-recovery",
      { headers: { authorization: "Bearer cron-a" } },
    ));
    expect(await response.json()).toEqual({
      claimed: 2, completed: 1, retried: 0, operatorRequired: 1,
    });
    expect(recover).toHaveBeenCalledWith(10);
  });

  // The job finishes deletions the API started, so it has to answer to the delete feature's own
  // gate: with the feature off it must not run even when Phase 1 is live and the secret matches.
  it.each([
    ["SETTERFI_PHASE3_LIVE"],
    ["SETTERFI_CONTACT_DELETE_LIVE"],
  ])("stays absent and never recovers when %s is off", async (disabled) => {
    for (const name of ["SETTERFI_PHASE1_LIVE", "SETTERFI_PHASE3_LIVE", "SETTERFI_CONTACT_DELETE_LIVE"]) {
      vi.stubEnv(name, name === disabled ? "false" : "true");
    }
    const recover = vi.fn(async () => ({ claimed: 0, completed: 0, retried: 0, operatorRequired: 0 }));
    const handler = createContactDeletionRecoveryHandler({ secret: "cron-a", recover });
    const response = await handler(new Request(
      "https://setterfi.test/api/jobs/contact-deletion-recovery",
      { headers: { authorization: "Bearer cron-a" } },
    ));
    expect(response.status).toBe(404);
    expect(recover).not.toHaveBeenCalled();
  });
});
