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

const LOCAL_DB = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/*
 * One database only, and it is the one `supabase db reset` resets. The reset command takes no
 * connection string and always targets the CLI's local project, so an override that pointed the
 * suite anywhere else would leave the reset and the suite talking to two different databases
 * while this script reported one clean gate. A forwarded port on a Docker alias or on
 * host.docker.internal can reach a hosted database, which is why hostnames are not enough: the
 * URL has to be the local one, exactly.
 */
if (process.env.RLS_TEST_DB_URL !== undefined && process.env.RLS_TEST_DB_URL !== LOCAL_DB) {
  console.error(
    "Refusing to run: RLS_TEST_DB_URL is set to something other than the local Supabase database.\n" +
      `This script resets and tests only ${LOCAL_DB}. Unset RLS_TEST_DB_URL, or run ` +
      "`npm run test:rls` yourself against the database you mean.",
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

process.env.RLS_TEST_DB_URL = LOCAL_DB;
process.exit(run("npx", ["vitest", "run", "--config", "vitest.rls.config.mts"]));
