import Link from "next/link";
import { useState } from "react";

import type { CoachMeasurementWindow } from "@/lib/repositories/analytics";

/**
 * The date range control `Main.dc.html:113` draws beside the greeting.
 *
 * Six stops in one well: five presets and Custom. The five presets are links because the window is
 * a server read -- `coach/home/page.tsx` renders from `searchParams.window` -- so a control that
 * changed the view without changing the URL would leave a coach unable to reload or share what
 * they are looking at. Each preset rewrites `window` and drops the custom pair, because a preset
 * window is not a custom one and carrying `from`/`to` onto it hands the page a pair it refuses.
 *
 * Custom cannot be a link, because there is no honest href for it: the page needs a `from` and a
 * `to` before it can read a custom window, and inventing a default range would show a coach a span
 * they never picked. So the sixth stop opens a small form that submits the two dates as a plain
 * GET to the same route, which lands on the same URL a preset link would and leaves the window a
 * server read either way. The panel renders under the strip rather than over it, so it cannot
 * cover the stop that opened it on the one screen where the strip is already two rows tall.
 *
 * The strip wraps on a phone rather than scrolling sideways. Six stops need about 550px and the
 * phone gives the control near 300, so a single scrolling row shows three of them and hides the
 * other three behind a gesture with no affordance, including "All", which is the stop a coach
 * reaches for when a window looks empty.
 *
 * The stops moved from `1D / 1W / 1M / 3M / All` to the artboard's words. The abbreviations were
 * mono two-character labels, which is the face `coach-mono-labels.test.ts` was written against,
 * and "1 month" is the phrase the eyebrow on every bubble already uses.
 */

/**
 * The five preset stops, in the artboard's order and wording.
 *
 * Exported because `coach/home/loading.tsx` reserves one bone per stop and must not go out of step
 * with the control: a sixth preset added here would land in the strip and nowhere in the skeleton,
 * and the picker would change width at the moment the page settles.
 */
export const RANGE_STOPS = [
  { label: "1 day", value: "1d" },
  { label: "1 week", value: "1w" },
  { label: "1 month", value: "1m" },
  { label: "3 months", value: "3m" },
  { label: "All", value: "all" },
] as const satisfies ReadonlyArray<{ label: string; value: CoachMeasurementWindow }>;

/** The sixth stop's label, beside the five above, for the same reason the array is exported. */
export const CUSTOM_STOP_LABEL = "Custom";

const STOP_BASE = [
  "inline-flex h-11 flex-none items-center justify-center rounded-[9px] border px-[18px]",
  "text-[16px] whitespace-nowrap no-underline hover:no-underline",
].join(" ");

const STOP_REST = `${STOP_BASE} border-transparent bg-transparent font-medium text-[color:var(--muted)]`;
const STOP_ACTIVE = [
  STOP_BASE,
  "border-[var(--accent-edge)] bg-[var(--accent-wash-strong)] font-semibold text-[color:var(--ink)]",
].join(" ");

const FIELD_CLASS = [
  "h-12 w-full rounded-[9px] border border-[var(--line-input)] bg-[var(--well)] px-3",
  "text-[16px] text-[color:var(--ink)]",
].join(" ");

/**
 * Apply is a quiet control rather than the filled one a form's submit usually is.
 *
 * `design/coach/VOCABULARY.md` allows one filled accent button per page besides the active
 * navigation pill, and on the live composition that one is already spent by the pill itself. A
 * second filled face here would be the page's only accent-fill *inside the content*, on a control
 * that narrows a date range, which is not the most important thing on the screen by any reading.
 */
const APPLY_CLASS = [
  "inline-flex h-12 flex-none items-center justify-center rounded-[9px]",
  "border border-[var(--line)] bg-[var(--control-fill)] px-[22px]",
  "text-[16px] font-medium text-[color:var(--body)]",
].join(" ");

export type CoachHomeRangeProps = {
  customFrom?: string | null;
  customTo?: string | null;
  window: CoachMeasurementWindow;
};

export function CoachHomeRange({ customFrom, customTo, window }: CoachHomeRangeProps) {
  const custom = window === "custom";
  // Open when the page is already rendering a custom window, so the control shows the range the
  // figures were read over rather than hiding the only stop that carries its own values.
  const [open, setOpen] = useState(custom);

  return (
    <div className="flex min-w-0 flex-1 flex-col items-stretch gap-3 sm:flex-none sm:items-end">
      <div
        aria-label="Date range"
        className="flex max-w-full flex-wrap gap-1 rounded-xl border border-[var(--line)] bg-[var(--well)] p-1 sm:flex-nowrap"
        role="group"
      >
        {RANGE_STOPS.map((stop) => {
          const active = !custom && stop.value === window;
          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={active ? STOP_ACTIVE : STOP_REST}
              href={`/coach/home?window=${stop.value}`}
              key={stop.value}
            >
              {stop.label}
            </Link>
          );
        })}
        <button
          aria-expanded={open}
          className={custom ? STOP_ACTIVE : STOP_REST}
          data-slot="home-range-custom"
          onClick={() => setOpen((was) => !was)}
          type="button"
        >
          {CUSTOM_STOP_LABEL}
        </button>
      </div>

      {open ? (
        <form
          action="/coach/home"
          className="flex flex-wrap items-end gap-3 rounded-xl border border-[var(--line)] bg-[var(--card)] p-3"
          data-slot="home-range-custom-form"
          method="get"
        >
          <input name="window" type="hidden" value="custom" />
          <label className="flex min-w-[150px] flex-1 flex-col gap-1.5 text-[16px] text-[color:var(--muted)]">
            From
            <input
              className={FIELD_CLASS}
              defaultValue={customFrom ?? ""}
              name="from"
              required
              type="date"
            />
          </label>
          <label className="flex min-w-[150px] flex-1 flex-col gap-1.5 text-[16px] text-[color:var(--muted)]">
            To
            <input
              className={FIELD_CLASS}
              defaultValue={customTo ?? ""}
              name="to"
              required
              type="date"
            />
          </label>
          <button className={APPLY_CLASS} type="submit">
            Apply
          </button>
        </form>
      ) : null}
    </div>
  );
}
