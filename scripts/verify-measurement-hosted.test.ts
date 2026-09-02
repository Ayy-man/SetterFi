/**
 * The hosted round-trip these three surfaces never had.
 *
 * `/admin/overview`, `/admin/agent-performance` and `/coach/home` crashed in production for
 * months while every unit test stayed green, because nothing ever fed a *hosted* RPC answer to
 * the production parser. This does exactly that: it calls the three `*_for_actor` functions
 * against the linked Supabase project and passes each raw answer to the real loader as its
 * `source`, so a shape the database emits and the parser refuses fails a command instead of a
 * browser. The diagnostic value is the MeasurementEvidenceError code, which is printed with the
 * offending row rather than swallowed.
 *
 * Run through `npm run verify:measurement-hosted`, never bare - the runner unsets an inherited
 * SUPABASE_SERVICE_ROLE_KEY before loading `.env.local`, and without that hygiene this reaches a
 * different project and reports `Invalid API key`.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  loadCoachLeadComposition,
  loadCoachMeasurement,
  type CoachLeadComposition,
  type CoachMeasurement,
} from "@/lib/repositories/analytics";
import { MeasurementEvidenceError } from "@/lib/repositories/measurement-evidence";
import { loadPlatformMeasurement, type PlatformMeasurement } from "@/lib/repositories/platform-analytics";

function required(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `MISSING_ENV:${name} - set it in .env.local and run through npm run verify:measurement-hosted`,
    );
  }
  return value;
}

type ActorRow = { id: string; email: string; role: string; tenant_id: string | null };

let client: SupabaseClient;
let owner: ActorRow;
let coach: ActorRow;
let asOf: string;

/**
 * Print the refusal code beside the payload that earned it. `MeasurementEvidenceError` carries
 * only its code, so the offending row has to come from the raw answer the harness captured on
 * the way in - without that pairing the code names a rule but not the row that broke it, which
 * is the position this codebase spent two lanes in.
 */
async function reporting<T>(
  label: string,
  raw: () => unknown,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MeasurementEvidenceError) {
      console.error(`\n${label} REFUSED: ${error.code}`);
      console.error(JSON.stringify(raw(), null, 2));
    }
    throw error;
  }
}

function metricLines(metrics: PlatformMeasurement["metrics"] | CoachMeasurement["metrics"]) {
  return metrics
    .map((row) => `    ${row.metricKey.padEnd(34)} ${row.state.padEnd(18)} ${row.value ?? "-"}`)
    .join("\n");
}

beforeAll(async () => {
  const url = required("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");
  client = createClient(url, serviceKey, { auth: { persistSession: false } });
  asOf = new Date().toISOString();

  // Resolved from the tables rather than hard-coded, so a reseeded project does not silently
  // verify a user that no longer exists.
  const { data: owners, error: ownerError } = await client
    .from("users").select("id,email,role,tenant_id").eq("role", "owner").limit(1);
  if (ownerError) throw new Error(`OWNER_LOOKUP_FAILED: ${ownerError.message}`);
  if (!owners?.length) throw new Error("NO_OWNER_ACTOR: public.users holds no owner row");
  owner = owners[0] as ActorRow;

  const { data: coaches, error: coachError } = await client
    .from("users").select("id,email,role,tenant_id")
    .eq("role", "coach").not("tenant_id", "is", null).limit(1);
  if (coachError) throw new Error(`COACH_LOOKUP_FAILED: ${coachError.message}`);
  if (!coaches?.length) throw new Error("NO_COACH_ACTOR: public.users holds no tenant-bound coach");
  coach = coaches[0] as ActorRow;

  console.log(`\nhosted project : ${url}`);
  console.log(`owner actor    : ${owner.email} (${owner.id})`);
  console.log(`coach actor    : ${coach.email} (${coach.id}) tenant ${coach.tenant_id}`);
  console.log(`as of          : ${asOf}`);
});

