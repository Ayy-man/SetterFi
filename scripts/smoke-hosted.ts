/**
 * Runs the platform smoke against the hosted database: every admin loader and the coach inbox
 * read, as the earliest platform owner, against the seeded demo coach tenant. One line per check,
 * exit code 1 on any failure, exit code 2 when no owner or no environment could be resolved.
 * Nothing is written to the database and no credential value is printed.
 *
 * Run it from the repo root with the hosted project's variables in `.env.local`, clearing any
 * stale shell exports first:
 *
 *   env -u SUPABASE_SERVICE_ROLE_KEY -u SUPABASE_ANON_KEY -u SUPABASE_JWT_SECRET zsh -c \
 *     'set -a; source .env.local; set +a; npx --yes tsx --tsconfig tsconfig.json scripts/smoke-hosted.ts'
 *
 * The seeders spawn this script after a `--confirm-hosted` run and fail with `SMOKE_FAILED:<check>`
 * when it exits non-zero; the last stderr line, `SMOKE_FAILED:<keys>`, is what they read.
 */

import {
  resolveDemoCoachTenant,
  resolvePlatformOwnerActor,
  runPlatformSmoke,
} from "@/lib/operations/smoke";

const REQUIRED_NAMES = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;

async function main() {
  const missing = REQUIRED_NAMES.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    console.error(`SMOKE_ENV_MISSING:${missing.join(",")}`);
    process.exitCode = 2;
    return;
  }
  const actor = await resolvePlatformOwnerActor();
  if (!actor) {
    console.error("SMOKE_OWNER_MISSING: no users row with role owner or admin");
    process.exitCode = 2;
    return;
  }
  const demoTenant = await resolveDemoCoachTenant();
  const nowIso = new Date().toISOString();
  console.log(`Platform smoke: actor_role=${actor.role} demo_tenant=${demoTenant?.slug ?? "missing"} as_of=${nowIso}`);

  const result = await runPlatformSmoke({
    actorId: actor.actorId,
    actorRole: actor.role,
    nowIso,
    demoTenantId: demoTenant?.id ?? null,
  });
  for (const check of result.checks) {
    const line = `${check.ok ? "ok  " : "FAIL"} ${check.key.padEnd(22)} ${String(check.ms).padStart(6)}ms${check.error ? `  ${check.error}` : ""}`;
    if (check.ok) console.log(line);
    else console.error(line);
  }
  const failed = result.checks.filter((check) => !check.ok).map((check) => check.key);
  console.log(`Platform smoke ${result.ok ? "passed" : "failed"}: checks=${result.checks.length} failed=${failed.length}`);
  if (!result.ok) {
    console.error(`SMOKE_FAILED:${failed.join(",")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : "SMOKE_CRASHED");
  process.exitCode = 2;
});
