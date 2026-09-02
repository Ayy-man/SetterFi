// Seeds four demo accounts — owner, admin, coach, affiliate — on the hosted Supabase
// project, all on one shared password, so the /login flow and its role routing can be
// exercised end to end. Idempotent — safe to re-run; existing users are left alone.
//
// The coach is assigned to the **Phase 1 demo tenant**, not to a tenant of this script's
// own making. An earlier version minted a `staging-demo` tenant here, which was empty and
// always would have been: every demo seeder (`seed-phase1-demo.mjs` and its phase2/5/6/7/8
// followers) writes to its own fixed-UUID tenants instead. A coach who clicked the demo
// button therefore landed in a workspace with nothing in it, which proves the opposite of
// what the button exists to prove. The hosted database has already been corrected by hand;
// this change is about the script agreeing with reality on its next run.
//
// These are demo accounts guarding fixture data, not production credentials. They can only be
// seeded when SETTERFI_DEMO_LOGIN_PASSWORD is present in the selected environment file. Keep
// SETTERFI_DEMO_LOGINS off anywhere real coaches can reach: when that gate and the password are
// both configured, /login offers these four as one-click buttons and puts the environment-supplied
// password into its HTML.
//
// Usage:  node scripts/seed-staging-users.mjs            hosted, reads .env.local
//         node scripts/seed-staging-users.mjs --local    local stack, reads .env.production.local
//
// The local mode exists because the visual suite needs it. `.env.production.local` points the
// production build at 127.0.0.1:54321, so `npm run build && npm run start` -- which is how the
// Playwright baselines are photographed -- authenticates against the local stack, and this was
// the only script that can put a user there. It refused a loopback target outright, so a
// recreated local database left the e2e personas unseedable and the baselines unregenerable.
// That has now blocked the baseline regen twice. The refusal stays the default, because the
// hosted project is what an unflagged run is asking for and seeding it by accident is the
// mistake worth preventing; --local is the way to say you meant the other one.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

import { DEMO_IDS } from "./seed-phase1-demo.mjs";

const LOCAL = process.argv.includes("--local");
const ENV_FILE = LOCAL ? "../.env.production.local" : "../.env.local";

const env = Object.fromEntries(
  readFileSync(new URL(ENV_FILE, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
    .map((line) => {
      const idx = line.indexOf("=");
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim().replace(/^"|"$/g, "")];
    }),
);

const password = env.SETTERFI_DEMO_LOGIN_PASSWORD;
if (typeof password !== "string" || password.trim().length === 0) {
  console.error(
    `Missing SETTERFI_DEMO_LOGIN_PASSWORD in ${ENV_FILE.slice(3)}. Refusing to contact Supabase or seed demo accounts.`,
  );
  process.exit(1);
}

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error(`Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in ${ENV_FILE.slice(3)}`);
  process.exit(1);
}
const isLoopback = url.includes("127.0.0.1") || url.includes("localhost");
if (isLoopback && !LOCAL) {
  console.error("This script targets the hosted staging project. Pass --local to seed the local stack.");
  process.exit(1);
}
// The mirror of the guard above: --local must not be a way to reach the hosted project with the
// hosted service key, which is what would happen if .env.production.local were ever repointed.
if (!isLoopback && LOCAL) {
  console.error(`--local was passed but ${ENV_FILE.slice(3)} points at ${url}, which is not the local stack.`);
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

// Project email (+role aliases) on one shared password — defined once so a future edit
// cannot half-change it and leave a button offering a credential that no longer works.
// Kept in sync with src/lib/auth/demo-logins.ts by a parity test in demo-logins.test.ts.
// Imported rather than written out, so this can never drift from the tenant the demo
// seeders actually populate. Run `npm run demo:seed -- --confirm-hosted` (and the phase2/
// 5/6/7/8 followers) before or after this script; order does not matter, but a coach whose
// tenant has never been seeded sees empty screens.
const DEMO_TENANT_ID = DEMO_IDS.tenant;
const SEED_USERS = [
  { email: "support+owner@livelegacystrong.com", role: "owner", fullName: "Staging Owner", tenant: false },
  { email: "support+admin@livelegacystrong.com", role: "admin", fullName: "Staging Admin", tenant: false },
  { email: "support+coach@livelegacystrong.com", role: "coach", fullName: "Staging Coach", tenant: true },
  { email: "support+affiliate@livelegacystrong.com", role: "affiliate", fullName: "Staging Affiliate", tenant: false },
];

// The demo tenant must already exist, and this script deliberately does not create it.
// `seed-phase1-demo.mjs` owns that row and refuses a hosted target whose demo tenant is
// missing (HOSTED_TARGET_IS_NOT_EXISTING_DEMO_TENANT) — a guard against seeding fixtures
// into a real customer tenant. Failing loudly here is the same guard from the other side.
const { data: tenant, error: tenantErr } = await supabase
  .from("tenants")
  .select("id, slug, is_demo")
  .eq("id", DEMO_TENANT_ID)
  .maybeSingle();
if (tenantErr) throw tenantErr;
if (!tenant) {
  console.error(
    `Demo tenant ${DEMO_TENANT_ID} does not exist. Run the demo seeders first:\n` +
    (LOCAL ? "  npm run demo:seed" : "  npm run demo:seed -- --confirm-hosted"),
  );
  process.exit(1);
}
if (tenant.is_demo !== true) {
  console.error(`Tenant ${DEMO_TENANT_ID} exists but is_demo is not true — refusing to seed users into it.`);
  process.exit(1);
}
console.log(`coach will be assigned to demo tenant ${tenant.slug} (${tenant.id})`);

const credentials = [];

for (const seed of SEED_USERS) {
  const { data: existing, error: lookupErr } = await supabase
    .from("users")
    .select("id")
    .eq("email", seed.email)
    .maybeSingle();
  if (lookupErr) throw lookupErr;
  if (existing) {
    console.log(`${seed.email} already seeded — skipping`);
    continue;
  }

  const { data: created, error: authErr } = await supabase.auth.admin.createUser({
    email: seed.email,
    password,
    email_confirm: true,
  });
  if (authErr) throw new Error(`auth.createUser(${seed.email}): ${authErr.message}`);

  const { error: rowErr } = await supabase.from("users").insert({
    id: created.user.id,
    email: seed.email,
    full_name: seed.fullName,
    role: seed.role,
    tenant_id: seed.tenant ? tenant.id : null,
  });
  if (rowErr) throw new Error(`public.users insert (${seed.email}): ${rowErr.message}`);

  if (seed.role === "affiliate") {
    const { error: affErr } = await supabase.from("affiliates").insert({
      user_id: created.user.id,
      referral_code: `staging-${randomBytes(4).toString("hex")}`,
    });
    if (affErr) throw new Error(`affiliates insert: ${affErr.message}`);
  }

  credentials.push({ email: seed.email, role: seed.role });
  console.log(`created ${seed.role}: ${seed.email}`);
}

if (credentials.length) {
  console.log("\n=== DEMO ACCOUNTS ===");
  console.log("Password supplied from SETTERFI_DEMO_LOGIN_PASSWORD in the environment.");
  for (const c of credentials) console.log(`${c.role.padEnd(10)} ${c.email}`);
} else {
  console.log("\nNothing new created.");
}