describe("hosted measurement round-trip", () => {
  it("parses the platform snapshot the hosted RPC actually returns", async () => {
    let raw: unknown = null;
    const snapshot = await reporting("platform", () => raw, () => loadPlatformMeasurement(
      owner.id,
      asOf,
      async (actorId, requestedAsOf) => {
        const { data, error } = await client.rpc("read_platform_measurement_for_actor", {
          p_actor_id: actorId,
          p_as_of: requestedAsOf,
        });
        if (error) throw new Error(`PLATFORM_RPC_FAILED: ${error.message}`);
        raw = data;
        return data;
      },
    ));

    console.log("\nplatform snapshot");
    console.log(metricLines(snapshot.metrics));
    console.log(`    rows: subscriptions=${snapshot.subscriptions.length}`
      + ` tenantPerformance=${snapshot.tenantPerformance.length}`
      + ` guardrailRules=${snapshot.guardrailRules.length}`
      + ` followupPerformance=${snapshot.followupPerformance.length}`
      + ` provisioningPerformance=${snapshot.provisioningPerformance.length}`
      + ` history=${snapshot.history.length}`);
    for (const row of snapshot.tenantPerformance) {
      console.log(`    tenant ${row.tenantId} margin=${row.marginState} (${row.marginCents ?? "-"})`);
    }

    expect(snapshot.metrics).toHaveLength(27);
    // Every rendered number traces to a row: a value only ever accompanies a state that claims one.
    for (const row of snapshot.metrics) {
      if (row.value !== null) expect(["available", "still_filling"]).toContain(row.state);
    }
    // A demo tenant is a tenant the platform aggregate must never contain, whatever the coach
    // read in the same session did.
    const { data: demoTenants } = await client.from("tenants").select("id").eq("is_demo", true);
    const demoIds = (demoTenants ?? []).map((row) => row.id as string);
    for (const id of demoIds) {
      expect(snapshot.tenantPerformance.map((row) => row.tenantId)).not.toContain(id);
      expect(snapshot.subscriptions.map((row) => row.tenantId)).not.toContain(id);
    }
  });

  it("parses the coach snapshot the hosted RPC actually returns", async () => {
    let raw: unknown = null;
    const snapshot: CoachMeasurement = await reporting("coach", () => raw, () => loadCoachMeasurement(
      coach.id,
      coach.tenant_id as string,
      { window: "1m", customFrom: null, customTo: null, asOf },
      async (actorId, expectedTenant, options) => {
        const { data, error } = await client.rpc("read_coach_measurement_for_actor", {
          p_actor_id: actorId,
          p_expected_tenant: expectedTenant,
          p_window: options.window,
          p_custom_from: options.customFrom,
          p_custom_to: options.customTo,
          p_as_of: options.asOf,
        });
        if (error) throw new Error(`COACH_RPC_FAILED: ${error.message}`);
        raw = data;
        return data;
      },
    ));

    console.log(`\ncoach snapshot (isDemo=${snapshot.isDemo}, allowance=${snapshot.allowance.state})`);
    console.log(metricLines(snapshot.metrics));
    console.log(`    rows: funnel=${snapshot.funnel.length} responses=${snapshot.responses.length}`
      + ` keywords=${snapshot.keywords.length} pipeline=${snapshot.pipeline.length}`);

    expect(snapshot.tenantId).toBe(coach.tenant_id);
    expect(typeof snapshot.isDemo).toBe("boolean");
    for (const row of snapshot.metrics) {
      if (row.value !== null) expect(["available", "still_filling"]).toContain(row.state);
    }
    // Economics never reach a coach snapshot, label or no label.
    expect(snapshot.metrics.every((row) => !row.metricKey.startsWith("platform."))).toBe(true);
  });

  it("parses the coach lead composition the hosted RPC actually returns", async () => {
    let raw: unknown = null;
    const composition: CoachLeadComposition = await reporting("composition", () => raw, () =>
      loadCoachLeadComposition(
        coach.id,
        coach.tenant_id as string,
        asOf,
        async (actorId, expectedTenant, requestedAsOf) => {
          const { data, error } = await client.rpc("read_coach_lead_composition_for_actor", {
            p_actor_id: actorId,
            p_expected_tenant: expectedTenant,
            p_as_of: requestedAsOf,
          });
          if (error) throw new Error(`COMPOSITION_RPC_FAILED: ${error.message}`);
          raw = data;
          return data;
        },
      ));

    console.log(`\ncomposition (${composition.timezone}) months=${composition.months.length}`);
    for (const month of composition.months) {
      console.log(`    ${month.label.padEnd(10)} total=${month.total}`
        + ` qualified=${month.qualified} active=${month.active}`
        + ` disqualified=${month.disqualified}${month.partial ? " (still filling)" : ""}`);
    }

    expect(composition.months).toHaveLength(6);
    for (const month of composition.months) {
      expect(month.qualified + month.active + month.disqualified).toBe(month.total);
    }
  });
});
