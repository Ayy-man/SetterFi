/**
 * The one meter.
 *
 * Three surfaces draw the same bar over the same kind of reading -- the billing page's allowance
 * well, the deck's Booked footer, the agent page's objection rows -- and each had grown its own
 * copy of the geometry and its own opinion about clamping. A share is a thing that can be greater
 * than one (a coach past their allowance) or undefined (an allowance of zero), and a bar drawn by
 * a caller that forgot the first case overflows its track while a caller that forgot the second
 * paints a full bar over a limit that does not exist. Clamping belongs here; deciding whether
 * there is a share at all belongs to the caller, which is why `value` is a number and the absent
 * case is the caller not rendering this.
 *
 * Always `aria-hidden`. Every use sits directly beside the same ratio in words, so the bar carries
 * no information a reader without it has lost -- what it adds is how close to the edge this is,
 * which is the one thing a ratio in text is bad at.
 */
export function Meter({
  className,
  tone = "accent",
  value,
}: {
  className?: string;
  /**
   * `accent` paints the accent on a neutral track, which is the plain-panel case. `current` takes
   * the panel's own text colour for both, which is what lets the same bar sit on a drenched deck
   * panel without asking the caller which ground it is on.
   */
  tone?: "accent" | "current";
  /** A share, 0 to 1. Anything outside that is clamped rather than drawn. */
  value: number;
}) {
  return (
    <span
      aria-hidden
      className={`block h-[8px] overflow-hidden rounded-[var(--r-full)] ${
        tone === "current" ? "bg-current/20" : "bg-[rgba(120,150,200,0.14)]"
      }${className ? ` ${className}` : ""}`}
      data-slot="meter"
    >
      <span
        className={`block h-full rounded-[var(--r-full)] ${
          tone === "current" ? "bg-current" : "bg-[var(--accent)]"
        }`}
        style={{ width: `${Math.round(Math.min(Math.max(value, 0), 1) * 100)}%` }}
      />
    </span>
  );
}
