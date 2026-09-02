import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Separate config from vitest.config.mts for the same reason vitest.rls.config.mts is separate:
// this suite talks to the hosted Supabase project and must FAIL when its credentials are absent,
// so it cannot ride along in the offline unit run. It exists at all because the production
// parsers import `@/lib/supabase/server`, which plain `node --experimental-strip-types` resolves
// neither the alias nor the `next/headers` import for - vitest already resolves both, and the
// point of this harness is to run the *production* parsers, not a copy of them.
// Invoked via `npm run verify:measurement-hosted`, whose runner does the env hygiene first.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["scripts/verify-measurement-hosted.test.ts"],
    // The printed snapshot summary IS the deliverable here, and the default reporter buffers
    // console output per task and then drops it for tests that passed - which swallows exactly
    // the run the next person wants to diff. Going straight to the terminal keeps it.
    disableConsoleIntercept: true,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
