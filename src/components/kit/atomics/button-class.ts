import { cn } from "@/lib/utils";

export type KitButtonVariant = "primary" | "secondary" | "ghost" | "destructive" | "soft";
export type KitButtonSize = "sm" | "md" | "lg";

/**
 * Three heights, and they are places rather than preferences: `sm` (26px) is an action inside a
 * queue row, `md` (30px) an action on a toolbar, `lg` (34px) the page's own header action. The
 * artifact draws exactly these three and nothing between them.
 */
const SIZE = {
  sm: "h-[26px] px-[10px] text-[12px] rounded-[var(--r-chip)]",
  md: "h-[30px] px-[11px] text-[12.5px] rounded-[var(--r-chip)]",
  lg: "h-[34px] px-[15px] text-[13px] rounded-[9px]",
} as const satisfies Record<KitButtonSize, string>;

/**
 * Five variants, and only one of them fills.
 *
 * `primary` is the One Fill Rule made physical: `--accent-fill` under `--on-accent`, with an inset
 * top highlight. It carried an accent-tinted floor shadow as well until 2026-09-01 -- see
 * `ACCENT_FILL_SHADOW` below for why that half is gone. `soft` is the accent
 * wash version -- "Assign owner" on a selection toolbar in 1c -- which asserts nothing about being
 * the page's live action and so may appear more than once.
 *
 * `destructive` is clay wash on a clay hairline, never a solid red fill: nothing in this product
 * destroys anything so fast that it needs to shout, and a filled red button on a dark navy card
 * would be the loudest object on any screen it appears on.
 */
const VARIANT = {
  primary:
    "border border-[var(--accent-line)] font-[600] text-[color:var(--on-accent)] [background:var(--accent-fill)] [box-shadow:0_1px_0_rgba(255,255,255,.25)_inset] hover:brightness-110",
  secondary:
    "border border-[var(--line)] bg-[var(--control-fill)] font-[400] text-[color:var(--body)] [box-shadow:0_1px_0_rgba(255,255,255,.05)_inset] hover:border-[var(--accent-edge)] hover:text-[color:var(--ink)]",
  ghost: "border border-transparent font-[400] text-[color:var(--muted)] hover:text-[color:var(--ink)]",
  destructive:
    "border border-[var(--failure-line)] bg-[var(--failure-wash)] font-[400] text-[color:var(--failure-text)] hover:brightness-115",
  soft:
    "border border-[var(--accent-edge)] bg-[var(--accent-wash)] font-[500] text-[color:var(--accent-text)] hover:bg-[var(--accent-wash-strong)]",
} as const satisfies Record<KitButtonVariant, string>;

/**
 * The primary fill's shadow, as a whole utility rather than a bare value, exported so the coach
 * surface's local 52-60px recipes share one string with the kit's 26-34px buttons instead of each
 * carrying a copy. It is the full class on purpose: Tailwind generates arbitrary values by finding
 * them written out in a source file, so a caller interpolating this constant gets working CSS only
 * because the utility is spelled here.
 *
 * It used to carry a second layer: a downward-offset blur of the accent colour itself, which
 * over the near-black pane the product used to have read as the button lifting off the page. The
 * light palette landed in `39f0cae` and a blue shadow under a blue button on a near-white ground
 * reads as a halo or a print registration error instead. It was a glow authored for one ground and
 * it has no equivalent on the other, so the colour is dropped rather than re-tuned -- the fill and
 * its hairline are what say the button is the page's live action, and they say it in both
 * palettes. The inset top highlight stays: white at 25% on a saturated fill is a bevel on the
 * button's own face and does not depend on what is behind it.
 */
export const ACCENT_FILL_SHADOW_CLASS = "shadow-[0_1px_0_rgba(255,255,255,0.25)_inset]";

/**
 * `kit-button` is a marker, not a style: no stylesheet defines it as a rule on its own.
 *
 * It exists so `coach.css` can name this face. `KitButton` carries `data-slot="kit-button"` and
 * the coach type floor keys on that, but `kitButtonClass` is exported precisely for the elements
 * that are not `KitButton` -- a `next/Link` that has to be the page's live action -- and those
 * carry no slot. The 2026-09-04 audit measured one of them, "Tell us about a lead" on
 * `/coach/pipelines`, rendering at 12.5px under a 14px floor for exactly that reason.
 *
 * A class rather than a slot because a caller spreading `data-slot` would overwrite it, which is
 * what a Radix trigger already does to `data-slot="button"` elsewhere in this kit.
 */
const BASE =
  "kit-button inline-flex shrink-0 items-center justify-center gap-[var(--s-2)] whitespace-nowrap transition-[filter,color,border-color,background-color] duration-[var(--duration-quick)] ease-[var(--ease-out)] active:scale-[var(--press-scale)] disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100";

/**
 * The same face, for the elements that cannot be a `<button>`.
 *
 * A `next/Link` that is the page's live action still has to be the page's one accent fill, and
 * before this existed the only way to get one was to retype the primary variant's nine values --
 * which the craft audit on 2026-08-30 found several lanes had done, at slightly different values.
 * `KitButton` renders through this, so there is exactly one definition of each face.
 */
export function kitButtonClass({
  className,
  size = "md",
  variant = "secondary",
}: {
  className?: string;
  size?: KitButtonSize;
  variant?: KitButtonVariant;
} = {}) {
  return cn(BASE, SIZE[size], VARIANT[variant], className);
}
