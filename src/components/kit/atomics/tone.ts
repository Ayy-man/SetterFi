/**
 * The tone contract every atomic shares.
 *
 * Seven tones, and each one is a claim about state rather than a colour choice. They are the
 * hues the extracted artifact actually spends across its fifteen drawn screens, mapped onto the
 * token roles in `src/app/tokens.css`:
 *
 *   neutral  nothing is being asserted -- a count, a plan name, an unstyled row
 *   accent   yours or live: the thing the coach owns or the platform is running right now
 *   good     enforced, resolved, booked, active
 *   warning  waiting on you, and a clock is running (1a "Open request", 2a "At risk")
 *   waiting  waiting on someone else, and the clock is theirs (1a/1c "Waiting on coach")
 *   draft    written but not running -- never on a live surface (3a "Draft", "unpublished")
 *   failure  something broke and a person has to fix it (2a "Breaching", 2c "Past due")
 *
 * `waiting`, `draft` and `failure` are the three roles the token contract gained on 2026-08-30;
 * before that a screen had to reach for `--warning` for all three, which is why an unpublished
 * draft and a breached SLA used to look identical.
 *
 * Splitting `failure` from `--negative` is deliberate and is documented in tokens.css: `--negative`
 * is a 14x2px bar held to WCAG 1.4.11's 3:1 floor, these are light foregrounds on a dark card held
 * to 1.4.3's 4.5:1. Collapsing them would drag text down to a bar's floor.
 */
export type Tone = "neutral" | "accent" | "good" | "warning" | "waiting" | "draft" | "failure";

export const TONES = [
  "neutral",
  "accent",
  "good",
  "warning",
  "waiting",
  "draft",
  "failure",
] as const satisfies readonly Tone[];

/** The saturated stop: dots, bar fills, the leading edge of a progress gradient. */
export const TONE_MARK = {
  neutral: "var(--glyph)",
  accent: "var(--accent-bright)",
  good: "var(--good)",
  warning: "var(--warning)",
  waiting: "var(--waiting)",
  draft: "var(--draft)",
  failure: "var(--failure)",
} as const satisfies Record<Tone, string>;

/**
 * The light foreground: pill labels, tone-carrying numerals, the "-20pts" in a table cell. Every
 * one of these clears 4.5:1 on `--card-top` and on its own wash over that ground; the ratios are
 * recorded per-token in tokens.css. `neutral` resolves to `--body`, not to a dimmer role, because
 * a neutral status is still a sentence someone reads.
 */
export const TONE_TEXT = {
  neutral: "var(--body)",
  accent: "var(--accent-text)",
  good: "var(--good-text)",
  warning: "var(--warning-text)",
  waiting: "var(--waiting-text)",
  draft: "var(--draft-text)",
  failure: "var(--failure-text)",
} as const satisfies Record<Tone, string>;

/** The translucent fill behind a pill, an icon tile, or a tinted row. */
export const TONE_WASH = {
  neutral: "var(--control-fill)",
  accent: "var(--accent-wash)",
  good: "var(--good-wash)",
  warning: "var(--warning-wash)",
  waiting: "var(--waiting-wash)",
  draft: "var(--draft-wash)",
  failure: "var(--failure-wash)",
} as const satisfies Record<Tone, string>;

/** The hairline that goes with that wash. Always a full border, never one edge. */
export const TONE_LINE = {
  neutral: "var(--line)",
  accent: "var(--accent-edge)",
  good: "var(--good-line)",
  warning: "var(--warning-line)",
  waiting: "var(--waiting-line)",
  draft: "var(--draft-line)",
  failure: "var(--failure-line)",
} as const satisfies Record<Tone, string>;

/**
 * The faintest wash there is: the tint a whole table row takes when it is the row that is wrong
 * (1a's open-request row at .035, 2b's failing agent at .045, 2c's past-due row). It has to stay
 * under the row-hover value or hovering a tinted row would read as untinting it.
 */
export const TONE_ROW_TINT = {
  neutral: "transparent",
  accent: "var(--accent-wash)",
  good: "color-mix(in oklab, var(--good) 5%, transparent)",
  warning: "color-mix(in oklab, var(--warning) 5%, transparent)",
  waiting: "color-mix(in oklab, var(--waiting) 5%, transparent)",
  draft: "color-mix(in oklab, var(--draft) 5%, transparent)",
  failure: "color-mix(in oklab, var(--failure) 5%, transparent)",
} as const satisfies Record<Tone, string>;

/**
 * Which tones are *allowed* to glow when a caller explicitly asks. Not which tones glow.
 *
 * That distinction is the whole point, and getting it wrong is what this comment used to do. The
 * earlier version argued that "glow is what attention looks like", scoped to these two tones, with
 * every other dot passing `glow={false}` to opt out. A design ruling overruled that on 2026-08-30
 * and said why: a tone-keyed default had shipped five glowing dots on Integrations and destroyed
 * the signal it implements. `docs/DESIGN.md:378` allows one glow in the product and spends it on
 * the attention card's dot.
 *
 * So this table is a permission, not a behaviour. `toneGlow` still refuses `good` and `neutral`,
 * because a glowing "Resolved" dot is a defect no caller should be able to ask for -- but a
 * `warning` dot is flat too, unless something passes `glow`. `glow-budget.test.ts` holds the
 * budget at one and names the site that spends it.
 */
export const TONE_GLOWS = {
  neutral: false,
  accent: false,
  good: false,
  warning: true,
  waiting: false,
  draft: false,
  failure: true,
} as const satisfies Record<Tone, boolean>;

/** The dot's own halo. Sized off `--distance-base` so it tracks the motion scale, not a literal. */
export function toneGlow(tone: Tone): string | undefined {
  return TONE_GLOWS[tone] ? `0 0 var(--distance-base) ${TONE_MARK[tone]}` : undefined;
}

/**
 * The legacy `StateTone` mapped onto the kit's `Tone`.
 *
 * The two vocabularies are not the same size: `StateTone` has five members and `Tone` has seven,
 * because the kit split `critical` three ways -- a state becomes `failure`, inline error text
 * takes a text token, and a destructive affordance is a button variant -- and added `draft` and
 * `accent`, which the legacy scale never had. So this map is deliberately not a
 * bijection and it only goes one way -- porting a screen off `StateBadge` reads it, and nothing
 * reads it back.
 *
 * `info` becomes `waiting` rather than `accent`. `StateBadge` documents `info` as "a state that is
 * genuinely in progress and informational", and `accent` in the kit is the selected/active colour;
 * mapping to `accent` would make a row of in-progress items read as a row of selected ones, which
 * is the same class of error as the tone-keyed glow default.
 *
 * `critical` becomes `failure` for a *state*. Inline error text and destructive confirmation are
 * the other two arms of the split and neither is a `Status`, so neither belongs in this map.
 *
 * This exists so the port to the kit has one answer rather than thirty-five. Delete it once no
 * screen imports `StateBadge`.
 */
export const STATE_TONE_TO_TONE = {
  neutral: "neutral",
  good: "good",
  warning: "warning",
  critical: "failure",
  info: "waiting",
} as const satisfies Record<"neutral" | "good" | "warning" | "critical" | "info", Tone>;
