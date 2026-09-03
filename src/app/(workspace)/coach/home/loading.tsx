import CoachLoading from "@/app/(workspace)/coach/loading";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Home's own loading boundary, which exists for exactly one element the segment's does not have.
 *
 * `CoachLoading` one level up covers all eight `/coach/*` routes, and it draws three generic deck
 * panels rather than Home's six because the panel is the shape every coach screen is made of. That
 * argument is right and it is also why the performance-window picker could not go in it:
 * `WindowPills` is declared in `coach-dashboard.tsx` and referenced nowhere else in the tree, so
 * the control exists on Home and on none of the other seven. Drawing it in the shared boundary
 * would have held Home's shape by inserting a block that never arrives on Inbox, Leads, Billing or
 * Setup -- moving the jump onto seven pages to remove it from one.
 *
 * Next resolves the nearest `loading.tsx` to the route, so this file takes Home and leaves the
 * other seven exactly as they were.
 *
 * **Bones rather than a live control.** The picker is five links whose value is a server read:
 * pressing "3M" here would navigate the page that has not finished loading, and pre-selecting a
 * stop would show a window the coach has not chosen and the page may not agree with -- `window`
 * comes from the URL, and it defaults to `1m` only when the URL says nothing. The point of this
 * file is the space the control occupies, and bones hold that without asserting which stop is
 * picked.
 */

/**
 * One stop per pill, at the width the real pill will be.
 *
 * The rehaul picker draws `1D / 1W / 1M / 3M / All` in 14px mono inside `min-w-14 px-3.5`, and no
 * label is long enough to push a pill past that floor, so every stop is 56px. The widths are still
 * written out one by one rather than repeated from a count, because the next label added here is
 * likelier to be a word than another two-character abbreviation, and a list of widths takes that
 * change where a count would hide it.
 *
 * The comment is not what keeps the two in step, though: this file promises a shape it does not
 * render, so a sixth pill would land in the picker and nowhere here, and the picker would change
 * width at the moment the page settles -- the same twenty-pixel jump the height note below
 * describes being fixed once already. `loading.test.tsx` imports both arrays and asserts the
 * lengths match, which is why this is exported.
 */
export const STOP_WIDTHS = ["56px", "56px", "56px", "56px", "56px"] as const;

export default function CoachHomeLoading() {
  return (
    <CoachLoading>
      <div
        // The picker's own gap and alignment, so the row is the size the control will be. The real
        // control is `aria-label="Performance window"`; these bones are `aria-hidden` and the
        // segment boundary above already owns the page's one live region, so nothing here is
        // announced twice.
        aria-hidden
        className="mt-[34px] flex min-w-0 justify-end gap-1.5"
        data-slot="home-window-bones"
      >
        {/*
          Keyed by position, not by the width. Every stop is 56px, so keying by width would give
          all five children the key `56px` -- with duplicate keys React is free to omit or
          duplicate a child, and the picker could come back four bones wide. The list is a fixed
          set of placeholders that never reorders, which is exactly the case where the index is the
          correct identity rather than the lazy one.
        */}
        {STOP_WIDTHS.map((width, index) => (
          <Skeleton
            // 44px, which is the height the real pill is, not the height a bone looks right at.
            // The pills are `h-11`, and `coach.css`'s target floor raises every control on a coach
            // surface to `--coach-target`, the same 44px. Bones drawn at a control's unfloored
            // height came out ~30px against a control that arrives ~52px, and the picker grew by
            // twenty pixels at the moment the page settled.
            className="block h-[44px] rounded-[10px] bg-[var(--band)]"
            key={index}
            style={{ width }}
          />
        ))}
      </div>
    </CoachLoading>
  );
}
