import type { ReactNode } from "react";

import { IconTile } from "@/components/kit/atomics/icon-tile";
import { TONE_LINE, TONE_MARK, TONE_TEXT, type Tone } from "@/components/kit/atomics/tone";
import { cn } from "@/lib/utils";

export type SettingRowProps = {
  /** The name of the decision. Never a verb: the row is a setting, the control is the verb. */
  title: ReactNode;
  /**
   * One sentence saying what the setting does and, where it matters, why the default is what it
   * is: "A short pause reads human. Instant replies get flagged as bots."
   *
   * It is required. The row kit exists because the console this is modelled on puts an
   * explanation on every row, and a settings page whose rows are bare labels is the stack of
   * equal-weight blocks the redesign is replacing.
   */
  description: ReactNode;
  icon?: ReactNode;
  /**
   * The tile's own tone, when it is saying something the row's tone is not.
   *
   * A toned row already tints its tile, and an untoned row's tile is `accent` because most rows
   * lead something the platform runs. Notification settings needs the third case: the tile is the
   * only mark saying "you moved this off our default", so a row the coach has not touched has to
   * be able to render a neutral tile. Without this, adopting the row kit would have put a
   * decorative teal square on every row, which is the exact thing the Ownership Rule forbids.
   */
  iconTone?: Tone;
  /**
   * The control, or the value. Most rows in a done-for-you product state what SetterFi already
   * chose rather than offering a control, and a stated value is a `<span>`, never a disabled
   * input -- a disabled toggle reads as broken, a settled decision reads as decided.
   */
  control?: ReactNode;
  /**
   * `failure` is 3b's "Needs a value": a clay tint across the row and a clay control, because a
   * setting that blocks publish has to say so where it is rather than only in a summary.
   */
  tone?: Tone;
  /** A row whose control wraps under the text rather than beside it -- a tag input, a long list. */
  align?: "center" | "start";
  /** The last row in a group drops its top divider handling to the group; this is for standalone use. */
  className?: string;
};

/**
 * One settings row: icon tile, name, sentence, control.
 *
 * The layout is container-queried, not viewport-queried. The same row renders in a full-width
 * agent config pane and in a 380px drawer, and the control drops under the text at the point the
 * row itself runs out of width.
 */
