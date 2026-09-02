"use client";

import { FieldShell, Prose } from "@/components/kit/atomics";

import { EditorRegion } from "./offer-editor-chrome";

/**
 * Screen 3d, inline: when you take calls.
 *
 * The artifact draws this as an editor: drag on the grid, type the hours per day, add a day off.
 * SetterFi stores none of that. A coach's weekly hours, their exceptions and the gap between
 * calls live in the calendar they connected, and reach us only as the free slots that calendar
 * hands back per request. `calendar_connections` holds the three values below and nothing else.
 *
 * So this is the artifact's geometry telling the truth: the same week, the same by-day column,
 * the same figure line, rendered from what the calendar says and pointing at the calendar for the
 * change. A drag target that quietly discarded the drag would be worse than no drag target, and
 * "leads only ever see these slots" has to stay literally true or the screen is lying about the
 * one thing it exists to state.
 */

export type DayAvailability = {
  /** "Mon". The grid's column head takes its first letter. */
  label: string;
  open: boolean;
  /** Minutes from midnight, in the calendar's own timezone. Null whenever the day is closed. */
  startMinutes: number | null;
  endMinutes: number | null;
};

export type AvailabilityException = {
  id: string;
  /** "Sep 8 – Sep 12" */
  when: string;
  /** "no calls" */
  detail: string;
};

export type CalendarBookingSettings = {
  calendarName: string | null;
  minNoticeMinutes: number;
  slotDurationMinutes: number;
  timezone: string;
};

const DEFAULT_WINDOW = { end: 18, start: 8 };

