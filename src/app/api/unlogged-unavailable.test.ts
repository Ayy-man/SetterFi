import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A 503 that names its cause nowhere is a route that cannot report why it failed.
 *
 * Every route under `src/app/api` answers its own failures with a deliberately generic body: a
 * caller must not be able to read from the response whether the repository is down, the tenant
 * predicate refused, or another tenant's row exists. That is right, and it stays. What was wrong
 * is that the cause went nowhere else either — `catch {` discards the error object before anything
 * can log it, so a Postgres read error, a Stripe timeout, and a genuine refusal all reached the
 * runtime log as the same bare 503. A real production 503 on `/api/affiliate/referrals` on
 * 2026-09-01 could be narrowed no further than "the route 503'd", which is what prompted this.
 *
 * The split this enforces is the one `contacts/[id]/pipeline-stage` and `contacts/[id]/identities`
 * already make: the reason goes to `console.error` server-side and nowhere near the response body.
 *
 * ## Why this only covers 503
 *
 * A bare `catch` is not a defect by itself. Most of the ones in this tree are body parsers —
 * `try { parsed = body(await request.json()); } catch { parsed = null; }` — where the thrown value
 * carries nothing the log wants, and a further large group answers 409 with a refusal code the
 * route already computed and logs itself. 503 is the class where the cause is both unknown to the
 * route and unrecoverable from the response, so it is the class where discarding it costs the
 * operator the whole diagnosis. Widening this scan to every status would fail forty-odd correct
 * parsers and would be quietly narrowed again the first time it was inconvenient.
 */

const API_ROOT = join(process.cwd(), "src/app/api");

function handlerFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return handlerFiles(path);
    if (!path.endsWith(".ts") || path.endsWith(".test.ts")) return [];
    return [path];
  });
}

/**
 * Deliberately textual rather than a TypeScript parse: the rule is "a catch that binds nothing
 * must not be the thing that answers 503", and it can be checked by reading the ten lines after
 * the catch. Ten is generous — the widest of these blocks is a five-line `Response.json`.
 */
function unloggedUnavailableCatches(source: string): number[] {
  const lines = source.split("\n");
  const offenders: number[] = [];
  lines.forEach((line, index) => {
    if (!/catch\s*\{\s*$/.test(line)) return;
    const block = lines.slice(index + 1, index + 10).join("\n");
    if (/status:\s*503/.test(block)) offenders.push(index + 1);
  });
  return offenders;
}

describe("API routes name their own unavailability in the log", () => {
  it("has no catch that discards the error and then answers 503", () => {
    const offenders = handlerFiles(API_ROOT).flatMap((path) =>
      unloggedUnavailableCatches(readFileSync(path, "utf8")).map(
        (line) => `${path.slice(process.cwd().length + 1)}:${line}`,
      ),
    );

    expect(offenders).toEqual([]);
  });

  /**
   * The scan is only worth having if it can see a violation, and the shape it must see is the one
   * that existed forty-one times in this tree before the sweep.
   */
  it("catches the shape it exists for", () => {
    const regressed = [
      "    try {",
      "      return Response.json({ ok: true });",
      "    } catch {",
      "      return Response.json(",
      '        { error: "Temporarily unavailable." },',
      "        { status: 503, headers: noStoreHeaders },",
      "      );",
      "    }",
    ].join("\n");

    expect(unloggedUnavailableCatches(regressed)).toEqual([3]);
    expect(unloggedUnavailableCatches(regressed.replace("catch {", "catch (cause) {"))).toEqual([]);
  });
});
