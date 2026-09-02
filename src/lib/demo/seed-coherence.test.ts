import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEMO_STAFF_NAMES,
  DEMO_SUPPORT_TENANT_NAMES,
  DEMO_TAG,
} from "../../../scripts/fixtures/names.mjs";
import {
  DEMO_CONNECTED_CHANNELS,
  DEMO_CONNECTED_CHANNEL_NAMES,
} from "../../../scripts/fixtures/demo-channels.mjs";

/**
 * The demo seed has to be one demo.
 *
 * A production review found four separate ways it was not: the coach was greeted "Welcome back,
 * Staging" with an account chip reading "SC Staging"; Sofia Patel was booked in her conversation
 * thread and No show in the pipeline with no appointment anywhere behind either; four leads
 * rendered "no channel saved" for a channel the product has no connection or provider for; and two
 * seeders wrote the same ten contacts under two different sets of names and stages, so whichever
 * ran last decided what the client saw.
 *
 * These read the seed sources rather than a database, so they hold on a machine with no Postgres
 * and they fail on the change that would reintroduce the defect rather than on a later reseed.
 */
function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("the demo login accounts are people", () => {
  it("never introduces the product with a deployment environment's name", () => {
    const seed = source("scripts/seed-staging-users.mjs");
    const names = Object.values(DEMO_STAFF_NAMES) as string[];

    expect(names).toHaveLength(4);
    expect(names.some((name) => /\bstaging\b/i.test(name))).toBe(false);
    expect(seed).not.toMatch(/fullName: "Staging /u);
    // The header prints the first whitespace token, so that token has to be a given name.
    expect(names.every((name) => /^[A-Z][a-z]+ /u.test(name))).toBe(true);
    expect(names.every((name) => name.endsWith(DEMO_TAG))).toBe(true);
  });

  /**
   * Skipping an existing row was why the names could never be corrected on a database that had
   * already been seeded, which is every database anyone was looking at.
   */
  it("repairs the display name of an account that already exists", () => {
    const seed = source("scripts/seed-staging-users.mjs");

    expect(seed).toContain('.update({ full_name: seed.fullName })');
    expect(seed).toContain('.neq("full_name", seed.fullName)');
  });
});

describe("every demo tenant says it is a demo", () => {
  it("labels the two workspaces that are not coach tenants", () => {
    const review = source("scripts/seed-platform-review-data.mjs");
    const phase7 = source("scripts/seed-phase7-demo.mjs");

    expect(Object.values(DEMO_SUPPORT_TENANT_NAMES).every(
      (name) => (name as string).endsWith(DEMO_TAG),
    )).toBe(true);
    expect(review).not.toContain("'Affiliate Partner Demo'");
    expect(review).not.toContain("'Measurement Review Workspace'");
    expect(phase7).not.toContain("'Measurement Review Workspace'");
    expect(review).toContain("DEMO_SUPPORT_TENANT_NAMES.affiliatePartner");
    expect(review).toContain("DEMO_SUPPORT_TENANT_NAMES.measurement");
    expect(phase7).toContain("DEMO_SUPPORT_TENANT_NAMES.measurement");
  });
});

describe("a seeded lead arrives on a channel the product actually has", () => {
  /**
   * "Where they came from" reads `contact_identities`, not `contacts.last_channel`. `webchat` has
   * no `channel_connections` row on any demo tenant and `channel_provider` holds only
   * `meta_direct` and `ghl`, so a lead stamped `webchat` could never carry an identity and the
   * honest cell said "no channel saved".
   */
  it("offers only provider-backed channels, and web chat is not one of them", () => {
    expect(DEMO_CONNECTED_CHANNEL_NAMES).not.toContain("webchat");
    expect(DEMO_CONNECTED_CHANNELS.every(
      (entry: { provider: string }) => entry.provider === "meta_direct" || entry.provider === "ghl",
    )).toBe(true);
    expect(new Set(DEMO_CONNECTED_CHANNEL_NAMES).size).toBe(DEMO_CONNECTED_CHANNELS.length);

    const showcase = source("scripts/seed-showcase-leads.mjs");
    const phase1 = source("scripts/seed-phase1-demo.mjs");
    expect(showcase).not.toContain('"webchat"');
    expect(phase1).not.toContain('"whatsapp", "messenger", "webchat"');
  });

  it("writes the identity that makes the channel visible, for every showcase lead", () => {
    const showcase = source("scripts/seed-showcase-leads.mjs");

    expect(showcase).toContain("insert into public.contact_identities");
    expect(showcase).toContain("dataset.identities.map(");
    // A `ghl` identity without its install is refused outright, so the install is resolved first.
    expect(showcase).toContain("ensureShowcaseGhlInstall");
  });
});

describe("one fixture owns each demo contact", () => {
  /**
   * `seed-phase1-demo.mjs` and `seed-demo-complete.mjs` both write the ten Phase 3 contacts.
   * Phase 3 called contact 8 "Sofia Patel" at No show; the other called the same row "Bianca
   * Ferreira" at Booked. Both re-run on every reseed, so the demo changed identity depending on
   * which command was typed last.
   */
  it("takes the name and the stage from the Phase 3 fixture, never a second copy", () => {
    const complete = source("scripts/seed-demo-complete.mjs");

    expect(complete).toContain("PHASE3_CONTACT_FIXTURES");
    expect(complete).toContain("const PHASE3_OWNED_COLUMNS = new Map(");
    expect(complete).toContain("...(PHASE3_OWNED_COLUMNS.get(spec.id) ?? {}),");
  });

  /**
   * `set_contact_pipeline_stage` raises PIPELINE_BOOKED_REQUIRES_APPOINTMENT without a booking and
   * PIPELINE_NO_SHOW_REQUIRES_LATEST_APPOINTMENT unless the latest booking is itself no_show. A
   * seed writing either state without the appointment is demonstrating a state the product refuses
   * to produce, so anything read off those rows is read off a fiction.
   */
  it("puts a booking behind every stage that rests on one", async () => {
    const seeder = await import("../../../scripts/seed-demo-complete.mjs");
    const phase3 = await import("../../../scripts/seed-phase1-demo.mjs");
    const contacts = phase3.DEMO_PHASE3_IDS.contacts as string[];
    const fixtures = phase3.PHASE3_CONTACT_FIXTURES as readonly { pipelineStage: string }[];
    const appointments = seeder.SHOWCASE_APPOINTMENTS as readonly {
      contactId: string;
      status: string;
      startAt: string;
    }[];

    const latestFor = (contactId: string) => appointments
      .filter((appointment) => appointment.contactId === contactId)
      .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt))
      .at(-1);

    for (const [index, fixture] of fixtures.entries()) {
      const latest = latestFor(contacts[index]!);
      if (fixture.pipelineStage === "booked") {
        expect(latest, `contact ${index} is Booked with no appointment`).toBeDefined();
        expect(["scheduled", "confirmed"]).toContain(latest!.status);
        expect(Date.parse(latest!.startAt)).toBeGreaterThan(Date.now());
      }
      if (fixture.pipelineStage === "no_show") {
        expect(latest, `contact ${index} is No show with no appointment`).toBeDefined();
        expect(latest!.status).toBe("no_show");
        expect(Date.parse(latest!.startAt)).toBeLessThan(Date.now());
      }
    }
  });

  /**
   * D-11: the demo's dates are computed from the run's clock. They were offsets from a frozen
   * 2026-08-19, so within two weeks the "upcoming" bookings were all in the past while still
   * reading Scheduled, and coach home measured a window nothing fell inside.
   */
  it("computes its dates from the run clock rather than a frozen date", async () => {
    const seeder = await import("../../../scripts/seed-demo-complete.mjs");
    const complete = source("scripts/seed-demo-complete.mjs");
    const today = Date.UTC(
      new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate(),
    );

    expect(complete).not.toMatch(/SHOWCASE_ANCHOR = "\d{4}-/u);
    expect(seeder.resolveAnchor([])).toBe(today);
    // `--anchor` still pins the whole fixture, which is what the visual baselines need.
    expect(seeder.resolveAnchor(["--anchor=2026-08-19"])).toBe(Date.parse("2026-08-19T00:00:00.000Z"));
  });
});

