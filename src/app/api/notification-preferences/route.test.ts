import { describe, expect, it, vi } from "vitest";

import { createNotificationPreferenceHandlers, type Preference } from "./handler";

const actor = { userId: "user", tenantId: "tenant", role: "coach" as const, impersonatingTenant: null, impersonationSessionId: null };
const preference: Preference = {
  ruleId: "rule",
  event: "appointment.booked",
  scope: "tenant" as const,
  name: "Appointment booked",
  description: "A lead booked an appointment.",
  category: "booking",
  audience: "coach",
  defaultDestinations: ["bell", "email"],
  defaultEnabled: true,
  destination: "email" as const,
  enabled: false,
  locked: false,
};

function setup(overrides: Record<string, unknown> = {}) {
  const repository = {
    list: vi.fn(async () => [preference]),
    set: vi.fn(async () => preference),
  };
  const session = vi.fn(async () => actor);
  const audit = vi.fn(async () => {});
  const handlers = createNotificationPreferenceHandlers({
    enabled: () => true, session, repository: () => repository, audit, ...overrides,
  } as Parameters<typeof createNotificationPreferenceHandlers>[0]);
  return { audit, handlers, repository, session };
}

describe("notification preference API", () => {
  it("returns 404 before session or repository work while disabled", async () => {
    const values = setup({ enabled: () => false });
    expect((await values.handlers.GET()).status).toBe(404);
    expect(values.session).not.toHaveBeenCalled();
    expect(values.repository.list).not.toHaveBeenCalled();
  });

  it("lists and writes only for the session user through the locked RPC boundary", async () => {
    const values = setup();
    expect(await (await values.handlers.GET()).json()).toEqual({ preferences: [preference] });
    expect(values.repository.list).toHaveBeenCalledWith("user", "coach");
    const response = await values.handlers.PUT(new Request("http://local", {
      method: "PUT", body: JSON.stringify({ ruleId: "rule", destination: "email", enabled: false }),
    }));
    expect(response.status).toBe(200);
    expect(values.repository.set).toHaveBeenCalledWith("user", { ruleId: "rule", destination: "email", enabled: false });
    expect(await response.json()).toEqual({ preference });
  });

  /*
   * The account panel prints "Notification change logged" over this control, so the record is part
   * of what a 200 promises. The recorded value is the database's read-back, not the browser's ask:
   * a locked rule can clamp the write, and logging the request would log something that never
   * happened.
   */
  it("records the change the database settled on, not the one that was asked for", async () => {
    const values = setup();
    values.repository.set.mockResolvedValueOnce({ ...preference, enabled: true });
    const response = await values.handlers.PUT(new Request("http://local", {
      method: "PUT", body: JSON.stringify({ ruleId: "rule", destination: "email", enabled: false }),
    }));

    expect(response.status).toBe(200);
    expect(values.audit).toHaveBeenCalledWith("user", {
      ruleId: "rule",
      destination: "email",
      enabled: true,
    });
  });

  it("fails the request when the change cannot be recorded, and still returns the new value", async () => {
    const values = setup();
    values.audit.mockRejectedValueOnce(new Error("NOTIFICATION_PREFERENCE_AUDIT_WRITE_FAILED"));
    const response = await values.handlers.PUT(new Request("http://local", {
      method: "PUT", body: JSON.stringify({ ruleId: "rule", destination: "email", enabled: false }),
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Notification preference change could not be recorded.",
      preference,
    });
  });

  it("writes no audit row when the preference write itself was refused", async () => {
    const values = setup();
    values.repository.set.mockRejectedValueOnce(new Error("NOTIFICATION_PREFERENCE_LOCKED"));
    const response = await values.handlers.PUT(new Request("http://local", {
      method: "PUT", body: JSON.stringify({ ruleId: "rule", destination: "email", enabled: false }),
    }));

    expect(response.status).toBe(409);
    expect(values.audit).not.toHaveBeenCalled();
  });

  it("refuses extra authority, invalid destinations, locked changes, and impersonation", async () => {
    for (const body of [
      { ruleId: "rule", destination: "sms", enabled: true },
      { ruleId: "rule", destination: "email", enabled: true, userId: "other" },
    ]) {
      const values = setup();
      expect((await values.handlers.PUT(new Request("http://local", { method: "PUT", body: JSON.stringify(body) }))).status).toBe(409);
      expect(values.repository.set).not.toHaveBeenCalled();
    }
    const locked = setup();
    locked.repository.set.mockRejectedValueOnce(new Error("NOTIFICATION_PREFERENCE_LOCKED"));
    expect((await locked.handlers.PUT(new Request("http://local", { method: "PUT", body: JSON.stringify({ ruleId: "rule", destination: "email", enabled: false }) }))).status).toBe(409);
    const impersonated = setup({ session: async () => null });
    expect((await impersonated.handlers.GET()).status).toBe(401);
    expect(impersonated.repository.list).not.toHaveBeenCalled();
  });
});

/**
 * The coach settings surface renders `alert_rules.description` as the consequence line under each
 * row's name. Nothing in the handler suite above would notice the column falling out of the select,
 * because that suite injects its own repository, and the component would quietly fall back to a
 * derived sentence that reads plausibly enough to pass a "some description rendered" assertion.
 *
 * So this drives the real query builder against a fake client and asserts on both halves: the
 * select names the column, and the mapping puts the row's own words on the preference.
 */
describe("the preference repository selects the authored rule description", () => {
  const rule = {
    id: "rule",
    event_key: "appointment.booked",
    scope: "tenant",
    name: "Appointment booked",
    description: "A lead booked an appointment.",
    category: "booking",
    audience_roles: ["coach"],
    include_success_owner: false,
    include_billing_contact: false,
    suppressible: true,
    default_destinations: ["bell"],
    default_enabled: true,
  };

  function fakeClient(selects: string[], filters: string[] = []) {
    const query = (rows: unknown[], record: boolean) => {
      const chain: Record<string, unknown> = {
        eq: (column: string, value: unknown) => {
          if (record) filters.push(`eq:${column}=${String(value)}`);
          return chain;
        },
        not: (column: string, operator: string, value: unknown) => {
          if (record) filters.push(`not:${column} ${operator} ${String(value)}`);
          return chain;
        },
        order: () => chain,
        then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
          resolve({ data: rows, error: null }),
      };
      return chain;
    };
    return {
      from: (table: string) => ({
        select: (columns: string) => {
          if (table === "alert_rules") selects.push(columns);
          return query(table === "alert_rules" ? [rule] : [], table === "alert_rules");
        },
      }),
    };
  }

  it("names description in the alert_rules select and maps it onto every preference", async () => {
    const selects: string[] = [];
    vi.doMock("@/lib/supabase/server", () => ({
      createSupabaseServiceClient: () => fakeClient(selects),
    }));
    vi.resetModules();
    const { createPreferenceRepository: create } = await import("./handler");

    const preferences = await create().list("user", "coach");

    expect(selects, "the alert_rules read must run exactly once").toHaveLength(1);
    expect(
      selects[0].split(","),
      "description is what the coach settings row states as its consequence",
    ).toContain("description");
    for (const preference of preferences) {
      expect(preference.description).toBe("A lead booked an appointment.");
    }
    expect(preferences.length).toBeGreaterThan(0);
    vi.doUnmock("@/lib/supabase/server");
    vi.resetModules();
  });
  /**
   * A coach must never be shown a demo rule.
   *
   * On 2026-08-24 somebody hand-inserted `phase8.demo.slack:tenant` into hosted `alert_rules`:
   * scope `tenant`, `default_enabled = true`, aimed at a demo Slack channel. Scope was the only
   * filter this query applied and `audience_roles` never filters, so it reached every coach on the
   * live platform and rendered under a title-cased "Demo" heading with no test-data label. This
   * pins both halves of the fix so the filter cannot be dropped while the row is still out there.
   */
  it("hides demo-category rules from a coach, and filters nothing extra for an admin", async () => {
    for (const role of ["coach", "coach_member"] as const) {
      const selects: string[] = [];
      const filters: string[] = [];
      vi.doMock("@/lib/supabase/server", () => ({
        createSupabaseServiceClient: () => fakeClient(selects, filters),
      }));
      vi.resetModules();
      const { createPreferenceRepository: create } = await import("./handler");
      await create().list("user", role);

      expect(filters, `${role} must be held to tenant scope`).toContain("eq:scope=tenant");
      expect(filters, `${role} must never be shown a demo rule`).toContain("not:category eq demo");
      vi.doUnmock("@/lib/supabase/server");
      vi.resetModules();
    }

    // An admin sees the platform as it really is, demo rows included, because hiding one from the
    // person who can delete it is how it survives.
    const selects: string[] = [];
    const filters: string[] = [];
    vi.doMock("@/lib/supabase/server", () => ({
      createSupabaseServiceClient: () => fakeClient(selects, filters),
    }));
    vi.resetModules();
    const { createPreferenceRepository: create } = await import("./handler");
    await create().list("user", "admin");
    expect(filters).toEqual([]);
    vi.doUnmock("@/lib/supabase/server");
    vi.resetModules();
  });
});
