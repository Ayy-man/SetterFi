import { Surface, SurfaceHeader } from "@/components/kit/atomics/surface";
import { ExportMenu } from "@/components/kit/export-menu";
import { workspaceCountFormat } from "@/lib/format/datetime";
import type { CoachLeadComposition } from "@/lib/repositories/analytics";

/**
 * Leads by month, as six bars, which is what `Main.dc.html:281` draws.
 *
 * **Bars rather than a line, and six or nothing.** A monthly count is a magnitude per period, and
 * `docs/COACH-REDESIGN-PLAYBOOK.md` rule 2 is the reason `SPARKLINE_MIN_POINTS` went from two to
 * six: a smoothed curve through three readings asserts a shape those readings never held. Under
 * six points this panel prints a sentence saying how many months it has instead of drawing a
 * shorter chart, because a two-bar chart is a comparison dressed as a trend.
 *
 * **Why this is not `kit/bar-chart.tsx`.** That component labels the two ends only, at the
 * console's axis size, and puts every other period in an `sr-only` table. The artboard labels all
 * six months under the bars, and `docs/SIMPLIFICATION-SPEC.md` §5 puts the coach floor at 14px, so
 * the shared component would have needed a coach arm. The kit is frozen for this rebuild, so the
 * bars are drawn here at the coach's own sizes and the shared component is left alone. The
 * `sr-only` table it would have given is drawn here too, for the same reason it exists there.
 *
 * **The partial month is solid, labelled and stated.** The current month reads low because it is
 * still filling, and a chart that does not say so invites the one wrong conclusion a coach can
 * draw from it. The bar carries "so far" beside its figure and the sentence under the chart says
 * how many days the month has had, counted in the tenant's own timezone off the same `asOf` the
 * bars were read at.
 */

const PAST_BAR_OPACITY = 0.28;

/**
 * Six, the same floor `SPARKLINE_MIN_POINTS` sets, spelled here rather than imported.
 *
 * `kit/sparkline.tsx` carries the `"use client"` directive, and `server-client-boundary.test.ts`
 * refuses a runtime import out of one into a module that could be pulled into the server graph:
 * Next replaces the export with a client reference, so the constant stops being a number at
 * runtime while the typechecker and Vitest both stay green. Two screens shipped that way. The
 * number is the same rule for the same reason -- `docs/COACH-REDESIGN-PLAYBOOK.md` rule 2, that
 * fewer than six readings cannot support a shape over time -- and the day either moves, both
 * should.
 */
const MONTHS_MINIMUM = 6;

/**
 * The phone does not get this SVG, because an SVG's type scales with its viewBox and a type floor
 * does not.
 *
 * The chart is drawn at a fixed user-unit width and scaled to the panel, which is the ordinary way
 * to make one responsive and is wrong under about 500px: at 1300 units inside a 330px phone column
 * the scale is about 0.25, so a 15px label renders at four pixels.
 * `docs/SIMPLIFICATION-SPEC.md` section 5 puts the coach floor at 14px and calls it absolute, and a
 * chart's own labels are not exempt. Narrowing the viewBox only moves the problem, because the
 * scale is still the column width over a number written here and the column is not a constant.
 *
 * So the phone gets `NarrowBars` below instead: the same six readings as HTML rows, where the type
 * is laid out by the browser at the size it is written at and cannot be scaled by a parent. The
 * alternative was measuring the panel in an effect and picking a width, which puts a layout jump on
 * the one element whose labels have to be legible on the first paint.
 */
const CHART_WIDTH = 1300;
const VIEW_HEIGHT = 260;
const BASELINE_Y = 210;
const BAR_TOP_MIN = 46;
const AXIS_Y = 240;
const VALUE_GAP = 10;

/**
 * How many days of the partial month have happened, in the tenant's own clock.
 *
 * The composition carries its timezone and the instant it was read at, so the day number is a
 * reading rather than a guess about the reader's browser. A month boundary is exactly where a
 * server clock and a viewer clock disagree, and this sentence is about the month.
 */
function daysSoFar(composition: CoachLeadComposition): number | null {
  const asOf = new Date(composition.asOf);
  if (Number.isNaN(asOf.getTime())) return null;
  try {
    const day = new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      timeZone: composition.timezone,
    }).format(asOf);
    const parsed = Number(day);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const AXIS_SIZE = 16;
const VALUE_SIZE = 15;

