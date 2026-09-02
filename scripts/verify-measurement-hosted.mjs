#!/usr/bin/env node
/**
 * Runner for the hosted measurement round-trip.
 *
 * It exists as a separate file from the assertions because of one env trap this project has
 * already been bitten by: the shell profile exports a SUPABASE_SERVICE_ROLE_KEY for a different,
 * dead project, and Node's `--env-file` does not override an already-set variable. Anything that
 * inherits that key reaches the wrong project and reports `Invalid API key` while looking like a
 * credentials problem. So the inherited key is deleted here, before `.env.local` is read, and the
 * child vitest process is given a clean environment built from the file.
 *
 * The assertions live in scripts/verify-measurement-hosted.test.ts under vitest.hosted.config.mts
 * because the production parsers import `@/lib/supabase/server`, and plain node resolves neither
 * the `@/` alias nor its `next/headers` import - vitest resolves both, and running the production
 * parsers rather than a copy of them is the entire point.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
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

console.log(`Verifying measurement against ${env.NEXT_PUBLIC_SUPABASE_URL}`);
const result = spawnSync(
  "npx",
  ["vitest", "run", "--config", "vitest.hosted.config.mts"],
  { env, stdio: "inherit" },
);
process.exit(result.status ?? 1);