export function SettingRow({
  align = "center",
  className,
  control,
  description,
  icon,
  iconTone,
  title,
  tone = "neutral",
}: SettingRowProps) {
  const toned = tone !== "neutral";
  return (
    <div
      className={cn(
        "@container flex flex-col gap-[var(--s-3)] px-[17px] py-[14px]",
        "@min-[440px]:flex-row @min-[440px]:gap-[14px]",
        align === "center" ? "@min-[440px]:items-center" : "@min-[440px]:items-start",
        className,
      )}
      data-slot="setting-row"
      data-tone={tone}
      style={
        toned
          ? { background: `color-mix(in oklab, ${TONE_MARK[tone]} 4.5%, transparent)` }
          : undefined
      }
    >
      <div className="flex min-w-0 items-start gap-[14px]">
        {icon ? (
          <IconTile size="lg" tone={iconTone ?? (toned ? tone : "accent")}>
            {icon}
          </IconTile>
        ) : null}
        <div className="min-w-0">
          <div
            className="mb-[3px] text-[13.5px] leading-[1.3] font-[500] text-[color:var(--ink)]"
            data-slot="setting-row-title"
          >
            {title}
          </div>
          <p
            className="m-0 max-w-[var(--measure-prose)] text-[12px] leading-[1.45] text-pretty"
            data-slot="setting-row-description"
            style={{ color: toned ? TONE_TEXT[tone] : "var(--muted)" }}
          >
            {description}
          </p>
        </div>
      </div>
      {control ? (
        <div
          className={cn(
            "flex shrink-0 flex-wrap items-center gap-[13px] @min-[440px]:ml-auto @min-[440px]:justify-end",
            align === "start" && "@min-[440px]:max-w-[230px]",
          )}
          data-slot="setting-row-control"
        >
          {control}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The hairline between adjacent rows, written once.
 *
 * Rows are separated with `--line-soft` rather than `--line` because a divider inside a card
 * competes with the card's own edge at the same weight. Two containers hold rows -- the standalone
 * group and an accordion section's body -- and a selector this long retyped in both is a second
 * definition waiting to drift.
 */
const ROW_DIVIDERS =
  "[&>[data-slot='setting-row']+[data-slot='setting-row']]:border-t [&>[data-slot='setting-row']+[data-slot='setting-row']]:border-[var(--line-soft)]";

/**
 * A run of rows with the dividers and nothing else: no face, no radius, no padding.
 *
 * This is what an accordion section's body is. The face belongs to the section around it, and a
 * `SettingGroup` nested inside a card would be a card inside a card.
 */
export function SettingRows({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("@container min-w-0", ROW_DIVIDERS, className)} data-slot="setting-rows">
      {children}
    </div>
  );
}

/**
 * The group the rows live in: one bordered face, hairlines between rows, nothing between the rows
 * and the edge.
 */
export function SettingGroup({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "@container overflow-hidden rounded-[13px] border border-[var(--line)] [background:linear-gradient(180deg,var(--card-top),var(--card))]",
        ROW_DIVIDERS,
        className,
      )}
      data-slot="setting-group"
    >
      {children}
    </div>
  );
}

/**
 * The disclosure chevron: a 26px tile with a rotating caret, shared by every section that opens.
 *
 * It is always `aria-hidden`. The button around it carries `aria-expanded`, which is what actually
 * says open or closed -- a rotated glyph on its own is a distinction carried by shape and nothing
 * else, and the screen reader would hear neither state.
 */
function DisclosureChevron({ expanded }: { expanded?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-[7px] border border-[var(--line)] bg-[var(--control-fill)]"
      data-slot="disclosure-chevron"
    >
      <span
        className="size-[8px] border-r-[1.5px] border-b-[1.5px] border-[var(--muted)] transition-transform duration-[var(--duration-quick)] motion-reduce:transition-none"
        style={{
          marginBottom: expanded ? -3 : 0,
          marginTop: expanded ? 0 : -3,
          transform: expanded ? "rotate(-135deg)" : "rotate(45deg)",
        }}
      />
    </span>
  );
}

/**
 * 3a's collapsed section: a title, its sentence, the current value stated in mono, and a chevron.
 *
 * This is the row type that carries the redesign's central idea. Five of these stacked say five
 * decisions the platform has already made, in one line each, and the reader can see all five at
 * once instead of scrolling through five open panels. Opening one is a deliberate act.
 */
export function CollapsedSettingCard({
  className,
  description,
  expanded,
  onToggle,
  summary,
  title,
  tone = "neutral",
}: {
  className?: string;
  description: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  /** The current value, in mono or as a status: "$4k setup · $1.5k/mo · no discounts". */
  summary?: ReactNode;
  title: ReactNode;
  tone?: Tone;
}) {
  return (
    <button
      aria-expanded={expanded ?? false}
      className={cn(
        "@container surface-card is-actionable flex w-full flex-col gap-[var(--s-3)] text-left transition-[border-color] duration-[var(--duration-quick)] motion-reduce:transition-none",
        "@min-[520px]:flex-row @min-[520px]:items-center @min-[520px]:gap-[14px]",
        className,
      )}
      data-expanded={expanded ? "true" : undefined}
      data-slot="collapsed-setting-card"
      data-tone={tone}
      onClick={onToggle}
      style={tone === "neutral" ? undefined : { borderColor: TONE_LINE[tone] }}
      type="button"
    >
      <span className="min-w-0">
        <span className="mb-[4px] block text-[15px] leading-[1.3] font-[600] text-[color:var(--ink)]">
          {title}
        </span>
        <span
          className="block max-w-[var(--measure-prose)] text-[12.5px] leading-[1.45] text-[color:var(--muted)]"
          data-slot="setting-summary-line"
        >
          {description}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-[11px] @min-[520px]:ml-auto">
        {summary ? (
          <span className="mono text-[11.5px] tabular-nums text-[color:var(--muted)]" data-slot="collapsed-setting-summary">
            {summary}
          </span>
        ) : null}
        <DisclosureChevron expanded={expanded} />
      </span>
    </button>
  );
}

/**
 * 3a's *expanded* accordion: the same disclosure header as a collapsed card, with the rows inside
 * the same face rather than in a second card underneath it.
 *
 * The artifact draws both halves of this pattern -- one section open with its rows attached to its
 * own header, the rest collapsed and stating their answer in mono on the right -- and the kit only
 * had the collapsed half. Building the open half as two stacked faces would have read as a card
 * inside a card, which is the one thing the surface ladder forbids outright.
 *
 * The header is a `<button>` carrying `aria-expanded`, so the state is announced rather than left
 * to the chevron's rotation.
 */
export function SettingSection({
  children,
  className,
  description,
  expanded = false,
  headingId,
  onToggle,
  summary,
  title,
}: {
  /** The rows. Rendered only when open, inside the section's own face. */
  children?: ReactNode;
  className?: string;
  description: ReactNode;
  expanded?: boolean;
  /**
   * Names the section by its own title. When set, the face becomes a labelled group, so a screen
   * reader reaching the rows knows which section it is standing in rather than hearing eight
   * unattached checkboxes.
   */
  headingId?: string;
  onToggle?: () => void;
  /** What the section says while it is shut: the current answer, in mono or as a status. */
  summary?: ReactNode;
  title: ReactNode;
}) {
  return (
    <div
      aria-labelledby={headingId}
      className={cn("@container surface-card is-flush min-w-0 overflow-hidden", className)}
      data-expanded={expanded ? "true" : undefined}
      data-slot="setting-section"
      role={headingId ? "group" : undefined}
    >
      <button
        aria-expanded={expanded}
        className="@container flex w-full flex-col gap-[var(--s-3)] px-[18px] py-[15px] text-left transition-colors duration-[var(--duration-quick)] hover:bg-[var(--row-hover)] motion-reduce:transition-none @min-[520px]:flex-row @min-[520px]:items-center @min-[520px]:gap-[14px]"
        data-slot="setting-section-toggle"
        onClick={onToggle}
        type="button"
      >
        <span className="min-w-0">
          <span
            className="mb-[4px] block text-[15px] leading-[1.3] font-[600] text-[color:var(--ink)]"
            id={headingId}
          >
            {title}
          </span>
          <span
          className="block max-w-[var(--measure-prose)] text-[12.5px] leading-[1.45] text-[color:var(--muted)]"
          data-slot="setting-summary-line"
        >
            {description}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-[11px] @min-[520px]:ml-auto">
          {summary ? (
            <span
              className="mono text-[11.5px] tabular-nums text-[color:var(--muted)]"
              data-slot="setting-section-summary"
            >
              {summary}
            </span>
          ) : null}
          <DisclosureChevron expanded={expanded} />
        </span>
      </button>
      {expanded ? (
        <SettingRows className="border-t border-[var(--line)]">{children}</SettingRows>
      ) : null}
    </div>
  );
}
