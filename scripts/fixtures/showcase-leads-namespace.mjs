/**
 * The one fixed UUID prefix every showcase-leads row carries.
 *
 * It lives in its own module because three seeders need it and two of them already import each
 * other: `seed-showcase-leads.mjs` imports `resolveDemoTarget` from `seed-phase1-demo.mjs`, so
 * declaring the prefix in either of those files and importing it back would close a cycle. The
 * two Phase 1 / Phase 7 contact normalisers use it to leave showcase rows alone; the seeder uses
 * it to build every id it writes. One definition, three readers, no cycle.
 *
 * `grep -rn "8d000000" scripts/ src/ supabase/` was empty before this file existed.
 */
export const SHOWCASE_LEADS_NAMESPACE = "8d000000-";

/**
 * The same prefix as a SQL `like` pattern, for the fixture verifiers that count rows per tenant
 * and have to leave the showcase book out of an exact count. Inlined rather than parameterised:
 * the queries that need it already carry positional parameters and this is a compile-time
 * constant, not input.
 */
export const SHOWCASE_LEADS_SQL_PATTERN = `${SHOWCASE_LEADS_NAMESPACE}%`;

/** True for any row this namespace owns, so a normaliser can skip it by id alone. */
export function isShowcaseLeadId(id) {
  return typeof id === "string" && id.startsWith(SHOWCASE_LEADS_NAMESPACE);
}
