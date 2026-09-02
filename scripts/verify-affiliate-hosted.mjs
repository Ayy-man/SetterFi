#!/usr/bin/env node
/**
 * Runner for the affiliate portal round-trip against the hosted project.
 *
 * It exists because `/affiliate` answered 503 in production on 2026-09-01 over a disagreement
 * between the deployed application and the deployed database that no offline test can be in: the
 * account-state allowlist had moved to four values while the hosted projection still returned the
 * old two. Every offline test builds the rows it then asserts against, so all of them stayed
 * green. This is the check that would not have.
 *
 * It is a separate file from the assertions for the same env trap the measurement runner names:
 * the shell profile on at least one machine exports a SUPABASE_SERVICE_ROLE_KEY for a different,
 * dead project, and Node's `--env-file` does not override an already-set variable. Anything that
 * inherits it reaches the wrong project and reports `Invalid API key`, which reads as a
 * credentials problem rather than a configuration one. The inherited Supabase values are deleted
 * here, before `.env.local` is read, and the child vitest process is handed a clean environment
 * built from the file.
 *
 * The assertions live in `src/lib/affiliates/hosted-portal-read.spec.ts` under
 * `vitest.affiliate-hosted.config.mts`, because the spec drives the production route handler and
 * plain node resolves neither the `@/` alias nor the `next/headers` import behind it. The `.spec`
 * suffix is what keeps it out of the offline suite, whose include is `src/**\/*.test.ts`.
 *
 * Run after a deploy, or after applying a migration that touches an affiliate object.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  // The affiliate demo account is signed in for a real user JWT, because both projections select
  // the affiliate from `app.current_user_id()` inside PostgreSQL: a service-role client reads no
  // rows here and would prove nothing about what an affiliate sees.
  "SETTERFI_DEMO_LOGIN_PASSWORD",
];

function parseEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    console.error(`Cannot read ${path}. This harness talks to the hosted project and has no`
      + ` offline mode; copy the project's .env.local into place and re-run.`);
    process.exit(1);
  }
  const values = {};
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

const fileEnv = parseEnvFile(resolve(process.cwd(), ".env.local"));

// The file wins over the shell for every Supabase variable, which is the whole hygiene point.
const env = { ...process.env };
delete env.SUPABASE_SERVICE_ROLE_KEY;
delete env.NEXT_PUBLIC_SUPABASE_URL;
delete env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
for (const [key, value] of Object.entries(fileEnv)) env[key] = value;

const missing = REQUIRED.filter((name) => !env[name]);
if (missing.length) {
  console.error(`Missing from .env.local: ${missing.join(", ")}.`
    + ` Each one is read by name, so a renamed or commented-out line reads as absent.`);
  process.exit(1);
}

console.log(`Verifying the affiliate portal against ${env.NEXT_PUBLIC_SUPABASE_URL}`);
const result = spawnSync(
  "npx",
  ["vitest", "run", "--config", "vitest.affiliate-hosted.config.mts"],
  { env, stdio: "inherit" },
);
process.exit(result.status ?? 1);
