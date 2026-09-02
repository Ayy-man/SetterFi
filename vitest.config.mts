import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
};

/**
 * One `vitest run` that covers both halves of the suite, split by environment rather than by
 * config file.
 *
 * **Why this is two projects and not one `environment`.** The node half -- 358 files of pure
 * logic, storage seams and HTTP contracts -- is deliberately not jsdom. Standing a DOM up per
 * file costs real wall-clock (the jsdom half below spends ~43s of a 25s run inside `environment`
 * alone), and this suite sits in front of every push, so flattening everything to jsdom would tax
 * 3600-odd tests that never touch a DOM to serve the 1100 that do. That decision predates this
 * file's split and is not up for grabs; what changed is only how it is expressed.
 *
 * **Why this replaced a second config file.** The DOM tests used to live in `vitest.ui.config.mts`
 * and ran only under `npm run test:ui`. That is a trap rather than a split: a bare `npx vitest run`
 * -- which is what anyone types, and what several agents typed tonight -- silently matched
 * `src/**\/*.test.ts` only, printed a fully green 3605, and reported nothing about the 92 `.test.tsx`
 * files. Two real defects shipped behind that green: coach Home printed "Day 31 / of about 31 days
 * needed" on all six panels, and `src/components/kit/field.tsx` threw on every server render of
 * `/login`. Both had a covering `.tsx` test; neither test was ever executed. A default command that
 * runs a strict subset of the suite while looking like the whole thing is worse than no split at
 * all, so the split now lives *inside* the default command.
 *
 * **Why not `environmentMatchGlobs`.** It was deprecated in Vitest 3 and removed in Vitest 4 (this
 * repo is on 4.1.10); `projects` is its replacement and is the only form that also lets the two
 * halves carry different `setupFiles` and `testTimeout`, which they need to.
 *
 * If you are here to simplify this back down to a single `environment`: don't. Run
 * `npx vitest run --project node` and watch the clock first.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "node",
          // Node, not jsdom: everything under test is pure logic or a storage/HTTP seam,
          // and the few browser globals needed are stubbed per-suite. That keeps the test
          // run dependency-light and fast enough to sit in front of every push.
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./src/test/setup-ui.ts"],
          /**
           * Above the 5s `asyncUtilTimeout` the setup file configures, and it has to be.
           *
           * Vitest's default is 5000ms, which was exactly equal to the query budget: any test that
           * actually needed the retries died of a test timeout on the same tick the query would
           * have given up, so the budget could never be spent. Under load that killed a different
           * test on each run -- and it reported as `Test timed out in 5000ms` on whichever one
           * lost, which reads as one slow test rather than as a setting that cancels another
           * setting.
           *
           * 165 tests already carry `{ timeout: 15_000 }` for this, one at a time. This is that
           * same decision made once, and it matches vitest.rls.config.mts.
           */
          testTimeout: 20_000,
        },
      },
    ],
  },
});