/**
 * The Phase 7 measurement tenant is a real tenant that people use. Its verifier asserts exact
 * counts, and it used to assert them over the tenant's totals, so a coach opening the test agent
 * in production added a session, a contact, a conversation, two messages and a trace, and every
 * one of those genuine rows read as drift and failed the next reseed. Production did that on
 * 2026-08-22 and the hosted reseed stopped with PHASE7_DEMO_COUNT_MISMATCH.
 *
 * The fixture's own test turn is minted by RPCs with server-side ids, so it cannot be recognised
 * by an id shape; it is recognised by the session it belongs to. Every count real usage can
 * inflate has to be scoped to that session, and the exactness is kept over the fixture set.
 */
describe("the phase 7 verifier counts the fixture, not the tenant", () => {
  const verifier = readFileSync(join(process.cwd(), "scripts/run-phase7-demo.mjs"), "utf8");

  it("finds the fixture's test session through the turn the seed wrote", () => {
    expect(verifier).toContain("DEMO_MEASUREMENT_COPY.testAgentResponse");
    expect(verifier).toContain("PHASE7_DEMO_TEST_SESSION_NOT_UNIQUE");
  });

  it("scopes every count a real test run can inflate", () => {
    const query = verifier.slice(
      verifier.indexOf("const counts = (await database.query("),
      verifier.indexOf("const expected = {"),
    );

    for (const counted of ["contacts", "conversations", "messages", "traces", "test_sessions"]) {
      const clause = query.slice(0, query.indexOf(`) ${counted},`));
      expect(
        clause.slice(clause.lastIndexOf("(select count(")),
        `${counted} still counts rows the fixture does not own`,
        // The row tables reach the session through `contacts.test_session_id`; the session table
        // is the session. Either way the count is bounded by the fixture's session parameter.
      ).toMatch(/\bis not distinct from \$\d::uuid/u);
    }
  });

  /**
   * A coach types their own words into the test agent, and those are neither synthetic nor this
   * verifier's to judge. What the seed writes is what the seed has to label.
   */
  it("asks only the seed's own messages to carry the demo marker", () => {
    const guard = verifier.slice(0, verifier.indexOf(" non_placeholder_messages,"));

    expect(guard.slice(-700)).toMatch(/test_session_id is not distinct from \$\d::uuid/u);
  });

  /** Segregation is unchanged: it still counts every row on the tenant and still has to be zero. */
  it("keeps the is_test sweep across the whole tenant", () => {
    expect(verifier).toContain("from public.messages where tenant_id=$1 and not is_test) messages,");
    expect(verifier).toContain("PHASE7_DEMO_SEGREGATION_FAILED");
  });
});
