import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

if (existsSync(".env.e2e")) {
  process.loadEnvFile(".env.e2e");
}
// The demo accounts and their password live in `.env.local`, and a run against a deployed URL has
// no `next start` to load them for it. Read after `.env.e2e` so a purpose-made E2E credential still
// wins: `process.loadEnvFile` leaves an already-set variable alone.
if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

// Another local Next app can hold :3000; set E2E_PORT to run the suite beside it.
export const E2E_PORT = process.env.E2E_PORT ?? "3000";

/**
 * Where the suite points, and the one thing that decides whether it builds an app first.
 *
 * `E2E_BASE_URL=https://setter-fi.vercel.app npx playwright test` runs every spec against the
 * deployment; unset, it builds and starts the local app as before. The server block is dropped
 * rather than pointed at the hosted URL, because `webServer.url` is a readiness probe Playwright
 * will also try to start a process for, and starting a local build to test a remote one is the
 * confusion this variable exists to avoid.
 */
const hostedBaseUrl = process.env.E2E_BASE_URL?.trim();
export const E2E_BASE_URL = hostedBaseUrl || `http://localhost:${E2E_PORT}`;

const viewports = [
  { label: "1440", viewport: { width: 1440, height: 900 } },
  { label: "1024", viewport: { width: 1024, height: 768 } },
  { label: "390", viewport: { width: 390, height: 844 } },
] as const;

function authenticatedProjects(role: "admin" | "coach" | "affiliate") {
  return viewports.map(({ label, viewport }) => ({
    name: `${role}-${label}`,
    dependencies: ["setup"],
    testMatch: `${role}.smoke.spec.ts`,
    use: {
      storageState: `e2e/.auth/${role}.json`,
      viewport,
    },
  }));
}

const publicProjects = viewports.map(({ label, viewport }) => ({
  name: `public-${label}`,
  testMatch: "public.smoke.spec.ts",
  use: { viewport },
}));

const visualProjects = (["admin", "coach", "affiliate", "public"] as const).map((role) => ({
  name: `${role}-visual-1440`,
  ...(role === "public" ? {} : { dependencies: ["setup"] }),
  grep: new RegExp(`${role} visual `),
  testMatch: "visual.spec.ts",
  use: {
    ...(role === "public" ? {} : { storageState: `e2e/.auth/${role}.json` }),
    viewport: { width: 1440, height: 900 },
  },
}));

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
    },
  },
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
  },
  ...(hostedBaseUrl ? {} : {
    webServer: {
      command: `npm run build && npm run start -- -p ${E2E_PORT}`,
      url: E2E_BASE_URL,
      reuseExistingServer: true,
      timeout: 180_000,
    },
  }),
  projects: [
    {
      name: "setup",
      testMatch: "auth.setup.ts",
    },
    {
      name: "a11y-1440",
      dependencies: ["setup"],
      testMatch: "a11y.spec.ts",
      use: { viewport: { width: 1440, height: 900 } },
    },
    ...authenticatedProjects("admin"),
    ...authenticatedProjects("coach"),
    ...authenticatedProjects("affiliate"),
    ...publicProjects,
    {
      name: "aliases-1440",
      dependencies: ["setup"],
      testMatch: "aliases.spec.ts",
      use: {
        storageState: "e2e/.auth/admin.json",
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "login-1440",
      testMatch: "login.spec.ts",
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      // No `storageState`: every test in here is about arriving signed out and pressing a button
      // that signs somebody in. Borrowing a role's session would make all four pass on a page they
      // never reached.
      name: "demo-logins-1440",
      testMatch: "demo-logins.smoke.spec.ts",
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: "project-matrix",
      testMatch: "*.project-matrix.spec.ts",
      use: { viewport: { width: 1440, height: 900 } },
    },
    ...visualProjects,
  ],
});
