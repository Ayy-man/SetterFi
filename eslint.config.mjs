import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    // vendored shadcn/ui + shadcnblocks sources (phase 11, W0a-DEPS): generated code we do not author
    "src/components/ui/**",
    "src/components/blocks/**",
    ".next/**",
    // Any NEXT_DIST_DIR build tree (see next.config.ts): same generated output, different name.
    ".next-*/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "supabase/.temp/**",
    // Transient full-repo worktrees the parallel quick-task agents create. They are
    // git-excluded but eslint walks the filesystem, so without this line a parallel
    // run reports ~1200 errors that belong to copies of this same codebase.
    ".claude/**",
  ]),
]);

export default eslintConfig;
