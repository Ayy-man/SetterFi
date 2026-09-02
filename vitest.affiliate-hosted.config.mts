import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Separate from vitest.config.mts for the same reason vitest.hosted.config.mts is: this spec talks
 * to the hosted Supabase project and must FAIL when its credentials are absent, so it cannot ride
 * along in the offline unit run. It exists at all because the spec drives the production route
 * handler, which imports `@/lib/supabase/server` and through it `next/headers` - plain node
 * resolves neither the alias nor that import, vitest resolves both, and running the real handler
 * rather than a copy of it is the whole point.
 *
 * Invoked via `npm run verify:affiliate-hosted`, whose runner does the env hygiene first.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/lib/affiliates/hosted-portal-read.spec.ts"],
    // The printed response IS the deliverable after a deploy, and the default reporter buffers
    // console output per task and then drops it for tests that passed, which swallows exactly the
    // rows the next person wants to read.
    disableConsoleIntercept: true,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
