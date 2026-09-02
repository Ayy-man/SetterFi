import { WORKSPACE_DISPLAY_TIMEZONE } from "@/lib/format/datetime"

export type DayCounterProps = {
  since: string
  typicalDays: readonly [number, number]
  now?: Date
}

const workspaceDayParts = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "numeric",
  timeZone: WORKSPACE_DISPLAY_TIMEZONE,
  year: "numeric",
})

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
// Any number of fractional digits. Postgres serialises timestamptz with six, so the old
// {1,3} bound rejected every value that came straight from the database and the counter threw
// where a wait was actually in progress.
const ZONED_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i

/**
 * An unreadable start time is an absence, not a crash. It is still a bug -- something handed the
 * counter a shape it does not accept -- so development says so out loud while the screen quietly
 * shows no day count rather than taking the page down with it.
 */
function unreadable(value: string, reason: string): null {
  if (process.env.NODE_ENV !== "production") {
    console.warn(`DayCounter could not read "${value}": ${reason}`)
  }
  return null
}

function civilDayNumber(date: Date) {
  const parts = workspaceDayParts.formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value)

  return Date.UTC(value("year"), value("month") - 1, value("day")) / 86_400_000
}

function startDayNumber(value: string): number | null {
  const dateOnly = DATE_ONLY.exec(value)

  if (dateOnly) {
    const [, year, month, day] = dateOnly
    const instant = Date.UTC(Number(year), Number(month) - 1, Number(day))
    const normalized = new Date(instant)

    if (
      normalized.getUTCFullYear() !== Number(year) ||
      normalized.getUTCMonth() !== Number(month) - 1 ||
      normalized.getUTCDate() !== Number(day)
    ) {
      return unreadable(value, "the date does not exist")
    }

    return instant / 86_400_000
  }

  if (!ZONED_DATE_TIME.test(value)) {
    return unreadable(value, "a start time must carry a timezone")
  }

  const start = new Date(value)

  if (Number.isNaN(start.getTime())) {
    return unreadable(value, "the timestamp did not parse")
  }

  return civilDayNumber(start)
}

const submittedFormat = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: WORKSPACE_DISPLAY_TIMEZONE,
})

function submittedLabel(value: string) {
  const dateOnly = DATE_ONLY.exec(value)
  if (dateOnly) {
    const [, year, month, day] = dateOnly
    // Date-only starts are civil dates already; format them without timezone shifting.
    return new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", timeZone: "UTC" })
      .format(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))))
  }
  return submittedFormat.format(new Date(value))
}

/**
 * Whole days elapsed in the workspace timezone, or null when the start time cannot be read.
 *
 * Null rather than a throw or a zero: "day 0" would claim the wait started today, which is exactly
 * the kind of confident wrong number the honest-state rule exists to prevent.
 */
export function elapsedWorkspaceDays(since: string, now = new Date()): number | null {
  const start = startDayNumber(since)
  if (start === null) return null
  return Math.max(0, civilDayNumber(now) - start)
}

export function DayCounter({ since, typicalDays, now }: DayCounterProps) {
  const day = elapsedWorkspaceDays(since, now)
  const [typicalStart, typicalEnd] = typicalDays

  if (day === null) {
    return (
      <p className="daycount flex flex-wrap items-baseline gap-x-[var(--s-1)] text-body font-medium text-[var(--body)]">
        <strong className="text-row font-semibold text-[var(--ink)]">Still waiting</strong>
        {" "}
        <span className="of font-normal text-[var(--muted)]">
          &middot; the submission date was not recorded, so no day count is shown &middot; typical{" "}
          {typicalStart} to {typicalEnd} days
        </span>
      </p>
    )
  }

  return (
    <p className="daycount flex flex-wrap items-baseline gap-x-[var(--s-1)] text-body font-medium text-[var(--body)]">
      {/* Mono, not Archivo. A day count is a figure, and the Mono Licence rule in docs/DESIGN.md
          puts every figure on the mono face -- this readout sits in the same well as mono
          timestamps and mono counts on five surfaces, and in Archivo it was the one number in the
          well that did not line up with them. The size stays at --t-row so nothing reflows. */}
      <strong className="mono text-row font-semibold text-[var(--ink)]">Day {day}</strong>
      {" "}
      <span className="of font-normal text-[var(--muted)]">
        &middot; submitted {submittedLabel(since)} &middot; typical {typicalStart} to {typicalEnd} days
      </span>
      {" "}
      <span className="of font-normal text-[var(--muted)]">&middot; no action needed from you</span>
    </p>
  )
}
