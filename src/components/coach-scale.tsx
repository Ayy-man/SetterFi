import type { ElementType, HTMLAttributes, ReactNode } from "react";

/*
 * The coach language, on the surfaces that come before the workspace shell.
 *
 * `coach.css` is written entirely under `[data-shell-role="coach"]`, and that attribute is stamped
 * by `AppShell`. Sign-in, sign-up and onboarding never render an `AppShell` -- there is no rail, no
 * pill bar and, on /signup, no account yet -- so every rule in that stylesheet was unreachable from
 * them. They were therefore still drawing at the owner console's 13px density, on the three screens
 * a coach reads before they have ever seen the product, which is precisely backwards.
 *
 * Three ways to reach the same scale were available, and this is the one that does not fork it:
 *
 *   1. Retype the sizes here. That is a second copy of the language, and the craft audit on
 *      2026-08-30 is the record of what happens next -- seven lanes retyping nine class strings,
 *      at slightly different values, visible to the reader.
 *   2. Widen `coach.css`'s own selectors to a second attribute. That edits a file three other
 *      lanes are porting against right now, for no gain over (3).
 *   3. Load `coach.css` here and stamp the attribute it already keys on. One definition, one
 *      stylesheet, and the sizes move for these surfaces the moment they move for the workspace.
 *
 * `docs/REDESIGN-CANVAS.md` is the authority for the attribute being honest rather than a trick:
 * its density table puts "coach, affiliate, consumer, onboarding" in one column at 16px body and a
 * 44px target floor, against the console's 13.5px and 30-34px. These surfaces are that column. The
 * name says which of the product's two densities the subtree is drawn at, and that is exactly what
 * is being claimed.
 *
 * The import lives in this file rather than in the pages because `src/app/entry-surfaces.test.ts`
 * refuses a route-local stylesheet import on any entry page, and it is right to: the defect it was
 * written for was `landing.css` hiding a whole second palette behind one import line. This adds no
 * palette and no rule -- it loads the language the workspace already ships -- but the guard cannot
 * tell those apart from a page's import statement, and it should not have to.
 */
import "../app/(workspace)/coach/coach.css";

export type CoachScaleProps = {
  /** The element to render. `main` on a page that owns its document, `div` inside one. */
  as?: ElementType;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "children">;

export function CoachScale({ as, children, ...rest }: CoachScaleProps) {
  const Tag = (as ?? "div") as ElementType;
  return (
    <Tag data-shell-role="coach" {...rest}>
      {children}
    </Tag>
  );
}
