import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Separate config from vitest.config.mts on purpose: the RLS suite needs a live
// Postgres (supabase start / supabase db start) and must FAIL when it's absent,
// so it cannot ride along in the DB-free unit run. Invoked via `npm run test:rls`.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["supabase/tests/**/*.test.ts"],
    // One connection, transactional tests — parallel files would deadlock on it.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
