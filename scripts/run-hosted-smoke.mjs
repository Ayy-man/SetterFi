/**
 * The seeders' closing check. After a `--confirm-hosted` run, `scripts/smoke-hosted.ts` is run in
 * a child process with the same environment, so a seeder can never leave an admin page broken
 * silently: a failing check ends the seeder run with `SMOKE_FAILED:<check>`.
 *
 * The smoke's own output is passed through as it happens; the trailing `SMOKE_FAILED:<keys>` line
 * on stderr is what names the failure here.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function hostedSmokeRequested(argumentsList = process.argv.slice(2)) {
  return argumentsList.includes("--confirm-hosted") && !argumentsList.includes("--skip-smoke");
}

export function runHostedSmokeAfterSeed(argumentsList = process.argv.slice(2), environment = process.env) {
  if (!hostedSmokeRequested(argumentsList)) return { ran: false };
  console.log("Seed complete; running the platform smoke against the hosted loaders.");
  const child = spawnSync("npx", ["--yes", "tsx", "--tsconfig", "tsconfig.json", "scripts/smoke-hosted.ts"], {
    cwd: REPO_ROOT,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error) throw new Error(`SMOKE_FAILED:spawn:${child.error.message}`);
  if (child.status === 0) return { ran: true };
  const marker = (child.stderr ?? "").split("\n").map((line) => line.trim()).filter((line) => line.startsWith("SMOKE_FAILED:")).pop();
  const failedChecks = marker ? marker.slice("SMOKE_FAILED:".length) : `exit_${child.status ?? "signal"}`;
  throw new Error(`SMOKE_FAILED:${failedChecks}`);
}
