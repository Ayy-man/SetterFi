import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

import { DISCLOSURE_CASES } from "@/lib/onboarding/disclosure-url.cases";
import { disclosureHostIsReachable } from "@/lib/onboarding/disclosure-url";

/**
 * One rule, two runtimes, and the test that stops them drifting.
 *
 * `app.disclosure_host_is_reachable(text)` decides whether a lead is handed a privacy link at all;
 * `disclosureHostIsReachable()` in `src/lib/onboarding/disclosure-url.ts` decides whether an admin
 * evidence or export read flags a stored URL as unusable. They are supposed to be the same rule.
 * Nothing but this file makes that true -- Postgres cannot call the TypeScript, and the TypeScript
 * has no reason to call Postgres at runtime, so without an explicit assertion the two are free to
 * disagree for as long as it takes someone to notice.
 *
 * The failure this prevents is quiet and asymmetric. If the SQL side gets stricter, a lead stops
 * seeing a link the admin console still calls fine. If the TypeScript gets stricter, the console
 * flags a URL that leads are being shown perfectly well. Neither raises anything.
 *
 * Both sides read the same case table, so adding a case here tests both halves at once.
 */

const DB_URL = process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try { await db.connect(); } catch (cause) {
    throw new Error(`Disclosure-agreement suite could not reach Postgres at ${DB_URL}. Start the local stack with supabase start.`, { cause });
  }
});
afterAll(async () => db?.end());

describe("disclosure host rule agrees across SQL and TypeScript", () => {
  it("returns the same answer from both runtimes for every case in the table", async () => {
    // One round trip for the whole table: unnest the cases, call the SQL function on each, and
    // compare the column against the TypeScript answer for the same input. A per-case query would
    // be slower and would report only the first disagreement.
    const urls = DISCLOSURE_CASES.map((entry) => entry.url);
    const { rows } = await db.query<{ url: string; sql_reachable: boolean }>(
      `select url, app.disclosure_host_is_reachable(url) as sql_reachable
       from unnest($1::text[]) as t(url)`,
      [urls],
    );

    // Compare as one object rather than case by case, so a failure prints every disagreement at
    // once and names the URL that caused it.
    const fromSql = Object.fromEntries(rows.map((row) => [row.url, row.sql_reachable]));
    const fromTs = Object.fromEntries(urls.map((url) => [url, disclosureHostIsReachable(url)]));
    expect(fromSql).toEqual(fromTs);
  });

  it("matches the expectation the table declares, so agreeing on a wrong answer still fails", async () => {
    // Two implementations agreeing is not the same as either being correct -- they could drift
    // together, or both be wrong from the start. The table's own `reachable` column is the third
    // party, and this is the assertion that makes the agreement above worth having.
    const { rows } = await db.query<{ url: string; sql_reachable: boolean }>(
      `select url, app.disclosure_host_is_reachable(url) as sql_reachable
       from unnest($1::text[]) as t(url)`,
      [DISCLOSURE_CASES.map((entry) => entry.url)],
    );
    const fromSql = Object.fromEntries(rows.map((row) => [row.url, row.sql_reachable]));
    for (const { url, reachable, because } of DISCLOSURE_CASES) {
      expect(fromSql[url], `SQL side, ${url}: ${because}`).toBe(reachable);
      expect(disclosureHostIsReachable(url), `TS side, ${url}: ${because}`).toBe(reachable);
    }
  });

  it("keeps the SQL function immutable and search_path-pinned, which is what lets it be inlined", async () => {
    // `immutable` is not decoration here: it is what allows the planner to inline the call in the
    // session-start function's `and` chain. `search_path = ''` is the project-wide hardening rule
    // for every security-relevant function.
    expect((await db.query(`select provolatile, proconfig from pg_proc
      where oid = 'app.disclosure_host_is_reachable(text)'::regprocedure`)).rows[0])
      .toEqual({ provolatile: "i", proconfig: ['search_path=""'] });
  });
});
