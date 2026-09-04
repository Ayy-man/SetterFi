import { Surface, SurfaceHeader } from "@/components/kit/atomics/surface";
import { ExportMenu } from "@/components/kit/export-menu";
import { workspaceCountFormat } from "@/lib/format/datetime";
import { formatMetric } from "@/lib/format/metric";
import {
  KEYWORD_RATE_MINIMUM,
  NO_KEYWORD_ROW,
} from "@/components/workspace/rehaul/coach-home-figures";
import type { CoachMeasurement, CoachMeasurementWindow } from "@/lib/repositories/analytics";

/**
 * Which keyword brings the best leads, as `Main.dc.html:298` draws it.
 *
 * **Every rate carries its denominator on the row.** "60 of 86 leads" beside a 15 percent booked
 * rate is what lets a coach see that the best-converting keyword is also the one four people used,
 * and it is the single change that makes this table honest rather than suggestive. The four-stage
 * funnel sparkline the previous build drew is gone with it: a bar strip in a 100px cell was the
 * shape of the row's own numbers with none of their magnitudes, printed beside the numbers.
 *
 * **Rates are suppressed under ten senders, in words.** `docs/plans/2026-09-04-coach-backend-gaps.md`
 * flags this as a presentation-layer rule off `row.conversations`, which is the exact denominator
 * the repository already returns, and says to apply it here rather than mint a second source of
 * truth for it. A row under the floor prints the reason and its own count in the cells the rates
 * would have taken, so the row is still countable and no percentage is drawn off four people.
 *
 * **The "No keyword" row is a real row.** `read_coach_measurement` groups the leads who sent
 * nothing under that name and sorts it last, and it covers a population the other rows do not, so
 * its denominator says which population that is.
 */

/** The window's name inside the footer sentence, so a fixed "this month" cannot be five-sixths wrong. */
const WINDOW_PHRASE: Record<CoachMeasurementWindow, string> = {
  "1d": "in the last day",
  "1m": "in the last month",
  "1w": "in the last week",
  "3m": "in the last three months",
  all: "since you started",
  custom: "in the range you picked",
};

const HEAD_CLASS = "px-[26px] py-3.5 text-[15px] font-semibold whitespace-nowrap text-[color:var(--muted)]";
const NAME_CELL = "h-16 px-[26px] text-[17px] font-medium text-[color:var(--ink)]";
const RATE_CELL = "px-[26px] text-right font-mono text-[17px] tabular-nums text-[color:var(--ink)]";

function rate(part: number, whole: number) {
  return formatMetric((part * 100) / whole, "percent");
}

export type CoachHomeKeywordsProps = {
  customFrom?: string | null;
  customTo?: string | null;
  keywords: CoachMeasurement["keywords"];
  window: CoachMeasurementWindow;
};

export function CoachHomeKeywords({
  customFrom,
  customTo,
  keywords,
  window,
}: CoachHomeKeywordsProps) {
  /*
   * Ordered by qualified leads, with the "No keyword" row pinned last. The RPC already sorts it
   * there; sorting here would float it up the moment its population is the largest, which it
   * usually is, and the row that means "no keyword at all" reading as the best keyword is the one
   * misreading this table cannot afford.
   */
  const rows = [...keywords].sort((left, right) => {
    if (left.keyword === NO_KEYWORD_ROW) return 1;
    if (right.keyword === NO_KEYWORD_ROW) return -1;
    return right.qualifiedContacts - left.qualifiedContacts;
  });

  return (
    <Surface
      aria-labelledby="home-keywords-heading"
      className="flex min-w-0 flex-col"
      variant="panel"
    >
      <SurfaceHeader
        overline="Where your leads come from"
        scale="coach-data"
        title="Which keyword brings the best leads"
        titleAs="h2"
        titleId="home-keywords-heading"
        trailing={
          <ExportMenu
            filename="setterfi-coach-measurement-keywords"
            mode="server"
            query={{
              window,
              ...(window === "custom" && customFrom && customTo
                ? { from: customFrom, to: customTo }
                : {}),
            }}
            resource="coach-measurement-keywords"
          />
        }
      />

      {rows.length === 0 ? (
        <p className="px-[26px] py-6 text-[16px] text-[color:var(--muted)]">
          No lead has sent a keyword in this window yet.
        </p>
      ) : (
        <>
          <div className="w-full overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-[var(--band)]">
                  <th className={`${HEAD_CLASS} text-left`} scope="col">Keyword</th>
                  <th className={`${HEAD_CLASS} text-right`} scope="col">Qualified leads</th>
                  <th className={`${HEAD_CLASS} text-right`} scope="col">Response rate</th>
                  <th className={`${HEAD_CLASS} text-right`} scope="col">Booked rate</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const thin = row.conversations < KEYWORD_RATE_MINIMUM;
                  const senders = workspaceCountFormat.format(row.conversations);
                  return (
                    <tr className="border-t border-[var(--line-soft)]" key={row.keyword}>
                      <th className={`${NAME_CELL} text-left`} scope="row">{row.keyword}</th>
                      {thin ? (
                        /*
                          The absence, in the place the three readings would have been. It carries
                          the row's own count so the row is still a fact rather than a blank: four
                          senders is the reason there is no rate, and it is also the reading.
                        */
                        <td
                          className="px-[26px] text-[16px] text-[color:var(--muted)]"
                          colSpan={3}
                          data-slot="keyword-thin"
                        >
                          Rates show after {KEYWORD_RATE_MINIMUM} leads have sent it.{" "}
                          {senders} {row.conversations === 1 ? "lead" : "leads"} so far.
                        </td>
                      ) : (
                        <>
                          <td className="px-[26px] text-right whitespace-nowrap">
                            <span className="font-mono text-[17px] tabular-nums text-[color:var(--ink)]">
                              {workspaceCountFormat.format(row.qualifiedContacts)}
                            </span>{" "}
                            <span className="text-[14px] text-[color:var(--muted)]">
                              {row.keyword === NO_KEYWORD_ROW
                                ? `of ${senders} leads who sent none`
                                : `of ${senders} leads`}
                            </span>
                          </td>
                          <td className={RATE_CELL}>
                            {rate(row.respondedConversations, row.conversations)}
                          </td>
                          <td className={RATE_CELL}>
                            {rate(row.bookedContacts, row.conversations)}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap justify-between gap-6 border-t border-[var(--line-soft)] px-[26px] py-3.5 text-[14px] text-[color:var(--muted)]">
            <span>
              Rates are out of the leads who sent each keyword {WINDOW_PHRASE[window]}.
            </span>
            <span>Ordered by qualified leads.</span>
          </div>
        </>
      )}
    </Surface>
  );
}
