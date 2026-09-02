import type { ReactNode } from "react";

import { TONE_LINE, TONE_MARK, TONE_WASH, type Tone } from "@/components/kit/atomics/tone";
import { cn } from "@/lib/utils";

export type IconTileSize = "xs" | "sm" | "md" | "lg";

/**
 * Four sizes, and each one is a place rather than a preference: `xs` (22px) leads a queue row in
 * 2a, `sm` (26px) sits beside a KPI overline in 1b, `md` (28px) is the KPI tile in 1a and the
 * account monogram's neighbour, `lg` (33px) leads a settings row in 3a/3b. The tile radius steps
 * with it so the corner stays proportional rather than fixed.
 */
const TILE_SIZE = {
  xs: { box: 22, glyph: 10, radius: "7px" },
  sm: { box: 26, glyph: 11, radius: "8px" },
  md: { box: 28, glyph: 12, radius: "8px" },
  lg: { box: 33, glyph: 14, radius: "9px" },
} as const satisfies Record<IconTileSize, { box: number; glyph: number; radius: string }>;

export type IconTileProps = {
  /**
   * The glyph. Rendered at the tile's own size with `currentColor`, so an icon component that
   * strokes on `currentColor` picks up the tone without being told which tone it is in.
   */
  children?: ReactNode;
  /**
   * The tile is tinted by the state of the card it leads, not by what the icon depicts. A clay
   * tile on a DISQUALIFIED tile, an amber one on an open request, accent on everything the coach
   * owns. This is why it takes a tone and not a colour.
   */
  tone?: Tone;
  size?: IconTileSize;
  className?: string;
  /**
   * Decorative by default: the label beside the tile is what the reader and the screen reader get.
   * Pass a label only when the tile is genuinely the only thing carrying the meaning.
   */
  label?: string;
};

/**
 * The tinted square that leads a card, a KPI, a queue row or a settings row.
 *
 * `accent` is the resting tone because most tiles lead something the platform runs and nothing is
 * wrong with it; a tone here is a deviation the reader should notice.
 */
export function IconTile({ children, className, label, size = "md", tone = "accent" }: IconTileProps) {
  const { box, glyph, radius } = TILE_SIZE[size];
  return (
    <span
      aria-hidden={label ? undefined : "true"}
      aria-label={label}
      className={cn("inline-flex shrink-0 items-center justify-center border", className)}
      data-size={size}
      data-slot="icon-tile"
      data-tone={tone}
      role={label ? "img" : undefined}
      style={{
        background: TONE_WASH[tone],
        borderColor: TONE_LINE[tone],
        borderRadius: radius,
        color: TONE_MARK[tone],
        height: box,
        width: box,
      }}
    >
      <span
        className="inline-flex items-center justify-center [&>svg]:size-full"
        style={{ height: glyph, width: glyph }}
      >
        {children}
      </span>
    </span>
  );
}

export type MonogramProps = {
  /** The full name. The initials are derived here so no caller ships a wrong two-letter string. */
  name: string;
  /**
   * `account` is the rounded-square teal tile a client row wears in 1a and 2a. `person` is the
   * circle a success owner wears. The two shapes are how a table tells a company from a human at a
   * glance, so the shape is not a style prop with a default anyone should be changing casually.
   */
  kind?: "account" | "person";
  size?: number;
  className?: string;
};

/** Two letters, or one if the name is a single word. Never more: three letters stop reading as a mark. */
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length === 1
    ? [words[0]!.slice(0, 2)]
    : [words[0]!.slice(0, 1), words[words.length - 1]!.slice(0, 1)];
  return letters.join("").toUpperCase();
}

/**
 * The monogram avatar. There are no uploaded logos anywhere in this product, so this is the only
 * identity mark a row gets and it has to stay legible at 20px.
 */
export function Monogram({ className, kind = "account", name, size }: MonogramProps) {
  const box = size ?? (kind === "account" ? 28 : 20);
  return (
    <span
      className={cn(
        "mono inline-flex shrink-0 items-center justify-center border border-[var(--line)] font-[500] text-[color:var(--accent-text)]",
        className,
      )}
      data-kind={kind}
      data-slot="monogram"
      role="img"
      aria-label={name}
      style={{
        background: "linear-gradient(150deg, var(--accent), var(--accent-active))",
        borderRadius: kind === "account" ? "8px" : "var(--r-full)",
        fontSize: Math.max(8.5, Math.round(box * 0.39 * 10) / 10),
        height: box,
        width: box,
      }}
    >
      {initialsFor(name)}
    </span>
  );
}

/**
 * The seat nobody is in. A dashed ring rather than a grey monogram, because a filled circle with
 * initials in it reads as a person and "Unassigned" is the absence of one -- and 1a has seven of
 * these in eight rows, so it is a state the client book is mostly made of.
 */
export function UnassignedMark({ className, size = 20 }: { className?: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block shrink-0 rounded-[var(--r-full)] border-[1.5px] border-dashed border-[var(--line-input)]", className)}
      data-slot="unassigned-mark"
      style={{ height: size, width: size }}
    />
  );
}
