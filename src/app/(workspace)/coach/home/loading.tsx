import CoachLoading from "@/app/(workspace)/coach/loading";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Home's own loading boundary, which exists for exactly one element the segment's does not have.
 *
 * `CoachLoading` one level up covers all eight `/coach/*` routes, and it draws three generic deck
 * panels rather than Home's six because the panel is the shape every coach screen is made of. That
 * argument is right and it is also why the performance-window picker could not go in it:
 * `MeasurementPicker` is declared in `coach-measurement.tsx` and referenced nowhere else in the
 * tree, so the control exists on Home and on none of the other seven. Drawing it in the shared
 * boundary would have held Home's shape by inserting a block that never arrives on Inbox, Leads,
 * Billing or Setup -- moving the jump onto seven pages to remove it from one.
 *
 * Next resolves the nearest `loading.tsx` to the route, so this file takes Home and leaves the
 * other seven exactly as they were.
 *
 * **Bones rather than a live control**, unlike `CoachLoading.dc.html`, which draws the picker as
 * real interactive pills with Month selected. The picker is a `GET` form whose value is a server
 * read: pressing "3 months" here would navigate the page that has not finished loading, and
 * pre-selecting a stop would show a window the coach has not chosen and the page may not agree
 * with -- `window` comes from the URL, and it defaults to `1m` only when the URL says nothing.
 * The point of this file is the space the control occupies, and bones hold that without asserting
 * which stop is picked.
 */

/**
 * The six stops, so the bones are the width the real pills will be rather than six equal blocks.
 *
 * These grew when the pills stopped being abbreviations. `Main.dc.html:114-118` draws words --
 * `Today`, `Week`, `Month`, `3 months`, `All` -- at 16px/500 inside `px-[18px]`, so a stop is its
 * word plus 36px of padding rather than the 26-34px a two-character `1D` needed. No two are equal
 * any more, which is incidental: the keys are positional and React's own duplicate-key warning is
 * what the suite reads.
 *
 * **Six bones against five drawn pills, and the code is the one that is right.** The artboard
 * enumerates five windows; `WINDOW_OPTIONS` in `coach-measurement.tsx` carries six, the sixth being
 * `{ value: "custom", pill: "Custom" }`, and the real control renders one stop per entry. So the
 * count the canvas shows predates the custom range the code later gained -- this is one of the few
 * places the artboard loses outright rather than being adapted, and an audit reading `:114-118` as
 * the bone count will keep re-reporting a bone that belongs here.
 *
 * The comment is not what keeps the two in step, though: this file promises a shape it never
 * imports, so a seventh window would land in the picker and nowhere here, and the picker would
 * change width at the moment the page settles -- the same twenty-pixel jump the height note below
 * describes being fixed once already. `loading.test.tsx` imports both arrays and asserts the
 * lengths match, which is why this is exported.
 */
export const STOP_WIDTHS = ["80px", "78px", "84px", "104px", "62px", "92px"] as const;

export default function CoachHomeLoading() {
  return (
    <CoachLoading>
      <div
        // `surface-well` and the picker's own gaps, so the box is the size the form will be. The
        // real control is `aria-label="Performance window"`; these bones are `aria-hidden` and the
        // segment boundary above already owns the page's one live region, so nothing here is
        // announced twice.
        aria-hidden
        className="surface-well mt-[34px] flex min-w-0 flex-col gap-[var(--s-1)]"
        data-slot="home-window-bones"
      >
        <Skeleton className="block h-[13px] w-[142px] rounded-[6px] bg-[var(--well)]" />
        {/* The well at `scale="coach"`: 4px gaps in a 4px pad on 12px corners, which is what
            `Segmented` renders once the picker asks for the coach density. */}
        <div className="mt-[var(--s-1)] inline-flex max-w-full gap-[4px] rounded-[12px] border border-[var(--line)] bg-[var(--control-fill)] p-[4px]">
          {/*
            Keyed by position, not by the width. Two of the six stops are 30px, and React was
            warning that two children shared the key `30px` -- with duplicate keys it is free to
            omit or duplicate a child, so the picker could come back five bones wide. The list is
            a fixed set of placeholders that never reorders, which is exactly the case where the
            index is the correct identity rather than the lazy one.
          */}
          {STOP_WIDTHS.map((width, index) => (
            <Skeleton
              // 44px, which is the height the real stop is, not the height a bone looks right at.
              // `Segmented` sized its buttons `py-[5px]` on a 12.5px line -- about 24px, which is
              // what these bones were -- and then `coach.css`'s target floor raised every control
              // on a coach surface to `--coach-target`, 44px. So the box the bones sit in came out
              // ~30px tall against a control that arrives ~52px, and the picker grew by twenty
              // pixels at the moment the page settled. The atomic's coach scale now sets 44px
              // itself, so the two agree at the source; `CoachLoading.dc.html` draws the same 44px.
              className="block h-[44px] rounded-[9px] bg-[var(--band)]"
              key={index}
              style={{ width }}
            />
          ))}
        </div>
      </div>
    </CoachLoading>
  );
}
