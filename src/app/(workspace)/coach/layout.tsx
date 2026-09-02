import type { ReactNode } from "react";

import "./coach.css";

/**
 * Exists to import one stylesheet, and that is the whole job.
 *
 * `coach.css` is scoped to `[data-shell-role="coach"]`, so importing it globally would be
 * harmless in effect but wrong in principle: the coach surface is a different visual language
 * from the owner console, and a language that only applies to one route group should only be
 * loaded by that route group. `consumer/consumer.css` is deferred the same way, and
 * `src/app/css-budget.test.ts` lists both so their weight is printed rather than hidden.
 *
 * No markup, no server reads: the group's real server boundary is `(workspace)/layout.tsx` one
 * level up, and adding a second one here would give the nav flags two places to be resolved.
 */
export default function CoachLayout({ children }: { children: ReactNode }) {
  return children;
}
