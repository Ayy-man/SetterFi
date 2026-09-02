import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

if (existsSync(".env.e2e")) {
  process.loadEnvFile(".env.e2e");
}

// Another local Next app can hold :3000; set E2E_PORT to run the suite beside it.
export const E2E_PORT = process.env.E2E_PORT ?? "3000";
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

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
  webServer: {
    command: `npm run build && npm run start -- -p ${E2E_PORT}`,
    url: E2E_BASE_URL,
    reuseExistingServer: true,
    timeout: 180_000,
  },
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
      name: "project-matrix",
      testMatch: "*.project-matrix.spec.ts",
      use: { viewport: { width: 1440, height: 900 } },
    },
    ...visualProjects,
  ],
});
