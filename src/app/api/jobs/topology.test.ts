import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

type CronConfiguration = {
  crons: readonly { path: string; schedule: string }[];
};

function configuration() {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), "vercel.json"), "utf8"),
  ) as CronConfiguration;
}

describe("Vercel cron topology", () => {
  it("routes every configured cron through an exported GET handler", () => {
    const crons = configuration().crons;
    expect(new Set(crons.map((cron) => cron.path)).size).toBe(crons.length);

    for (const cron of crons) {
      const routeFile = resolve(process.cwd(), `src/app${cron.path}/route.ts`);
      expect(existsSync(routeFile), `${cron.path} must resolve to a route`).toBe(true);
      const source = readFileSync(routeFile, "utf8");
      expect(
        source,
        `${cron.path} must export GET because Vercel cron invokes GET`,
      ).toMatch(
        /export\s+(?:(?:const\s+GET\b|async\s+function\s+GET\b)|\{[^}]*\bGET\b[^}]*\}\s+from)/,
      );
    }
  });

  it("schedules the time-sensitive recovery workers at bounded cadences", () => {
    const schedules = new Map(
      configuration().crons.map((cron) => [cron.path, cron.schedule]),
    );

    expect(schedules.get("/api/jobs/followups")).toBe("*/5 * * * *");
    expect(schedules.get("/api/jobs/ghl-install-reconcile")).toBe("7,22,37,52 * * * *");
    expect(schedules.get("/api/jobs/inbound-recovery")).toBe("*/2 * * * *");
    expect(schedules.get("/api/jobs/outbound-reconciliation")).toBe("*/2 * * * *");
    expect(schedules.get("/api/jobs/capi-events")).toBe("*/2 * * * *");
  });

  it("wires real calendar consumers to refresh-aware stored location credentials", () => {
    for (const relativeFile of [
      "src/app/api/jobs/appointment-reconcile/handler.ts",
      "src/app/api/onboarding/run/handler.ts",
    ]) {
      const source = readFileSync(resolve(process.cwd(), relativeFile), "utf8");
      expect(source).toContain("resolveGhlLocationAccessToken");
      expect(source).toMatch(
        /createRealCalendarDriver\(\{[\s\S]*?getLocationAccessToken:\s*resolveGhlLocationAccessToken[\s\S]*?\}\)/,
      );
    }
  });
});
