#!/usr/bin/env node
/**
 * One-shot live-contract probe against services.leadconnectorhq.com, using the two agency
 * grants stored in ghl_agency_installs on 2026-08-21. It settles the questions the repo
 * currently guesses at (docs/GAPS.md): whether this agency clears the Agency Pro gate on
 * POST /locations/, whether the agent app's agency install can mint a location token for a
 * sub-account created after the install (the zero-touch question), what snapshot-status
 * really returns, and whether DELETE /locations/{id} exists at all.
 *
 * The script is read-only against Supabase and read-mostly against the provider: its only
 * provider writes are one clearly-named location create and that location's delete. It never
 * refreshes a grant — refresh tokens are single-use and rotating, and one spent outside
 * resolveRefreshingAccessToken's lease destroys the install — and it never prints, logs, or
 * persists a decrypted token. Evidence is status codes and sorted body key lists only.
 */
import { createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const API_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";
const PROBE_LOCATION_NAME = "SetterFi Contract Probe - safe to delete";

function parseEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    console.error(`Cannot read ${path}. This probe talks to the hosted project and has no offline mode.`);
    process.exit(1);
  }
  const values = {};
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

const fileEnv = parseEnvFile(resolve(process.cwd(), ".env.local"));
const env = { ...process.env };
delete env.SUPABASE_SERVICE_ROLE_KEY;
delete env.NEXT_PUBLIC_SUPABASE_URL;
delete env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
for (const [key, value] of Object.entries(fileEnv)) env[key] = value;

// 1. The encryption key, before anything else. An unset key silently derives MOCK_KEY in the
// production module and every decrypt then fails as CREDENTIAL_ENVELOPE_AUTHENTICATION_FAILED,
// which reads like row corruption and has already cost an investigation.
const keyMaterial = env.SETTERFI_CREDENTIAL_ENCRYPTION_KEY ?? "";
let key;
try {
  key = Buffer.from(keyMaterial, "base64url");
} catch {
  key = Buffer.alloc(0);
}
if (keyMaterial.length === 0 || key.length !== 32) {
  console.error(
    "SETTERFI_CREDENTIAL_ENCRYPTION_KEY is unset or does not base64url-decode to exactly 32 bytes."
      + " Refusing to continue: an absent key would silently derive MOCK_KEY and every decrypt would"
      + " fail as CREDENTIAL_ENVELOPE_AUTHENTICATION_FAILED, which reads like row corruption.",
  );
  process.exit(1);
}

// 2. Provably inert without the flag.
if (!process.argv.includes("--confirm-live")) {
  console.log("This probe would, in order:");
  console.log("  1. read both agency grants from ghl_agency_installs (read-only, no refresh)");
  console.log(`  2. POST /locations/ on the client's live agency, creating "${PROBE_LOCATION_NAME}"`);
  console.log("  3. POST /oauth/locationToken for that new location with the agent grant (zero-touch test)");
  console.log("  4. GET snapshot-status for it (skipped unless GHL_SNAPSHOT_ID is set)");
  console.log("  5. DELETE /locations/{id}, recording the status either way");
  console.log("Nothing was called. Re-run with --confirm-live to spend the run.");
  console.error("PROBE_LIVE_CONFIRMATION_REQUIRED");
  process.exit(1);
}

function decryptEnvelope(envelope, label) {
  if (!envelope || envelope.version !== 1 || envelope.keyVersion !== 1 || envelope.algorithm !== "A256GCM") {
    console.error(`${label}: envelope is not version 1 / keyVersion 1 / A256GCM. Refusing.`);
    process.exit(1);
  }
  const iv = Buffer.from(envelope.iv, "base64url");
  const tag = Buffer.from(envelope.tag, "base64url");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function sortedKeys(value) {
  if (value === null || typeof value !== "object") return `(non-object: ${typeof value})`;
  if (Array.isArray(value)) return `(array of ${value.length})`;
  return Object.keys(value).sort().join(", ");
}

async function callProvider(label, url, init) {
  const response = await fetch(url, init);
  let body = null;
  const text = await response.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text.length > 0 ? `(non-JSON, ${text.length} bytes)` : "(empty)";
  }
  const keys = typeof body === "string" ? body : sortedKeys(body);
  console.log(`${label}: HTTP ${response.status} — body keys: ${keys}`);
  return { status: response.status, body, keys };
}

// 3. Load both grants read-only.
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const { data: rows, error } = await supabase
  .from("ghl_agency_installs")
  .select("app, company_id, install_state, access_credential_envelope, token_expires_at")
  .in("app", ["agent", "provisioning"]);
if (error) {
  console.error(`ghl_agency_installs read failed: ${error.message}`);
  process.exit(1);
}
const byApp = Object.fromEntries((rows ?? []).map((row) => [row.app, row]));
for (const app of ["agent", "provisioning"]) {
  const row = byApp[app];
  if (!row) {
    console.error(`No ghl_agency_installs row for app='${app}'. Reinstall through the portal.`);
    process.exit(1);
  }
  if (new Date(row.token_expires_at).getTime() <= Date.now()) {
    console.error(
      `app='${app}' access token expired at ${row.token_expires_at}. This script does not refresh —`
        + " a refresh outside the store's lease would spend the single-use rotating refresh token."
        + " Let the driver refresh it (any live provisioning call), or reinstall through the portal.",
    );
    process.exit(1);
  }
}
const provisioningToken = decryptEnvelope(byApp.provisioning.access_credential_envelope, "provisioning access envelope");
const agentToken = decryptEnvelope(byApp.agent.access_credential_envelope, "agent access envelope");
const companyId = byApp.provisioning.company_id;
console.log(`Grants loaded for company ${companyId}; both unexpired. No refresh performed.`);

