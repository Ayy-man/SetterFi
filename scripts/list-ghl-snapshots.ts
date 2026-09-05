/**
 * Read-only lookup for the launch checklist: lists the agency's snapshots (for GHL_SNAPSHOT_ID)
 * and a sample of locations, using the provisioning grant through the lease-guarded resolver so
 * a refresh rotates the token correctly. Number pools need the numberpools.read scope, which
 * neither installed app carries as of 2026-09-06, so that call is expected to answer 401 until
 * the scope is added and the app re-authorized. Never prints a token.
 *
 *   env -u SUPABASE_SERVICE_ROLE_KEY -u SUPABASE_ANON_KEY -u SUPABASE_JWT_SECRET \
 *     zsh -c 'set -a; source .env.local; set +a; npx --yes tsx --tsconfig tsconfig.json scripts/list-ghl-snapshots.ts'
 */
import { resolveGhlProvisioningAccessToken } from "@/lib/integrations/ghl-oauth-store";

const API_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

async function get(token: string, label: string, url: string) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Version: API_VERSION, Accept: "application/json" },
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = null; }
  console.log(`${label}: HTTP ${response.status}`);
  if (!response.ok && body && typeof body === "object" && "message" in body) {
    console.log(`  message: ${String((body as { message: unknown }).message).slice(0, 160)}`);
  }
  return response.ok ? body as Record<string, unknown> : null;
}

async function main() {
const { companyId, accessToken } = await resolveGhlProvisioningAccessToken();
console.log(`provisioning grant refreshed for company ${companyId}`);

const snapshots = await get(accessToken, "GET /snapshots/", `${API_BASE}/snapshots/?companyId=${encodeURIComponent(companyId)}`);
const snapshotRows = Array.isArray(snapshots?.snapshots) ? snapshots.snapshots as Record<string, unknown>[] : [];
console.log(`\nSnapshots (${snapshotRows.length}):`);
for (const row of snapshotRows) console.log(`  ${row.id ?? row._id}  ${row.name ?? "(unnamed)"}  type=${row.type ?? "?"}`);
if (snapshots && snapshotRows.length === 0) console.log(`  (keys: ${Object.keys(snapshots).sort().join(", ")})`);

const search = await get(accessToken, "GET /locations/search", `${API_BASE}/locations/search?companyId=${encodeURIComponent(companyId)}&limit=3`);
const locations = Array.isArray(search?.locations) ? search.locations as Record<string, unknown>[] : [];
console.log(`\nLocations sampled (${locations.length}):`);
for (const row of locations) console.log(`  ${row.id ?? row._id}  ${row.name ?? "?"}`);
const locationId = locations[0]?.id ?? locations[0]?._id;
if (locationId) {
  const pools = await get(accessToken, "GET /phone-system/number-pools", `${API_BASE}/phone-system/number-pools?locationId=${encodeURIComponent(String(locationId))}`);
  const rows = Array.isArray(pools?.numberPools) ? pools.numberPools as Record<string, unknown>[]
    : Array.isArray(pools?.pools) ? pools.pools as Record<string, unknown>[] : [];
  console.log(`\nNumber pools (${rows.length}):`);
  for (const row of rows) console.log(`  ${row.id ?? row._id}  ${row.name ?? row.poolName ?? "(unnamed)"}`);
  if (pools && rows.length === 0) console.log(`  (keys: ${Object.keys(pools).sort().join(", ")})`);
}

}
main().catch((error) => { console.error(String(error?.message ?? error)); process.exit(1); });