/** The desk chart. One box, because the phone is served by `NarrowBars` rather than this. */
function Bars({ months }: { months: CoachLeadComposition["months"] }) {
  const peak = Math.max(1, ...months.map((month) => month.total));
  const slot = CHART_WIDTH / months.length;
  const barWidth = slot * 0.72;

  return (
    <svg
      aria-label="Leads by month, the last six months"
      className="block h-auto w-full"
      role="img"
      viewBox={`0 0 ${CHART_WIDTH} ${VIEW_HEIGHT}`}
    >
      <line
        stroke="var(--line)"
        strokeWidth="1"
        x1="0"
        x2={CHART_WIDTH}
        y1={BASELINE_Y}
        y2={BASELINE_Y}
      />
      {months.map((month, index) => {
        const height = Math.max(4, (month.total / peak) * (BASELINE_Y - BAR_TOP_MIN));
        const x = slot * index + (slot - barWidth) / 2;
        const top = BASELINE_Y - height;
        return (
          <g key={month.month}>
            <rect
              data-slot={month.partial ? "month-bar-partial" : "month-bar"}
              fill="var(--accent)"
              fillOpacity={month.partial ? 1 : PAST_BAR_OPACITY}
              height={height}
              rx="4"
              width={barWidth}
              x={x}
              y={top}
            />
            <text
              className="tabular-nums"
              fill="var(--ink)"
              fontFamily="var(--font-mono)"
              fontSize={VALUE_SIZE}
              fontWeight="500"
              textAnchor="middle"
              x={x + barWidth / 2}
              y={top - VALUE_GAP}
            >
              {workspaceCountFormat.format(month.total)}
              {month.partial ? (
                <tspan fill="var(--muted)" fontFamily="var(--font-sans)" fontWeight="450">
                  {" so far"}
                </tspan>
              ) : null}
            </text>
            <text
              fill="var(--muted)"
              fontSize={AXIS_SIZE}
              textAnchor="middle"
              x={x + barWidth / 2}
              y={AXIS_Y}
            >
              {month.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The same six readings on a phone, as rows rather than columns.
 *
 * Six vertical bars across 330px gives each month about 40px of width and puts its label under a
 * bar narrower than the label, so the months turn sideways or collide. Rows turn the long axis into
 * the one the phone actually has: the month name and the count are ordinary text at the sizes they
 * are written at, and the bar is a plain box whose width is the reading. Nothing here is inside a
 * scaled coordinate system, so nothing can render under the floor.
 *
 * The partial month keeps the two marks the desk chart gives it, the solid fill and the words
 * beside its figure, for the same reason: a month still filling reads as a collapse otherwise.
 */
function NarrowBars({ months }: { months: CoachLeadComposition["months"] }) {
  const peak = Math.max(1, ...months.map((month) => month.total));

  return (
    /*
     * One grid for the whole list rather than one per row, with each row set to `contents`, so the
     * month names, the bar track and the counts each line up down their own column. Six independent
     * grids would size their columns to their own row and leave the counts in a ragged edge, which
     * is the readability the bars are here for in the first place.
     */
    <ul
      aria-hidden
      className="m-0 grid list-none grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5 p-0"
    >
      {months.map((month) => (
        <li className="contents" key={month.month}>
          <span className="text-[15px] whitespace-nowrap text-[color:var(--muted)]">
            {month.label}
          </span>
          {/* The track is the full column and the bar is a share of it, so the count beside it
              keeps its own column and the longest bar cannot push a reading off the screen. */}
          <span className="block h-6 min-w-0">
            <span
              className="block h-full rounded-[5px] bg-[var(--accent)]"
              data-slot={month.partial ? "month-bar-partial" : "month-bar"}
              style={{
                opacity: month.partial ? 1 : PAST_BAR_OPACITY,
                // Floored, so a real reading of zero still shows a mark rather than reading as a
                // row that failed to draw.
                width: `${Math.max(3, (month.total / peak) * 100)}%`,
              }}
            />
          </span>
          <span className="whitespace-nowrap">
            <span className="font-mono text-[15px] tabular-nums text-[color:var(--ink)]">
              {workspaceCountFormat.format(month.total)}
            </span>
            {month.partial ? (
              <span className="text-[14px] text-[color:var(--muted)]">{" so far"}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export type CoachHomeMonthsProps = {
  composition: CoachLeadComposition;
};

export function CoachHomeMonths({ composition }: CoachHomeMonthsProps) {
  const months = composition.months;
  const partial = months.find((month) => month.partial);
  const days = partial ? daysSoFar(composition) : null;

  const download = (
    <ExportMenu
      filename="setterfi-coach-leads-by-month"
      mode="server"
      resource="coach-lead-composition"
    />
  );

  if (months.length < MONTHS_MINIMUM) {
    return (
      <Surface
        aria-labelledby="home-months-heading"
        className="flex min-w-0 flex-col"
        variant="panel"
      >
        <SurfaceHeader
          overline="Six months"
          scale="coach-data"
          title="Leads by month"
          titleAs="h2"
          titleId="home-months-heading"
          trailing={download}
        />
        <div className="px-[26px] py-6">
          <p className="text-[16px] leading-[1.5] text-[color:var(--muted)]">
            Six months of history are needed before the bars can be drawn. You have{" "}
            {workspaceCountFormat.format(months.length)} so far.
          </p>
        </div>
      </Surface>
    );
  }

  return (
    <Surface
      aria-labelledby="home-months-heading"
      className="flex min-w-0 flex-col"
      variant="panel"
    >
      <SurfaceHeader
        overline="Six months"
        scale="coach-data"
        title="Leads by month"
        titleAs="h2"
        titleId="home-months-heading"
        trailing={download}
      />
      <div className="px-[26px] pt-7 pb-5">
        <div className="sm:hidden">
          <NarrowBars months={months} />
        </div>
        <div className="hidden sm:block">
          <Bars months={months} />
        </div>
        {partial ? (
          <p className="mt-3 text-[16px] leading-[1.5] text-[color:var(--muted)]">
            {partial.label} has{" "}
            {days === null
              ? "not finished yet, so its bar is still filling."
              : `${workspaceCountFormat.format(days)} ${days === 1 ? "day" : "days"} in it so far.`}
          </p>
        ) : null}
        <table className="sr-only">
          <caption>Leads by month, the last six months</caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col">New leads</th>
            </tr>
          </thead>
          <tbody>
            {months.map((month) => (
              <tr key={month.month}>
                <th scope="row">{month.label}</th>
                <td>
                  {workspaceCountFormat.format(month.total)}
                  {month.partial ? " so far" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Surface>
  );
}
