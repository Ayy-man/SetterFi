import { describe, expect, it, vi } from "vitest";

import {
  CoachNotificationPreferenceError,
  readCoachNotificationPreference,
  writeCoachNotificationPreference,
  type ControllableRow,
} from "./coach-notification-preference";

function rows(overrides: Partial<Record<string, boolean>> = {}): ControllableRow[] {
  return [
    { ruleId: "rule-a", destination: "email", enabled: overrides["rule-a:email"] ?? true },
    { ruleId: "rule-a", destination: "sms", enabled: overrides["rule-a:sms"] ?? false },
    { ruleId: "rule-b", destination: "email", enabled: overrides["rule-b:email"] ?? true },
    { ruleId: "rule-b", destination: "sms", enabled: overrides["rule-b:sms"] ?? false },
  ];
}

describe("readCoachNotificationPreference", () => {
  it("rejects a non-coach actor", async () => {
    await expect(
      readCoachNotificationPreference("user-1", "admin", async () => rows()),
    ).rejects.toThrow(CoachNotificationPreferenceError);
  });

  it("reads email-only rows as the email preference", async () => {
    await expect(
      readCoachNotificationPreference("user-1", "coach", async () => rows()),
    ).resolves.toBe("email");
  });

  it("reads text-only rows as the text preference", async () => {
    const source = async () => rows({ "rule-a:email": false, "rule-b:email": false, "rule-a:sms": true, "rule-b:sms": true });
    await expect(readCoachNotificationPreference("user-1", "coach", source)).resolves.toBe("text");
  });

  it("reads both-on rows as the both preference", async () => {
    const source = async () => rows({ "rule-a:sms": true, "rule-b:sms": true });
    await expect(readCoachNotificationPreference("user-1", "coach", source)).resolves.toBe("both");
  });

  it("renders absent rather than guessing when rows disagree", async () => {
    const source = async () => rows({ "rule-a:sms": true });
    await expect(readCoachNotificationPreference("user-1", "coach", source)).resolves.toBeNull();
  });

  it("renders absent when there are no controllable rules at all", async () => {
    await expect(readCoachNotificationPreference("user-1", "coach", async () => [])).resolves.toBeNull();
  });
});

describe("writeCoachNotificationPreference", () => {
  it("rejects a non-coach actor before writing anything", async () => {
    const writer = vi.fn();
    await expect(
      writeCoachNotificationPreference("user-1", "success", "text", vi.fn(), {
        source: async () => rows(), writer,
      }),
    ).rejects.toThrow(CoachNotificationPreferenceError);
    expect(writer).not.toHaveBeenCalled();
  });

  it("rejects an invalid preference value", async () => {
    await expect(
      writeCoachNotificationPreference(
        "user-1", "coach", "sms" as never, vi.fn(), { source: async () => rows() },
      ),
    ).rejects.toThrow(CoachNotificationPreferenceError);
  });

  it("only writes the destinations that actually change, and audits each one", async () => {
    const state = rows();
    const source = async () => state.map((row) => ({ ...row }));
    const writer = vi.fn(async (input: { ruleId: string; destination: "email" | "sms"; enabled: boolean }) => {
      const row = state.find((candidate) => candidate.ruleId === input.ruleId && candidate.destination === input.destination);
      if (row) row.enabled = input.enabled;
      return { enabled: input.enabled };
    });
    const audit = vi.fn(async () => {});
    const result = await writeCoachNotificationPreference("user-1", "coach", "both", audit, {
      source, writer,
    });
    expect(result).toBe("both");
    // Email is already on for both rules; only the sms destinations need flipping.
    expect(writer).toHaveBeenCalledTimes(2);
    expect(writer).toHaveBeenCalledWith({ userId: "user-1", ruleId: "rule-a", destination: "sms", enabled: true });
    expect(writer).toHaveBeenCalledWith({ userId: "user-1", ruleId: "rule-b", destination: "sms", enabled: true });
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it("writes nothing and audits nothing when the preference already matches every row", async () => {
    const writer = vi.fn();
    const audit = vi.fn();
    const result = await writeCoachNotificationPreference("user-1", "coach", "email", audit, {
      source: async () => rows(), writer,
    });
    expect(result).toBe("email");
    expect(writer).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("skips the audit entry when the write comes back clamped by a locked rule", async () => {
    const writer = vi.fn(async () => ({ enabled: false }));
    const audit = vi.fn(async () => {});
    await writeCoachNotificationPreference("user-1", "coach", "both", audit, {
      source: async () => rows(), writer,
    });
    expect(audit).not.toHaveBeenCalled();
  });
});
