#!/usr/bin/env node
// Reproducible RLS gate: reset the local database, then run the RLS suite against it.
//
// The plain `npm run test:rls` runs against whatever is already in the local database. That is
// fast while iterating, but seeds left behind by the demo scripts collide with the fixed tenant,
// user and slug literals the suite inserts, so a shared machine can show failures that say
// nothing about the code. This wrapper makes the gate answer one question only: does the suite
// pass on the migrations as committed.
//
// Refuses to touch anything but a local database, because a reset is destructive.

import { spawnSync } from "node:child_process";

const DEFAULT_LOCAL_DB = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const dbUrl = process.env.RLS_TEST_DB_URL ?? DEFAULT_LOCAL_DB;

const host = (() => {
  try {
    return new URL(dbUrl).hostname;
  } catch {
    return "";
  }
})();

if (!["127.0.0.1", "localhost", "::1", "db", "host.docker.internal"].includes(host)) {
  console.error(
    `Refusing to reset a non-local database (host "${host}").\n` +
      "This script only runs against local Supabase. Unset RLS_TEST_DB_URL or point it at 127.0.0.1.",
  );
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.error) {
    console.error(`Failed to start ${command}: ${result.error.message}`);
    process.exit(1);
  }
  return result.status ?? 1;
}

console.log("Resetting local Supabase before the RLS suite...");
const resetStatus = run("npx", ["--yes", "supabase", "db", "reset"]);
if (resetStatus !== 0) {
  console.error("supabase db reset failed. Is local Supabase running (npx supabase start)?");
  process.exit(resetStatus);
}

process.exit(run("npx", ["vitest", "run", "--config", "vitest.rls.config.mts"]));
