import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

if (existsSync(".env.e2e")) process.loadEnvFile(".env.e2e");

// A camera rig, not a test suite: it drives the reworked gestures and samples frames mid-flight
// so the motion can be looked at. Point E2E_PORT at whichever dev server is already up.
const port = process.env.E2E_PORT ?? "3000";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "motion.capture.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  use: {
    baseURL: `http://localhost:${port}`,
    storageState: "e2e/.auth/admin.json",
    viewport: { width: 1440, height: 900 },
  },
});