function hourLabel(hour: number) {
  if (hour === 0) return "12am";
  if (hour === 12) return "12pm";
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

function clockLabel(minutes: number | null) {
  if (minutes === null) return null;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour < 12 ? "am" : "pm";
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  return `${shown}:${String(minute).padStart(2, "0")}${suffix}`;
}

function noticeLabel(minutes: number) {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.round(hours / 24)} days`;
}

/** The window the grid draws, widened to hold every open day rather than fixed at office hours. */
function gridWindow(week: readonly DayAvailability[]) {
  const open = week.filter((day) => day.open && day.startMinutes !== null && day.endMinutes !== null);
  if (!open.length) return DEFAULT_WINDOW;
  const start = Math.min(...open.map((day) => Math.floor((day.startMinutes ?? 0) / 60)));
  const end = Math.max(...open.map((day) => Math.ceil((day.endMinutes ?? 0) / 60)));
  return { end: Math.min(24, end + 1), start: Math.max(0, start - 1) };
}

/** Bookable slots a week, from the hours the calendar reports and the slot length it books at. */
export function weeklySlotCount(
  week: readonly DayAvailability[],
  slotDurationMinutes: number,
): number {
  if (slotDurationMinutes < 1) return 0;
  return week.reduce((total, day) => {
    if (!day.open || day.startMinutes === null || day.endMinutes === null) return total;
    const span = day.endMinutes - day.startMinutes;
    return span > 0 ? total + Math.floor(span / slotDurationMinutes) : total;
  }, 0);
}

export type AvailabilityPanelProps = {
  /** Null while no calendar is connected: the dialog then has nothing to report and says so. */
  calendar: CalendarBookingSettings | null;
  /** Where a coach changes any of this. Null hides the verb rather than linking nowhere. */
  calendarHref: string | null;
  exceptions: readonly AvailabilityException[];
  week: readonly DayAvailability[];
};

export function AvailabilityPanel({
  calendar,
  calendarHref,
  exceptions,
  week,
}: AvailabilityPanelProps) {
  const { end, start } = gridWindow(week);
  const hours = Array.from({ length: Math.max(end - start, 1) }, (_, offset) => start + offset);
  const slots = calendar ? weeklySlotCount(week, calendar.slotDurationMinutes) : 0;

  return (
    <EditorRegion
      aside={
        <span className="text-[11.5px] leading-[1.45] text-[color:var(--meta)]">
          Read from the calendar you connected. Leads only ever see these slots.
        </span>
      }
      label="When you take calls"
    >
      <div className="@container/hours rounded-[var(--r-well)] border border-[var(--line)]">
        <div className="grid grid-cols-1 @3xl/hours:grid-cols-[342px_minmax(0,1fr)]">
          <div className="border-b border-[var(--line)] px-[18px] py-[16px] @3xl/hours:border-r @3xl/hours:border-b-0">
            {/*
              The gap is on a wrapper rather than on this column, because the column also holds the
              Exceptions block below and a gap there would space that too. `.coach-eyebrow` sets
              `margin: 0` and ten of its thirteen callers sit in a gapped flex or grid parent, so
              the recipe is right and these three were the outliers -- they reached for `mb-[8px]`,
              `mb-[4px]` and `mb-[7px]`, all three of which the recipe silently discarded, which is
              why nothing on screen ever had the gap they were asking for.
            */}
            <div className="flex min-w-0 flex-col gap-[var(--s-2)]">
              <span className="coach-eyebrow">By day</span>
              <ul className="flex list-none flex-col p-0">
                {week.map((day) => {
                  const from = clockLabel(day.startMinutes);
                  const to = clockLabel(day.endMinutes);
                  return (
                    <li
                      className="flex items-center gap-[9px] border-b border-[var(--line-soft)] py-[8px] last:border-b-0"
                      data-open={day.open ? "true" : "false"}
                      key={day.label}
                    >
                      <span
                        aria-hidden
                        className={`h-[8px] w-[8px] shrink-0 rounded-full ${
                          day.open ? "bg-[var(--accent)]" : "bg-[var(--line-input)]"
                        }`}
                      />
                      <span
                        className={`w-[34px] shrink-0 text-[12.5px] leading-none ${
                          day.open
                            ? "font-medium text-[color:var(--ink)]"
                            : "text-[color:var(--faint)]"
                        }`}
                      >
                        {day.label}
                      </span>
                      {day.open && from && to ? (
                        <span className="font-[family-name:var(--font-mono)] text-[11.5px] leading-none text-[color:var(--body)]">
                          {from} – {to}
                        </span>
                      ) : (
                        <span className="text-[12.5px] leading-none text-[color:var(--dim)]">
                          unavailable
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="mt-[13px] flex min-w-0 flex-col gap-[var(--s-2)]">
              <span className="coach-eyebrow">Exceptions</span>
              <p className="m-0 text-[12px] leading-[1.5] text-[color:var(--faint)]">
                Days that break the pattern: a trip, a launch week.
              </p>
              {exceptions.length ? (
                <ul className="flex list-none flex-col gap-[7px] p-0">
                  {exceptions.map((exception) => (
                    <li
                      className="flex items-center gap-[8px] rounded-[9px] border border-[var(--line)] bg-[rgba(255,255,255,0.03)] px-[10px] py-[8px]"
                      key={exception.id}
                    >
                      <span className="font-[family-name:var(--font-mono)] text-[12px] leading-none text-[color:var(--body)]">
                        {exception.when}
                      </span>
                      <span className="text-[12px] leading-none text-[color:var(--faint)]">
                        {exception.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] leading-[1.5] text-[color:var(--dim)]">
                  None this week. A day off you block in your calendar disappears from the grid
                  here within the hour.
                </p>
              )}
            </div>

            {calendar ? (
              <p className="mt-[13px] rounded-[10px] border border-[var(--accent-edge)] bg-[var(--accent-wash)] px-[12px] py-[11px] text-[12px] leading-[1.5] text-[color:var(--faint)]">
                That is{" "}
                <strong className="font-[family-name:var(--font-mono)] font-semibold text-[color:var(--accent-text)]">
                  {slots} slots
                </strong>{" "}
                a week at {calendar.slotDurationMinutes} minutes each.
              </p>
            ) : null}
          </div>

          <div className="px-[18px] py-[16px]">
            <div className="mb-[11px] flex flex-wrap items-center gap-[10px]">
              <span className="coach-eyebrow block">The week</span>
              <span className="ml-auto inline-flex items-center gap-[7px] text-[11.5px] leading-none text-[color:var(--faint)]">
                <span
                  aria-hidden
                  className="size-[11px] rounded-[3px] border border-[var(--accent-edge)] bg-[var(--slot-on)]"
                />
                bookable
              </span>
              <span className="inline-flex items-center gap-[7px] text-[11.5px] leading-none text-[color:var(--faint)]">
                <span
                  aria-hidden
                  className="size-[11px] rounded-[3px] border border-[var(--line-soft)] bg-[rgba(255,255,255,0.04)]"
                />
                closed
              </span>
            </div>

            {week.length ? (
              <table className="w-full border-separate border-spacing-[5px_3px]">
                <caption className="sr-only">
                  Bookable hours by day, read from your connected calendar
                </caption>
                <thead>
                  <tr>
                    <th className="w-[46px]" scope="col">
                      <span className="sr-only">Hour</span>
                    </th>
                    {week.map((day) => (
                      <th
                        className={`text-center font-[family-name:var(--font-mono)] text-[10.5px] leading-none ${
                          day.open
                            ? "font-medium text-[color:var(--faint)]"
                            : "font-normal text-[color:var(--dim)]"
                        }`}
                        key={day.label}
                        scope="col"
                      >
                        <abbr title={day.label}>{day.label.slice(0, 1)}</abbr>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {hours.map((hour) => (
                    <tr key={hour}>
                      <th
                        className="w-[46px] text-right font-[family-name:var(--font-mono)] text-[10px] leading-none font-normal text-[color:var(--dim)]"
                        scope="row"
                      >
                        {hourLabel(hour)}
                      </th>
                      {week.map((day) => {
                        const minutes = hour * 60;
                        const bookable =
                          day.open &&
                          day.startMinutes !== null &&
                          day.endMinutes !== null &&
                          minutes >= day.startMinutes &&
                          minutes < day.endMinutes;
                        const first = bookable && minutes === day.startMinutes;
                        const last =
                          bookable && day.endMinutes !== null && minutes + 60 >= day.endMinutes;
                        return (
                          <td
                            className={`h-[26px] border ${
                              bookable
                                ? "border-[var(--accent-edge)] bg-[var(--slot-on)]"
                                : "border-[var(--line-soft)] bg-[rgba(255,255,255,0.035)]"
                            } ${first ? "rounded-t-[7px]" : ""} ${last ? "rounded-b-[7px]" : ""}`}
                            key={`${day.label}-${hour}`}
                          >
                            <span className="sr-only">
                              {day.label} {hourLabel(hour)} {bookable ? "bookable" : "closed"}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="rounded-[12px] border border-[var(--line)] bg-[var(--well)] p-[14px]">
                <h3 className="text-[13px] leading-[1.35] font-semibold text-[color:var(--ink)]">
                  No calendar is connected yet
                </h3>
                <Prose className="mt-[4px] text-[12.5px] leading-[1.5] text-[color:var(--faint)]">
                  Your setter cannot offer a time until a calendar tells it which ones are free, so
                  until then it qualifies the lead and hands the booking back to you.
                </Prose>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-[12px] border-t border-[var(--line)] bg-[rgba(255,255,255,0.015)] px-[19px] py-[15px]">
          <FooterFact
            label="Call length"
            value={calendar ? `${calendar.slotDurationMinutes} minutes` : "not connected"}
          />
          <FooterFact
            label="Shortest notice"
            value={calendar ? noticeLabel(calendar.minNoticeMinutes) : "not connected"}
          />
          <FooterFact label="Timezone" value={calendar?.timezone ?? "not connected"} />
          <FooterFact label="Calendar" value={calendar?.calendarName ?? "not connected"} />
        </div>

        <p className="flex flex-wrap items-center gap-[9px] border-t border-[var(--line-soft)] px-[19px] py-[13px] text-[12px] leading-[1.5] text-[color:var(--faint)]">
          <span>
            These hours are your calendar&rsquo;s, not a second copy we keep. Change them where you
            keep them and your setter follows within the hour.
          </span>
          {calendarHref ? (
            <a
              className="link-inline text-[12.5px]"
              href={calendarHref}
            >
              Open your calendar settings
            </a>
          ) : null}
        </p>
      </div>
    </EditorRegion>
  );
}

function FooterFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-[min(100%,150px)] flex-1 flex-col gap-[var(--s-1)]">
      <span className="coach-eyebrow">{label}</span>
      <FieldShell className="text-[13px] leading-none text-[color:var(--body)]">{value}</FieldShell>
    </div>
  );
}
