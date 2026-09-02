import { Circle, CircleAlert, CircleCheck, Clock, Info } from "@/components/kit/icons";
import type { KitIcon } from "@/components/kit/icons";


import { cn } from "@/lib/utils";
import type { StateTone } from "@/lib/copy/states";

export type { StateTone } from "@/lib/copy/states";

export type StateBadgeSize = "sm" | "md";

export type StateBadgeProps = {
  /**
   * `lifecycle` and `verdict` are washed pills, `tag` is an outlined chip, and `none` is not a
   * badge at all -- muted text with no pill, for the cells that say a thing has not happened
   * ("No request", "No scheduled change", "Not run"). An absence in a pill reads as a state the
   * reader has to weigh against the real ones, and a table full of them is a table of nothing.
   */
  kind?: "lifecycle" | "verdict" | "tag" | "none";
  tone: StateTone;
  label: string;
  icon?: KitIcon;
  detail?: string;
  size?: StateBadgeSize;
  /** Lifecycle pills carry a dot by default. Pass `false` for label-only. */
  dot?: boolean;
  className?: string;
};

/** Same split as the pills below: a state's dot is clay and periwinkle, not the destructive red. */
const INDICATOR_TONE_CLASSES = {
  neutral: "text-[var(--neutral)]",
  good: "text-[var(--good)]",
  warning: "text-[var(--warning)]",
  critical: "text-[var(--failure)]",
  info: "text-[var(--waiting)]",
} as const satisfies Record<StateTone, string>;

/**
 * Tone is a claim about the state, not decoration. `info` is reserved for a state that is
 * genuinely in progress and informational; it is close enough to the accent that a row full of
 * `info` pills reads as selected, so a state that means "nothing yet", "closed", or "not
 * applicable" is `neutral`, and an absence is `kind="none"` rather than any tone at all.
 */
// A pill is a wash plus its semantic text colour. The wash carries the state at a glance and the
// text stays readable on it, so a status never reduces to a bare dot the reader has to decode.
/*
 * `critical` and `info` deliberately do NOT use `--critical-*` / `--info-*` here.
 *
 * Those are the pre-redesign palette: `--critical` is oklch(0.74 0.14 25), a saturated red, and
 * `--info` is hue 230, a cyan-blue. The redesign brief replaced both for *states* with the muted
 * clay (#C98679, `--failure-*`) and periwinkle (#8FA0D8, `--waiting-*`) the kit already uses. Until
 * this pointed at them, a past-due state rendered saturated red on the 21 screens using StateBadge
 * and muted clay on the 8 using the kit's Status -- the same state in two colours.
 *
 * `--critical` and `--info` themselves are untouched and still correct for what they are used for:
 * `--color-destructive`, chart series, the agent trace, and inline error alerts. The kit's ruling
 * separates those from states explicitly: `critical` splits three ways, so a state becomes
 * `failure`, inline error text takes a text token and never becomes a `Status`, and a destructive
 * affordance is a button variant. This is only the state arm of that split, which is why it
 * changes here rather than in tokens.css.
 */
const PILL_TONE_CLASSES = {
  neutral: "bg-[var(--neutral-wash)] text-[color:var(--body)]",
  good: "bg-[var(--good-wash)] text-[color:var(--good-text)]",
  warning: "bg-[var(--warning-wash)] text-[color:var(--warning-text)]",
  critical: "bg-[var(--failure-wash)] text-[color:var(--failure-text)]",
  info: "bg-[var(--waiting-wash)] text-[color:var(--waiting-text)]",
} as const satisfies Record<StateTone, string>;

const VERDICT_ICONS = {
  neutral: Circle,
  good: CircleCheck,
  warning: Clock,
  critical: CircleAlert,
  info: Info,
} as const satisfies Record<StateTone, KitIcon>;

const SIZE_CLASSES = {
  sm: "min-h-[var(--s-5)] gap-[var(--s-1)] px-[var(--s-2)] text-[length:var(--t-badge)] leading-[var(--t-badge-lh)] tracking-[var(--t-badge-tr)]",
  md: "min-h-[var(--s-6)] gap-[var(--s-2)] px-[var(--s-2)] text-[length:var(--t-body)] leading-[var(--t-body-lh)] tracking-[var(--t-body-tr)]",
} as const satisfies Record<StateBadgeSize, string>;

export function StateBadge({
  className,
  detail,
  dot,
  icon,
  kind = "lifecycle",
  label,
  size = "md",
  tone,
}: StateBadgeProps) {
  if (kind === "none") {
    return (
      <span
        className={cn(
          "inline-flex items-center whitespace-nowrap text-[length:var(--t-body)] text-[color:var(--faint)]",
          className,
        )}
        data-kind="none"
        data-slot="state-badge"
        data-tone={tone}
      >
        {label}
        {detail ? <span className="ml-[var(--s-1)]">{detail}</span> : null}
      </span>
    );
  }

  const showDot = dot ?? (icon === undefined && kind !== "verdict");
  const Indicator = icon ?? (kind === "verdict" ? VERDICT_ICONS[tone] : showDot ? Circle : null);
  const isDot = Indicator === Circle && showDot && icon === undefined && kind !== "verdict";

  return (
    <span
      className={cn(
        "state-badge inline-flex items-center rounded-[var(--r-input)] font-medium whitespace-nowrap normal-case",
        SIZE_CLASSES[size],
        kind === "lifecycle" && cn("state-badge--lifecycle", PILL_TONE_CLASSES[tone]),
        kind === "verdict" && cn("state-badge--verdict", PILL_TONE_CLASSES[tone]),
        kind === "tag" &&
          "state-badge--tag border border-[var(--line)] bg-transparent text-[color:var(--body)]",
        className,
      )}
      data-kind={kind}
      data-slot="state-badge"
      data-tone={tone}
    >
      {Indicator ? (
        <Indicator
          aria-hidden="true"
          className={cn(
            "state-badge__indicator shrink-0",
            isDot ? "size-[var(--distance-small)]" : "size-[var(--s-3)]",
            kind === "tag" && INDICATOR_TONE_CLASSES[tone],
            isDot && "fill-current",
          )}
        />
      ) : null}
      <span className="inline-flex items-baseline gap-[var(--s-1)]">
        <span className="state-badge__label">{label}</span>
        {detail ? (
          <span className="font-normal text-[var(--muted)]">{detail}</span>
        ) : null}
      </span>
    </span>
  );
}
