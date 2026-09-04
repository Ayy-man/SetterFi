# Design slop audit

Audit of the shipped UI against 20 known "generated, not designed" tells. Run as a fan-out of 20
scoped auditors (10 tell-hunters, 10 surface auditors) with an adversarial verification pass over
every finding, a completeness critic, and a round of targeted follow-up probes.

Method note: 78 agent reports were collected. 46 findings were refuted outright by the verification
pass, usually because `tokens.css` or `docs/DESIGN.md` documents an explicit reason for the thing
being flagged. Deliberate is not slop, and this repo documents its reasoning unusually well. 27
findings survived adversarial verification with a CONFIRMED verdict; those are the ones listed
below. The rest are recorded but not promoted here.

## Verdict

The 20 tells are almost entirely absent. This does not read as generated work. The failures are of
a different and more interesting kind: the design system is real, documented and argued for, and
the code drifts off it in a few hundred specific places. The problem is not taste, it is
enforcement.

## Scorecard

| # | Tell | Status | Note |
|---|------|--------|------|
| 1 | Purple-to-blue gradient | CLEAN | Accent is blue at OKLCH hue 264 across all four theme blocks. Violet appears only as a documented non-production draft marker. |
| 2 | Gradient hero text | CLEAN | No `bg-clip-text`, no `-webkit-background-clip` anywhere in `src/`. |
| 3 | Emojis in headings | CLEAN | No emoji codepoints in rendered strings. |
| 4 | Inter font everywhere | CLEAN | Archivo plus IBM Plex Mono, loaded via `next/font` in `layout.tsx`. |
| 5 | Colored left-border cards | CLEAN | Depth comes from the documented four-ground model, not from border accents. |
| 6 | Glassmorphism cards | MINOR | 6 `backdrop-filter` uses, all on sticky overlay chrome rather than static cards. Separately, 4 sites inline `--shadow-card` as a literal and keep a light-mode inset highlight in dark. |
| 7 | Low-contrast dark mode | CLEAN | Every text role is solved to a measured ratio and pinned by a contrast test. One exception, item 9 below. |
| 8 | Three icon boxes in a row | CLEAN | No icon-box triptych on any entry surface. |
| 9 | Badge above the headline | CLEAN | Not present on the shipped front door. |
| 10 | Lucide icons everywhere | CLEAN | 5 import sites total, each carrying meaning. |
| 11 | Untouched shadcn components | PRESENT | See items 2 and 5. Radius shim is non-monotonic and 5 primitives are dead. |
| 12 | Sections fading in on scroll | CLEAN | Scroll work is the deliberate scrollcraft site, not a generic reveal-on-scroll wrapper. |
| 13 | Cursor-following beam | CLEAN | No pointer-driven gradient, glow or spotlight anywhere. |
| 14 | Hover effects that fade buttons | MINOR | Hover is a ground or border change, per the system. One surface uses a fade to mean two different things. |
| 15 | Inconsistent spacing | **BAD** | The headline finding. See below. |
| 16 | Em dashes everywhere | CLEAN | 17 em dashes in `.tsx`, effectively all in code comments rather than rendered copy. |
| 17 | Generic buzzword copy | CLEAN | Copy is specific and refuses to claim unconfirmed outcomes, which is a stated hard rule. |
| 18 | Serif italics for accent words | CLEAN | Italic is used only for a documented "no reading yet" state, and the repo argues against it elsewhere. |
| 19 | Space Grotesk plus Instrument Serif | CLEAN | Neither face is present. |
| 20 | Grain texture over a gradient | CLEAN | No `feTurbulence`, no noise overlay. |

## The headline finding: two spacing vocabularies running side by side

`tokens.css:291` states that every step "aliases a `--s-*` rung so the rhythm cannot drift off the
4px grid". The tokens are real and heavily used: 1,472 `var(--s-N)` references in TSX, 139 in CSS.

Alongside them sit 1,382 arbitrary-px spacing classes, and **720 of those are off the 4px grid**.
Thirty-eight distinct spacing values are in use, covering every integer from 1px to 20px.

The compounding problem is that both spellings appear in the same files. **51 files contain both**
`gap-[var(--s-3)]` and `gap-[12px]`: the same value, written two ways, in one file.

Off-grid instances, most frequent first:

```
gap-[10px]  73    px-[14px]  42    px-[26px]  26    py-[10px]  20
gap-[14px]  63    px-[18px]  32    px-[22px]  22    py-[14px]  18
gap-[13px]  14    gap-[7px]  11    px-[17px]  10    gap-[9px]  10
py-[19px]   15    px-[30px]  12    mt-[3px]   10
```

The same drift shows up on the other axes. The owner console writes 227 off-grid px literals while
spending none of the `--d-stack-gap` / `--d-head-gap` / `--d-section-gap` scale authored for it.
`--d-head-gap` is declared, argued for at length, pinned by a test, and referenced zero times. The
type scale is bypassed by literal px 244 times against 38 token references, 78 of those at 12.5px,
a size the 16-token scale does not contain.

## Confirmed findings, ranked