const findings = [];

// 4. POST /locations/ — the Agency Pro gate and the location response shape.
const createResult = await callProvider("POST /locations/", `${API_BASE}/locations/`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${provisioningToken}`,
    Version: API_VERSION,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: JSON.stringify({
    companyId,
    name: PROBE_LOCATION_NAME,
    timezone: "America/New_York",
    country: "US",
    address: "123 Probe Street",
    city: "Testville",
    state: "NY",
    postalCode: "10001",
  }),
});
findings.push({ step: "location-create", status: createResult.status, keys: createResult.keys });

const createdId =
  createResult.body && typeof createResult.body === "object"
    ? createResult.body.id ?? createResult.body._id ?? createResult.body.location?.id ?? null
    : null;
if (createResult.status >= 200 && createResult.status < 300 && createdId) {
  console.log(`Created probe location ${createdId} ("${PROBE_LOCATION_NAME}")`);
} else {
  console.log("Location create did not return a usable id; downstream steps that need one will be skipped.");
}

// 5. POST /oauth/locationToken — the zero-touch question.
if (createdId) {
  const mintResult = await callProvider("POST /oauth/locationToken", `${API_BASE}/oauth/locationToken`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${agentToken}`,
      Version: API_VERSION,
      "X-Client-Id": env.GHL_CLIENT_ID ?? "",
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ companyId, locationId: createdId }).toString(),
  });
  findings.push({ step: "location-token-mint", status: mintResult.status, keys: mintResult.keys });
  if (mintResult.status >= 400 && mintResult.body && typeof mintResult.body === "object") {
    // The provider's error text is the only thing that separates "app not installed on this
    // location" (zero-touch refuted) from a malformed request (probe defect). It carries no
    // credential material.
    console.log(`  provider error: ${JSON.stringify({ error: mintResult.body.error, message: mintResult.body.message, statusCode: mintResult.body.statusCode })}`);
  }
  if (mintResult.body && typeof mintResult.body === "object") {
    const required = [
      ["access_token/accessToken", Boolean(mintResult.body.access_token ?? mintResult.body.accessToken)],
      ["refresh_token/refreshToken", Boolean(mintResult.body.refresh_token ?? mintResult.body.refreshToken)],
      ["companyId", Boolean(mintResult.body.companyId)],
      ["expires_in > 0", Number(mintResult.body.expires_in) > 0],
    ];
    for (const [name, present] of required) {
      console.log(`  reconcileInstall requirement ${name}: ${present ? "present" : "ABSENT"}`);
    }
  }
} else {
  findings.push({ step: "location-token-mint", status: "skipped", keys: "no location id from create" });
}

// 6. snapshot-status, only with a real snapshot id.
if (env.GHL_SNAPSHOT_ID && createdId) {
  const snapshotResult = await callProvider(
    "GET snapshot-status",
    `${API_BASE}/snapshots/snapshot-status/${env.GHL_SNAPSHOT_ID}/location/${createdId}?companyId=${encodeURIComponent(companyId)}`,
    { headers: { Authorization: `Bearer ${provisioningToken}`, Version: API_VERSION, Accept: "application/json" } },
  );
  findings.push({ step: "snapshot-status", status: snapshotResult.status, keys: snapshotResult.keys });
} else {
  const reason = env.GHL_SNAPSHOT_ID ? "no location id" : "GHL_SNAPSHOT_ID is unset in .env.local";
  console.log(`GET snapshot-status: SKIPPED — ${reason}. A skip written down is evidence.`);
  findings.push({ step: "snapshot-status", status: "skipped", keys: reason });
}

// 7. DELETE /locations/{id} — the delete API's existence is itself unverified.
if (createdId) {
  const deleteResult = await callProvider("DELETE /locations/{id}", `${API_BASE}/locations/${createdId}?deleteTwilioAccount=false`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${provisioningToken}`, Version: API_VERSION, Accept: "application/json" },
  });
  findings.push({ step: "location-delete", status: deleteResult.status, keys: deleteResult.keys });
  if (deleteResult.status >= 400) {
    console.log(
      `DELETE failed — the probe location "${PROBE_LOCATION_NAME}" (id ${createdId}) must be removed`
        + " by hand from the agency UI.",
    );
  }
} else {
  findings.push({ step: "location-delete", status: "skipped", keys: "no location id from create" });
}

// 8. Print, do not pretend.
console.log("\n--- Findings (status codes and key lists only) ---");
for (const finding of findings) {
  console.log(`${finding.step}: ${finding.status} — ${finding.keys}`);
}
console.log(
  "\nWebhook delivery of AppInstall/AppUninstall was NOT observed by this script — the receiving"
    + " endpoint is the deployed /api/webhooks/ghl. Read the hosted audit trail afterwards:\n"
    + "  select occurred_at, action, target_id from audit_log where action ilike '%install%'"
    + " and occurred_at > now() - interval '1 hour' order by occurred_at;",
);
