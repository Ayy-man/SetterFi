import type { ReactNode } from "react";

import "./console.css";

/**
 * Exists to import one stylesheet, and that is the whole job.
 *
 * `console.css` is scoped to `[data-shell-role="admin"]`, so importing it globally would be
 * harmless in effect but wrong in principle: the owner console is a different visual language
 * from the coach surface, at a different density, for a different reader, and a language that
 * only applies to one route group should only be loaded by that route group. `coach/layout.tsx`
 * is the same file for the other half of the split, and `src/app/css-budget.test.ts` lists both
 * so their weight is printed rather than hidden inside the app budget.
 *
 * No markup and no server reads: the group's real server boundary is `(workspace)/layout.tsx` one
 * level up, and adding a second one here would give the nav flags two places to be resolved.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return children;
}
