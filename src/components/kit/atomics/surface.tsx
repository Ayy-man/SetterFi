import type { ElementType, HTMLAttributes, ReactNode } from "react";

import { TONE_LINE, TONE_WASH, type Tone } from "@/components/kit/atomics/tone";
import { Overline } from "@/components/kit/atomics/type";
import { cn } from "@/lib/utils";

export type SurfaceVariant = "card" | "panel" | "well" | "strip";

export type SurfaceProps = {
  /**
   * `card` is the lit face a figure or a setting sits on. `panel` is the same face carrying a
   * table, a chart or a queue: it takes no interior padding of its own and clips its children, so
   * a header strip and hairline-separated rows meet its rounded corners. `well` is the region sunk
   * into a card, and `strip` is the flattest thing on the page -- what SetterFi already decided.
   */
  variant?: SurfaceVariant;
  /**
   * A non-neutral tone frames the whole surface: the tone's hairline all the way round plus a
   * radial wash off the top-left corner. This is the attention-card recipe from `docs/DESIGN.md`
   * generalised to the other tones the artifact frames a card with -- the clay DISQUALIFIED tile
   * in 1b, the clay BREACHING tile in 2a, the amber escalation row in 3a, the accented suggestion
   * card in 2b. It is a full border and a face tint, never an edge stripe.
   */
  tone?: Tone;
  /** Open or being edited: `--accent-edge` and a rung of shadow, per the surface recipe. */
  open?: boolean;
  as?: ElementType;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "color">;

/**
 * The surface ladder, as one component rather than four inline gradient strings.
 *
 * Every face comes from the recipes in `src/app/globals.css` (`.surface-card`, `.surface-well`,
 * `.surface-strip`), so a token move reaches all of them. The only thing this adds on top is the
 * tone frame, because eight admin screens each frame a card in a status colour and each would
 * otherwise re-roll the radial by hand at a slightly different stop.
 *
 * Nested cards are always wrong: a card contains wells, not cards.
 */
export function Surface({
  as,
  children,
  className,
  open,
  style,
  tone = "neutral",
  variant = "card",
  ...rest
}: SurfaceProps) {
  const Component = (as ?? "div") as ElementType;
  const toned = tone !== "neutral";

  return (
    <Component
      className={cn(
        "@container",
        variant === "card" && "surface-card",
        // A panel is a card that has given up its padding to whatever it contains, and clips so a
        // full-bleed header row and the last table row both meet the 14px corner.
        variant === "panel" && "surface-card is-flush overflow-hidden",
        variant === "well" && "surface-well",
        variant === "strip" && "surface-strip",
        className,
      )}
      data-open={open ? "true" : undefined}
      data-slot="surface"
      data-tone={tone}
      data-variant={variant}
      style={{
        ...(toned
          ? {
              backgroundImage: `radial-gradient(120% 140% at 12% 0%, ${TONE_WASH[tone]}, transparent 62%)`,
              borderColor: TONE_LINE[tone],
            }
          : null),
        ...style,
      }}
      {...rest}
    >
      {children}
    </Component>
  );
}

export type SurfaceHeaderScale = "console" | "coach-data";

export type SurfaceHeaderProps = {
  /**
   * The category above the title. On the console scale this is the mono overline a panel wears
   * instead of a title -- QUEUE, ROW TYPES, BLAST RADIUS. On `coach-data` it is the coach's
   * sentence-case eyebrow, because `Overline` is the 9.5px uppercase mono role that
   * `coach-shared-type-floor.test.ts` bans outright from a coach page.
   */
  overline?: ReactNode;
  title?: ReactNode;
  /**
   * The element the title renders as. Defaults to a `div`, which is why every console caller
   * passes its own heading inside `title` with `text-[length:inherit]`. A `coach-data` panel is
   * its section's own heading, so it defaults to `h2` and the caller passes a plain string.
   */
  titleAs?: ElementType;
  /**
   * Put on the title element, so the panel around it can point `aria-labelledby` at the heading
   * the reader actually sees. Without it a caller that moves its heading into the band has to
   * choose between a labelled region and the drawn shape.
   */
  titleId?: string;
  subtitle?: ReactNode;
  /** Right-aligned: a segmented control, a count, an action. */
  trailing?: ReactNode;
  /**
   * `console` is the owner console's band: `--s-4`/`--s-3` padding and a 14px section title, the
   * density this component was built at.
   *
   * `coach-data` is the **wide data panel** -- a full-width panel whose body is a data surface, a
   * chart or a table or a board. Its band is `22px 26px` with no header floor, its eyebrow is
   * sentence case at `--coach-eyebrow`, and its name is 22px at weight 500. The recipe itself
   * lives in `coach.css` under `.coach-data-panel__*`, with the census and both discriminators
   * written out there; this arm only decides which classes the band wears, so the numbers have one
   * home rather than two that agree until somebody edits one.
   *
   * **That sheet is scoped to `[data-shell-role="coach"]`, so this arm fails open outside it** --
   * an unstyled band, not a visibly broken one. `coach-data-panel.test.ts` holds the caller list
   * for that reason; a new caller belongs in it, and belongs under a coach root.
   */
  scale?: SurfaceHeaderScale;
  className?: string;
};

/**
 * A panel's own head: padded, hairline-footed, and container-queried so it stacks rather than
 * squeezes when the panel is dropped into a narrow pane. Admin drops these panels into a 266px
 * list column and a full-width content pane on the same screen (3a), so viewport breakpoints would
 * be measuring the wrong box.
 *
 * Two scales, and `scale` documents which is which. The console arm is the original and is
 * unchanged; `coach-data` is the wide data panel, whose recipe lives in `coach.css`.
 */
/**
 * The band, one recipe per scale, as a lookup rather than a ternary inside `cn()`.
 *
 * The shape of this constant is the finding, not a style preference. Written inline, both arms'
 * class strings sit in one `className` expression on one element, and nothing reading the file
 * statically -- `unlayered-cascade.test.ts` included -- can tell that they never co-occur. That
 * guard reported nine collisions between the console arm's utilities and the coach arm's unlayered
 * sheet rule, every one of them unreachable, and it was right to: a reader cannot distinguish an
 * impossible pairing from a live one, and the next person to add a third scale would inherit the
 * ambiguity. One literal per scale makes the exclusivity structural.
 *
 * `coach-data` carries no utilities at all. Its geometry, its type and its narrow-pane stacking
 * are all in `coach.css` under `.coach-data-panel__*`, because that sheet is unlayered and would
 * silently outrank anything written here anyway.
 */
const BAND_CLASS = {
  console: cn(
    "flex flex-col gap-[var(--s-2)] border-b border-[var(--line)] px-[var(--s-4)] py-[var(--s-3)]",
    "@min-[380px]:flex-row @min-[380px]:items-baseline @min-[380px]:gap-[var(--s-3)]",
  ),
  "coach-data": "coach-data-panel__header",
} as const satisfies Record<SurfaceHeaderScale, string>;

export function SurfaceHeader({
  className,
  overline,
  scale = "console",
  subtitle,
  title,
  titleAs,
  titleId,
  trailing,
}: SurfaceHeaderProps) {
  const data = scale === "coach-data";
  const Title = (titleAs ?? (data ? "h2" : "div")) as ElementType;

  return (
    <div
      className={cn(BAND_CLASS[scale], className)}
      data-scale={data ? "coach-data" : undefined}
      data-slot="surface-header"
    >
      <div className="min-w-0">
        {overline
          ? data
            ? <span className="coach-data-panel__eyebrow">{overline}</span>
            : <Overline className="mb-[var(--s-1)] block">{overline}</Overline>
          : null}
        {title ? (
          <Title
            id={titleId}
            className={
              data
                ? "coach-data-panel__name"
                : "text-[length:var(--t-section-title)] leading-[var(--t-section-title-lh)] font-[600] tracking-[var(--t-section-title-tr)] text-[color:var(--ink)]"
            }
          >
            {title}
          </Title>
        ) : null}
        {/*
          The canvas draws no sub-line on any of the three data panels, so this is the shape
          extended rather than the shape attested -- and it is extended deliberately, because a
          chart or table head is exactly where a scope sentence belongs. It reads at the coach body
          size rather than the console's 13px `--t-body`, which would land under the 14px floor
          `SIMPLIFICATION-SPEC` §5 calls absolute.
        */}
        {subtitle ? (
          <div className="mt-[var(--s-1)] text-[length:var(--coach-body)] leading-[1.55] text-[color:var(--muted)]">
            {subtitle}
          </div>
        ) : null}
      </div>
      {trailing ? (
        <div
          className={
            data
              ? "coach-data-panel__trailing"
              : "flex shrink-0 items-center gap-[var(--s-2)] @min-[380px]:ml-auto"
          }
        >
          {trailing}
        </div>
      ) : null}
    </div>
  );
}