Every item below survived an adversarial pass whose default posture was to refute.

**1. The global focus rule squares every focused control.** `tokens.css:976` sets
`:focus-visible { ...; border-radius: var(--r-control); }`, forcing 4px onto every element that
takes focus. A card at 14px or a chip at 8px visibly changes shape on focus. Modern browsers
already follow the element's own radius when drawing an outline. Fix: delete the declaration.
Mechanical, ~43 affected sites.

**2. The radius shim is non-monotonic.** `globals.css:40-44` maps `--radius-sm: --r-control` (4px),
`--radius-md: --r-input` (6px), `--radius-lg: --r-card` (14px), `--radius-xl: --r-panel` (12px). So
`xl` renders *smaller* than `lg`, and every shadcn control asking for `lg` gets card radius. Fix:
make the shim monotonic and control-biased. Moderate, ~22 sites.

**3. The documented mobile breakpoint cites an artboard that does not exist.** `coach.css:606-610`
justifies four values against a source that is not in `design/`, and the real `HomeMobile.dc.html`
contradicts each of them. Fix: re-derive from the artboard that exists and correct the prose.
Moderate, 14 values.

**4. Breakpoints disagree with themselves.** Desktop begins at 959px in some files and 1023/1024 in
others; phone begins at 620 or 639/640. Fix: collapse to one number per boundary in `--bp-*`. 1024
is already the majority at 62 JSX sites. Mechanical, 10 sites.

**5. 2,261 lines of never-imported shadcn primitives.** `file-upload`, `field`, `form`,
`aspect-ratio` and `progress` have zero importers outside `components/ui/`. Fix: delete them and
their `index.ts` entries; re-add via `shadcn add` at the moment of need. Mechanical.

**6. 19 hand-rolled focus utilities are inert** against the unlayered global rule, and two silently
render a different offset than they declare. Fix: delete all 19. Mechanical.

**7. 41% of the type-role class layer has zero consumers.** The whole layer has 66 uses and one
class owns 36% of them. Fix: delete the nine dead declarations or convert them to `--t-*` token
form. Mechanical.

**8. Two date orders ship side by side.** Seven `en-GB` formatters render "4 Sept 2026" while the
module that claims to own dates renders "Sep 4, 2026". Fix: move the seven to `en-US`, or express
day-first through an explicit option set rather than by borrowing a foreign locale. Mechanical.

**9. `.share-field` draws focus as a 3px box-shadow at 22% alpha**, measuring 1.24:1. The playbook
names that exact figure as unacceptable. Fix: drop `outline: 0` at `globals.css:1358` and the
shadow at `:1369`, and let the global outline paint. Mechanical.

**10. The 590-line marketing page cannot render.** The flag that switches on
`components/marketing/landing-page.tsx` also rewrites `/` away from it. Fix: decide which `/` is
the front door and delete the loser. Moderate.

**11. Padding utilities on `<Surface>` never apply** at three sites, in the exact failure mode the
repo already diagnosed in writing for `.surface-card`. Same defect on `MetricCard`. Fix: drop the
dead utilities or opt into `is-flush`. Mechanical.

**12. The documented `--smoothing` fork never reaches the page**: `tokens.css:965` hard-codes the
value the token exists to vary. Fix: read the token. Mechanical, 1 line.

**13. Three different reduced-motion policies**, one contradicting the repo's stated hard rule,
with five animated declarations covered by none. Fix: use the universal form everywhere.
Mechanical.

**14. Segmented control ships in three heights** (44 vs 48), and `VOCABULARY.md:85` contradicts six
of eight artboards. Fix: pick 44px, delete the parenthetical. Mechanical.

**15. The formatting guard test is reportedly red**, and its scope exempts the failure modes it
exists to catch. NOT VERIFIED BY EXECUTION: node_modules was not installed in the audit
environment, so this is a read-only finding. Confirm before acting.

Smaller confirmed items: `DataState`'s disclosure pasted into three pages instead of passed as a
prop; byte-identical error plumbing duplicated across Overview and Overview detail; three
route-level forks of the global focus rule; the one class `DESIGN.md` names by explicit rule
hand-rolled at its only callsite with tracking drifted 2x; the pillbar height hardcoded in two
files with no token; one control's horizontal padding taking four values across the canvas and two
files.

## What to do first

1. `tokens.css:976`, delete `border-radius: var(--r-control)`. One line, fixes a visible bug on
   every focusable element.
2. `globals.css:40-44`, make the radius shim monotonic. One block, fixes every shadcn control.
3. Install deps and confirm finding 15 before touching anything else in `src/lib/format/`.
4. Then the spacing work, which is the large one. It is not a reformat: it is picking, per
   relationship, which of the two vocabularies wins, and writing a guard test that keeps it won.
   The repo already has the guard-test idiom for this (`overline-size.test.ts`, `tokens.test.ts`);
   the spacing axis is the one that never got one.

The order matters. Items 1 and 2 are single-block edits with visible payoff. The spacing cleanup is
weeks of mechanical change across 51 files and should not start until there is a test that stops
the drift from coming back.
